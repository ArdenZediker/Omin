import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { ChatToolCall, ChatAttachment, Message, ModelConfig } from "../adapters/types";
import { loadProviderConfigs, modelRegistry } from "../adapters/registry";
import { isMainWindowUserVisible } from "../app/window";
import { COMPACT_WINDOW_LABEL, CURRENT_MODEL_STORAGE_KEY, MAIN_WINDOW_LABEL, PET_THOUGHT_WINDOW_LABEL } from "../app/constants";
import { readSqliteBackedValue } from "../app/sqliteStorage";
import { snapshotAttachments } from "../app/outputStorage";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { executeInputTask, executeTask } from "../chat/taskExecutor";
import type { ToolCallOutcome } from "../chat/engine";
import { resolveCurrentModelId, resolveExecutionModelId } from "../chat/modelSelection";
import { getInitialTaskHistory, saveTaskHistory } from "../chat/taskStorage";
import { getChatSessionTitle, stripPendingPlaceholder } from "../chat/storage";
import { settleInterruptedSteps } from "../chat/stepSettlement";
import { executeLocalTool } from "../chat/localTools";
import { requestConfirmation } from "../chat/confirmationGate";
import { appendArtifact, loadArtifacts, notifyArtifactsChanged, NO_PROJECT_ARTIFACT_KEY, type Artifact } from "../chat/artifacts";
import { executeMcpToolCall, listActiveMcpTools } from "../plugins/mcp";
import type { TaskExecutionResult, TaskRuntimeState } from "../chat/taskTypes";
import type { Project, ChatExecutionResult, ChatSendOptions, ChatStep, ChatSession } from "../chat/types";
import type { ProjectMemoryRecord, SessionSummaryRecord } from "../chat/types";
import type { PetThoughtState } from "../app/types";
import type { ViewMode } from "../app/types";
import { getPetThoughtKey, matchesPetThought } from "../app/petThoughts";
import {
  type SessionLite,
  resolveEnabledToolNames,
  buildChatTools,
  extractToolCallArgs,
  toolCallNameToCommand,
  formatToolCallResult,
  PET_THOUGHT_QUEUE_LIMIT,
  PET_THOUGHT_DISMISS_DELAY_MS,
  type PetThoughtSyncRequestPayload,
  type PetThoughtSyncResponsePayload,
  createPreviewThrottler,
  createStructuredOutputFilter,
  safelyEmitPetThoughtEvent,
  safelyEmitPetThoughtEventTo,
  canUseTauriEvents,
} from "./chatRuntimeHelpers";

// 工具执行结果的扩展形态：携带本次落库产物的引用（engine 据此追加 artifact step）
type ToolResultWithArtifact = import("../chat/toolRegistry").ToolExecutionResult & {
  savedArtifact?: { artifactId: string; title: string };
};

// 写类本地工具：任务级隔离对这些入口做「按工作区串行 + 并发任务冲突确认」。
// 与 WorkBuddy「每个 task 是独立沙箱单元」对齐——Omni 用逻辑围栏替代容器沙箱。
const WRITE_TOOL_IDS = new Set<string>([
  "export_docx",
  "export_xlsx",
  "export_pptx",
  "export_md",
  "git_commit",
  "git_pr",
  "update_persona",
  "install_expert",
  "install_skill",
]);

function generateTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 整轮任务的硬性看门狗（分钟）。
 * 流式请求已有空闲/总超时兜底，但工具调用、MCP 子进程等环节仍可能永久挂起，
 * 导致 UI 一直停在「正在思考」。这里做最后一道保险，超时即中断并给出明确错误。
 */
const RUN_WATCHDOG_MINUTES = 20;
const RUN_WATCHDOG_MS = RUN_WATCHDOG_MINUTES * 60_000;

/** 兜底生成 assistant 最终展示文本：优先用模型正式 content，其次流式累积内容，
 * 再次工具输出；若全部为空但收集到 reasoning，则用 reasoning 作为内容并附加提示，
 * 避免模型只思考不答复时 UI 出现空白消息。 */
function resolveProjectReply(
  finalContent: string | undefined,
  streamedReply: string,
  toolOutput: string | undefined,
  reasoning: string
): string {
  const trimmed = (finalContent ?? "").trim() || streamedReply.trim() || (toolOutput ?? "").trim();
  if (trimmed) return trimmed;
  const trimmedReasoning = reasoning.trim();
  if (trimmedReasoning) {
    return `模型已完成思考，但未生成最终答复。可展开上方「深度思考」查看完整思考过程。\n\n---\n\n${trimmedReasoning}`;
  }
  return "";
}

type UseChatRuntimeArgs = {
  activeChatId: string | null;
  activeProject: Project | null;
  availableModels: ModelConfig[];
  messages: Message[];
  applyUsageToSession: (sessionId: string, result: ChatExecutionResult, conversationMessages: Message[]) => void;
  commitProjectMemory: (sessionId: string, conversationMessages: Message[], result: ChatExecutionResult) => void;
  // 返回完整 ChatSession（含 title）：附件快照需要用 title 生成与镜像一致的会话目录名。
  createSessionFromMessages: (conversationMessages: Message[], projectId?: string) => ChatSession;
  currentModel: string;
  getProjectById: (projectId: string) => Project | null;
  getChatSessionById: (sessionId: string) => SessionLite | null;
  getRelatedContextForProject: (query: string) => {
    summaries: SessionSummaryRecord[];
    memories: ProjectMemoryRecord[];
  };
  searchChatSessions: (query: string) => SessionLite[];
  setActiveProjectId: React.Dispatch<React.SetStateAction<string>>;
  setActiveChatId: React.Dispatch<React.SetStateAction<string | null>>;
  setInputDraft: React.Dispatch<React.SetStateAction<string>>;
  setInputDraftImages: React.Dispatch<React.SetStateAction<string[]>>;
  setInputDraftKey: React.Dispatch<React.SetStateAction<number>>;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setOpenChatMenu: React.Dispatch<React.SetStateAction<{ id: string; x: number; y: number } | null>>;
  updateChatSessionMessages: (sessionId: string, nextMessages: Message[] | ((current: Message[]) => Message[])) => void;
  isCompactWindow: boolean;
  view: ViewMode;
};

// 会话运行时辅助函数（工具解析 / 宠物思考事件同步 / 节流器）已抽到 ./chatRuntimeHelpers。

/**
 * 把用户随消息附带的非图片本地文件，转成注入模型的上下文说明。
 * 文件内容不内联（避免把几十 MB 的 docx 塞进请求体），只给绝对路径，
 * 让模型按需在工具循环里调用 /read_file 读取——这正是 WorkBuddy「把文件挂进
 * 工作上下文、由智能体自行读取」的本地化实现。
 */
function buildAttachmentContext(attachments: ChatAttachment[]): string | undefined {
  if (attachments.length === 0) {
    return undefined;
  }
  const lines = attachments.map((attachment) => {
    const size = attachment.size != null ? `（${attachment.size} 字节）` : "";
    return `- ${attachment.path}${size}`;
  });
  return [
    "以下为用户随本条消息附带的本地文件（绝对路径）。如需其内容，请调用 /read_file 传入对应路径读取，不要假设文件内容已在上下文中：",
    ...lines,
  ].join("\n");
}

