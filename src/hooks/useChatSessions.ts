import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Message } from "../adapters/types";
import {
  getInitialAssistantMemories,
  createChatSession,
  createCustomAssistant,
  DEFAULT_ASSISTANT_ID,
  getChatSessionGroupLabel,
  getChatSessionTitle,
  getInitialAssistants,
  getInitialChatSessions,
  getInitialSessionSummaries,
  getInitialScheduledTasks,
  getInitialUserPreferences,
  searchAssistantMemories,
  searchSessionSummaries,
} from "../chat/storage";
import { loadPersistedChatState, savePersistedChatState, savePersistedMemoryState } from "../chat/persistence";
import { savePersistedAutomationState } from "../chat/persistence";
import type {
  AssistantMemoryRecord,
  AssistantProfile,
  AssistantProfileDraft,
  ChatExecutionResult,
  ChatSession,
  ScheduledTaskRecord,
  SessionSummaryRecord,
  UserPreferenceRecord,
} from "../chat/types";

function createMemoryId() {
  return `memory-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function buildSessionSummary(messages: Message[], assistantReply: string) {
  const userTurns = messages.filter((message) => message.role === "user").map((message) => message.content.trim()).filter(Boolean);
  const latestUser = userTurns[userTurns.length - 1] ?? "";
  const latestAssistant = assistantReply.trim();
  const summaryParts = [latestUser, latestAssistant].filter(Boolean);
  const summary = summaryParts.join(" -> ");
  if (!summary) {
    return "";
  }
  return summary.length > 220 ? `${summary.slice(0, 217)}...` : summary;
}

function extractAssistantMemories(messages: Message[]) {
  const memorySignals = ["记住", "偏好", "习惯", "以后", "默认", "总是", "不要", "优先", "我希望", "请用"];
  const userMessages = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter(Boolean);

  const candidates = userMessages
    .flatMap((content) => content.split(/[\n。；;]+/))
    .map((item) => item.trim())
    .filter((item) => item.length >= 6 && item.length <= 120)
    .filter((item) => memorySignals.some((signal) => item.includes(signal)));

  return [...new Set(candidates)].slice(0, 3);
}

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
      assistantMemories: getInitialAssistantMemories(),
      sessionSummaries: getInitialSessionSummaries(),
      scheduledTasks: getInitialScheduledTasks(),
      userPreferences: getInitialUserPreferences(),
      activeAssistantId: initialAssistantId,
      activeChatId: initialSession?.id ?? null,
      messages: initialSession?.messages ?? [],
    };
  });

  const [assistants, setAssistants] = useState<AssistantProfile[]>(initialState.assistants);
  const [chatSessions, setChatSessions] = useState<ChatSession[]>(initialState.sessions);
  const [assistantMemories, setAssistantMemories] = useState<AssistantMemoryRecord[]>(initialState.assistantMemories);
  const [sessionSummaries, setSessionSummaries] = useState<SessionSummaryRecord[]>(initialState.sessionSummaries);
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTaskRecord[]>(initialState.scheduledTasks);
  const [userPreferences, setUserPreferences] = useState<UserPreferenceRecord[]>(initialState.userPreferences);
  const [activeAssistantId, setActiveAssistantId] = useState<string>(initialState.activeAssistantId);
  const [activeChatId, setActiveChatId] = useState<string | null>(initialState.activeChatId);
  const [messages, setMessages] = useState<Message[]>(initialState.messages);
  const [isStorageHydrated, setIsStorageHydrated] = useState(!persist);
  const activeChatIdRef = useRef(activeChatId);

  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

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

    void loadPersistedChatState()
      .then(({ assistants: nextAssistants, sessions: nextSessions, assistantMemories: nextMemories, sessionSummaries: nextSummaries, userPreferences: nextPreferences, scheduledTasks: nextScheduledTasks }) => {
        if (cancelled) return;

        const nextActiveAssistantId =
          nextAssistants.find((assistant) => assistant.id === activeAssistantId)?.id ?? nextAssistants[0]?.id ?? DEFAULT_ASSISTANT_ID;
        const nextActiveSession =
          nextSessions.find((session) => session.id === activeChatId && session.assistantId === nextActiveAssistantId) ??
          nextSessions.find((session) => session.assistantId === nextActiveAssistantId) ??
          null;

        setAssistants(nextAssistants);
        setChatSessions(nextSessions);
        setAssistantMemories(nextMemories);
        setSessionSummaries(nextSummaries);
        setScheduledTasks(nextScheduledTasks);
        setUserPreferences(nextPreferences);
        setActiveAssistantId(nextActiveAssistantId);
        setActiveChatId(nextActiveSession?.id ?? null);
        setMessages(nextActiveSession?.messages ?? []);
        setIsStorageHydrated(true);
      })
      .catch(() => {
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
    void savePersistedMemoryState(assistantMemories, sessionSummaries, userPreferences);
    void savePersistedAutomationState(scheduledTasks);
  }, [assistants, chatSessions, assistantMemories, sessionSummaries, scheduledTasks, userPreferences, isStorageHydrated, persist]);

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

  const updateChatSessionMessages = useCallback((sessionId: string, nextMessages: Message[] | ((current: Message[]) => Message[])) => {
    const now = Date.now();
    let resolvedMessages: Message[] | null = null;

    setChatSessions((sessions) =>
      sessions.map((session) => {
        if (session.id !== sessionId) return session;
        const messagesForSession = typeof nextMessages === "function" ? nextMessages(session.messages) : nextMessages;
        resolvedMessages = messagesForSession;
        return {
          ...session,
          title: getChatSessionTitle(messagesForSession),
          messages: messagesForSession,
          updatedAt: now,
        };
      })
    );

    if (activeChatIdRef.current === sessionId && resolvedMessages) {
      setMessages(resolvedMessages);
    }
  }, []);

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

  const createCustomAssistantProfile = useCallback((input?: string | AssistantProfileDraft) => {
    const nextInput: AssistantProfileDraft =
      typeof input === "string"
        ? { title: input.trim() || "自定义助手" }
        : (input ?? {});

    const nextAssistant = createCustomAssistant(nextInput);

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
          description: typeof patch.description === "string" && patch.description.trim() ? patch.description.trim() : assistant.description,
          groupName:
            typeof patch.groupName === "string"
              ? patch.groupName.trim() || null
              : patch.groupName === null
              ? null
              : assistant.groupName ?? null,
          updatedAt: now,
        };

        return updatedAssistant;
      })
    );

    return updatedAssistant;
  }, []);

  const deleteAssistantProfile = useCallback(
    (assistantId: string) => {
      if (!assistantId || assistantId === DEFAULT_ASSISTANT_ID) {
        return false;
      }

      let removed = false;
      const relatedSessionIds = new Set(chatSessions.filter((session) => session.assistantId === assistantId).map((session) => session.id));

      setAssistants((current) => {
        const target = current.find((assistant) => assistant.id === assistantId);
        if (!target || target.kind !== "custom") {
          removed = false;
          return current;
        }
        removed = true;
        return current.filter((assistant) => assistant.id !== assistantId);
      });

      if (!removed) {
        return false;
      }

      setChatSessions((current) => current.filter((session) => session.assistantId !== assistantId));
      setAssistantMemories((current) => current.filter((memory) => memory.assistantId !== assistantId));
      setSessionSummaries((current) => current.filter((summary) => summary.assistantId !== assistantId && !relatedSessionIds.has(summary.sessionId)));
      setScheduledTasks((current) => current.filter((task) => !task.sessionId || !relatedSessionIds.has(task.sessionId)));

      if (activeAssistantId === assistantId) {
        setActiveAssistantId(DEFAULT_ASSISTANT_ID);
        const fallbackSession = chatSessions
          .filter((session) => session.assistantId === DEFAULT_ASSISTANT_ID)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
        setActiveChatId(fallbackSession?.id ?? null);
        setMessages(fallbackSession?.messages ?? []);
      } else if (activeChatId && chatSessions.some((session) => session.id === activeChatId && session.assistantId === assistantId)) {
        setActiveChatId(null);
        setMessages([]);
      }

      return true;
    },
    [activeAssistantId, activeChatId, chatSessions]
  );

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
    setChatSessions((sessions) => sessions.map((session) => (session.id === sessionId ? { ...session, title: nextTitle } : session)));
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

  const getChatSessionById = useCallback((sessionId: string) => chatSessions.find((session) => session.id === sessionId) ?? null, [chatSessions]);

  const getRelatedContextForAssistant = useCallback(
    (query: string) => {
      if (!activeAssistant) {
        return {
          summaries: [],
          memories: [],
        };
      }

      if (activeAssistant.memoryScope === "off") {
        return {
          summaries: [],
          memories: [],
        };
      }

      const summaryMatches = searchSessionSummaries(sessionSummaries, query)
        .filter((item) => {
          if (activeAssistant.memoryScope === "session") {
            return item.sessionId === activeChatId;
          }
          return item.assistantId === activeAssistantId;
        })
        .slice(0, 5);
      const memoryMatches = searchAssistantMemories(assistantMemories, activeAssistantId, query)
        .filter((item) => {
          if (activeAssistant.memoryScope === "session") {
            return item.sourceSessionId === activeChatId;
          }
          return true;
        })
        .slice(0, 5);
      return {
        summaries: summaryMatches,
        memories: memoryMatches,
      };
    },
    [activeAssistant, activeAssistantId, activeChatId, assistantMemories, sessionSummaries]
  );

  const commitAssistantMemory = useCallback(
    (sessionId: string, conversationMessages: Message[], assistantReply: string) => {
      const assistant = assistants.find((item) => item.id === activeAssistantId) ?? activeAssistant;
      if (!assistant) {
        return;
      }

      const now = Date.now();

      if (assistant.autoSaveSummaries) {
        const summary = buildSessionSummary(conversationMessages, assistantReply);
        if (summary) {
          setSessionSummaries((current) => {
            const nextTitle = getChatSessionTitle(conversationMessages);
            const existingIndex = current.findIndex((item) => item.sessionId === sessionId);
            if (existingIndex >= 0) {
              const next = [...current];
              next[existingIndex] = {
                ...next[existingIndex],
                assistantId: assistant.id,
                title: nextTitle,
                summary,
                updatedAt: now,
              };
              return next;
            }

            return [
              {
                sessionId,
                assistantId: assistant.id,
                title: nextTitle,
                summary,
                updatedAt: now,
              },
              ...current,
            ].slice(0, 200);
          });
        }
      }

      if (assistant.autoSaveMemories) {
        const memoryItems = extractAssistantMemories(conversationMessages);
        if (memoryItems.length > 0) {
          setAssistantMemories((current) => {
            const existingKeys = new Set(current.filter((item) => item.assistantId === assistant.id).map((item) => item.content));
            const additions = memoryItems
              .filter((content) => !existingKeys.has(content))
              .map((content) => ({
                id: createMemoryId(),
                assistantId: assistant.id,
                content,
                sourceSessionId: sessionId,
                createdAt: now,
                updatedAt: now,
              }));

            if (additions.length === 0) {
              return current;
            }

            return [...additions, ...current].slice(0, 300);
          });
        }
      }
    },
    [activeAssistant, activeAssistantId, assistants]
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
    commitAssistantMemory,
    createCustomAssistantProfile,
    createSessionFromMessages,
    deleteChatSession,
    getChatSessionById,
    getRelatedContextForAssistant,
    groupedChatSessions,
    messages,
    renameChatSession,
    resetActiveChat,
    searchChatSessions,
    scheduledTasks,
    selectAssistant,
    selectChatSession,
    setActiveAssistantId,
    setActiveChatId,
    setAssistants,
    setAssistantMemories,
    setChatSessions,
    setMessages,
    updateChatSessionMessages,
    setSessionSummaries,
    setScheduledTasks,
    setUserPreferences,
    toggleFavoriteChatSession,
    togglePinnedChatSession,
    deleteAssistantProfile,
    updateAssistantProfile,
  };
}
