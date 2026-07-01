import { useCallback, useEffect, useRef, useState } from "react";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import type { Message, ModelConfig } from "../adapters/types";
import { loadProviderConfigs, modelRegistry } from "../adapters/registry";
import { isMainWindowUserVisible } from "../app/window";
import { COMPACT_WINDOW_LABEL, CURRENT_MODEL_STORAGE_KEY, MAIN_WINDOW_LABEL, PET_THOUGHT_WINDOW_LABEL } from "../app/constants";
import { readSqliteBackedValue } from "../app/sqliteStorage";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { executeInputTask, executeTask } from "../chat/taskExecutor";
import { resolveCurrentModelId, resolveExecutionModelId } from "../chat/modelSelection";
import { getInitialTaskHistory, saveTaskHistory } from "../chat/taskStorage";
import { getChatSessionTitle } from "../chat/storage";
import { executeLocalTool } from "../chat/localTools";
import type { TaskExecutionResult, TaskRuntimeState } from "../chat/taskTypes";
import type { AssistantMemorySourceType, AssistantProfile, ChatExecutionResult } from "../chat/types";
import type { AssistantMemoryRecord, SessionSummaryRecord } from "../chat/types";
import { getToolManifestById } from "../config/manifests/tools";
import type { PetThoughtState } from "../app/types";
import type { ViewMode } from "../app/types";
import { getPetThoughtKey, matchesPetThought } from "../app/petThoughts";

type SessionLite = {
  id: string;
  assistantId?: string;
  title: string;
  messages: Message[];
};

type UseChatRuntimeArgs = {
  activeChatId: string | null;
  activeAssistant: AssistantProfile | null;
  availableModels: ModelConfig[];
  messages: Message[];
  addAssistantMemory: (assistantId: string, content: string, sourceSessionId?: string | null, sourceType?: AssistantMemorySourceType) => boolean;
  applyUsageToSession: (sessionId: string, result: ChatExecutionResult, conversationMessages: Message[]) => void;
  commitAssistantMemory: (sessionId: string, conversationMessages: Message[], result: ChatExecutionResult) => void;
  createSessionFromMessages: (conversationMessages: Message[], assistantId?: string) => { id: string };
  currentModel: string;
  getAssistantById: (assistantId: string) => AssistantProfile | null;
  getChatSessionById: (sessionId: string) => SessionLite | null;
  getRelatedContextForAssistant: (query: string) => {
    summaries: SessionSummaryRecord[];
    memories: AssistantMemoryRecord[];
  };
  handleModelChange: (modelId: string) => void;
  renameChatSession: (sessionId: string, title: string) => boolean;
  searchChatSessions: (query: string) => SessionLite[];
  setActiveAssistantId: React.Dispatch<React.SetStateAction<string>>;
  setActiveChatId: React.Dispatch<React.SetStateAction<string | null>>;
  setInputDraft: React.Dispatch<React.SetStateAction<string>>;
  setInputDraftImages: React.Dispatch<React.SetStateAction<string[]>>;
  setInputDraftKey: React.Dispatch<React.SetStateAction<number>>;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setOpenChatMenu: React.Dispatch<React.SetStateAction<{ id: string; x: number; y: number } | null>>;
  togglePinnedChatSession: (sessionId: string) => boolean;
  updateAssistantProfile: (assistantId: string, patch: Partial<AssistantProfile>) => AssistantProfile | null;
  updateChatSessionMessages: (sessionId: string, nextMessages: Message[] | ((current: Message[]) => Message[])) => void;
  isCompactWindow: boolean;
  view: ViewMode;
};

function resolveEnabledToolNames(assistant: AssistantProfile | null) {
  if (!assistant) {
    return [];
  }
  return assistant.allowedToolIds
    .map((toolId) => getToolManifestById(toolId)?.title)
    .filter((title): title is string => Boolean(title));
}

const SILENT_LOCAL_TOOL_IDS = new Set([
  "model",
  "pet",
]);

const PET_THOUGHT_QUEUE_LIMIT = 12;
const PET_THOUGHT_DISMISS_DELAY_MS = 900;

type PetThoughtSyncRequestPayload = {
  requesterLabel?: string;
  requestId?: string;
};

type PetThoughtSyncResponsePayload = {
  requestId?: string;
  queue: PetThoughtState[];
  currentThought: PetThoughtState | null;
};

