import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { listen } from "@tauri-apps/api/event";
import type { Message, ModelConfig } from "../adapters/types";
import { showCompactWindow, showSettingsWindow } from "../app/window";
import { COMPACT_WINDOW_LABEL } from "../app/constants";
import { getPetWindowScale } from "../app/compactPetScale";
import { isCompactPetHidden, setCompactPetHidden } from "../app/compactVisibility";
import { saveSqliteBackedValue } from "../app/sqliteStorage";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { executeInputTask, executeTask } from "../chat/taskExecutor";
import { getInitialTaskHistory, saveTaskHistory } from "../chat/taskStorage";
import { getChatSessionTitle } from "../chat/storage";
import { ToolRegistry } from "../chat/toolRegistry";
import type { TaskExecutionResult, TaskRuntimeState } from "../chat/taskTypes";
import type { AssistantProfile, ChatExecutionResult } from "../chat/types";
import { getToolManifestById } from "../config/manifests/tools";
import type { PetThoughtState } from "../app/types";

type SessionLite = {
  id: string;
  title: string;
  messages: Message[];
};

type UseChatRuntimeArgs = {
  activeChatId: string | null;
  activeAssistant: AssistantProfile | null;
  availableModels: ModelConfig[];
  applyUsageToSession: (sessionId: string, result: ChatExecutionResult, conversationMessages: Message[]) => void;
  commitAssistantMemory: (sessionId: string, conversationMessages: Message[], assistantReply: string) => void;
  createSessionFromMessages: (conversationMessages: Message[]) => { id: string };
  currentModel: string;
  getChatSessionById: (sessionId: string) => SessionLite | null;
  handleModelChange: (modelId: string) => void;
  messages: Message[];
  renameChatSession: (sessionId: string, title: string) => boolean;
  searchChatSessions: (query: string) => SessionLite[];
  setActiveChatId: React.Dispatch<React.SetStateAction<string | null>>;
  setInputDraft: React.Dispatch<React.SetStateAction<string>>;
  setInputDraftImages: React.Dispatch<React.SetStateAction<string[]>>;
  setInputDraftKey: React.Dispatch<React.SetStateAction<number>>;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setOpenChatMenu: React.Dispatch<React.SetStateAction<{ id: string; x: number; y: number } | null>>;
  togglePinnedChatSession: (sessionId: string) => boolean;
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

function canUseTauriEvents() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function useChatRuntime({
  activeChatId,
  activeAssistant,
  availableModels,
  applyUsageToSession,
  commitAssistantMemory,
  createSessionFromMessages,
  currentModel,
  getChatSessionById,
  handleModelChange,
  messages,
  renameChatSession,
  searchChatSessions,
  setActiveChatId,
  setInputDraft,
  setInputDraftImages,
  setInputDraftKey,
  setMessages,
  setOpenChatMenu,
  togglePinnedChatSession,
  isCompactWindow,
}: UseChatRuntimeArgs) {
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [editingMessageIndex, setEditingMessageIndex] = useState<number | null>(null);
  const [latestTaskResult, setLatestTaskResult] = useState<TaskExecutionResult | null>(null);
  const [taskRuntimeState, setTaskRuntimeState] = useState<TaskRuntimeState>({
    activeTask: null,
    history: [],
  });
  const abortControllerRef = useRef<AbortController | null>(null);
  const lastRunIdRef = useRef(0);
  const lastTaskResultRef = useRef<TaskExecutionResult | null>(null);
  const toolRegistryRef = useRef<ToolRegistry | null>(null);
  const petThoughtRef = useRef<PetThoughtState | null>(null);
  const pendingPetThoughtSessionIdsRef = useRef<Set<string>>(new Set());
  const petThoughtBroadcastFrameRef = useRef<number | null>(null);
  const petThoughtClearTimerRef = useRef<number | null>(null);

  const executionModel =
    activeAssistant?.defaultModelId && availableModels.some((model) => model.id === activeAssistant.defaultModelId)
      ? activeAssistant.defaultModelId
      : currentModel;
  const assistantSystemPrompt = activeAssistant?.systemPrompt?.trim() ? activeAssistant.systemPrompt.trim() : undefined;

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

  const emitPetThought = useCallback((state: PetThoughtState | null) => {
    petThoughtRef.current = state;
    if (!canUseTauriEvents()) {
      return;
    }
    if (petThoughtBroadcastFrameRef.current !== null) {
      window.cancelAnimationFrame(petThoughtBroadcastFrameRef.current);
    }
    petThoughtBroadcastFrameRef.current = window.requestAnimationFrame(() => {
      petThoughtBroadcastFrameRef.current = null;
      void emit("omni-pet-thought-changed", petThoughtRef.current);
    });
  }, []);

  const startPetThought = useCallback(
    (sessionId: string | null | undefined, conversationMessages: Message[]) => {
      clearPetThoughtTimer();
      const responseCount = resolvePetThoughtResponseCount(sessionId);
      emitPetThought({
        sessionId: sessionId ?? null,
        sessionTitle: resolvePetThoughtTitle(sessionId, conversationMessages),
        previewText: "",
        responseCount,
        status: "thinking",
        updatedAt: Date.now(),
      });
    },
    [clearPetThoughtTimer, emitPetThought, resolvePetThoughtResponseCount, resolvePetThoughtTitle]
  );

  const updatePetThought = useCallback(
    (sessionId: string | null | undefined, conversationMessages: Message[], previewText: string) => {
      const responseCount = resolvePetThoughtResponseCount(sessionId);
      emitPetThought({
        sessionId: sessionId ?? null,
        sessionTitle: resolvePetThoughtTitle(sessionId, conversationMessages),
        previewText,
        responseCount,
        status: "thinking",
        updatedAt: Date.now(),
      });
    },
    [emitPetThought, resolvePetThoughtResponseCount, resolvePetThoughtTitle]
  );

  const completePetThought = useCallback(
    (sessionId: string | null | undefined, conversationMessages: Message[], previewText: string) => {
      clearPetThoughtTimer();
      const responseCount = resolvePetThoughtResponseCount(sessionId);
      emitPetThought({
        sessionId: sessionId ?? null,
        sessionTitle: resolvePetThoughtTitle(sessionId, conversationMessages),
        previewText,
        responseCount,
        status: "complete",
        updatedAt: Date.now(),
      });
    },
    [clearPetThoughtTimer, emitPetThought, resolvePetThoughtResponseCount, resolvePetThoughtTitle]
  );

  const clearPetThought = useCallback(() => {
    clearPetThoughtTimer();
    pendingPetThoughtSessionIdsRef.current.clear();
    emitPetThought(null);
  }, [clearPetThoughtTimer, emitPetThought]);

  useEffect(() => {
    if (isCompactWindow || !canUseTauriEvents()) {
      return;
    }

    let unlistenRequest: (() => void) | undefined;
    let unlistenViewed: (() => void) | undefined;
    void listen("omni-pet-thought-request", () => {
      void emit("omni-pet-thought-changed", petThoughtRef.current);
    }).then((cleanup) => {
      unlistenRequest = cleanup;
    });
    void listen("omni-pet-thought-viewed", () => {
      clearPetThought();
    }).then((cleanup) => {
      unlistenViewed = cleanup;
    });

    return () => {
      unlistenRequest?.();
      unlistenViewed?.();
    };
  }, [clearPetThought, isCompactWindow]);

  useEffect(() => {
    return () => {
      if (petThoughtBroadcastFrameRef.current !== null) {
        window.cancelAnimationFrame(petThoughtBroadcastFrameRef.current);
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
        setMessages([
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
        setMessages([...conversationMessages, { role: "assistant", content: taskResult.toolResult.outputText }]);
      }

      if (taskResult.status === "failed") {
        setError(taskResult.error || "任务执行失败");
      }
    },
    [applyUsageToSession, commitAssistantMemory, setMessages]
  );

  const runConversationTurn = useCallback(
    async (
      conversationMessages: Message[],
      options: { sessionId?: string | null; createSession?: boolean; hiddenContext?: string } = {}
    ) => {
      let sessionId = options.sessionId ?? activeChatId;
      if (!sessionId && options.createSession) {
        const nextSession = createSessionFromMessages(conversationMessages);
        sessionId = nextSession.id;
      }

      const runId = lastRunIdRef.current + 1;
      lastRunIdRef.current = runId;
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      setMessages([...conversationMessages, { role: "assistant", content: "" }]);
      setError(null);
      setIsLoading(true);
      clearPetThoughtSession(sessionId);
      emitPetThought(null);
      startPetThought(sessionId, conversationMessages);

      try {
        const taskResult = await executeTask({
          model: executionModel,
          messages: conversationMessages,
          signal: abortController.signal,
          systemPrompt: [assistantSystemPrompt, options.hiddenContext?.trim()].filter(Boolean).join("\n\n") || undefined,
          onChunk: (chunk) => {
            if (runId !== lastRunIdRef.current || abortController.signal.aborted) {
              return;
            }
            updatePetThought(sessionId, conversationMessages, `${petThoughtRef.current?.previewText ?? ""}${chunk}`);
            setMessages((prev) => {
              const updated = [...prev];
              const lastIdx = updated.length - 1;
              if (lastIdx >= 0 && updated[lastIdx].role === "assistant") {
                updated[lastIdx] = { ...updated[lastIdx], content: updated[lastIdx].content + chunk };
              }
              return updated;
            });
          },
        });

        if (runId !== lastRunIdRef.current) {
          return;
        }

        if (!taskResult.finalResult && taskResult.status === "aborted") {
          setMessages((prev) => prev.filter((message, index) => index < conversationMessages.length || message.content));
          clearPetThoughtSession(sessionId);
          emitPetThought(null);
          return;
        }

        if (!taskResult.finalResult && !taskResult.toolResult?.outputText) {
          setError(taskResult.error || "?????????");
          setMessages(conversationMessages);
          const responseCount = resolvePetThoughtResponseCount(sessionId);
          emitPetThought({
            sessionId: sessionId ?? null,
            sessionTitle: resolvePetThoughtTitle(sessionId, conversationMessages),
            previewText: "",
            responseCount,
            status: "error",
            updatedAt: Date.now(),
          });
          return;
        }

        completePetThought(
          sessionId,
          conversationMessages,
          taskResult.finalResult?.content || taskResult.toolResult?.outputText || petThoughtRef.current?.previewText || ""
        );
        finishTaskResult(taskResult, sessionId, conversationMessages);
        return;
      } catch (runError) {
        if (runId !== lastRunIdRef.current) {
          return;
        }
        if (runError instanceof DOMException && runError.name === "AbortError") {
          setMessages((prev) => prev.filter((message, index) => index < conversationMessages.length || message.content));
          clearPetThoughtSession(sessionId);
          emitPetThought(null);
          return;
        }

        setError(runError instanceof Error ? runError.message : "??????");
        setMessages(conversationMessages);
        const responseCount = resolvePetThoughtResponseCount(sessionId);
        emitPetThought({
          sessionId: sessionId ?? null,
          sessionTitle: resolvePetThoughtTitle(sessionId, conversationMessages),
          previewText: "",
          responseCount,
          status: "error",
          updatedAt: Date.now(),
        });
        return;
      } finally {
        if (runId === lastRunIdRef.current) {
          abortControllerRef.current = null;
          setIsLoading(false);
        }
      }
    },
    [
      activeChatId,
      assistantSystemPrompt,
      clearPetThought,
      clearPetThoughtSession,
      completePetThought,
      createSessionFromMessages,
      emitPetThought,
      executionModel,
      finishTaskResult,
      resolvePetThoughtResponseCount,
      resolvePetThoughtTitle,
      setMessages,
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

  const handleSend = useCallback(
    async (content: string, images?: string[], hiddenContext?: string) => {
      if (isLoading) {
        return;
      }

      const runId = lastRunIdRef.current + 1;
      lastRunIdRef.current = runId;
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      setError(null);
      setIsLoading(true);
      clearPetThoughtSession(activeChatId);
      emitPetThought(null);

      let sessionId = activeChatId;
      let conversationMessagesForTask = messages;
      let hasPetThought = false;

      try {
        const taskResult = await executeInputTask({
          input: content,
          images,
          hiddenContext,
          currentMessages: messages,
          model: executionModel,
          onPrepareConversation: (preparedMessages) => {
            conversationMessagesForTask = preparedMessages;
            if (!sessionId) {
              const nextSession = createSessionFromMessages(preparedMessages);
              sessionId = nextSession.id;
            }
            setMessages([...preparedMessages, { role: "assistant", content: "" }]);
            startPetThought(sessionId, preparedMessages);
            hasPetThought = true;
          },
          signal: abortController.signal,
          systemPrompt: [assistantSystemPrompt, hiddenContext?.trim()].filter(Boolean).join("\n\n") || undefined,
          onChunk: (chunk) => {
            if (runId !== lastRunIdRef.current || abortController.signal.aborted) {
              return;
            }
            if (hasPetThought) {
              updatePetThought(sessionId, conversationMessagesForTask, `${petThoughtRef.current?.previewText ?? ""}${chunk}`);
            }
            setMessages((prev) => {
              const updated = [...prev];
              const lastIdx = updated.length - 1;
              if (lastIdx >= 0 && updated[lastIdx].role === "assistant") {
                updated[lastIdx] = { ...updated[lastIdx], content: updated[lastIdx].content + chunk };
              }
              return updated;
            });
          },
          executeTool,
        });

        if (runId !== lastRunIdRef.current) {
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
            setMessages([...messages, { role: "assistant", content: taskResult.toolResult.outputText }]);
          }
          return;
        }

        const conversationMessages = taskResult.conversationMessages ?? conversationMessagesForTask;
        if (!taskResult.finalResult) {
          if (taskResult.status === "aborted") {
            setMessages((prev) => prev.filter((message, index) => index < conversationMessages.length || message.content));
            if (hasPetThought) {
              clearPetThoughtSession(sessionId);
              emitPetThought(null);
            }
            return;
          }

          setError(taskResult.error || "任务执行失败");
          setMessages(conversationMessages);
          if (hasPetThought) {
            const responseCount = resolvePetThoughtResponseCount(sessionId);
            emitPetThought({
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

        if (hasPetThought) {
          completePetThought(
            sessionId,
            conversationMessages,
            taskResult.finalResult?.content || taskResult.toolResult?.outputText || petThoughtRef.current?.previewText || ""
          );
        }
        finishTaskResult(taskResult, sessionId, conversationMessages);
      } catch (sendError) {
        if (runId !== lastRunIdRef.current) {
          return;
        }
        if (sendError instanceof DOMException && sendError.name === "AbortError") {
          if (hasPetThought) {
            clearPetThoughtSession(sessionId);
            emitPetThought(null);
          }
          return;
        }
        setError(sendError instanceof Error ? sendError.message : "发送消息失败");
        if (hasPetThought) {
          const responseCount = resolvePetThoughtResponseCount(sessionId);
          emitPetThought({
            sessionId: sessionId ?? null,
            sessionTitle: resolvePetThoughtTitle(sessionId, conversationMessagesForTask),
            previewText: "",
            responseCount,
            status: "error",
            updatedAt: Date.now(),
          });
        }
      } finally {
        if (runId === lastRunIdRef.current) {
          abortControllerRef.current = null;
          setIsLoading(false);
        }
      }
    },
    [
      activeChatId,
      assistantSystemPrompt,
      clearPetThoughtSession,
      completePetThought,
      createSessionFromMessages,
      emitPetThought,
      executeTool,
      executionModel,
      finishTaskResult,
      isLoading,
      messages,
      resolvePetThoughtResponseCount,
      resolvePetThoughtTitle,
      setMessages,
      startPetThought,
      updatePetThought,
    ]
  );

  const handleStop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsLoading(false);
  }, []);

  const handleEditUserMessage = useCallback(
    (messageIndex: number) => {
      if (isLoading) {
        return;
      }
      const targetMessage = messages[messageIndex];
      if (!targetMessage || targetMessage.role !== "user") {
        return;
      }
      setEditingMessageIndex(messageIndex);
      setError(null);
    },
    [isLoading, messages]
  );

  const handleCancelEditUserMessage = useCallback(() => {
    setEditingMessageIndex(null);
  }, []);

  const handleSubmitEditedUserMessage = useCallback(
    async (messageIndex: number, content: string) => {
      if (isLoading) {
        return;
      }
      const targetMessage = messages[messageIndex];
      if (!targetMessage || targetMessage.role !== "user" || !content.trim()) {
        return;
      }
      const conversationMessages = [...messages.slice(0, messageIndex), { ...targetMessage, content: content.trim() }];
      setEditingMessageIndex(null);
      await runConversationTurn(conversationMessages, { sessionId: activeChatId });
    },
    [activeChatId, isLoading, messages, runConversationTurn]
  );

  const handleRegenerateMessage = useCallback(
    async (messageIndex: number) => {
      if (isLoading) {
        return;
      }
      const targetMessage = messages[messageIndex];
      if (!targetMessage || targetMessage.role !== "assistant") {
        return;
      }
      const conversationMessages = messages.slice(0, messageIndex);
      if (!conversationMessages.some((message) => message.role === "user")) {
        return;
      }
      await runConversationTurn(conversationMessages, { sessionId: activeChatId });
    },
    [activeChatId, isLoading, messages, runConversationTurn]
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
    createSessionFromMessages([]);
    setMessages([]);
    setInputDraft("");
    setInputDraftImages([]);
    setInputDraftKey((value) => value + 1);
    setError(null);
    setOpenChatMenu(null);
    setEditingMessageIndex(null);
  }, [createSessionFromMessages, setEditingMessageIndex, setError, setInputDraft, setInputDraftImages, setInputDraftKey, setMessages, setOpenChatMenu]);

  return {
    abortControllerRef,
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
    latestTaskResult,
    taskRuntimeState,
    lastTaskResultRef,
    runConversationTurn,
    setEditingMessageIndex,
    setError,
  };
}