export function useChatRuntime({
  activeChatId,
  activeProject,
  availableModels,
  messages,
  applyUsageToSession,
  commitProjectMemory,
  createSessionFromMessages,
  currentModel,
  getProjectById,
  getChatSessionById,
  getRelatedContextForProject,
  searchChatSessions,
  setActiveProjectId,
  setActiveChatId,
  setInputDraft,
  setInputDraftImages,
  setInputDraftKey,
  setMessages,
  setOpenChatMenu,
  updateChatSessionMessages,
  isCompactWindow,
  view,
}: UseChatRuntimeArgs) {
  const [error, setError] = useState<string | null>(null);
  const [loadingSessionIds, setLoadingSessionIds] = useState<string[]>([]);
  const [editingMessageIndex, setEditingMessageIndex] = useState<number | null>(null);
  const [latestTaskResult, setLatestTaskResult] = useState<TaskExecutionResult | null>(null);
  const [taskRuntimeState, setTaskRuntimeState] = useState<TaskRuntimeState>({
    activeTask: null,
    history: [],
  });
  const loadingSessionIdsRef = useRef<Set<string>>(new Set());
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const sessionRunIdsRef = useRef<Map<string, number>>(new Map());
  // 任务级隔离状态：当前 run 的 taskId、按工作区的写串行队列、当前写占用者（taskId）。
  const currentTaskIdRef = useRef<Map<string, string>>(new Map());
  const workspaceWriteQueueRef = useRef<Map<string, Promise<unknown>>>(new Map());
  const workspaceWriteOwnerRef = useRef<Map<string, string>>(new Map());
  /** 整轮任务看门狗定时器；被看门狗中断的会话（用于区分用户手动停止） */
  const runWatchdogRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const watchdogAbortedSessionIdsRef = useRef<Set<string>>(new Set());
  const lastTaskResultRef = useRef<TaskExecutionResult | null>(null);
  /** 本轮任务执行期间产生的产物，最终消息提交时挂到消息上 */
  const pendingArtifactsRef = useRef<Artifact[]>([]);
  const petThoughtRef = useRef<PetThoughtState | null>(null);
  const petThoughtQueueRef = useRef<PetThoughtState[]>([]);
  const activePetThoughtIdRef = useRef<string | null>(null);
  const activeChatIdRef = useRef<string | null>(activeChatId);
  const pendingPetThoughtSessionIdsRef = useRef<Set<string>>(new Set());
  const petThoughtClearTimerRef = useRef<number | null>(null);
  const isLoading = loadingSessionIds.length > 0;
  const loadingSessionId = loadingSessionIds[0] ?? null;

  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  const setSessionLoading = useCallback((sessionId: string, loading: boolean) => {
    const next = new Set(loadingSessionIdsRef.current);
    if (loading) {
      next.add(sessionId);
    } else {
      next.delete(sessionId);
    }
    loadingSessionIdsRef.current = next;
    setLoadingSessionIds(Array.from(next));
  }, []);

  const isSessionLoading = useCallback((sessionId: string | null | undefined) => {
    return Boolean(sessionId && loadingSessionIdsRef.current.has(sessionId));
  }, []);

  const startSessionRun = useCallback(
    (sessionId: string | null | undefined, abortController: AbortController) => {
      if (!sessionId) return 0;
      const runId = (sessionRunIdsRef.current.get(sessionId) ?? 0) + 1;
      sessionRunIdsRef.current.set(sessionId, runId);
      abortControllersRef.current.set(sessionId, abortController);
      // 兜底看门狗：任何环节永久挂起时硬性中断，交由错误处理给出提示
      const previous = runWatchdogRef.current.get(sessionId);
      if (previous) clearTimeout(previous);
      const watchdog = setTimeout(() => {
        if (sessionRunIdsRef.current.get(sessionId) !== runId) return;
        if (abortControllersRef.current.get(sessionId) !== abortController) return;
        watchdogAbortedSessionIdsRef.current.add(sessionId);
        abortController.abort();
      }, RUN_WATCHDOG_MS);
      runWatchdogRef.current.set(sessionId, watchdog);
      setSessionLoading(sessionId, true);
      return runId;
    },
    [setSessionLoading]
  );

  const isCurrentSessionRun = useCallback((sessionId: string | null | undefined, runId: number, abortController: AbortController) => {
    if (!sessionId) return !abortController.signal.aborted;
    return sessionRunIdsRef.current.get(sessionId) === runId && !abortController.signal.aborted;
  }, []);

  const finishSessionRun = useCallback(
    (sessionId: string | null | undefined, runId: number, abortController: AbortController) => {
      if (!sessionId) return;
      if (sessionRunIdsRef.current.get(sessionId) !== runId) return;
      if (abortControllersRef.current.get(sessionId) !== abortController) return;
      abortControllersRef.current.delete(sessionId);
      const watchdog = runWatchdogRef.current.get(sessionId);
      if (watchdog) {
        clearTimeout(watchdog);
        runWatchdogRef.current.delete(sessionId);
      }
      setSessionLoading(sessionId, false);
    },
    [setSessionLoading]
  );

  const setConversationMessagesForSession = useCallback(
    (sessionId: string | null | undefined, nextMessages: Message[] | ((current: Message[]) => Message[])) => {
      if (sessionId) {
        updateChatSessionMessages(sessionId, nextMessages);
        return;
      }
      setMessages(nextMessages);
    },
    [setMessages, updateChatSessionMessages]
  );

  const setLastProjectContent = useCallback(
    (sessionId: string | null | undefined, content: string) => {
      const updateLastProject = (prev: Message[]) => {
        if (prev.length === 0) {
          return prev;
        }
        const lastIdx = prev.length - 1;
        const lastMessage = prev[lastIdx];
        if (lastMessage.role !== "project") {
          return prev;
        }
        if (lastMessage.content === content) {
          return prev;
        }
        const updated = [...prev];
        updated[lastIdx] = { ...lastMessage, content };
        return updated;
      };

      if (sessionId) {
        updateChatSessionMessages(sessionId, updateLastProject);
        return;
      }

      setMessages(updateLastProject);
    },
    [setMessages, updateChatSessionMessages]
  );

  /** 流式思考链写入最后一条 project 消息（与 setLastProjectContent 互不覆盖） */
  const setLastProjectReasoning = useCallback(
    (sessionId: string | null | undefined, reasoning: string) => {
      const updateLastProject = (prev: Message[]) => {
        if (prev.length === 0) {
          return prev;
        }
        const lastIdx = prev.length - 1;
        const lastMessage = prev[lastIdx];
        if (lastMessage.role !== "project") {
          return prev;
        }
        if ((lastMessage.reasoning ?? "") === reasoning) {
          return prev;
        }
        const updated = [...prev];
        updated[lastIdx] = { ...lastMessage, reasoning };
        return updated;
      };

      if (sessionId) {
        updateChatSessionMessages(sessionId, updateLastProject);
        return;
      }

      setMessages(updateLastProject);
    },
    [setMessages, updateChatSessionMessages]
  );

  /** 流式追加工具调用步骤到最后一条 project 消息的 steps 字段（实时上屏 UI）。
   *  running 过渡态步骤在完成后由同工具同参数的最终步骤「原地升级」，保持时间线顺序。 */
  const appendLastProjectStep = useCallback(
    (sessionId: string | null | undefined, step: ChatStep) => {
      const updateLastProject = (prev: Message[]) => {
        if (prev.length === 0) return prev;
        const lastIdx = prev.length - 1;
        const lastMessage = prev[lastIdx];
        if (lastMessage.role !== "project") return prev;
        const existing = (lastMessage.steps ?? []) as ChatStep[];
        /** 两步「同一调用」的匹配：当 arguments 字符串完全一致时按精确匹配升级；
         *  fallthrough 时允许同名工具完成 step 替换最近一条同名 running step（兜底 streaming 期间
         *  与完成态 arguments 出现空白/编码/重试参数微差的场景，避免运行步孤立被打成 interrupted）。 */
        const sameCall = (a: ChatStep, b: ChatStep): a is Extract<ChatStep, { type: "tool_call" }> =>
          a.type === "tool_call" && b.type === "tool_call" && a.name === b.name && a.arguments === b.arguments;
        const sameToolName = (a: ChatStep, b: Extract<ChatStep, { type: "tool_call" }>): a is Extract<ChatStep, { type: "tool_call" }> =>
          a.type === "tool_call" && a.name === b.name;

        let nextSteps: ChatStep[];
        if (step.type === "tool_call" && step.status === "running") {
          // running 过渡态：同工具同参数已在跑则跳过，否则追加
          if (existing.some((s) => sameCall(s, step) && s.status === "running")) return prev;
          nextSteps = [...existing, step];
        } else if (step.type === "tool_call") {
          // 完成态：先尝试精确匹配（同名+同参数）的 running 步骤原地升级；
          // 失败时回退到「同名最近一条 running 步骤」兜底升级，避免因参数序列化差异导致
          // 运行步骤孤立被 settlement 误判为 interrupted。
          const runningIdx = existing.findIndex((s) => sameCall(s, step) && s.status === "running");
          let replaceIdx = runningIdx;
          if (replaceIdx < 0) {
            for (let i = existing.length - 1; i >= 0; i--) {
              const candidate = existing[i];
              if (candidate.type === "tool_call" && candidate.status === "running" && sameToolName(candidate, step)) {
                replaceIdx = i;
                break;
              }
            }
          }
          if (replaceIdx >= 0) {
            nextSteps = existing.slice();
            nextSteps[replaceIdx] = step;
          } else if (existing.some((s) => sameCall(s, step) && s.status !== "running")) {
            return prev;
          } else {
            nextSteps = [...existing, step];
          }
        } else {
          // artifact 等其他类型：按 artifactId 幂等去重
          if (step.type === "artifact" && existing.some((s) => s.type === "artifact" && s.artifactId === step.artifactId)) {
            return prev;
          }
          nextSteps = [...existing, step];
        }
        const updated = [...prev];
        updated[lastIdx] = { ...lastMessage, steps: nextSteps };
        return updated;
      };
      if (sessionId) {
        updateChatSessionMessages(sessionId, updateLastProject);
        return;
      }
      setMessages(updateLastProject);
    },
    [setMessages, updateChatSessionMessages]
  );

  /** 流式推理增量合入时间线：最后一段是 reasoning 则追加文本（逐字上屏），否则新开一段 reasoning 步骤。
   *  与 appendLastProjectStep 配合，保证流式期间「思考 → 工具 → 思考」在时间线里实时可见。 */
  const appendReasoningStepDelta = useCallback(
    (sessionId: string | null | undefined, delta: string) => {
      if (!delta) return;
      const updateLastProject = (prev: Message[]) => {
        if (prev.length === 0) return prev;
        const lastIdx = prev.length - 1;
        const lastMessage = prev[lastIdx];
        if (lastMessage.role !== "project") return prev;
        const existing = (lastMessage.steps ?? []) as ChatStep[];
        const last = existing[existing.length - 1];
        let nextSteps: ChatStep[];
        if (last && last.type === "reasoning") {
          nextSteps = existing.slice();
          nextSteps[nextSteps.length - 1] = { type: "reasoning", text: last.text + delta };
        } else {
          nextSteps = [...existing, { type: "reasoning", text: delta }];
        }
        const updated = [...prev];
        updated[lastIdx] = { ...lastMessage, steps: nextSteps };
        return updated;
      };
      if (sessionId) {
        updateChatSessionMessages(sessionId, updateLastProject);
        return;
      }
      setMessages(updateLastProject);
    },
    [setMessages, updateChatSessionMessages]
  );

  const executionModel = resolveExecutionModelId({
    projectModelId: activeProject?.defaultModelId,
    currentModelId: currentModel,
    availableModels,
  });
  const projectSystemPrompt = activeProject?.systemPrompt?.trim() ? activeProject.systemPrompt.trim() : undefined;

  const getScopedConversationMessages = useCallback(() => {
    if (!activeChatId) {
      return messages;
    }

    const session = getChatSessionById(activeChatId);
    if (!session) {
      return messages;
    }

    if (activeProject?.id && session.projectId && session.projectId !== activeProject.id) {
      return [] as Message[];
    }

    // Use the visible pane messages as the source of truth to avoid
    // stale-session races right after switching/creating conversations.
    return messages;
  }, [activeProject?.id, activeChatId, getChatSessionById, messages]);

  const resolveProjectSystemPrompt = useCallback(
    (projectOverride?: Project | null) => {
      const targetProject = projectOverride ?? activeProject;
      return targetProject?.systemPrompt?.trim() ? targetProject.systemPrompt.trim() : undefined;
    },
    [activeProject]
  );

  const resolvePetThoughtTitle = useCallback(
    (sessionId: string | null | undefined, conversationMessages: Message[]) => {
      const sessionTitle = sessionId ? getChatSessionById(sessionId)?.title?.trim() : "";
      const placeholderTitle = getChatSessionTitle([]).trim();
      if (sessionTitle && sessionTitle !== placeholderTitle) {
        return sessionTitle;
      }

      const inferredTitle = getChatSessionTitle(conversationMessages).trim();
      if (inferredTitle && inferredTitle !== placeholderTitle) {
        return inferredTitle;
      }

      if (sessionTitle) {
        return sessionTitle;
      }

      return activeProject?.kind === "basic" ? "Omni" : activeProject?.title?.trim() || "Omni";
    },
    [activeProject?.kind, activeProject?.title, getChatSessionById]
  );

  const resolvePetThoughtResponseCount = useCallback((sessionId: string | null | undefined) => {
    if (sessionId) {
      pendingPetThoughtSessionIdsRef.current.add(sessionId);
    }
    return Math.max(1, pendingPetThoughtSessionIdsRef.current.size || (sessionId ? 1 : 0));
  }, []);

  const clearPetThoughtSession = useCallback((sessionId: string | null | undefined) => {
    if (!sessionId) {
      return;
    }
    pendingPetThoughtSessionIdsRef.current.delete(sessionId);
  }, []);

  const clearPetThoughtTimer = useCallback(() => {
    if (petThoughtClearTimerRef.current !== null) {
      window.clearTimeout(petThoughtClearTimerRef.current);
      petThoughtClearTimerRef.current = null;
    }
  }, []);

  const broadcastPetThoughtQueue = useCallback((queue: PetThoughtState[], currentThought: PetThoughtState | null) => {
    if (!canUseTauriEvents()) {
      return;
    }

    safelyEmitPetThoughtEvent("omni-pet-thought-changed", currentThought);
    safelyEmitPetThoughtEvent("omni-pet-thought-queue-changed", queue);
    safelyEmitPetThoughtEventTo(COMPACT_WINDOW_LABEL, "omni-pet-thought-changed", currentThought);
    safelyEmitPetThoughtEventTo(COMPACT_WINDOW_LABEL, "omni-pet-thought-queue-changed", queue);
    safelyEmitPetThoughtEventTo(PET_THOUGHT_WINDOW_LABEL, "omni-pet-thought-queue-changed", queue);
  }, []);

  const emitPetThoughtQueue = useCallback(
    (queue: PetThoughtState[]) => {
      petThoughtQueueRef.current = queue;
      const currentThought = queue[0] ?? null;
      petThoughtRef.current = currentThought;
      broadcastPetThoughtQueue(queue, currentThought);
    },
    [broadcastPetThoughtQueue]
  );

  const emitPetThought = useCallback((state: PetThoughtState | null) => {
    if (!state) {
      emitPetThoughtQueue([]);
      return;
    }

    const nextKey = getPetThoughtKey(state);
    const currentQueue = petThoughtQueueRef.current;
    const currentIndex = currentQueue.findIndex((item) => getPetThoughtKey(item) === nextKey);
    const nextQueue =
      currentIndex >= 0
        ? currentQueue.map((item, index) => (index === currentIndex ? state : item))
        : currentQueue[0]?.status === "thinking"
          ? [currentQueue[0], state, ...currentQueue.slice(1)]
          : [state, ...currentQueue];

    emitPetThoughtQueue(nextQueue.slice(0, PET_THOUGHT_QUEUE_LIMIT));
  }, [emitPetThoughtQueue]);

  const removePetThought = useCallback(
    (target: { sessionId?: string | null; thoughtId?: string | null }) => {
      const nextQueue = petThoughtQueueRef.current.filter((thought) => !matchesPetThought(thought, target));
      emitPetThoughtQueue(nextQueue);
    },
    [emitPetThoughtQueue]
  );

  const createPetThoughtId = useCallback((sessionId: string | null | undefined) => {
    return `${sessionId || "adhoc"}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  }, []);

  const isCurrentPetThought = useCallback((thoughtId: string | null | undefined, sessionId: string | null | undefined) => {
    if (!thoughtId) {
      return true;
    }

    const currentThought = sessionId
      ? petThoughtQueueRef.current.find((item) => item.sessionId === sessionId)
      : petThoughtQueueRef.current.find((item) => item.thoughtId === thoughtId);
    return !currentThought || currentThought.thoughtId === thoughtId;
  }, []);

  const dismissPetThoughtForVisibleMainSession = useCallback(
    async (target: { sessionId?: string | null; thoughtId?: string | null } = {}) => {
      if (isCompactWindow) {
        return;
      }

      const sessionId = target.sessionId ?? activeChatIdRef.current;
      if (!sessionId || activeChatIdRef.current !== sessionId) {
        return;
      }
      if (view !== "chat" || !(await isMainWindowUserVisible())) {
        return;
      }

      const matchingThought = target.thoughtId
        ? petThoughtQueueRef.current.find((thought) => matchesPetThought(thought, target))
        : petThoughtQueueRef.current.find((thought) => thought.sessionId === sessionId);
      if (!matchingThought) {
        return;
      }
      if (matchingThought.status === "thinking") {
        return;
      }
      if (!isCurrentPetThought(target.thoughtId ?? matchingThought.thoughtId ?? null, sessionId)) {
        return;
      }

      removePetThought({
        sessionId,
        thoughtId: target.thoughtId ?? matchingThought.thoughtId,
      });
      clearPetThoughtSession(sessionId);
    },
    [clearPetThoughtSession, isCompactWindow, isCurrentPetThought, removePetThought, view]
  );

  const startPetThought = useCallback(
    (sessionId: string | null | undefined, conversationMessages: Message[]) => {
      clearPetThoughtTimer();
      const thoughtId = createPetThoughtId(sessionId);
      activePetThoughtIdRef.current = thoughtId;
      const responseCount = resolvePetThoughtResponseCount(sessionId);
      emitPetThought({
        thoughtId,
        sessionId: sessionId ?? null,
        sessionTitle: resolvePetThoughtTitle(sessionId, conversationMessages),
        previewText: "",
        responseCount,
        status: "thinking",
        updatedAt: Date.now(),
      });
      return thoughtId;
    },
    [clearPetThoughtTimer, createPetThoughtId, emitPetThought, resolvePetThoughtResponseCount, resolvePetThoughtTitle]
  );

  const updatePetThought = useCallback(
    (thoughtId: string | null, sessionId: string | null | undefined, conversationMessages: Message[], previewText: string) => {
      if (!isCurrentPetThought(thoughtId, sessionId)) {
        return;
      }

      const responseCount = resolvePetThoughtResponseCount(sessionId);
      emitPetThought({
        thoughtId: thoughtId ?? activePetThoughtIdRef.current ?? undefined,
        sessionId: sessionId ?? null,
        sessionTitle: resolvePetThoughtTitle(sessionId, conversationMessages),
        previewText,
        responseCount,
        status: "thinking",
        updatedAt: Date.now(),
      });
    },
    [emitPetThought, isCurrentPetThought, resolvePetThoughtResponseCount, resolvePetThoughtTitle]
  );

  const completePetThought = useCallback(
    (thoughtId: string | null, sessionId: string | null | undefined, conversationMessages: Message[], previewText: string) => {
      if (!isCurrentPetThought(thoughtId, sessionId)) {
        return;
      }

      clearPetThoughtTimer();
      const responseCount = resolvePetThoughtResponseCount(sessionId);
      emitPetThought({
        thoughtId: thoughtId ?? activePetThoughtIdRef.current ?? undefined,
        sessionId: sessionId ?? null,
        sessionTitle: resolvePetThoughtTitle(sessionId, conversationMessages),
        previewText,
        responseCount,
        status: "complete",
        updatedAt: Date.now(),
      });
    },
    [clearPetThoughtTimer, emitPetThought, isCurrentPetThought, resolvePetThoughtResponseCount, resolvePetThoughtTitle]
  );

  const dismissPetThoughtWhenSessionVisible = useCallback(
    (sessionId: string | null | undefined, thoughtId: string | null | undefined) => {
      if (!sessionId) {
        return;
      }
      if (isCompactWindow) {
        return;
      }
      if (activeChatIdRef.current !== sessionId) {
        return;
      }
      clearPetThoughtTimer();
      petThoughtClearTimerRef.current = window.setTimeout(() => {
        petThoughtClearTimerRef.current = null;
        void dismissPetThoughtForVisibleMainSession({
          sessionId,
          thoughtId: thoughtId ?? undefined,
        });
      }, PET_THOUGHT_DISMISS_DELAY_MS);
    },
    [clearPetThoughtTimer, dismissPetThoughtForVisibleMainSession, isCompactWindow]
  );

  useEffect(() => {
    if (isCompactWindow || !canUseTauriEvents()) {
      return;
    }

    let unlistenRequest: (() => void) | undefined;
    let unlistenSyncRequest: (() => void) | undefined;
    let unlistenViewed: (() => void) | undefined;
    let unlistenClose: (() => void) | undefined;
    let unlistenFocus: (() => void) | undefined;
    void listen("omni-pet-thought-request", () => {
      const nextThought = petThoughtRef.current;
      const queue = petThoughtQueueRef.current;
      broadcastPetThoughtQueue(queue, nextThought);
    }).then((cleanup) => {
      unlistenRequest = cleanup;
    });
    void listen<PetThoughtSyncRequestPayload>("omni-pet-thought-sync-request", (event) => {
      const queue = [...petThoughtQueueRef.current];
      const currentThought = petThoughtRef.current;
      const requesterLabel = event.payload?.requesterLabel?.trim();
      if (!requesterLabel) {
        broadcastPetThoughtQueue(queue, currentThought);
        return;
      }
      const responsePayload: PetThoughtSyncResponsePayload = {
        requestId: event.payload?.requestId,
        queue,
        currentThought,
      };
      safelyEmitPetThoughtEventTo(requesterLabel, "omni-pet-thought-changed", currentThought);
      safelyEmitPetThoughtEventTo(requesterLabel, "omni-pet-thought-queue-changed", queue);
      safelyEmitPetThoughtEventTo(requesterLabel, "omni-pet-thought-sync-response", responsePayload);
    }).then((cleanup) => {
      unlistenSyncRequest = cleanup;
    });
    void listen<{ sessionId?: string | null; thoughtId?: string | null }>("omni-pet-thought-viewed", (event) => {
      void dismissPetThoughtForVisibleMainSession(event.payload ?? {});
    }).then((cleanup) => {
      unlistenViewed = cleanup;
    });
    void listen<{ sessionId?: string | null; thoughtId?: string | null }>("omni-pet-thought-close", (event) => {
      removePetThought(event.payload ?? {});
    }).then((cleanup) => {
      unlistenClose = cleanup;
    });
    void WebviewWindow.getByLabel(MAIN_WINDOW_LABEL)
      .then((mainWindow) =>
        mainWindow?.onFocusChanged(({ payload }) => {
          if (payload) {
            void dismissPetThoughtForVisibleMainSession();
          }
        })
      )
      .then((cleanup) => {
        unlistenFocus = cleanup;
      });

    return () => {
      unlistenRequest?.();
      unlistenSyncRequest?.();
      unlistenViewed?.();
      unlistenClose?.();
      unlistenFocus?.();
    };
  }, [broadcastPetThoughtQueue, dismissPetThoughtForVisibleMainSession, isCompactWindow, removePetThought]);

  useEffect(() => {
    if (isCompactWindow || view !== "chat" || !activeChatId) {
      return;
    }

    void dismissPetThoughtForVisibleMainSession({ sessionId: activeChatId });
  }, [activeChatId, dismissPetThoughtForVisibleMainSession, isCompactWindow, view]);

  useEffect(() => {
    return () => {
      clearPetThoughtTimer();
    };
  }, [clearPetThoughtTimer]);

  useEffect(() => {
    void saveTaskHistory(taskRuntimeState.history);
  }, [taskRuntimeState.history]);

  useEffect(() => {
    let cancelled = false;

    void getInitialTaskHistory().then((history) => {
      if (cancelled) return;
      setTaskRuntimeState({
        activeTask: history[0] ?? null,
        history,
      });
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const finishTaskResult = useCallback(
    (taskResult: TaskExecutionResult, sessionId: string | null | undefined, fallbackMessages: Message[]) => {
      lastTaskResultRef.current = taskResult;
      setLatestTaskResult(taskResult);
      setTaskRuntimeState((current) => ({
        activeTask: taskResult,
        history: [taskResult, ...current.history.filter((item) => item.taskId !== taskResult.taskId)].slice(0, 12),
      }));

      const conversationMessages = taskResult.conversationMessages ?? fallbackMessages;

      if (taskResult.finalResult) {
        const pendingArtifacts = pendingArtifactsRef.current;
        pendingArtifactsRef.current = [];
        const finalToolResults = taskResult.finalResult.toolCallResults;
        const finalSteps = taskResult.finalResult.steps;
        setConversationMessagesForSession(sessionId, [
          ...conversationMessages,
          {
            role: "project",
            content: taskResult.finalResult.content,
            knowledgeContext: taskResult.finalResult.knowledgeContext ?? null,
            reasoning: taskResult.finalResult.reasoning || undefined,
            artifacts: pendingArtifacts.length ? pendingArtifacts : undefined,
            toolCallResults: finalToolResults?.length ? finalToolResults : undefined,
            steps: finalSteps?.length ? finalSteps : undefined,
          },
        ]);
        if (sessionId) {
          applyUsageToSession(sessionId, taskResult.finalResult, conversationMessages);
          commitProjectMemory(sessionId, conversationMessages, taskResult.finalResult);
        }
        return;
      }

      if (taskResult.toolResult?.outputText) {
        setConversationMessagesForSession(sessionId, [...conversationMessages, { role: "project", content: taskResult.toolResult.outputText }]);
      }

      if (taskResult.status === "failed") {
        setError(taskResult.error || "任务执行失败");
      }
    },
    [applyUsageToSession, commitProjectMemory, setConversationMessagesForSession]
  );

  const applyProjectReplyToTaskResult = useCallback((taskResult: TaskExecutionResult, projectReply: string): TaskExecutionResult => {
    if (!taskResult.finalResult) {
      return taskResult;
    }
    return {
      ...taskResult,
      finalResult: {
        ...taskResult.finalResult,
        content: projectReply,
      },
    };
  }, []);

  const runConversationTurn = useCallback(
    async (
      conversationMessages: Message[],
      options: { sessionId?: string | null; createSession?: boolean; hiddenContext?: string; projectOverride?: Project | null } = {}
    ) => {
      let sessionId = options.sessionId ?? activeChatId;
      if (!sessionId && options.createSession) {
        const nextSession = createSessionFromMessages(conversationMessages, options.projectOverride?.id ?? activeProject?.id ?? undefined);
        sessionId = nextSession.id;
      }

      const abortController = new AbortController();
      const runId = startSessionRun(sessionId, abortController);
      const petThoughtId = startPetThought(sessionId, conversationMessages);
      const executionProject = options.projectOverride ?? activeProject;
      const systemPrompt = resolveProjectSystemPrompt(options.projectOverride);
      const knowledgeCollectionId = executionProject?.knowledgeCollectionId ?? null;
      const latestUserQuery = [...conversationMessages].reverse().find((message) => message.role === "user")?.content ?? "";
      const relatedContext = getRelatedContextForProject(latestUserQuery);
      let streamedProjectReply = "";
      const streamedFilter = createStructuredOutputFilter();
      let streamedReasoning = "";
      const updateStreamPreview = createPreviewThrottler(16, () => setLastProjectContent(sessionId, streamedFilter.getVisibleText()));
      const updateThoughtPreview = createPreviewThrottler(66, () => updatePetThought(petThoughtId, sessionId, conversationMessages, streamedFilter.getVisibleText()));
      const updateReasoningPreview = createPreviewThrottler(33, () => setLastProjectReasoning(sessionId, streamedReasoning));
      // 推理增量合入时间线（WorkBuddy 式逐字上屏）：33ms 节流冲刷，避免每个网络分片触发一次 setState
      let pendingReasoningDelta = "";
      const flushReasoningDelta = createPreviewThrottler(33, () => {
        if (!pendingReasoningDelta) return;
        const delta = pendingReasoningDelta;
        pendingReasoningDelta = "";
        appendReasoningStepDelta(sessionId, delta);
      });

      setConversationMessagesForSession(sessionId, [...conversationMessages, { role: "project", content: "" }]);
      setError(null);

      try {
        if (!executionModel) {
          throw new Error("请先在设置中配置一个可用模型");
        }

        const { toolNames: resolvedToolNames, toolDescriptions: resolvedToolDescriptions } =
          resolveEnabledToolNames(executionProject);

        const taskResult = await executeTask({
          model: executionModel,
          messages: conversationMessages,
          signal: abortController.signal,
          systemPrompt: [systemPrompt, options.hiddenContext?.trim()].filter(Boolean).join("\n\n") || undefined,
          project: executionProject,
          relatedContext,
          enabledToolNames: resolvedToolNames,
          enabledToolDescriptions: resolvedToolDescriptions,
          knowledgeCollectionId,
          tools: [...buildChatTools(executionProject), ...listActiveMcpTools()],
          executeToolCall,
          onChunk: (chunk) => {
            if (!isCurrentSessionRun(sessionId, runId, abortController)) {
              return;
            }
            streamedProjectReply += chunk;
            streamedFilter.append(chunk);
            updateThoughtPreview();
            updateStreamPreview();
          },
          onReasoning: (reasoning) => {
            if (!isCurrentSessionRun(sessionId, runId, abortController)) {
              return;
            }
            streamedReasoning += reasoning;
            pendingReasoningDelta += reasoning;
            flushReasoningDelta();
            updateReasoningPreview();
          },
          onToolStep: (step) => {
            if (!isCurrentSessionRun(sessionId, runId, abortController)) {
              return;
            }
            // 实时上屏：每完成一个工具调用立刻把步骤追加到最后一条消息的思考块
            appendLastProjectStep(sessionId, step);
          },
        });

        if (!isCurrentSessionRun(sessionId, runId, abortController)) {
          return;
        }

        if (!taskResult.finalResult && taskResult.status === "aborted") {
          setConversationMessagesForSession(sessionId, (prev) => prev.filter((message, index) => index < conversationMessages.length || message.content));
          clearPetThoughtSession(sessionId);
          return;
        }

        if (!taskResult.finalResult && !taskResult.toolResult?.outputText) {
          setError(taskResult.error || "回复失败");
          setConversationMessagesForSession(sessionId, conversationMessages);
          if (isCurrentPetThought(petThoughtId, sessionId)) {
            const responseCount = resolvePetThoughtResponseCount(sessionId);
            emitPetThought({
              thoughtId: petThoughtId,
              sessionId: sessionId ?? null,
              sessionTitle: resolvePetThoughtTitle(sessionId, conversationMessages),
              previewText: "",
              responseCount,
              status: "error",
              updatedAt: Date.now(),
            });
          }
          return;
        }

        const projectReply = resolveProjectReply(taskResult.finalResult?.content, streamedProjectReply, taskResult.toolResult?.outputText, streamedReasoning);
        updateStreamPreview(true);
        updateThoughtPreview(true);
        completePetThought(
          petThoughtId,
          sessionId,
          conversationMessages,
          projectReply
        );
        dismissPetThoughtWhenSessionVisible(sessionId, petThoughtId);
        finishTaskResult(applyProjectReplyToTaskResult(taskResult, projectReply), sessionId, conversationMessages);
        return;
      } catch (runError) {
        if (!isCurrentSessionRun(sessionId, runId, abortController)) {
          return;
        }
        if (runError instanceof DOMException && runError.name === "AbortError") {
          setConversationMessagesForSession(sessionId, (prev) => prev.filter((message, index) => index < conversationMessages.length || message.content));
          clearPetThoughtSession(sessionId);
          if (sessionId && watchdogAbortedSessionIdsRef.current.delete(sessionId)) {
            setError(`任务执行超时（${RUN_WATCHDOG_MINUTES} 分钟），已自动停止`);
          }
          return;
        }

        setError(runError instanceof Error ? runError.message : "回复失败");
        setConversationMessagesForSession(sessionId, conversationMessages);
        if (isCurrentPetThought(petThoughtId, sessionId)) {
          const errorPreview = runError instanceof Error ? runError.message : "回复失败";
          const responseCount = resolvePetThoughtResponseCount(sessionId);
          emitPetThought({
            thoughtId: petThoughtId,
            sessionId: sessionId ?? null,
            sessionTitle: resolvePetThoughtTitle(sessionId, conversationMessages),
            previewText: errorPreview,
            responseCount,
            status: "error",
            updatedAt: Date.now(),
          });
        }
        return;
      } finally {
        finishSessionRun(sessionId, runId, abortController);
        // 中断收尾：把遗留的 running 过渡态步骤定案为 interrupted，随消息持久化（成功路径已替换为完整步骤、无 running，天然空操作）
        setConversationMessagesForSession(sessionId, (prev) => settleInterruptedSteps(prev));
      }
    },
    [
      activeProject?.id,
      activeProject?.knowledgeCollectionId,
      activeChatId,
      applyProjectReplyToTaskResult,
      clearPetThoughtSession,
      completePetThought,
      createSessionFromMessages,
      emitPetThought,
      executionModel,
      finishTaskResult,
      finishSessionRun,
      dismissPetThoughtWhenSessionVisible,
      isCurrentSessionRun,
      isCurrentPetThought,
      resolvePetThoughtResponseCount,
      resolvePetThoughtTitle,
      resolveProjectSystemPrompt,
      setConversationMessagesForSession,
      setLastProjectContent,
      setLastProjectReasoning,
      startSessionRun,
      startPetThought,
      updatePetThought,
    ]
  );

  const executeTool = useCallback(
    async (command: { command: string; args: string }): Promise<ToolResultWithArtifact | void> => {
      const result = await executeLocalTool(
        {
          activeProject,
          activeChatId,
          getChatSessionById,
          searchChatSessions,
        },
        command
      );
      // 工具执行产出的交付内容 → 落库 + 收集，最终消息提交时挂到消息上。
      // 放在 executeTool 而非 executeToolCall，可同时覆盖 function calling 与 slash 命令两条路径。
      const artifact = result?.artifact;
      if (artifact && result) {
        // 产物始终保存：有项目则归属项目，无项目则归入全局产物。
        const saved = appendArtifact({
          ...artifact,
          projectId: activeProject?.id ?? NO_PROJECT_ARTIFACT_KEY,
          sessionId: activeChatId,
        });
        pendingArtifactsRef.current.push(saved);
        notifyArtifactsChanged();
        // 把落库产物引用随结果带回：engine 据此在 tool_call step 后追加 artifact step
        return { ...result, savedArtifact: { artifactId: saved.id, title: saved.title } };
      }
      return result;
    },
    [
      activeProject,
      activeChatId,
      getChatSessionById,
      searchChatSessions,
    ]
  );

  /**
   * function calling 的执行器：把模型发起的工具调用（name + JSON arguments）
   * 映射回本地 slash 命令或 MCP 工具执行，结果转成文本回填给模型继续推理。
   */
  const executeToolCall = useCallback(
    async (toolCall: ChatToolCall): Promise<string | ToolCallOutcome> => {
      // MCP 连接器工具：mcp__{serverId}__{toolName}
      if (toolCall.name.startsWith("mcp__")) {
        return executeMcpToolCall(toolCall.name, toolCall.arguments);
      }
      const result = await executeTool({
        command: toolCallNameToCommand(toolCall.name),
        args: extractToolCallArgs(toolCall.arguments),
      });
      return { outputText: formatToolCallResult(result), artifact: result?.savedArtifact };
    },
    [executeTool]
  );

  const getWorkspacePathForSession = (sid: string | null): string => {
    const sess = sid ? getChatSessionById(sid) : null;
    const proj = sess?.projectId ? getProjectById(sess.projectId) : activeProject;
    return proj?.workspacePath ?? "";
  };

  // 任务级工具执行器：写类工具按工作区串行化，并在检测到另一并发任务占用同工作区时走确认门。
  const makeTaskToolExecutor = useCallback(
    (sessionId: string | null, taskId: string, workspacePath: string) =>
      async (toolCall: ChatToolCall): Promise<string | ToolCallOutcome> => {
        const command = toolCallNameToCommand(toolCall.name);
        if (WRITE_TOOL_IDS.has(command)) {
          const wsKey = workspacePath || "__no_project__";
          const liveTaskId = currentTaskIdRef.current.get(sessionId ?? "") ?? taskId ?? wsKey;
          const owner = workspaceWriteOwnerRef.current.get(wsKey);
          if (owner && owner !== liveTaskId) {
            const approved = await requestConfirmation({
              source: "task_concurrent_write",
              title: "另一任务正在写入该工作区",
              summary: "检测到并发任务正在写入同一项目工作区，可能产生文件互相覆盖。",
              riskLevel: "write",
              details: [
                { label: "工作区", value: workspacePath || "(未绑定项目)" },
                { label: "当前任务", value: liveTaskId },
                { label: "占用任务", value: owner },
              ],
              targets: workspacePath ? [workspacePath] : [],
              warning:
                "两个任务同时写同一工作区会互相覆盖文件。确认后本任务仍可写入；取消则本次写操作被跳过。",
              confirmLabel: "仍要写入",
            });
            if (!approved) {
              throw new Error("已取消：检测到并发任务写入同一工作区");
            }
          }
          workspaceWriteOwnerRef.current.set(wsKey, liveTaskId);
          const prev = workspaceWriteQueueRef.current.get(wsKey) ?? Promise.resolve();
          const run = prev
            .then(() => executeToolCall(toolCall))
            .finally(() => {
              if (workspaceWriteOwnerRef.current.get(wsKey) === liveTaskId) {
                workspaceWriteOwnerRef.current.delete(wsKey);
              }
            });
          workspaceWriteQueueRef.current.set(wsKey, run);
          return run;
        }
        return executeToolCall(toolCall);
      },
    [executeToolCall, requestConfirmation]
  );

  const handlePetThoughtReply = useCallback(
    async (sessionId: string, content: string) => {
      if (isSessionLoading(sessionId)) {
        return;
      }

      const session = getChatSessionById(sessionId);
      if (!session) {
        return;
      }

      const targetProject = session.projectId ? getProjectById(session.projectId) : null;
      const systemPrompt = resolveProjectSystemPrompt(targetProject);
      if (targetProject) {
        setActiveProjectId(targetProject.id);
      }
      setActiveChatId(session.id);
      // Keep the visible chat pane aligned with the replied session immediately.
      setMessages(session.messages);
      try {
        await loadProviderConfigs();
      } catch {
        // Keep fallback model resolution below; reply should not fail on config hydration glitches.
      }

      const preferredProjectModelId = targetProject?.defaultModelId?.trim() ?? "";
      const resolvedModelId =
        resolveExecutionModelId({
          projectModelId: preferredProjectModelId,
          currentModelId: readSqliteBackedValue(CURRENT_MODEL_STORAGE_KEY) ?? modelRegistry.getCurrentModel(),
          availableModels: modelRegistry.getAvailableModels(),
        }) ||
        resolveCurrentModelId({
          savedModelId: executionModel,
          registryModelId: modelRegistry.getCurrentModel(),
          availableModels,
        });
      if (!resolvedModelId) {
        throw new Error("请先在设置中配置一个可用模型");
      }

      const abortController = new AbortController();
      const runId = startSessionRun(session.id, abortController);
      const taskId = generateTaskId();
      currentTaskIdRef.current.set(session.id, taskId);
      const taskWs = getWorkspacePathForSession(session.id);
      setError(null);

      let conversationMessagesForTask = session.messages;
      let petThoughtId: string | null = null;
      let streamedProjectReply = "";
      const streamedFilter = createStructuredOutputFilter();
      let streamedReasoning = "";
      const updateStreamPreview = createPreviewThrottler(16, () => setLastProjectContent(session.id, streamedFilter.getVisibleText()));
      const updateThoughtPreview = createPreviewThrottler(66, () => updatePetThought(petThoughtId, session.id, conversationMessagesForTask, streamedFilter.getVisibleText()));
      const updateReasoningPreview = createPreviewThrottler(33, () => setLastProjectReasoning(session.id, streamedReasoning));
      // 推理增量合入时间线：33ms 节流冲刷
      let pendingReasoningDelta = "";
      const flushReasoningDelta = createPreviewThrottler(33, () => {
        if (!pendingReasoningDelta) return;
        const delta = pendingReasoningDelta;
        pendingReasoningDelta = "";
        appendReasoningStepDelta(session.id, delta);
      });

      try {
        const taskResult = await executeInputTask({
          input: content,
          currentMessages: session.messages,
          model: resolvedModelId,
          onPrepareConversation: (preparedMessages) => {
            conversationMessagesForTask = preparedMessages;
            const nextMessages: Message[] = [...preparedMessages, { role: "project", content: "" }];
            setConversationMessagesForSession(sessionId, nextMessages);
            petThoughtId = startPetThought(session.id, preparedMessages);
          },
          signal: abortController.signal,
          systemPrompt,
          knowledgeCollectionId: targetProject?.knowledgeCollectionId ?? null,
          onChunk: (chunk) => {
            if (!isCurrentSessionRun(session.id, runId, abortController)) {
              return;
            }
            streamedProjectReply += chunk;
            streamedFilter.append(chunk);
            updateThoughtPreview();
            updateStreamPreview();
          },
          onReasoning: (reasoning) => {
            if (!isCurrentSessionRun(session.id, runId, abortController)) {
              return;
            }
            streamedReasoning += reasoning;
            pendingReasoningDelta += reasoning;
            flushReasoningDelta();
            updateReasoningPreview();
          },
          onToolStep: (step) => {
            if (!isCurrentSessionRun(session.id, runId, abortController)) {
              return;
            }
            appendLastProjectStep(session.id, step);
          },
          executeTool,
          tools: [...buildChatTools(targetProject), ...listActiveMcpTools()],
          executeToolCall: makeTaskToolExecutor(session.id, taskId, taskWs),
        });

        if (!isCurrentSessionRun(session.id, runId, abortController)) {
          return;
        }

        const conversationMessages = taskResult.conversationMessages ?? conversationMessagesForTask;
        if (!taskResult.finalResult) {
          if (taskResult.status === "aborted") {
            setConversationMessagesForSession(sessionId, (prev) => prev.filter((message, index) => index < conversationMessages.length || message.content));
            clearPetThoughtSession(session.id);
            return;
          }

          setError(taskResult.error || "任务执行失败");
          setConversationMessagesForSession(sessionId, conversationMessages);
          if (isCurrentPetThought(petThoughtId, session.id)) {
            const responseCount = resolvePetThoughtResponseCount(session.id);
            emitPetThought({
              thoughtId: petThoughtId ?? undefined,
              sessionId: session.id,
              sessionTitle: resolvePetThoughtTitle(session.id, conversationMessages),
              previewText: taskResult.error || "回复失败",
              responseCount,
              status: "error",
              updatedAt: Date.now(),
            });
          }
          return;
        }

        const projectReply = resolveProjectReply(taskResult.finalResult?.content, streamedProjectReply, taskResult.toolResult?.outputText, streamedReasoning);
        updateStreamPreview(true);
        updateThoughtPreview(true);
        if (isCurrentPetThought(petThoughtId, session.id)) {
          completePetThought(
            petThoughtId,
            session.id,
            conversationMessages,
            projectReply
          );
        }
        dismissPetThoughtWhenSessionVisible(session.id, petThoughtId);
        finishTaskResult(applyProjectReplyToTaskResult(taskResult, projectReply), session.id, conversationMessages);
      } catch (replyError) {
        if (!isCurrentSessionRun(session.id, runId, abortController)) {
          return;
        }
        if (replyError instanceof DOMException && replyError.name === "AbortError") {
          clearPetThoughtSession(session.id);
          if (watchdogAbortedSessionIdsRef.current.delete(session.id)) {
            setError(`任务执行超时（${RUN_WATCHDOG_MINUTES} 分钟），已自动停止`);
          }
          return;
        }

        const message = replyError instanceof Error ? replyError.message : "发送消息失败";
        setError(message);
        setConversationMessagesForSession(sessionId, conversationMessagesForTask);
        if (isCurrentPetThought(petThoughtId, session.id)) {
          const responseCount = resolvePetThoughtResponseCount(session.id);
          emitPetThought({
            thoughtId: petThoughtId ?? undefined,
            sessionId: session.id,
            sessionTitle: resolvePetThoughtTitle(session.id, conversationMessagesForTask),
            previewText: message,
            responseCount,
            status: "error",
            updatedAt: Date.now(),
          });
        }
      } finally {
        finishSessionRun(session.id, runId, abortController);
        // 统一清理可能残留的空 assistant 占位消息：流式成功时内容已填充不会被误删；
        // 失败/中止时删除占位，避免当前会话或重启后 UI 认为仍在流式中而锁死输入框；
        // 同时把遗留的 running 过渡态步骤定案为 interrupted（中断信息随消息持久化）。
        setConversationMessagesForSession(session.id, (prev) => settleInterruptedSteps(stripPendingPlaceholder(prev)));
      }
    },
    [
      applyProjectReplyToTaskResult,
      clearPetThoughtSession,
      completePetThought,
      executeTool,
      executionModel,
      finishTaskResult,
      finishSessionRun,
      dismissPetThoughtWhenSessionVisible,
      getProjectById,
      getChatSessionById,
      isCurrentSessionRun,
      isCurrentPetThought,
      isSessionLoading,
      resolveProjectSystemPrompt,
      resolvePetThoughtResponseCount,
      resolvePetThoughtTitle,
      setActiveProjectId,
      setActiveChatId,
      setConversationMessagesForSession,
      setLastProjectContent,
      setLastProjectReasoning,
      startSessionRun,
      startPetThought,
      updatePetThought,
    ]
  );

  useEffect(() => {
    if (isCompactWindow || !canUseTauriEvents()) {
      return;
    }

    let unlistenReply: (() => void) | undefined;
    void listen<{ sessionId?: string | null; content?: string }>("omni-pet-thought-reply", (event) => {
      const sessionId = event.payload?.sessionId?.trim();
      const content = event.payload?.content?.trim();
      if (!sessionId || !content) {
        return;
      }

      void handlePetThoughtReply(sessionId, content);
    }).then((cleanup) => {
      unlistenReply = cleanup;
    });

    return () => {
      unlistenReply?.();
    };
  }, [handlePetThoughtReply, isCompactWindow]);

  const handleSend = useCallback(
    async (content: string, images?: string[], options: ChatSendOptions = {}) => {
      if (isSessionLoading(activeChatId)) {
        return;
      }

      const abortController = new AbortController();
      setError(null);
      const hiddenContext = options.hiddenContext;
      const selectedKnowledgeCollectionId = options.knowledgeCollectionId?.trim() || null;
      // let：发送前会落快照，把路径改写成会话产物目录下的快照路径（见下方 try 内）
      let attachments = options.attachments ?? [];

      let sessionId = activeChatId;
      let runId = startSessionRun(sessionId, abortController);
      const taskId = generateTaskId();
      currentTaskIdRef.current.set(sessionId ?? "", taskId);
      const taskWs = getWorkspacePathForSession(sessionId);
      const scopedCurrentMessages = getScopedConversationMessages();
      let conversationMessagesForTask = scopedCurrentMessages;
      let hasPetThought = false;
      let petThoughtId: string | null = null;
      let streamedProjectReply = "";
      const streamedFilter = createStructuredOutputFilter();
      let streamedReasoning = "";
      const updateStreamPreview = createPreviewThrottler(16, () => setLastProjectContent(sessionId, streamedFilter.getVisibleText()));
      const updateThoughtPreview = createPreviewThrottler(66, () => {
        if (!hasPetThought) {
          return;
        }
        updatePetThought(petThoughtId, sessionId, conversationMessagesForTask, streamedFilter.getVisibleText());
      });
      const updateReasoningPreview = createPreviewThrottler(33, () => setLastProjectReasoning(sessionId, streamedReasoning));
      // 推理增量合入时间线：sessionId 可能在 onPrepareConversation 中才确定，闭包读取当时的值
      let pendingReasoningDelta = "";
      const flushReasoningDelta = createPreviewThrottler(33, () => {
        if (!pendingReasoningDelta) return;
        const delta = pendingReasoningDelta;
        pendingReasoningDelta = "";
        appendReasoningStepDelta(sessionId, delta);
      });

      try {
        // 发送前把附件复制一份到会话产物目录（快照）。
        // 此前附件只存原始绝对路径，用户移动/重命名/删除原文件后，模型回看历史消息时
        // /read_file 就读不到了。落快照后路径恒定；图片是 base64 内联进消息体，本就不受此影响。
        if (attachments.length > 0) {
          // 快照目录按「会话」分桶，因此全新会话要先建会话拿到 id（已有会话不会重复创建）。
          // 注意：getChatSessionById 读的是闭包里的 chatSessions，新建会话的同一次 tick 内读不到
          // （ref 要等 effect 才同步），所以新会话直接用 createSessionFromMessages 的返回值。
          let snapshotProjectTitle = activeProject?.title;
          if (sessionId) {
            const existingSession = getChatSessionById(sessionId);
            if (existingSession?.projectId) {
              snapshotProjectTitle = getProjectById(existingSession.projectId)?.title ?? snapshotProjectTitle;
            }
          } else {
            const draftSession = createSessionFromMessages(
              [...scopedCurrentMessages, { role: "user" as const, content, images, attachments }],
              activeProject?.id ?? undefined
            );
            sessionId = draftSession.id;
            runId = startSessionRun(sessionId, abortController);
            currentTaskIdRef.current.set(sessionId, taskId);
          }
          attachments = await snapshotAttachments(attachments, {
            projectTitle: snapshotProjectTitle,
            sessionId,
          });
          // 上传的附件登记为产物：出现在右侧「产物」面板，点击即可内嵌预览。
          // 按快照路径去重——同一会话重复发送同一文件不重复建卡。
          const existingPaths = new Set(
            loadArtifacts()
              .filter((a) => a.sessionId === sessionId)
              .map((a) => a.path)
          );
          let artifactsDirty = false;
          for (const attachment of attachments) {
            if (!attachment.path || existingPaths.has(attachment.path)) continue;
            appendArtifact({
              type: "file",
              title: attachment.name,
              path: attachment.path,
              size: attachment.size,
              projectId: activeProject?.id ?? NO_PROJECT_ARTIFACT_KEY,
              sessionId,
            });
            existingPaths.add(attachment.path);
            artifactsDirty = true;
          }
          if (artifactsDirty) notifyArtifactsChanged();
        }
        const attachmentContext = buildAttachmentContext(attachments);
        const taskResult = await executeInputTask({
          input: content,
          images,
          hiddenContext: [hiddenContext, attachmentContext].filter(Boolean).join("\n\n") || undefined,
          attachments,
          currentMessages: scopedCurrentMessages,
          model: executionModel,
          onPrepareConversation: (preparedMessages) => {
            conversationMessagesForTask = preparedMessages;
            if (!sessionId) {
              const nextSession = createSessionFromMessages(preparedMessages, activeProject?.id ?? undefined);
              sessionId = nextSession.id;
              runId = startSessionRun(sessionId, abortController);
              currentTaskIdRef.current.set(sessionId, taskId);
            }
            setConversationMessagesForSession(sessionId, [...preparedMessages, { role: "project", content: "" }]);
            petThoughtId = startPetThought(sessionId, preparedMessages);
            hasPetThought = true;
          },
          signal: abortController.signal,
          systemPrompt: [projectSystemPrompt, hiddenContext?.trim()].filter(Boolean).join("\n\n") || undefined,
          knowledgeCollectionId: selectedKnowledgeCollectionId ?? activeProject?.knowledgeCollectionId ?? null,
          onChunk: (chunk) => {
            if (!isCurrentSessionRun(sessionId, runId, abortController)) {
              return;
            }
            streamedProjectReply += chunk;
            streamedFilter.append(chunk);
            updateThoughtPreview();
            updateStreamPreview();
          },
          onReasoning: (reasoning) => {
            if (!isCurrentSessionRun(sessionId, runId, abortController)) {
              return;
            }
            streamedReasoning += reasoning;
            pendingReasoningDelta += reasoning;
            flushReasoningDelta();
            updateReasoningPreview();
          },
          onToolStep: (step) => {
            if (!isCurrentSessionRun(sessionId, runId, abortController)) {
              return;
            }
            appendLastProjectStep(sessionId, step);
          },
          executeTool,
          tools: [...buildChatTools(activeProject), ...listActiveMcpTools()],
          executeToolCall: makeTaskToolExecutor(sessionId, taskId, taskWs),
        });

        if (!isCurrentSessionRun(sessionId, runId, abortController)) {
          return;
        }

        if (taskResult.intent === "local_command") {
          lastTaskResultRef.current = taskResult;
          setLatestTaskResult(taskResult);
          setTaskRuntimeState((current) => ({
            activeTask: taskResult,
            history: [taskResult, ...current.history.filter((item) => item.taskId !== taskResult.taskId)].slice(0, 12),
          }));
          if (taskResult.status === "failed") {
            setError(taskResult.error || "工具执行失败");
          }
          if (taskResult.toolResult?.outputText) {
            setConversationMessagesForSession(sessionId, [...scopedCurrentMessages, { role: "project", content: taskResult.toolResult.outputText }]);
          }
          return;
        }

        const conversationMessages = taskResult.conversationMessages ?? conversationMessagesForTask;
        if (!taskResult.finalResult) {
          if (taskResult.status === "aborted") {
            setConversationMessagesForSession(sessionId, (prev) => prev.filter((message, index) => index < conversationMessages.length || message.content));
            if (hasPetThought) {
              clearPetThoughtSession(sessionId);
            }
            return;
          }

          setError(taskResult.error || "任务执行失败");
          setConversationMessagesForSession(sessionId, conversationMessages);
          if (hasPetThought && isCurrentPetThought(petThoughtId, sessionId)) {
            const responseCount = resolvePetThoughtResponseCount(sessionId);
            emitPetThought({
              thoughtId: petThoughtId ?? undefined,
              sessionId: sessionId ?? null,
              sessionTitle: resolvePetThoughtTitle(sessionId, conversationMessages),
              previewText: "",
              responseCount,
              status: "error",
              updatedAt: Date.now(),
            });
          }
          return;
        }

        const projectReply = resolveProjectReply(taskResult.finalResult?.content, streamedProjectReply, taskResult.toolResult?.outputText, streamedReasoning);
        updateStreamPreview(true);
        updateThoughtPreview(true);
        if (hasPetThought && isCurrentPetThought(petThoughtId, sessionId)) {
          completePetThought(
            petThoughtId,
            sessionId,
            conversationMessages,
            projectReply
          );
        }
        dismissPetThoughtWhenSessionVisible(sessionId, petThoughtId);
        finishTaskResult(applyProjectReplyToTaskResult(taskResult, projectReply), sessionId, conversationMessages);
      } catch (sendError) {
        if (!isCurrentSessionRun(sessionId, runId, abortController)) {
          return;
        }
        if (sendError instanceof DOMException && sendError.name === "AbortError") {
          if (hasPetThought) {
            clearPetThoughtSession(sessionId);
          }
          if (sessionId && watchdogAbortedSessionIdsRef.current.delete(sessionId)) {
            setError(`任务执行超时（${RUN_WATCHDOG_MINUTES} 分钟），已自动停止`);
          }
          return;
        }
        setError(sendError instanceof Error ? sendError.message : "发送消息失败");
        if (hasPetThought) {
          const responseCount = resolvePetThoughtResponseCount(sessionId);
          emitPetThought({
            thoughtId: petThoughtId ?? undefined,
            sessionId: sessionId ?? null,
            sessionTitle: resolvePetThoughtTitle(sessionId, conversationMessagesForTask),
            previewText: "",
            responseCount,
            status: "error",
            updatedAt: Date.now(),
          });
        }
      } finally {
        finishSessionRun(sessionId, runId, abortController);
        // 统一清理可能残留的空 assistant 占位消息：流式成功时内容已填充不会被误删；
        // 失败/中止时删除占位，避免当前会话或重启后 UI 认为仍在流式中而锁死输入框；
        // 同时把遗留的 running 过渡态步骤定案为 interrupted（中断信息随消息持久化）。
        setConversationMessagesForSession(sessionId, (prev) => settleInterruptedSteps(stripPendingPlaceholder(prev)));
      }
    },
    [
      activeProject?.id,
      activeProject?.knowledgeCollectionId,
      activeChatId,
      applyProjectReplyToTaskResult,
      projectSystemPrompt,
      clearPetThoughtSession,
      completePetThought,
      createSessionFromMessages,
      emitPetThought,
      executeTool,
      executionModel,
      finishTaskResult,
      finishSessionRun,
      dismissPetThoughtWhenSessionVisible,
      getScopedConversationMessages,
      isCurrentSessionRun,
      isCurrentPetThought,
      isSessionLoading,
      resolvePetThoughtResponseCount,
      resolvePetThoughtTitle,
      setConversationMessagesForSession,
      setLastProjectContent,
      setLastProjectReasoning,
      startSessionRun,
      startPetThought,
      updatePetThought,
    ]
  );

  const handleStop = useCallback(() => {
    if (!activeChatId) {
      return;
    }
    const abortController = abortControllersRef.current.get(activeChatId);
    abortController?.abort();
    abortControllersRef.current.delete(activeChatId);
    // 清理看门狗，避免 20 分钟后再次触发 abort 并弹出“任务执行超时”误导提示
    const watchdog = runWatchdogRef.current.get(activeChatId);
    if (watchdog) {
      clearTimeout(watchdog);
      runWatchdogRef.current.delete(activeChatId);
    }
    // 如果流式请求已插入空 assistant 占位但尚未产出内容，手动停止后必须清理它，
    // 否则 App.tsx 的 hasPendingProjectPlaceholder 会让 UI 一直判定为“正在生成”，
    // 导致输入框禁用、思考框不收起、停止按钮不消失。
    // 若部分消息已有内容/步骤，则把遗留的 running 过渡态步骤定案为 interrupted，
    // 时间线不再无限转圈（渲染为「已中断」），该状态随消息持久化。
    setConversationMessagesForSession(activeChatId, (prev) => settleInterruptedSteps(stripPendingPlaceholder(prev)));
    setSessionLoading(activeChatId, false);
  }, [activeChatId, setConversationMessagesForSession, setSessionLoading]);

  const handleEditUserMessage = useCallback(
    (messageIndex: number) => {
      if (isSessionLoading(activeChatId)) {
        return;
      }
      const scopedMessages = getScopedConversationMessages();
      const targetMessage = scopedMessages[messageIndex];
      if (!targetMessage || targetMessage.role !== "user") {
        return;
      }
      setEditingMessageIndex(messageIndex);
      setError(null);
    },
    [activeChatId, getScopedConversationMessages, isSessionLoading]
  );

  const handleCancelEditUserMessage = useCallback(() => {
    setEditingMessageIndex(null);
  }, []);

  const handleSubmitEditedUserMessage = useCallback(
    async (messageIndex: number, content: string) => {
      if (isSessionLoading(activeChatId)) {
        return;
      }
      const scopedMessages = getScopedConversationMessages();
      const targetMessage = scopedMessages[messageIndex];
      if (!targetMessage || targetMessage.role !== "user" || !content.trim()) {
        return;
      }
      const conversationMessages = [...scopedMessages.slice(0, messageIndex), { ...targetMessage, content: content.trim() }];
      setEditingMessageIndex(null);
      await runConversationTurn(conversationMessages, { sessionId: activeChatId });
    },
    [activeChatId, getScopedConversationMessages, isSessionLoading, runConversationTurn]
  );

  const handleRegenerateMessage = useCallback(
    async (messageIndex: number) => {
      if (isSessionLoading(activeChatId)) {
        return;
      }
      const scopedMessages = getScopedConversationMessages();
      const targetMessage = scopedMessages[messageIndex];
      if (!targetMessage || targetMessage.role !== "project") {
        return;
      }
      const conversationMessages = scopedMessages.slice(0, messageIndex);
      if (!conversationMessages.some((message) => message.role === "user")) {
        return;
      }
      await runConversationTurn(conversationMessages, { sessionId: activeChatId });
    },
    [activeChatId, getScopedConversationMessages, isSessionLoading, runConversationTurn]
  );

  const handleClearChat = useCallback(() => {
    setMessages([]);
    setError(null);
    setEditingMessageIndex(null);
  }, [setMessages]);

  const handleUseEmptyPrompt = useCallback(
    (prompt: string) => {
      setInputDraft(prompt);
      setInputDraftImages([]);
      setInputDraftKey((value) => value + 1);
    },
    [setInputDraft, setInputDraftImages, setInputDraftKey]
  );

  const handleNewChat = useCallback(() => {
    createSessionFromMessages([], activeProject?.id ?? undefined);
    setMessages([]);
    setInputDraft("");
    setInputDraftImages([]);
    setInputDraftKey((value) => value + 1);
    setError(null);
    setOpenChatMenu(null);
    setEditingMessageIndex(null);
  }, [activeProject?.id, createSessionFromMessages, setEditingMessageIndex, setError, setInputDraft, setInputDraftImages, setInputDraftKey, setMessages, setOpenChatMenu]);

  return {
    editingMessageIndex,
    error,
    handleCancelEditUserMessage,
    handleClearChat,
    handleEditUserMessage,
    handleNewChat,
    handleRegenerateMessage,
    handleSend,
    handleStop,
    handleSubmitEditedUserMessage,
    handleUseEmptyPrompt,
    isLoading,
    loadingSessionIds,
    latestTaskResult,
    taskRuntimeState,
    lastTaskResultRef,
    runConversationTurn,
    setEditingMessageIndex,
    setError,
    loadingSessionId,
  };
}
