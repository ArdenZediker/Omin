import { useCallback, useRef, useState } from "react";
import type { Message, ModelConfig } from "../adapters/types";
import { executeChatTurn } from "../chat/engine";
import { resolveLocalSlashCommand, resolveSlashSkillPrompt } from "../chat/skills";

type UseChatRuntimeArgs = {
  activeChatId: string | null;
  availableModels: ModelConfig[];
  applyUsageToSession: (sessionId: string, result: Awaited<ReturnType<typeof executeChatTurn>>, conversationMessages: Message[]) => void;
  createSessionFromMessages: (conversationMessages: Message[]) => { id: string };
  currentModel: string;
  handleModelChange: (modelId: string) => void;
  messages: Message[];
  renameChatSession: (sessionId: string, title: string) => boolean;
  setActiveChatId: React.Dispatch<React.SetStateAction<string | null>>;
  setInputDraft: React.Dispatch<React.SetStateAction<string>>;
  setInputDraftImages: React.Dispatch<React.SetStateAction<string[]>>;
  setInputDraftKey: React.Dispatch<React.SetStateAction<number>>;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setOpenChatMenu: React.Dispatch<React.SetStateAction<{ id: string; x: number; y: number } | null>>;
  setView: React.Dispatch<React.SetStateAction<"chat" | "settings">>;
  togglePinnedChatSession: (sessionId: string) => boolean;
};

export function useChatRuntime({
  activeChatId,
  availableModels,
  applyUsageToSession,
  createSessionFromMessages,
  currentModel,
  handleModelChange,
  messages,
  renameChatSession,
  setActiveChatId,
  setInputDraft,
  setInputDraftImages,
  setInputDraftKey,
  setMessages,
  setOpenChatMenu,
  setView,
  togglePinnedChatSession,
}: UseChatRuntimeArgs) {
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [editingMessageIndex, setEditingMessageIndex] = useState<number | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const lastRunIdRef = useRef(0);

  const runConversationTurn = useCallback(
    async (conversationMessages: Message[], options: { sessionId?: string | null; createSession?: boolean } = {}) => {
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
        const result = await executeChatTurn({
          model: currentModel,
          messages: conversationMessages,
          signal: abortController.signal,
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

        setMessages([...conversationMessages, { role: "assistant", content: result.content }]);
        if (sessionId) {
          applyUsageToSession(sessionId, result, conversationMessages);
        }

        return sessionId;
      } catch (error) {
        if (runId !== lastRunIdRef.current) {
          return sessionId;
        }
        if (error instanceof DOMException && error.name === "AbortError") {
          setMessages((prev) => prev.filter((message, index) => index < conversationMessages.length || message.content));
          return sessionId;
        }

        const errorMessage = error instanceof Error ? error.message : "未知错误";
        setError(errorMessage);
        setMessages(conversationMessages);
        return sessionId;
      } finally {
        if (runId === lastRunIdRef.current) {
          abortControllerRef.current = null;
          setIsLoading(false);
        }
      }
    },
    [activeChatId, applyUsageToSession, createSessionFromMessages, currentModel, setMessages]
  );

  const handleSend = useCallback(
    async (content: string, images?: string[]) => {
      if (isLoading) {
        return;
      }

      const localCommand = resolveLocalSlashCommand(content);
      if (localCommand && (!images || images.length === 0)) {
        if (localCommand.command === "/new") {
          setActiveChatId(null);
          setMessages([]);
          setError(null);
          setOpenChatMenu(null);
          setEditingMessageIndex(null);
          return;
        }
        if (localCommand.command === "/clear") {
          setMessages([]);
          setError(null);
          setEditingMessageIndex(null);
          return;
        }
        if (localCommand.command === "/settings") {
          setView("settings");
          return;
        }
        if (localCommand.command === "/rename") {
          if (!activeChatId) {
            setError("当前没有可重命名的会话");
            return;
          }
          if (!localCommand.args) {
            setError("用法: /rename 新标题");
            return;
          }
          renameChatSession(activeChatId, localCommand.args);
          setError(null);
          setOpenChatMenu(null);
          return;
        }
        if (localCommand.command === "/pin") {
          if (!activeChatId) {
            setError("当前没有可置顶的会话");
            return;
          }
          togglePinnedChatSession(activeChatId);
          setError(null);
          setOpenChatMenu(null);
          return;
        }
        if (localCommand.command === "/model") {
          const query = localCommand.args.trim().toLowerCase();
          if (!query) {
            setError("用法: /model 模型 ID 或名称");
            return;
          }
          const matchedModel =
            availableModels.find((model) => model.id.toLowerCase() === query || model.name.toLowerCase() === query) ??
            availableModels.find((model) => model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query));
          if (!matchedModel) {
            setError(`未找到匹配模型: ${localCommand.args}`);
            return;
          }
          handleModelChange(matchedModel.id);
          setError(null);
          return;
        }
      }

      const resolved = resolveSlashSkillPrompt(content);
      const resolvedUserMessage: Message = { role: "user", content: resolved.content, images };
      const nextMessages = [...messages, resolvedUserMessage];
      await runConversationTurn(nextMessages, { sessionId: activeChatId, createSession: true });
    },
    [
      activeChatId,
      availableModels,
      handleModelChange,
      isLoading,
      messages,
      renameChatSession,
      runConversationTurn,
      setActiveChatId,
      setMessages,
      setOpenChatMenu,
      setView,
      togglePinnedChatSession,
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
    setActiveChatId(null);
    setMessages([]);
    setError(null);
    setOpenChatMenu(null);
    setEditingMessageIndex(null);
  }, [setActiveChatId, setMessages, setOpenChatMenu]);

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
    runConversationTurn,
    setEditingMessageIndex,
    setError,
  };
}
