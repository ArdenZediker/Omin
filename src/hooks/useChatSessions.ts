import { useCallback, useEffect, useMemo, useState } from "react";
import type { Message } from "../adapters/types";
import {
  CHAT_SESSIONS_STORAGE_KEY,
  createChatSession,
  getChatSessionGroupLabel,
  getChatSessionTitle,
  getInitialChatSessions,
} from "../chat/storage";
import type { ChatExecutionResult, ChatSession } from "../chat/types";

type UseChatSessionsOptions = {
  persist: boolean;
};

export function useChatSessions({ persist }: UseChatSessionsOptions) {
  const [initialState] = useState(() => {
    const initialSessions = getInitialChatSessions();
    return {
      sessions: initialSessions,
      activeChatId: initialSessions[0]?.id ?? null,
      messages: initialSessions[0]?.messages ?? [],
    };
  });

  const [chatSessions, setChatSessions] = useState<ChatSession[]>(initialState.sessions);
  const [activeChatId, setActiveChatId] = useState<string | null>(initialState.activeChatId);
  const [messages, setMessages] = useState<Message[]>(initialState.messages);

  useEffect(() => {
    if (!persist) return;
    if (!activeChatId) return;

    const now = Date.now();
    setChatSessions((sessions) =>
      sessions.map((session) => {
        if (session.id !== activeChatId) return session;
        if (session.messages === messages) return session;
        return {
          ...session,
          title: getChatSessionTitle(messages),
          messages,
          updatedAt: now,
        };
      })
    );
  }, [activeChatId, messages, persist]);

  useEffect(() => {
    if (!persist) return;
    localStorage.setItem(CHAT_SESSIONS_STORAGE_KEY, JSON.stringify(chatSessions));
  }, [chatSessions, persist]);

  const applyUsageToSession = useCallback((sessionId: string, result: ChatExecutionResult, conversationMessages: Message[]) => {
    const now = Date.now();
    setChatSessions((sessions) =>
      sessions.map((session) => {
        if (session.id !== sessionId) return session;
        return {
          ...session,
          title: getChatSessionTitle(conversationMessages),
          updatedAt: now,
          usage: {
            requestCount: session.usage.requestCount + 1,
            promptTokens: session.usage.promptTokens + result.usage.promptTokens,
            completionTokens: session.usage.completionTokens + result.usage.completionTokens,
            totalTokens: session.usage.totalTokens + result.usage.totalTokens,
            totalCostUsd: session.usage.totalCostUsd + result.costUsd,
            lastModel: result.model,
            lastUsedAt: now,
            hasEstimatedUsage: session.usage.hasEstimatedUsage || result.estimated,
          },
        };
      })
    );
  }, []);

  const createSessionFromMessages = useCallback((conversationMessages: Message[]) => {
    const nextSession = createChatSession(conversationMessages);
    setActiveChatId(nextSession.id);
    setChatSessions((sessions) => [nextSession, ...sessions]);
    return nextSession;
  }, []);

  const resetActiveChat = useCallback(() => {
    setActiveChatId(null);
    setMessages([]);
  }, []);

  const selectChatSession = useCallback(
    (sessionId: string) => {
      const session = chatSessions.find((item) => item.id === sessionId);
      if (!session) return null;
      setActiveChatId(session.id);
      setMessages(session.messages);
      return session;
    },
    [chatSessions]
  );

  const renameChatSession = useCallback((sessionId: string, title: string) => {
    const nextTitle = title.trim();
    if (!nextTitle) return false;
    setChatSessions((sessions) =>
      sessions.map((session) => (session.id === sessionId ? { ...session, title: nextTitle } : session))
    );
    return true;
  }, []);

  const togglePinnedChatSession = useCallback((sessionId: string) => {
    let nextPinned = false;
    setChatSessions((sessions) =>
      sessions.map((session) => {
        if (session.id !== sessionId) return session;
        nextPinned = !session.pinned;
        return { ...session, pinned: nextPinned };
      })
    );
    return nextPinned;
  }, []);

  const deleteChatSession = useCallback(
    (sessionId: string) => {
      setChatSessions((sessions) => sessions.filter((session) => session.id !== sessionId));
      if (sessionId === activeChatId) {
        setActiveChatId(null);
        setMessages([]);
      }
    },
    [activeChatId]
  );

  const groupedChatSessions = useMemo(() => {
    const groups = new Map<string, ChatSession[]>();
    [...chatSessions]
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt)
      .forEach((session) => {
        const label = session.pinned ? "置顶" : getChatSessionGroupLabel(session.updatedAt);
        const list = groups.get(label) ?? [];
        list.push(session);
        groups.set(label, list);
      });

    return Array.from(groups.entries()).map(([label, sessions]) => ({ label, sessions }));
  }, [chatSessions]);

  const activeSession = useMemo(
    () => chatSessions.find((session) => session.id === activeChatId) ?? null,
    [activeChatId, chatSessions]
  );

  return {
    activeChatId,
    activeSession,
    applyUsageToSession,
    chatSessions,
    createSessionFromMessages,
    deleteChatSession,
    groupedChatSessions,
    messages,
    renameChatSession,
    resetActiveChat,
    selectChatSession,
    setActiveChatId,
    setChatSessions,
    setMessages,
    togglePinnedChatSession,
  };
}
