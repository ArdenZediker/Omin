import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import type { Message, ModelConfig } from "../adapters/types";
import { loadProviderConfigs, modelRegistry } from "../adapters/registry";
import { showCompactWindow, showSettingsWindow } from "../app/window";
import { COMPACT_WINDOW_LABEL, CURRENT_MODEL_STORAGE_KEY, PET_THOUGHT_WINDOW_LABEL } from "../app/constants";
import { getPetWindowScale } from "../app/compactPetScale";
import { isCompactPetHidden, setCompactPetHidden } from "../app/compactVisibility";
import { readSqliteBackedValue, saveSqliteBackedValue } from "../app/sqliteStorage";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { executeInputTask, executeTask } from "../chat/taskExecutor";
import { getInitialTaskHistory, saveTaskHistory } from "../chat/taskStorage";
import { getChatSessionTitle } from "../chat/storage";
import { ToolRegistry } from "../chat/toolRegistry";
import type { TaskExecutionResult, TaskRuntimeState } from "../chat/taskTypes";
import type { AssistantProfile, ChatExecutionResult } from "../chat/types";
import { getToolManifestById } from "../config/manifests/tools";
import type { PetThoughtState } from "../app/types";
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
  applyUsageToSession: (sessionId: string, result: ChatExecutionResult, conversationMessages: Message[]) => void;
  commitAssistantMemory: (sessionId: string, conversationMessages: Message[], assistantReply: string) => void;
  createSessionFromMessages: (conversationMessages: Message[], assistantId?: string) => { id: string };
  currentModel: string;
  getAssistantById: (assistantId: string) => AssistantProfile | null;
  getChatSessionById: (sessionId: string) => SessionLite | null;
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
  updateChatSessionMessages: (sessionId: string, nextMessages: Message[] | ((current: Message[]) => Message[])) => void;
  isCompactWindow: boolean;
};

function requireTool(id: string) {
  const manifest = getToolManifestById(id);
  if (!manifest?.command) {
    throw new Error(`缺少工具定义: ${id}`);
  }
  return manifest as typeof manifest & { command: string };
}

const ALWAYS_ALLOWED_LOCAL_TOOL_IDS = new Set([
  "new",
  "clear",
  "settings",
  "pet",
  "model",
  "rename",
  "pin",
]);

const SILENT_LOCAL_TOOL_IDS = new Set([
  "pet",
]);

const PET_THOUGHT_QUEUE_LIMIT = 12;

type PetThoughtSyncRequestPayload = {
  requesterLabel?: string;
  requestId?: string;
};

