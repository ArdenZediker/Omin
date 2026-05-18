import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import type { Message, ModelConfig } from "../adapters/types";
import { showCompactWindow, showSettingsWindow } from "../app/window";
import { COMPACT_WINDOW_LABEL } from "../app/constants";
import { getPetWindowScale } from "../app/compactPetScale";
import { isCompactPetHidden, setCompactPetHidden } from "../app/compactVisibility";
import { saveSqliteBackedValue } from "../app/sqliteStorage";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { executeInputTask, executeTask } from "../chat/taskExecutor";
import { getInitialTaskHistory, saveTaskHistory } from "../chat/taskStorage";
import { ToolRegistry } from "../chat/toolRegistry";
import type { TaskExecutionResult, TaskRuntimeState } from "../chat/taskTypes";
import type { AssistantProfile, ChatExecutionResult } from "../chat/types";
import { getToolManifestById } from "../config/manifests/tools";

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

  const executionModel =
    activeAssistant?.defaultModelId && availableModels.some((model) => model.id === activeAssistant.defaultModelId)
      ? activeAssistant.defaultModelId
      : currentModel;
  const assistantSystemPrompt = activeAssistant?.systemPrompt?.trim() ? activeAssistant.systemPrompt.trim() : undefined;

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
          return sessionId;
        }

        if (!taskResult.finalResult && taskResult.status === "aborted") {
          setMessages((prev) => prev.filter((message, index) => index < conversationMessages.length || message.content));
          return sessionId;
        }

        if (!taskResult.finalResult && !taskResult.toolResult?.outputText) {
          setError(taskResult.error || "任务执行失败");
          setMessages(conversationMessages);
          return sessionId;
        }

        finishTaskResult(taskResult, sessionId, conversationMessages);
        return sessionId;
      } catch (runError) {
        if (runId !== lastRunIdRef.current) {
          return sessionId;
        }
        if (runError instanceof DOMException && runError.name === "AbortError") {
          setMessages((prev) => prev.filter((message, index) => index < conversationMessages.length || message.content));
          return sessionId;
        }

        setError(runError instanceof Error ? runError.message : "未知错误");
        setMessages(conversationMessages);
        return sessionId;
      } finally {
        if (runId === lastRunIdRef.current) {
          abortControllerRef.current = null;
          setIsLoading(false);
        }
      }
    },
    [activeChatId, assistantSystemPrompt, createSessionFromMessages, executionModel, finishTaskResult, setMessages]
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
                return { ok: true, outputText: "已收起桌面宠物。" };
              }

              setCompactPetHidden(false);
              saveSqliteBackedValue("omni_compact_appearance", "pet");
              await emit("omni-compact-appearance-changed", { appearance: "pet" });
              await showCompactWindow("pet", getPetWindowScale(), COMPACT_WINDOW_LABEL);
              return { ok: true, outputText: "已唤醒桌面宠物。" };
            }

            if (["wake", "open", "show", "on"].includes(action)) {
              setCompactPetHidden(false);
              saveSqliteBackedValue("omni_compact_appearance", "pet");
              await emit("omni-compact-appearance-changed", { appearance: "pet" });
              await showCompactWindow("pet", getPetWindowScale(), COMPACT_WINDOW_LABEL);
              return { ok: true, outputText: "已唤醒桌面宠物。" };
            }

            if (["close", "hide", "off"].includes(action)) {
              await hideCompactPet();
              return { ok: true, outputText: "已收起桌面宠物。" };
            }

            return { ok: false, error: "用法: /pet 或 /pet wake 或 /pet close" };
          },
        });

        registry.register({
          id: renameTool.id,
          command: renameTool.command,
          title: renameTool.title,
          execute: async (resolvedCommand, context) => {
            if (!context.activeChatId) return { ok: false, error: "当前没有可重命名的会话" };
            if (!resolvedCommand.args) return { ok: false, error: "用法: /rename 新标题" };
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
            if (!context.activeChatId) return { ok: false, error: "当前没有可置顶的会话" };
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
            if (!query) return { ok: false, error: "用法: /model 模型 ID 或名称" };

            const matchedModel =
              availableModels.find((model) => model.id.toLowerCase() === query || model.name.toLowerCase() === query) ??
              availableModels.find((model) => model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query));

            if (!matchedModel) return { ok: false, error: `未找到匹配模型: ${resolvedCommand.args}` };

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
            if (!query) return { ok: false, error: "用法: /search_sessions 关键词" };

            const matchedSessions = searchChatSessions(query);
            if (matchedSessions.length === 0) {
              return { ok: true, outputText: `未找到包含“${query}”的会话。`, data: [] };
            }

            const lines = matchedSessions.slice(0, 8).map((session, index) => {
              const marker = context.activeChatId === session.id ? " [当前]" : "";
              return `${index + 1}. ${session.title}${marker} | id=${session.id} | ${session.messages.length} 条消息`;
            });

            return {
              ok: true,
              outputText: [`找到 ${matchedSessions.length} 个相关会话：`, ...lines].join("\n"),
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
            if (!sessionId) return { ok: false, error: "用法: /read_session 会话ID" };
            const session = getChatSessionById(sessionId);
            if (!session) return { ok: false, error: `未找到会话: ${sessionId}` };

            const preview = session.messages
              .slice(-8)
              .map((message, index) => {
                const content = message.content.trim() || "[空内容]";
                const clipped = content.length > 120 ? `${content.slice(0, 117)}...` : content;
                return `${index + 1}. ${message.role}: ${clipped}`;
              })
              .join("\n");

            return {
              ok: true,
              outputText: [`会话：${session.title}`, `ID：${session.id}`, `消息数：${session.messages.length}`, "", preview].join("\n"),
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
            const entries = await invoke<Array<{ path: string; is_dir: boolean }>>('list_workspace_files', {
              query: query || null,
              limit: 80,
            });

            if (entries.length === 0) {
              return {
                ok: true,
                outputText: query ? `未找到包含“${query}”的文件。` : "当前工作区没有可列出的文件。",
                data: [],
              };
            }

            const lines = entries.slice(0, 20).map((entry, index) => `${index + 1}. ${entry.is_dir ? "[DIR]" : "[FILE]"} ${entry.path}`);
            return { ok: true, outputText: [`找到 ${entries.length} 个条目：`, ...lines].join("\n"), data: entries };
          },
        });

        registry.register({
          id: readFileTool.id,
          command: readFileTool.command,
          title: readFileTool.title,
          execute: async (resolvedCommand) => {
            const relativePath = resolvedCommand.args.trim();
            if (!relativePath) return { ok: false, error: "用法: /read_file 相对路径" };

            const content = await invoke<string>('read_workspace_file', {
              path: relativePath,
              maxChars: 6000,
            });

            return {
              ok: true,
              outputText: [`文件：${relativePath}`, "", content].join("\n"),
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
            if (!query) return { ok: false, error: "用法: /search_files 关键词" };

            const matches = await invoke<Array<{ path: string; line_number: number; line_preview: string }>>('search_workspace_files', {
              query,
              limit: 50,
            });

            if (matches.length === 0) {
              return { ok: true, outputText: `未找到包含“${query}”的文件内容。`, data: [] };
            }

            const lines = matches.slice(0, 20).map((match, index) => `${index + 1}. ${match.path}:${match.line_number} ${match.line_preview}`);
            return { ok: true, outputText: [`找到 ${matches.length} 条相关内容：`, ...lines].join("\n"), data: matches };
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
        return { ok: false, error: `暂不支持命令: ${command.command}` };
      }

      if (activeAssistant && !ALWAYS_ALLOWED_LOCAL_TOOL_IDS.has(tool.id) && !activeAssistant.allowedToolIds.includes(tool.id)) {
        return { ok: false, error: `当前助手未启用工具: ${tool.title}` };
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

      try {
        let sessionId = activeChatId;
        let conversationMessagesForTask = messages;
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
          },
          signal: abortController.signal,
            systemPrompt: [assistantSystemPrompt, hiddenContext?.trim()].filter(Boolean).join("\n\n") || undefined,
          onChunk: (chunk) => {
            if (runId !== lastRunIdRef.current || abortController.signal.aborted) {
              return;
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
            return;
          }

          setError(taskResult.error || "娴犺濮熼幍褑顢戞径杈Е");
          setMessages(conversationMessages);
          return;
        }

        finishTaskResult(taskResult, sessionId, conversationMessages);
      } catch (sendError) {
        if (runId !== lastRunIdRef.current) {
          return;
        }
        if (sendError instanceof DOMException && sendError.name === "AbortError") {
          return;
        }
        setError(sendError instanceof Error ? sendError.message : "閺堫亞鐓￠柨娆掝嚖");
      } finally {
        if (runId === lastRunIdRef.current) {
          abortControllerRef.current = null;
          setIsLoading(false);
        }
      }
    },
    [
      activeAssistant,
      activeChatId,
      assistantSystemPrompt,
      createSessionFromMessages,
      executeTool,
      executionModel,
      finishTaskResult,
      isLoading,
      messages,
      setMessages,
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