function createPreviewThrottler(intervalMs: number, update: () => void) {
  let lastUpdateAt = 0;
  return (force = false) => {
    const now = performance.now();
    if (!force && now - lastUpdateAt < intervalMs) {
      return;
    }
    lastUpdateAt = now;
    update();
  };
}

function canUseTauriEvents() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function safelyEmitPetThoughtEvent(event: string, payload: unknown) {
  if (!canUseTauriEvents()) {
    return;
  }

  try {
    void emit(event, payload).catch(() => undefined);
  } catch {
    // Pet bubble sync must never interrupt the model response stream.
  }
}

function safelyEmitPetThoughtEventTo(windowLabel: string, event: string, payload: unknown) {
  if (!canUseTauriEvents()) {
    return;
  }

  try {
    void emitTo(windowLabel, event, payload).catch(() => undefined);
  } catch {
    // A missing/closing auxiliary window should not affect chat execution.
  }
}

export function useChatRuntime({
  activeChatId,
  activeAssistant,
  availableModels,
  messages,
  addAssistantMemory,
  applyUsageToSession,
  commitAssistantMemory,
  createSessionFromMessages,
  currentModel,
  getAssistantById,
  getChatSessionById,
  getRelatedContextForAssistant,
  handleModelChange,
  renameChatSession,
  searchChatSessions,
  setActiveAssistantId,
  setActiveChatId,
  setInputDraft,
  setInputDraftImages,
  setInputDraftKey,
  setMessages,
  setOpenChatMenu,
  togglePinnedChatSession,
  updateAssistantProfile,
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
  const lastTaskResultRef = useRef<TaskExecutionResult | null>(null);
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

  const setLastAssistantContent = useCallback(
    (sessionId: string | null | undefined, content: string) => {
      const updateLastAssistant = (prev: Message[]) => {
        if (prev.length === 0) {
          return prev;
        }
        const lastIdx = prev.length - 1;
        const lastMessage = prev[lastIdx];
        if (lastMessage.role !== "assistant") {
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
        updateChatSessionMessages(sessionId, updateLastAssistant);
        return;
      }

      setMessages(updateLastAssistant);
    },
    [setMessages, updateChatSessionMessages]
  );

  const executionModel = resolveExecutionModelId({
    assistantModelId: activeAssistant?.defaultModelId,
    currentModelId: currentModel,
    availableModels,
  });
  const assistantSystemPrompt = activeAssistant?.systemPrompt?.trim() ? activeAssistant.systemPrompt.trim() : undefined;

  const getScopedConversationMessages = useCallback(() => {
    if (!activeChatId) {
      return messages;
    }

    const session = getChatSessionById(activeChatId);
    if (!session) {
      return messages;
    }

    if (activeAssistant?.id && session.assistantId && session.assistantId !== activeAssistant.id) {
      return [] as Message[];
    }

    // Use the visible pane messages as the source of truth to avoid
    // stale-session races right after switching/creating conversations.
    return messages;
  }, [activeAssistant?.id, activeChatId, getChatSessionById, messages]);

  const resolveAssistantSystemPrompt = useCallback(
    (assistantOverride?: AssistantProfile | null) => {
      const targetAssistant = assistantOverride ?? activeAssistant;
      return targetAssistant?.systemPrompt?.trim() ? targetAssistant.systemPrompt.trim() : undefined;
    },
    [activeAssistant]
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

      return activeAssistant?.kind === "basic" ? "Omni" : activeAssistant?.title?.trim() || "Omni";
    },
    [activeAssistant?.kind, activeAssistant?.title, getChatSessionById]
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
        setConversationMessagesForSession(sessionId, [
          ...conversationMessages,
          {
            role: "assistant",
            content: taskResult.finalResult.content,
            knowledgeContext: taskResult.finalResult.knowledgeContext ?? null,
          },
        ]);
        if (sessionId) {
          applyUsageToSession(sessionId, taskResult.finalResult, conversationMessages);
          commitAssistantMemory(sessionId, conversationMessages, taskResult.finalResult);
        }
        return;
      }

      if (taskResult.toolResult?.outputText) {
        setConversationMessagesForSession(sessionId, [...conversationMessages, { role: "assistant", content: taskResult.toolResult.outputText }]);
      }

      if (taskResult.status === "failed") {
        setError(taskResult.error || "任务执行失败");
      }
    },
    [applyUsageToSession, commitAssistantMemory, setConversationMessagesForSession]
  );

  const applyAssistantReplyToTaskResult = useCallback((taskResult: TaskExecutionResult, assistantReply: string): TaskExecutionResult => {
    if (!taskResult.finalResult) {
      return taskResult;
    }
    return {
      ...taskResult,
      finalResult: {
        ...taskResult.finalResult,
        content: assistantReply,
      },
    };
  }, []);

  const runConversationTurn = useCallback(
    async (
      conversationMessages: Message[],
      options: { sessionId?: string | null; createSession?: boolean; hiddenContext?: string; assistantOverride?: AssistantProfile | null } = {}
    ) => {
      let sessionId = options.sessionId ?? activeChatId;
      if (!sessionId && options.createSession) {
        const nextSession = createSessionFromMessages(conversationMessages, options.assistantOverride?.id ?? activeAssistant?.id ?? undefined);
        sessionId = nextSession.id;
      }

      const abortController = new AbortController();
      const runId = startSessionRun(sessionId, abortController);
      const petThoughtId = startPetThought(sessionId, conversationMessages);
      const executionAssistant = options.assistantOverride ?? activeAssistant;
      const systemPrompt = resolveAssistantSystemPrompt(options.assistantOverride);
      const knowledgeCollectionId = executionAssistant?.knowledgeCollectionId ?? null;
      const latestUserQuery = [...conversationMessages].reverse().find((message) => message.role === "user")?.content ?? "";
      const relatedContext = getRelatedContextForAssistant(latestUserQuery);
      let streamedAssistantReply = "";
      let visibleStreamedAssistantReply = "";
      let isStructuredOutputStreaming = false;
      const updateStreamPreview = createPreviewThrottler(16, () => setLastAssistantContent(sessionId, visibleStreamedAssistantReply));
      const updateThoughtPreview = createPreviewThrottler(66, () => updatePetThought(petThoughtId, sessionId, conversationMessages, visibleStreamedAssistantReply));

      setConversationMessagesForSession(sessionId, [...conversationMessages, { role: "assistant", content: "" }]);
      setError(null);

      try {
        if (!executionModel) {
          throw new Error("请先在设置中配置一个可用模型");
        }

        const taskResult = await executeTask({
          model: executionModel,
          messages: conversationMessages,
          signal: abortController.signal,
          systemPrompt: [systemPrompt, options.hiddenContext?.trim()].filter(Boolean).join("\n\n") || undefined,
          assistant: executionAssistant,
          relatedContext,
          enabledToolNames: resolveEnabledToolNames(executionAssistant),
          knowledgeCollectionId,
          onChunk: (chunk) => {
            if (!isCurrentSessionRun(sessionId, runId, abortController)) {
              return;
            }
            streamedAssistantReply += chunk;
            if (!isStructuredOutputStreaming) {
              const nextVisible = `${visibleStreamedAssistantReply}${chunk}`;
              const structuredStart = nextVisible.search(/<omni_(memory|summary)>/i);
              if (structuredStart >= 0) {
                visibleStreamedAssistantReply = nextVisible.slice(0, structuredStart).trimEnd();
                isStructuredOutputStreaming = true;
              } else {
                visibleStreamedAssistantReply = nextVisible;
              }
              updateThoughtPreview();
              updateStreamPreview();
            }
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

        const assistantReply = taskResult.finalResult?.content || streamedAssistantReply || taskResult.toolResult?.outputText || "";
        updateStreamPreview(true);
        updateThoughtPreview(true);
        completePetThought(
          petThoughtId,
          sessionId,
          conversationMessages,
          assistantReply
        );
        dismissPetThoughtWhenSessionVisible(sessionId, petThoughtId);
        finishTaskResult(applyAssistantReplyToTaskResult(taskResult, assistantReply), sessionId, conversationMessages);
        return;
      } catch (runError) {
        if (!isCurrentSessionRun(sessionId, runId, abortController)) {
          return;
        }
        if (runError instanceof DOMException && runError.name === "AbortError") {
          setConversationMessagesForSession(sessionId, (prev) => prev.filter((message, index) => index < conversationMessages.length || message.content));
          clearPetThoughtSession(sessionId);
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
      }
    },
    [
      activeAssistant?.id,
      activeAssistant?.knowledgeCollectionId,
      activeChatId,
      applyAssistantReplyToTaskResult,
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
      resolveAssistantSystemPrompt,
      setConversationMessagesForSession,
      setLastAssistantContent,
      startSessionRun,
      startPetThought,
      updatePetThought,
    ]
  );

  const executeTool = useCallback(
    async (command: { command: string; args: string }) => {
      return executeLocalTool({
        activeAssistant,
        activeChatId,
        addAssistantMemory,
        availableModels,
        getChatSessionById,
        handleModelChange,
        renameChatSession,
        searchChatSessions,
        setActiveChatId,
        setEditingMessageIndex,
        setError,
        setMessages,
        setOpenChatMenu,
        togglePinnedChatSession,
        updateAssistantProfile,
      }, command);
    },
    [
      activeAssistant,
      activeChatId,
      addAssistantMemory,
      availableModels,
      getChatSessionById,
      handleModelChange,
      renameChatSession,
      searchChatSessions,
      setActiveChatId,
      setEditingMessageIndex,
      setMessages,
      setOpenChatMenu,
      togglePinnedChatSession,
      updateAssistantProfile,
    ]
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

      const targetAssistant = session.assistantId ? getAssistantById(session.assistantId) : null;
      const systemPrompt = resolveAssistantSystemPrompt(targetAssistant);
      if (targetAssistant) {
        setActiveAssistantId(targetAssistant.id);
      }
      setActiveChatId(session.id);
      // Keep the visible chat pane aligned with the replied session immediately.
      setMessages(session.messages);
      try {
        await loadProviderConfigs();
      } catch {
        // Keep fallback model resolution below; reply should not fail on config hydration glitches.
      }

      const preferredAssistantModelId = targetAssistant?.defaultModelId?.trim() ?? "";
      const resolvedModelId =
        resolveExecutionModelId({
          assistantModelId: preferredAssistantModelId,
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
      setError(null);

      let conversationMessagesForTask = session.messages;
      let petThoughtId: string | null = null;
      let streamedAssistantReply = "";
      const updateStreamPreview = createPreviewThrottler(16, () => setLastAssistantContent(session.id, streamedAssistantReply));
      const updateThoughtPreview = createPreviewThrottler(66, () => updatePetThought(petThoughtId, session.id, conversationMessagesForTask, streamedAssistantReply));

      try {
        const taskResult = await executeInputTask({
          input: content,
          currentMessages: session.messages,
          model: resolvedModelId,
          onPrepareConversation: (preparedMessages) => {
            conversationMessagesForTask = preparedMessages;
            const nextMessages: Message[] = [...preparedMessages, { role: "assistant", content: "" }];
            setConversationMessagesForSession(sessionId, nextMessages);
            petThoughtId = startPetThought(session.id, preparedMessages);
          },
          signal: abortController.signal,
          systemPrompt,
          knowledgeCollectionId: targetAssistant?.knowledgeCollectionId ?? null,
          onChunk: (chunk) => {
            if (!isCurrentSessionRun(session.id, runId, abortController)) {
              return;
            }
            streamedAssistantReply += chunk;
            updateThoughtPreview();
            updateStreamPreview();
          },
          executeTool,
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

        const assistantReply = taskResult.finalResult?.content || streamedAssistantReply || taskResult.toolResult?.outputText || "";
        updateStreamPreview(true);
        updateThoughtPreview(true);
        if (isCurrentPetThought(petThoughtId, session.id)) {
          completePetThought(
            petThoughtId,
            session.id,
            conversationMessages,
            assistantReply
          );
        }
        dismissPetThoughtWhenSessionVisible(session.id, petThoughtId);
        finishTaskResult(applyAssistantReplyToTaskResult(taskResult, assistantReply), session.id, conversationMessages);
      } catch (replyError) {
        if (!isCurrentSessionRun(session.id, runId, abortController)) {
          return;
        }
        if (replyError instanceof DOMException && replyError.name === "AbortError") {
          clearPetThoughtSession(session.id);
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
      }
    },
    [
      applyAssistantReplyToTaskResult,
      clearPetThoughtSession,
      completePetThought,
      executeTool,
      executionModel,
      finishTaskResult,
      finishSessionRun,
      dismissPetThoughtWhenSessionVisible,
      getAssistantById,
      getChatSessionById,
      isCurrentSessionRun,
      isCurrentPetThought,
      isSessionLoading,
      resolveAssistantSystemPrompt,
      resolvePetThoughtResponseCount,
      resolvePetThoughtTitle,
      setActiveAssistantId,
      setActiveChatId,
      setConversationMessagesForSession,
      setLastAssistantContent,
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
    async (content: string, images?: string[], hiddenContext?: string) => {
      if (isSessionLoading(activeChatId)) {
        return;
      }

      const abortController = new AbortController();
      setError(null);

      let sessionId = activeChatId;
      let runId = startSessionRun(sessionId, abortController);
      const scopedCurrentMessages = getScopedConversationMessages();
      let conversationMessagesForTask = scopedCurrentMessages;
      let hasPetThought = false;
      let petThoughtId: string | null = null;
      let streamedAssistantReply = "";
      const updateStreamPreview = createPreviewThrottler(16, () => setLastAssistantContent(sessionId, streamedAssistantReply));
      const updateThoughtPreview = createPreviewThrottler(66, () => {
        if (!hasPetThought) {
          return;
        }
        updatePetThought(petThoughtId, sessionId, conversationMessagesForTask, streamedAssistantReply);
      });

      try {
        const taskResult = await executeInputTask({
          input: content,
          images,
          hiddenContext,
          currentMessages: scopedCurrentMessages,
          model: executionModel,
          onPrepareConversation: (preparedMessages) => {
            conversationMessagesForTask = preparedMessages;
            if (!sessionId) {
              const nextSession = createSessionFromMessages(preparedMessages, activeAssistant?.id ?? undefined);
              sessionId = nextSession.id;
              runId = startSessionRun(sessionId, abortController);
            }
            setConversationMessagesForSession(sessionId, [...preparedMessages, { role: "assistant", content: "" }]);
            petThoughtId = startPetThought(sessionId, preparedMessages);
            hasPetThought = true;
          },
          signal: abortController.signal,
          systemPrompt: [assistantSystemPrompt, hiddenContext?.trim()].filter(Boolean).join("\n\n") || undefined,
          knowledgeCollectionId: activeAssistant?.knowledgeCollectionId ?? null,
          onChunk: (chunk) => {
            if (!isCurrentSessionRun(sessionId, runId, abortController)) {
              return;
            }
            streamedAssistantReply += chunk;
            updateThoughtPreview();
            updateStreamPreview();
          },
          executeTool,
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
          const localCommandToolId = taskResult.plan.metadata?.toolId;
          if (taskResult.toolResult?.outputText && !SILENT_LOCAL_TOOL_IDS.has(String(localCommandToolId || ""))) {
            setConversationMessagesForSession(sessionId, [...scopedCurrentMessages, { role: "assistant", content: taskResult.toolResult.outputText }]);
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

        const assistantReply = taskResult.finalResult?.content || streamedAssistantReply || taskResult.toolResult?.outputText || "";
        updateStreamPreview(true);
        updateThoughtPreview(true);
        if (hasPetThought && isCurrentPetThought(petThoughtId, sessionId)) {
          completePetThought(
            petThoughtId,
            sessionId,
            conversationMessages,
            assistantReply
          );
        }
        dismissPetThoughtWhenSessionVisible(sessionId, petThoughtId);
        finishTaskResult(applyAssistantReplyToTaskResult(taskResult, assistantReply), sessionId, conversationMessages);
      } catch (sendError) {
        if (!isCurrentSessionRun(sessionId, runId, abortController)) {
          return;
        }
        if (sendError instanceof DOMException && sendError.name === "AbortError") {
          if (hasPetThought) {
            clearPetThoughtSession(sessionId);
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
      }
    },
    [
      activeAssistant?.id,
      activeAssistant?.knowledgeCollectionId,
      activeChatId,
      applyAssistantReplyToTaskResult,
      assistantSystemPrompt,
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
      setLastAssistantContent,
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
    setSessionLoading(activeChatId, false);
  }, [activeChatId, setSessionLoading]);

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
      if (!targetMessage || targetMessage.role !== "assistant") {
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
    createSessionFromMessages([], activeAssistant?.id ?? undefined);
    setMessages([]);
    setInputDraft("");
    setInputDraftImages([]);
    setInputDraftKey((value) => value + 1);
    setError(null);
    setOpenChatMenu(null);
    setEditingMessageIndex(null);
  }, [activeAssistant?.id, createSessionFromMessages, setEditingMessageIndex, setError, setInputDraft, setInputDraftImages, setInputDraftKey, setMessages, setOpenChatMenu]);

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