type PetThoughtSyncResponsePayload = {
  requestId?: string;
  queue: PetThoughtState[];
  currentThought: PetThoughtState | null;
};

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
  applyUsageToSession,
  commitAssistantMemory,
  createSessionFromMessages,
  currentModel,
  getAssistantById,
  getChatSessionById,
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
  updateChatSessionMessages,
  isCompactWindow,
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
  const toolRegistryRef = useRef<ToolRegistry | null>(null);
  const petThoughtRef = useRef<PetThoughtState | null>(null);
  const petThoughtQueueRef = useRef<PetThoughtState[]>([]);
  const activePetThoughtIdRef = useRef<string | null>(null);
  const pendingPetThoughtSessionIdsRef = useRef<Set<string>>(new Set());
  const petThoughtClearTimerRef = useRef<number | null>(null);
  const petThoughtBroadcastFrameRef = useRef<number | null>(null);
  const isLoading = loadingSessionIds.length > 0;
  const loadingSessionId = loadingSessionIds[0] ?? null;

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

  const executionModel =
    activeAssistant?.defaultModelId && availableModels.some((model) => model.id === activeAssistant.defaultModelId)
      ? activeAssistant.defaultModelId
      : currentModel;
  const assistantSystemPrompt = activeAssistant?.systemPrompt?.trim() ? activeAssistant.systemPrompt.trim() : undefined;

  const getScopedConversationMessages = useCallback(() => {
    if (!activeChatId) {
      return [] as Message[];
    }

    const session = getChatSessionById(activeChatId);
    if (!session) {
      return [] as Message[];
    }

    if (activeAssistant?.id && session.assistantId && session.assistantId !== activeAssistant.id) {
      return [] as Message[];
    }

    return session.messages;
  }, [activeAssistant?.id, activeChatId, getChatSessionById]);

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
      if (sessionTitle) {
        return sessionTitle;
      }

      const inferredTitle = getChatSessionTitle(conversationMessages).trim();
      if (inferredTitle) {
        return inferredTitle;
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

  const schedulePetThoughtQueueBroadcast = useCallback(() => {
    if (!canUseTauriEvents() || petThoughtBroadcastFrameRef.current !== null) {
      return;
    }

    petThoughtBroadcastFrameRef.current = window.requestAnimationFrame(() => {
      petThoughtBroadcastFrameRef.current = null;
      broadcastPetThoughtQueue(petThoughtQueueRef.current, petThoughtRef.current);
    });
  }, [broadcastPetThoughtQueue]);

  const emitPetThoughtQueue = useCallback(
    (queue: PetThoughtState[]) => {
      petThoughtQueueRef.current = queue;
      petThoughtRef.current = queue[0] ?? null;
      schedulePetThoughtQueueBroadcast();
    },
    [schedulePetThoughtQueueBroadcast]
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

  const clearPetThought = useCallback(() => {
    clearPetThoughtTimer();
    pendingPetThoughtSessionIdsRef.current.clear();
    activePetThoughtIdRef.current = null;
    emitPetThoughtQueue([]);
  }, [clearPetThoughtTimer, emitPetThoughtQueue]);

  useEffect(() => {
    if (isCompactWindow || !canUseTauriEvents()) {
      return;
    }

    let unlistenRequest: (() => void) | undefined;
    let unlistenSyncRequest: (() => void) | undefined;
    let unlistenViewed: (() => void) | undefined;
    let unlistenClose: (() => void) | undefined;
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
    void listen("omni-pet-thought-viewed", () => {
      clearPetThought();
    }).then((cleanup) => {
      unlistenViewed = cleanup;
    });
    void listen<{ sessionId?: string | null; thoughtId?: string | null }>("omni-pet-thought-close", (event) => {
      removePetThought(event.payload ?? {});
    }).then((cleanup) => {
      unlistenClose = cleanup;
    });

    return () => {
      unlistenRequest?.();
      unlistenSyncRequest?.();
      unlistenViewed?.();
      unlistenClose?.();
    };
  }, [broadcastPetThoughtQueue, clearPetThought, isCompactWindow, removePetThought]);

  useEffect(() => {
    return () => {
      if (petThoughtBroadcastFrameRef.current !== null) {
        window.cancelAnimationFrame(petThoughtBroadcastFrameRef.current);
        petThoughtBroadcastFrameRef.current = null;
      }
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
          commitAssistantMemory(sessionId, conversationMessages, taskResult.finalResult.content);
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
      const systemPrompt = resolveAssistantSystemPrompt(options.assistantOverride);
      let streamedAssistantReply = "";
      let lastUiUpdateAt = 0;
      let lastThoughtUpdateAt = 0;
      const updateStreamPreview = (force = false) => {
        const now = performance.now();
        if (!force && now - lastUiUpdateAt < 16) {
          return;
        }
        lastUiUpdateAt = now;
        setLastAssistantContent(sessionId, streamedAssistantReply);
      };
      const updateThoughtPreview = (force = false) => {
        const now = performance.now();
        if (!force && now - lastThoughtUpdateAt < 66) {
          return;
        }
        lastThoughtUpdateAt = now;
        updatePetThought(petThoughtId, sessionId, conversationMessages, streamedAssistantReply);
      };

      setConversationMessagesForSession(sessionId, [...conversationMessages, { role: "assistant", content: "" }]);
      setError(null);

      try {
        const taskResult = await executeTask({
          model: executionModel,
          messages: conversationMessages,
          signal: abortController.signal,
          systemPrompt: [systemPrompt, options.hiddenContext?.trim()].filter(Boolean).join("\n\n") || undefined,
          onChunk: (chunk) => {
            if (!isCurrentSessionRun(sessionId, runId, abortController)) {
              return;
            }
            streamedAssistantReply += chunk;
            updateThoughtPreview();
            updateStreamPreview();
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
          setError(taskResult.error || "?????????");
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

        const assistantReply = streamedAssistantReply || taskResult.finalResult?.content || taskResult.toolResult?.outputText || "";
        updateStreamPreview(true);
        updateThoughtPreview(true);
        completePetThought(
          petThoughtId,
          sessionId,
          conversationMessages,
          assistantReply
        );
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

        setError(runError instanceof Error ? runError.message : "??????");
        setConversationMessagesForSession(sessionId, conversationMessages);
        if (isCurrentPetThought(petThoughtId, sessionId)) {
          const errorPreview = runError instanceof Error ? runError.message : "Response failed";
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
      activeChatId,
      applyAssistantReplyToTaskResult,
      clearPetThoughtSession,
      completePetThought,
      createSessionFromMessages,
      emitPetThought,
      executionModel,
      finishTaskResult,
      finishSessionRun,
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
      if (!toolRegistryRef.current) {
        const registry = new ToolRegistry();

        const newTool = requireTool("new");
        const clearTool = requireTool("clear");
        const settingsTool = requireTool("settings");
        const petTool = requireTool("pet");
        const renameTool = requireTool("rename");
        const pinTool = requireTool("pin");
        const modelTool = requireTool("model");
        const searchSessionsTool = requireTool("search_sessions");
        const readSessionTool = requireTool("read_session");
        const listFilesTool = requireTool("list_files");
        const readFileTool = requireTool("read_file");
        const searchFilesTool = requireTool("search_files");
        const analyzeFilesTool = requireTool("analyze_files");

        registry.register({
          id: newTool.id,
          command: newTool.command,
          title: newTool.title,
          execute: async () => {
            setActiveChatId(null);
            setMessages([]);
            setError(null);
            setOpenChatMenu(null);
            setEditingMessageIndex(null);
            return { ok: true };
          },
        });

        registry.register({
          id: clearTool.id,
          command: clearTool.command,
          title: clearTool.title,
          execute: async () => {
            setMessages([]);
            setError(null);
            setEditingMessageIndex(null);
            return { ok: true };
          },
        });

        registry.register({
          id: settingsTool.id,
          command: settingsTool.command,
          title: settingsTool.title,
          execute: async () => {
            await showSettingsWindow();
            return { ok: true };
          },
        });

        registry.register({
          id: petTool.id,
          command: petTool.command,
          title: petTool.title,
          execute: async (resolvedCommand) => {
            if (!canUseTauriEvents()) {
              return { ok: false, error: "Desktop pet is only available in the desktop app." };
            }

            const action = resolvedCommand.args.trim().toLowerCase();
            const compactWindow = await WebviewWindow.getByLabel(COMPACT_WINDOW_LABEL);
            const isCompactWindowVisible = compactWindow ? await compactWindow.isVisible().catch(() => false) : false;
            const hideCompactPet = async () => {
              setCompactPetHidden(true);
              await compactWindow?.close().catch(() => undefined);
            };

            if (!action) {
              if (compactWindow && isCompactWindowVisible && !isCompactPetHidden()) {
                await hideCompactPet();
                return { ok: true, outputText: "Hid desktop pet." };
              }

              setCompactPetHidden(false);
              saveSqliteBackedValue("omni_compact_appearance", "pet");
              await emit("omni-compact-appearance-changed", { appearance: "pet" });
              await showCompactWindow("pet", getPetWindowScale(), COMPACT_WINDOW_LABEL);
              return { ok: true, outputText: "Opened desktop pet." };
            }

            if (["wake", "open", "show", "on"].includes(action)) {
              setCompactPetHidden(false);
              saveSqliteBackedValue("omni_compact_appearance", "pet");
              await emit("omni-compact-appearance-changed", { appearance: "pet" });
              await showCompactWindow("pet", getPetWindowScale(), COMPACT_WINDOW_LABEL);
              return { ok: true, outputText: "Opened desktop pet." };
            }

            if (["close", "hide", "off"].includes(action)) {
              await hideCompactPet();
              return { ok: true, outputText: "Hid desktop pet." };
            }

            return { ok: false, error: "Usage: /pet, /pet wake, or /pet close" };
          },
        });

        registry.register({
          id: renameTool.id,
          command: renameTool.command,
          title: renameTool.title,
          execute: async (resolvedCommand, context) => {
            if (!context.activeChatId) return { ok: false, error: "No chat session to rename." };
            if (!resolvedCommand.args) return { ok: false, error: "Usage: /rename <title>" };
            renameChatSession(context.activeChatId, resolvedCommand.args);
            setError(null);
            setOpenChatMenu(null);
            return { ok: true };
          },
        });

        registry.register({
          id: pinTool.id,
          command: pinTool.command,
          title: pinTool.title,
          execute: async (_, context) => {
            if (!context.activeChatId) return { ok: false, error: "No chat session to pin." };
            togglePinnedChatSession(context.activeChatId);
            setError(null);
            setOpenChatMenu(null);
            return { ok: true };
          },
        });

        registry.register({
          id: modelTool.id,
          command: modelTool.command,
          title: modelTool.title,
          execute: async (resolvedCommand) => {
            const query = resolvedCommand.args.trim().toLowerCase();
            if (!query) return { ok: false, error: "Usage: /model <model id or name>" };

            const matchedModel =
              availableModels.find((model) => model.id.toLowerCase() === query || model.name.toLowerCase() === query) ??
              availableModels.find((model) => model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query));

            if (!matchedModel) return { ok: false, error: `No matching model: ${resolvedCommand.args}` };

            handleModelChange(matchedModel.id);
            setError(null);
            return { ok: true };
          },
        });

        registry.register({
          id: searchSessionsTool.id,
          command: searchSessionsTool.command,
          title: searchSessionsTool.title,
          execute: async (resolvedCommand, context) => {
            const query = resolvedCommand.args.trim();
            if (!query) return { ok: false, error: "Usage: /search_sessions <keyword>" };

            const matchedSessions = searchChatSessions(query);
            if (matchedSessions.length === 0) {
              return { ok: true, outputText: `No sessions contain "${query}".`, data: [] };
            }

            const lines = matchedSessions.slice(0, 8).map((session, index) => {
              const marker = context.activeChatId === session.id ? " [current]" : "";
              return `${index + 1}. ${session.title}${marker} | id=${session.id} | ${session.messages.length} messages`;
            });

            return {
              ok: true,
              outputText: [`Found ${matchedSessions.length} related sessions:`, ...lines].join("\n"),
              data: matchedSessions.map((session) => ({ id: session.id, title: session.title })),
            };
          },
        });

        registry.register({
          id: readSessionTool.id,
          command: readSessionTool.command,
          title: readSessionTool.title,
          execute: async (resolvedCommand) => {
            const sessionId = resolvedCommand.args.trim();
            if (!sessionId) return { ok: false, error: "Usage: /read_session <session id>" };
            const session = getChatSessionById(sessionId);
            if (!session) return { ok: false, error: `Session not found: ${sessionId}` };

            const preview = session.messages
              .slice(-8)
              .map((message, index) => {
                const content = message.content.trim() || "[empty content]";
                const clipped = content.length > 120 ? `${content.slice(0, 117)}...` : content;
                return `${index + 1}. ${message.role}: ${clipped}`;
              })
              .join("\n");

            return {
              ok: true,
              outputText: [`Session: ${session.title}`, `ID: ${session.id}`, `Message count: ${session.messages.length}`, "", preview].join("\n"),
              data: { id: session.id, title: session.title, messageCount: session.messages.length },
            };
          },
        });

        registry.register({
          id: listFilesTool.id,
          command: listFilesTool.command,
          title: listFilesTool.title,
          execute: async (resolvedCommand) => {
            const query = resolvedCommand.args.trim();
            const entries = await invoke<Array<{ path: string; is_dir: boolean }>>("list_workspace_files", {
              query: query || null,
              limit: 80,
            });

            if (entries.length === 0) {
              return {
                ok: true,
                outputText: query ? `No files contain "${query}".` : "No files in the current workspace.",
                data: [],
              };
            }

            const lines = entries.slice(0, 20).map((entry, index) => `${index + 1}. ${entry.is_dir ? "[DIR]" : "[FILE]"} ${entry.path}`);
            return { ok: true, outputText: [`Found ${entries.length} items:`, ...lines].join("\n"), data: entries };
          },
        });

        registry.register({
          id: readFileTool.id,
          command: readFileTool.command,
          title: readFileTool.title,
          execute: async (resolvedCommand) => {
            const relativePath = resolvedCommand.args.trim();
            if (!relativePath) return { ok: false, error: "Usage: /read_file <relative path>" };

            const content = await invoke<string>("read_workspace_file", {
              path: relativePath,
              maxChars: 6000,
            });

            return {
              ok: true,
              outputText: [`File: ${relativePath}`, "", content].join("\n"),
              data: { path: relativePath },
            };
          },
        });

        registry.register({
          id: searchFilesTool.id,
          command: searchFilesTool.command,
          title: searchFilesTool.title,
          execute: async (resolvedCommand) => {
            const query = resolvedCommand.args.trim();
            if (!query) return { ok: false, error: "Usage: /search_files <keyword>" };

            const matches = await invoke<Array<{ path: string; line_number: number; line_preview: string }>>("search_workspace_files", {
              query,
              limit: 50,
            });

            if (matches.length === 0) {
              return { ok: true, outputText: `No file content contains "${query}".`, data: [] };
            }

            const lines = matches.slice(0, 20).map((match, index) => `${index + 1}. ${match.path}:${match.line_number} ${match.line_preview}`);
            return { ok: true, outputText: [`Found ${matches.length} related matches:`, ...lines].join("\n"), data: matches };
          },
        });

        registry.register({
          id: analyzeFilesTool.id,
          command: analyzeFilesTool.command,
          title: analyzeFilesTool.title,
          execute: async () => ({ ok: true }),
        });

        toolRegistryRef.current = registry;
      }

      const tool = toolRegistryRef.current.get(command.command);
      if (!tool) {
        return { ok: false, error: `Unsupported command: ${command.command}` };
      }

      if (activeAssistant && !ALWAYS_ALLOWED_LOCAL_TOOL_IDS.has(tool.id) && !activeAssistant.allowedToolIds.includes(tool.id)) {
        return { ok: false, error: `This assistant has not enabled tool: ${tool.title}` };
      }

      return toolRegistryRef.current.execute(command as never, {
        activeChatId,
        chatSessions: searchChatSessions(""),
      });
    },
    [
      activeAssistant,
      activeChatId,
      availableModels,
      getChatSessionById,
      handleModelChange,
      renameChatSession,
      searchChatSessions,
      setActiveChatId,
      setMessages,
      setOpenChatMenu,
      togglePinnedChatSession,
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
      const savedModelId = readSqliteBackedValue(CURRENT_MODEL_STORAGE_KEY)?.trim() ?? "";
      const registryCurrentModelId = modelRegistry.getCurrentModel()?.trim() ?? "";
      const registryFallbackModelId = modelRegistry.getAvailableModels()[0]?.id ?? executionModel;
      const resolvedModelId =
        (preferredAssistantModelId && modelRegistry.getModelConfig(preferredAssistantModelId)
          ? preferredAssistantModelId
          : null) ??
        (savedModelId && modelRegistry.getModelConfig(savedModelId)
          ? savedModelId
          : null) ??
        (registryCurrentModelId && modelRegistry.getModelConfig(registryCurrentModelId)
          ? registryCurrentModelId
          : null) ??
        (executionModel && modelRegistry.getModelConfig(executionModel) ? executionModel : registryFallbackModelId);

      const abortController = new AbortController();
      const runId = startSessionRun(session.id, abortController);
      setError(null);

      let conversationMessagesForTask = session.messages;
      let petThoughtId: string | null = null;
      let streamedAssistantReply = "";
      let lastUiUpdateAt = 0;
      let lastThoughtUpdateAt = 0;
      const updateStreamPreview = (force = false) => {
        const now = performance.now();
        if (!force && now - lastUiUpdateAt < 16) {
          return;
        }
        lastUiUpdateAt = now;
        setLastAssistantContent(session.id, streamedAssistantReply);
      };
      const updateThoughtPreview = (force = false) => {
        const now = performance.now();
        if (!force && now - lastThoughtUpdateAt < 66) {
          return;
        }
        lastThoughtUpdateAt = now;
        updatePetThought(petThoughtId, session.id, conversationMessagesForTask, streamedAssistantReply);
      };

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
              previewText: taskResult.error || "Response failed",
              responseCount,
              status: "error",
              updatedAt: Date.now(),
            });
          }
          return;
        }

        const assistantReply = streamedAssistantReply || taskResult.finalResult?.content || taskResult.toolResult?.outputText || "";
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
      let lastUiUpdateAt = 0;
      let lastThoughtUpdateAt = 0;
      const updateStreamPreview = (force = false) => {
        const now = performance.now();
        if (!force && now - lastUiUpdateAt < 16) {
          return;
        }
        lastUiUpdateAt = now;
        setLastAssistantContent(sessionId, streamedAssistantReply);
      };
      const updateThoughtPreview = (force = false) => {
        if (!hasPetThought) {
          return;
        }
        const now = performance.now();
        if (!force && now - lastThoughtUpdateAt < 66) {
          return;
        }
        lastThoughtUpdateAt = now;
        updatePetThought(petThoughtId, sessionId, conversationMessagesForTask, streamedAssistantReply);
      };

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

        const assistantReply = streamedAssistantReply || taskResult.finalResult?.content || taskResult.toolResult?.outputText || "";
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
