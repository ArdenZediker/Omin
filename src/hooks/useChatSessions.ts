import { useCallback, useEffect, useMemo, useState } from "react";
import type { Message } from "../adapters/types";
import {
  createChatSession,
  createCustomAssistant,
  DEFAULT_ASSISTANT_ID,
  getChatSessionGroupLabel,
  getChatSessionTitle,
  getInitialAssistants,
  getInitialChatSessions,
} from "../chat/storage";
import { loadPersistedChatState, savePersistedChatState } from "../chat/persistence";
import type { AssistantProfile, ChatExecutionResult, ChatSession } from "../chat/types";

type UseChatSessionsOptions = {
  persist: boolean;
};

export function useChatSessions({ persist }: UseChatSessionsOptions) {
  const [initialState] = useState(() => {
    const initialAssistants = getInitialAssistants();
    const initialSessions = getInitialChatSessions();
    const initialAssistantId = initialAssistants[0]?.id ?? DEFAULT_ASSISTANT_ID;
    const initialSession = initialSessions.find((session) => session.assistantId === initialAssistantId) ?? null;

    return {
      assistants: initialAssistants,
      sessions: initialSessions,
      activeAssistantId: initialAssistantId,
      activeChatId: initialSession?.id ?? null,
      messages: initialSession?.messages ?? [],
    };
  });

  const [assistants, setAssistants] = useState<AssistantProfile[]>(initialState.assistants);
  const [chatSessions, setChatSessions] = useState<ChatSession[]>(initialState.sessions);
  const [activeAssistantId, setActiveAssistantId] = useState<string>(initialState.activeAssistantId);
  const [activeChatId, setActiveChatId] = useState<string | null>(initialState.activeChatId);
  const [messages, setMessages] = useState<Message[]>(initialState.messages);
  const [isStorageHydrated, setIsStorageHydrated] = useState(!persist);

  useEffect(() => {
    if (!persist || !activeChatId) return;

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

    let cancelled = false;

    void loadPersistedChatState().then(({ assistants: nextAssistants, sessions: nextSessions }) => {
      if (cancelled) return;

      const nextActiveAssistantId = nextAssistants.find((assistant) => assistant.id === activeAssistantId)?.id
        ?? nextAssistants[0]?.id
        ?? DEFAULT_ASSISTANT_ID;
      const nextActiveSession =
        nextSessions.find((session) => session.id === activeChatId && session.assistantId === nextActiveAssistantId)
        ?? nextSessions.find((session) => session.assistantId === nextActiveAssistantId)
        ?? null;

      setAssistants(nextAssistants);
      setChatSessions(nextSessions);
      setActiveAssistantId(nextActiveAssistantId);
      setActiveChatId(nextActiveSession?.id ?? null);
      setMessages(nextActiveSession?.messages ?? []);
      setIsStorageHydrated(true);
    }).catch(() => {
      if (!cancelled) {
        setIsStorageHydrated(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [persist]);

  useEffect(() => {
    if (!persist || !isStorageHydrated) return;
    void savePersistedChatState(assistants, chatSessions);
  }, [assistants, chatSessions, isStorageHydrated, persist]);

  const activeAssistant = useMemo(
    () => assistants.find((assistant) => assistant.id === activeAssistantId) ?? assistants[0] ?? null,
    [activeAssistantId, assistants]
  );

  const assistantSessions = useMemo(
    () => chatSessions.filter((session) => session.assistantId === activeAssistantId),
    [activeAssistantId, chatSessions]
  );

  const activeSession = useMemo(
    () => chatSessions.find((session) => session.id === activeChatId) ?? null,
    [activeChatId, chatSessions]
  );

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

  const createSessionFromMessages = useCallback(
    (conversationMessages: Message[]) => {
      const nextSession = createChatSession(conversationMessages, activeAssistantId);
      setActiveChatId(nextSession.id);
      setChatSessions((sessions) => [nextSession, ...sessions]);
      return nextSession;
    },
    [activeAssistantId]
  );

  const selectAssistant = useCallback(
    (assistantId: string) => {
      setActiveAssistantId(assistantId);
      const latestSession = [...chatSessions]
        .filter((session) => session.assistantId === assistantId)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];

      setActiveChatId(latestSession?.id ?? null);
      setMessages(latestSession?.messages ?? []);
    },
    [chatSessions]
  );

  const createCustomAssistantProfile = useCallback((title?: string) => {
    const nextAssistant = createCustomAssistant({
      title: title?.trim() || "自定义助手",
    });

    setAssistants((current) => [...current, nextAssistant]);
    setActiveAssistantId(nextAssistant.id);
    setActiveChatId(null);
    setMessages([]);
    return nextAssistant;
  }, []);

  const updateAssistantProfile = useCallback((assistantId: string, patch: Partial<AssistantProfile>) => {
    let updatedAssistant: AssistantProfile | null = null;
    const now = Date.now();

    setAssistants((current) =>
      current.map((assistant) => {
        if (assistant.id !== assistantId) {
          return assistant;
        }

        updatedAssistant = {
          ...assistant,
          ...patch,
          title: typeof patch.title === "string" && patch.title.trim() ? patch.title.trim() : assistant.title,
          description:
            typeof patch.description === "string" && patch.description.trim() ? patch.description.trim() : assistant.description,
          updatedAt: now,
        };

        return updatedAssistant;
      })
    );

    return updatedAssistant;
  }, []);

  const resetActiveChat = useCallback(() => {
    setActiveChatId(null);
    setMessages([]);
  }, []);

  const selectChatSession = useCallback(
    (sessionId: string) => {
      const session = chatSessions.find((item) => item.id === sessionId);
      if (!session) return null;
      setActiveAssistantId(session.assistantId);
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

  const toggleFavoriteChatSession = useCallback((sessionId: string) => {
    let nextFavorite = false;
    setChatSessions((sessions) =>
      sessions.map((session) => {
        if (session.id !== sessionId) return session;
        nextFavorite = !session.favorite;
        return { ...session, favorite: nextFavorite };
      })
    );
    return nextFavorite;
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
    [...assistantSessions]
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt)
      .forEach((session) => {
        const label = session.pinned ? "置顶" : getChatSessionGroupLabel(session.updatedAt);
        const list = groups.get(label) ?? [];
        list.push(session);
        groups.set(label, list);
      });

    return Array.from(groups.entries()).map(([label, sessions]) => ({ label, sessions }));
  }, [assistantSessions]);

  const searchChatSessions = useCallback(
    (query: string) => {
      const normalizedQuery = query.trim().toLowerCase();
      const scope = chatSessions;
      if (!normalizedQuery) {
        return scope;
      }

      return scope.filter((session) => {
        if (session.title.toLowerCase().includes(normalizedQuery)) {
          return true;
        }
        return session.messages.some((message) => message.content.toLowerCase().includes(normalizedQuery));
      });
    },
    [chatSessions]
  );

  const getChatSessionById = useCallback(
    (sessionId: string) => chatSessions.find((session) => session.id === sessionId) ?? null,
    [chatSessions]
  );

  return {
    activeAssistant,
    activeAssistantId,
    activeChatId,
    activeSession,
    applyUsageToSession,
    assistantSessions,
    assistants,
    chatSessions,
    createCustomAssistantProfile,
    createSessionFromMessages,
    deleteChatSession,
    getChatSessionById,
    groupedChatSessions,
    messages,
    renameChatSession,
    resetActiveChat,
    searchChatSessions,
    selectAssistant,
    selectChatSession,
    setActiveAssistantId,
    setActiveChatId,
    setAssistants,
    setChatSessions,
    setMessages,
    toggleFavoriteChatSession,
    togglePinnedChatSession,
    updateAssistantProfile,
  };
}
