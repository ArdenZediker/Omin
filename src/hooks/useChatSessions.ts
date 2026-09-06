import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Message } from "../adapters/types";
import { requestConfirmation } from "../chat/confirmationGate";
import {
  getInitialProjectMemories,
  createChatSession,
  createCustomProject,
  createMainSession,
  DEFAULT_PROJECT_ID,
  MAIN_SESSION_ID,
  getChatSessionGroupLabel,
  getChatSessionTitle,
  getInitialProjects,
  getInitialChatSessions,
  getInitialSessionSummaries,
  getInitialScheduledTasks,
  getInitialUserPreferences,
  searchProjectMemories,
  searchSessionSummaries,
} from "../chat/storage";
import { loadPersistedChatState, savePersistedChatState, savePersistedMemoryState } from "../chat/persistence";
import { savePersistedAutomationState } from "../chat/persistence";
import { scheduleSessionMirror, clearSessionMirrorSchedule, deleteSessionMirrorFile } from "../chat/sessionMirror";
import { clearSessionArtifacts, notifyArtifactsChanged } from "../chat/artifacts";
import { isMirrorSessionsEnabled } from "../app/outputStorage";
import type {
  ProjectMemoryRecord,
  Project,
  ProjectDraft,
  ChatExecutionResult,
  ChatSession,
  ScheduledTaskRecord,
  SessionSummaryRecord,
  UserPreferenceRecord,
} from "../chat/types";

function createMemoryId() {
  return `memory-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function buildSessionSummary(messages: Message[], projectReply: string) {
  const userTurns = messages.filter((message) => message.role === "user").map((message) => message.content.trim()).filter(Boolean);
  const latestUser = userTurns[userTurns.length - 1] ?? "";
  const latestProject = projectReply.trim();
  const summaryParts = [latestUser, latestProject].filter(Boolean);
  const summary = summaryParts.join(" -> ");
  if (!summary) {
    return "";
  }
  return summary.length > 220 ? `${summary.slice(0, 217)}...` : summary;
}

function extractProjectMemories(messages: Message[]) {
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
    const initialProjects = getInitialProjects();
    const initialSessions = getInitialChatSessions();
    const initialProjectId = initialProjects[0]?.id ?? DEFAULT_PROJECT_ID;
    const initialSession = initialSessions.find((session) => session.projectId === initialProjectId) ?? null;

    return {
      projects: initialProjects,
      sessions: initialSessions,
      projectMemories: getInitialProjectMemories(),
      sessionSummaries: getInitialSessionSummaries(),
      scheduledTasks: getInitialScheduledTasks(),
      userPreferences: getInitialUserPreferences(),
      activeProjectId: initialProjectId,
      activeChatId: initialSession?.id ?? null,
      messages: initialSession?.messages ?? [],
    };
  });

  const [projects, setProjects] = useState<Project[]>(initialState.projects);
  const [chatSessions, setChatSessions] = useState<ChatSession[]>(initialState.sessions);
  const [projectMemories, setProjectMemories] = useState<ProjectMemoryRecord[]>(initialState.projectMemories);
  const [sessionSummaries, setSessionSummaries] = useState<SessionSummaryRecord[]>(initialState.sessionSummaries);
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTaskRecord[]>(initialState.scheduledTasks);
  const [userPreferences, setUserPreferences] = useState<UserPreferenceRecord[]>(initialState.userPreferences);
  const [activeProjectId, setActiveProjectId] = useState<string>(initialState.activeProjectId);
  const [activeChatId, setActiveChatId] = useState<string | null>(initialState.activeChatId);
  const [messages, setMessages] = useState<Message[]>(initialState.messages);
  const [isStorageHydrated, setIsStorageHydrated] = useState(!persist);
  const activeProjectIdRef = useRef(activeProjectId);
  const activeChatIdRef = useRef(activeChatId);
  const persistTimerRef = useRef<number | null>(null);
  const activeMessagesSyncTimerRef = useRef<number | null>(null);
  // 仅在「成功从存储加载过」的前提下才允许持久化写回。
  // 若加载抛异常（catch 分支），保持 false，避免把空回退状态写回数据库、
  // 从而把库里已有的会话清空（这正是「重启后记忆消失」的根因之一）。
  const hydratedWithDataRef = useRef(false);
  const projectsRef = useRef<Project[]>(projects);
  const chatSessionsRef = useRef<ChatSession[]>(chatSessions);

  useEffect(() => {
    activeProjectIdRef.current = activeProjectId;
  }, [activeProjectId]);

  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  useEffect(() => {
    chatSessionsRef.current = chatSessions;
  }, [chatSessions]);

  useEffect(() => {
    if (activeMessagesSyncTimerRef.current !== null) {
      window.clearTimeout(activeMessagesSyncTimerRef.current);
      activeMessagesSyncTimerRef.current = null;
    }

    if (!persist || !activeChatId) return;

    // Coalesce high-frequency stream updates to avoid re-rendering session lists
    // for every token chunk while keeping the active conversation in sync.
    activeMessagesSyncTimerRef.current = window.setTimeout(() => {
      activeMessagesSyncTimerRef.current = null;
      const now = Date.now();
      setChatSessions((sessions) => {
        let changed = false;
        const next = sessions.map((session) => {
          if (session.id !== activeChatId) return session;
          if (session.messages === messages) return session;
          changed = true;
          return {
            ...session,
            title: getChatSessionTitle(messages),
            messages,
            updatedAt: now,
          };
        });
        return changed ? next : sessions;
      });

      // 流式输出期间也防抖镜像活跃会话（开启开关时）。
      if (isMirrorSessionsEnabled() && activeChatId) {
        const meta = chatSessionsRef.current.find((session) => session.id === activeChatId);
        if (meta) {
          const project = projectsRef.current.find((p) => p.id === meta.projectId) ?? null;
          scheduleSessionMirror({ ...meta, messages, updatedAt: now }, project);
        }
      }
    }, 90);
  }, [activeChatId, messages, persist]);

  useEffect(() => {
    if (!persist) return;

    let cancelled = false;

    void loadPersistedChatState()
      .then(({ projects: nextProjects, sessions: loadedSessions, projectMemories: nextMemories, sessionSummaries: nextSummaries, userPreferences: nextPreferences, scheduledTasks: nextScheduledTasks }) => {
        if (cancelled) return;

        hydratedWithDataRef.current = true;

        // 确保主会话（Omni）专属会话存在：旧数据可能没有它，补建并置顶。
        let nextSessions = loadedSessions;
        if (!nextSessions.some((session) => session.id === MAIN_SESSION_ID)) {
          nextSessions = [createMainSession(), ...nextSessions];
        }

        const nextActiveProjectId =
          nextProjects.find((project) => project.id === activeProjectId)?.id ?? nextProjects[0]?.id ?? DEFAULT_PROJECT_ID;
        const nextActiveSession =
          nextSessions.find((session) => session.id === activeChatId && session.projectId === nextActiveProjectId) ??
          nextSessions.find((session) => session.projectId === nextActiveProjectId) ??
          null;

        setProjects(nextProjects);
        setChatSessions(nextSessions);
        setProjectMemories(nextMemories);
        setSessionSummaries(nextSummaries);
        setScheduledTasks(nextScheduledTasks);
        setUserPreferences(nextPreferences);
        activeProjectIdRef.current = nextActiveProjectId;
        activeChatIdRef.current = nextActiveSession?.id ?? null;
        setActiveProjectId(nextActiveProjectId);
        setActiveChatId(nextActiveSession?.id ?? null);
        setMessages(nextActiveSession?.messages ?? []);
        setIsStorageHydrated(true);
      })
      .catch(() => {
        if (!cancelled) {
          // 加载失败：仍让界面可用，但禁止后续持久化写回，
          // 防止用空回退状态覆盖数据库中可能仍存在的会话。
          hydratedWithDataRef.current = false;
          setIsStorageHydrated(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [persist]);

  useEffect(() => {
    if (!persist || !isStorageHydrated || !hydratedWithDataRef.current) return;

    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }

    // Streaming replies can update message state very frequently. Persist with debounce
    // to avoid high-frequency IPC/storage writes that cause UI and drag stutter.
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      void savePersistedChatState(projects, chatSessions);
      void savePersistedMemoryState(projectMemories, sessionSummaries, userPreferences);
      void savePersistedAutomationState(scheduledTasks);
    }, 260);
  }, [projects, chatSessions, projectMemories, sessionSummaries, scheduledTasks, userPreferences, isStorageHydrated, persist]);

  // 关闭窗口时尽力把最新状态写回，避免 260ms 防抖窗口内退出导致丢数据。
  useEffect(() => {
    const flush = () => {
      if (!hydratedWithDataRef.current) return;
      void savePersistedChatState(projects, chatSessions);
      void savePersistedMemoryState(projectMemories, sessionSummaries, userPreferences);
      void savePersistedAutomationState(scheduledTasks);
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
    };
  }, [projects, chatSessions, projectMemories, sessionSummaries, scheduledTasks, userPreferences]);

  useEffect(
    () => () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      if (activeMessagesSyncTimerRef.current !== null) {
        window.clearTimeout(activeMessagesSyncTimerRef.current);
        activeMessagesSyncTimerRef.current = null;
      }
    },
    []
  );

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? projects[0] ?? null,
    [activeProjectId, projects]
  );

  const projectSessions = useMemo(
    () => chatSessions.filter((session) => session.projectId === activeProjectId),
    [activeProjectId, chatSessions]
  );

  const activeSessionById = useMemo(
    () => chatSessions.find((session) => session.id === activeChatId) ?? null,
    [activeChatId, chatSessions]
  );

  const activeSession = useMemo(
    () => (activeSessionById && activeSessionById.projectId === activeProjectId ? activeSessionById : null),
    [activeProjectId, activeSessionById]
  );

  useEffect(() => {
    if (!activeChatId) {
      if (messages.length > 0) {
        setMessages([]);
      }
      return;
    }

    // Keep the active chat stable while session/project state is still converging.
    // Clear only when the chat id truly does not exist anymore.
    if (activeSessionById) {
      if (activeSessionById.projectId !== activeProjectId) {
        activeProjectIdRef.current = activeSessionById.projectId;
        setActiveProjectId(activeSessionById.projectId);
      }
      return;
    }

    activeChatIdRef.current = null;
    setActiveChatId(null);
    setMessages([]);
  }, [activeProjectId, activeChatId, activeSessionById, messages.length]);

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
            toolRounds: session.usage.toolRounds + (result.toolRounds ?? 0),
          },
        };
      })
    );
  }, []);

  const createSessionFromMessages = useCallback(
    (conversationMessages: Message[], projectId = activeProjectIdRef.current) => {
      const nextSession = createChatSession(conversationMessages, projectId);
      activeChatIdRef.current = nextSession.id;
      setActiveChatId(nextSession.id);
      setChatSessions((sessions) => [nextSession, ...sessions]);
      setMessages(conversationMessages);
      return nextSession;
    },
    []
  );

  const updateChatSessionMessages = useCallback((sessionId: string, nextMessages: Message[] | ((current: Message[]) => Message[])) => {
    const now = Date.now();
    const isActiveTarget = activeChatIdRef.current === sessionId;

    setChatSessions((sessions) => {
      const current = sessions.find((session) => session.id === sessionId);
      const currentMessages = current?.messages ?? [];
      const messagesForSession = typeof nextMessages === "function" ? nextMessages(currentMessages) : nextMessages;

      const updated: ChatSession = current
        ? { ...current, title: getChatSessionTitle(messagesForSession), messages: messagesForSession, updatedAt: now }
        : { ...createChatSession(messagesForSession), id: sessionId };

      const nextSessions = sessions.map((session) => (session.id === sessionId ? updated : session));

      // 在 setChatSessions 的 functional updater 内读取真实最新状态并同步更新 ref，
      // 保证同一 React 批次内多次调用 updateChatSessionMessages 时，后续调用能读到
      // 前一次的结果，避免 running 工具步骤被后续 settlement 等 updater 覆盖/误判为已中断。
      chatSessionsRef.current = nextSessions;

      if (isActiveTarget) {
        setMessages(messagesForSession);
      }

      // 开启「镜像对话为 Markdown」时，防抖地把这场对话写入其产出目录。
      if (isMirrorSessionsEnabled()) {
        const project = projectsRef.current.find((project) => project.id === updated.projectId) ?? null;
        scheduleSessionMirror(updated, project);
      }

      return nextSessions;
    });
  }, []);

  const selectProject = useCallback(
    (projectId: string) => {
      activeProjectIdRef.current = projectId;
      setActiveProjectId(projectId);
      const latestSession = [...chatSessions]
        .filter((session) => session.projectId === projectId)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];

      activeChatIdRef.current = latestSession?.id ?? null;
      setActiveChatId(latestSession?.id ?? null);
      setMessages(latestSession?.messages ?? []);
    },
    [chatSessions]
  );

  const createCustomProjectProfile = useCallback((input?: string | ProjectDraft) => {
    const nextInput: ProjectDraft =
      typeof input === "string"
        ? { title: input.trim() || "自定义助手" }
        : (input ?? {});

    const nextProject = createCustomProject(nextInput);

    setProjects((current) => [...current, nextProject]);
    activeProjectIdRef.current = nextProject.id;
    activeChatIdRef.current = null;
    setActiveProjectId(nextProject.id);
    setActiveChatId(null);
    setMessages([]);
    return nextProject;
  }, []);

  const updateProjectProfile = useCallback((projectId: string, patch: Partial<Project>) => {
    let updatedProject: Project | null = null;
    const now = Date.now();

    setProjects((current) =>
      current.map((project) => {
        if (project.id !== projectId) {
          return project;
        }

        updatedProject = {
          ...project,
          ...patch,
          title: typeof patch.title === "string" && patch.title.trim() ? patch.title.trim() : project.title,
          description: typeof patch.description === "string" && patch.description.trim() ? patch.description.trim() : project.description,
          groupName:
            typeof patch.groupName === "string"
              ? patch.groupName.trim() || null
              : patch.groupName === null
              ? null
              : project.groupName ?? null,
          updatedAt: now,
        };

        return updatedProject;
      })
    );

    return updatedProject;
  }, []);

  const deleteProjectProfile = useCallback(
    async (projectId: string): Promise<boolean> => {
      if (!projectId || projectId === DEFAULT_PROJECT_ID) {
        return false;
      }

      const target = projects.find((project) => project.id === projectId);
      if (!target || target.kind !== "custom") {
        return false;
      }

      const relatedSessionIds = new Set(
        chatSessions.filter((session) => session.projectId === projectId).map((session) => session.id)
      );

      const nextProjects = projects.filter((project) => project.id !== projectId);
      const nextSessions = chatSessions.filter((session) => session.projectId !== projectId);
      const nextMemories = projectMemories.filter((memory) => memory.projectId !== projectId);
      const nextSummaries = sessionSummaries.filter(
        (summary) => summary.projectId !== projectId && !relatedSessionIds.has(summary.sessionId)
      );
      const nextTasks = scheduledTasks.filter(
        (task) => !task.sessionId || !relatedSessionIds.has(task.sessionId)
      );

      setProjects(nextProjects);
      setChatSessions(nextSessions);
      setProjectMemories(nextMemories);
      setSessionSummaries(nextSummaries);
      setScheduledTasks(nextTasks);

      if (activeProjectId === projectId) {
        activeProjectIdRef.current = DEFAULT_PROJECT_ID;
        setActiveProjectId(DEFAULT_PROJECT_ID);
        const fallbackSession =
          nextSessions.filter((session) => session.projectId === DEFAULT_PROJECT_ID).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
        activeChatIdRef.current = fallbackSession?.id ?? null;
        setActiveChatId(fallbackSession?.id ?? null);
        setMessages(fallbackSession?.messages ?? []);
      } else if (activeChatId && relatedSessionIds.has(activeChatId)) {
        activeChatIdRef.current = null;
        setActiveChatId(null);
        setMessages([]);
      }

      try {
        await invoke("delete_project", { id: projectId });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("deleteProjectProfile: delete_project failed", error);
        // 即使后端删除失败，后续强制 flush 也会以当前 state（已移除该助手）为真相源重写数据库，
        // 借助 save_structured_chat_storage 现在会清理旧记录，避免"幽灵"助手复活。
      }

      try {
        await savePersistedChatState(nextProjects, nextSessions);
        await savePersistedMemoryState(nextMemories, nextSummaries, userPreferences);
        await savePersistedAutomationState(nextTasks);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("deleteProjectProfile: flush failed", error);
      }

      return true;
    },
    [activeProjectId, activeChatId, projects, chatSessions, projectMemories, sessionSummaries, scheduledTasks, userPreferences]
  );

  const resetActiveChat = useCallback(() => {
    activeChatIdRef.current = null;
    setActiveChatId(null);
    setMessages([]);
  }, []);

  const selectChatSession = useCallback(
    (sessionId: string) => {
      const session = chatSessions.find((item) => item.id === sessionId);
      if (!session) return null;
      activeProjectIdRef.current = session.projectId;
      activeChatIdRef.current = session.id;
      setActiveProjectId(session.projectId);
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
    async (sessionId: string): Promise<void> => {
      if (sessionId === MAIN_SESSION_ID) return; // 主会话（Omni）不可删除
      clearSessionMirrorSchedule(sessionId);
      const session = chatSessions.find((item) => item.id === sessionId);
      // 破坏性操作：删除后无回收站，必须用户过目确认（与 git 工具共用同一道确认门）。
      const approved = await requestConfirmation({
        source: "ui:delete_chat_session",
        title: "删除对话",
        summary: "永久删除这条对话记录，删除后无法从本地恢复。",
        riskLevel: "destructive",
        details: [{ label: "对话标题", value: session?.title || "(未命名对话)" }],
        targets: [session?.title || sessionId],
        warning:
          "删除后该对话的所有消息将从本地数据库移除，没有撤销入口。请确认你不再需要这条对话。",
        confirmLabel: "确认删除",
      });
      if (!approved) return;

      const nextSessions = chatSessions.filter((session) => session.id !== sessionId);
      setChatSessions(nextSessions);
      if (sessionId === activeChatId) {
        activeChatIdRef.current = null;
        setActiveChatId(null);
        setMessages([]);
      }

      // ---- 级联清理该会话关联的全部内容 ----
      // 1) 会话摘要（按 sessionId 过滤，避免孤儿记录）
      const nextSummaries = sessionSummaries.filter((summary) => summary.sessionId !== sessionId);
      // 2) 定时任务（按 sessionId 过滤，已删除会话不应再触发）
      const nextTasks = scheduledTasks.filter((task) => task.sessionId !== sessionId);
      // 3) 产物（按 项目 + 会话 过滤，清掉右侧「产物」面板里本会话的卡片）
      //    直接使用 session.projectId：产物正是按该 id 落库的，避免 project 查找为 null 时漏清。
      const sessionProject = projects.find((project) => project.id === session?.projectId) ?? null;
      if (session) {
        clearSessionArtifacts(session.projectId, session.id);
      }
      // 4) 对话镜像 .md 侧写文件（会话标题所在目录，按当前标题尽力删除）
      if (session) {
        void deleteSessionMirrorFile(session, sessionProject).catch(() => {});
      }

      setSessionSummaries(nextSummaries);
      setScheduledTasks(nextTasks);
      if (session) {
        notifyArtifactsChanged();
      }

      try {
        await invoke("delete_chat_session", { id: sessionId });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("deleteChatSession: delete_chat_session failed", error);
      }

      try {
        await savePersistedChatState(projects, nextSessions);
        await savePersistedMemoryState(projectMemories, nextSummaries, userPreferences);
        await savePersistedAutomationState(nextTasks);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("deleteChatSession: flush failed", error);
      }
    },
    [activeChatId, projects, chatSessions, projectMemories, sessionSummaries, scheduledTasks, userPreferences]
  );

  const groupedChatSessions = useMemo(() => {
    const groups = new Map<string, ChatSession[]>();
    [...projectSessions]
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt)
      .forEach((session) => {
        const label = session.pinned ? "置顶" : getChatSessionGroupLabel(session.updatedAt);
        const list = groups.get(label) ?? [];
        list.push(session);
        groups.set(label, list);
      });

    return Array.from(groups.entries()).map(([label, sessions]) => ({ label, sessions }));
  }, [projectSessions]);

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

  const getProjectMemories = useCallback(
    (projectId: string) =>
      projectMemories
        .filter((memory) => memory.projectId === projectId)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [projectMemories]
  );

  const addProjectMemory = useCallback((projectId: string, content: string, sourceSessionId?: string | null, sourceType: ProjectMemoryRecord["sourceType"] = "manual") => {
    const nextContent = content.trim();
    if (!projectId || nextContent.length < 4) {
      return false;
    }

    let added = false;
    const now = Date.now();
    setProjectMemories((current) => {
      const exists = current.some((memory) => memory.projectId === projectId && memory.content === nextContent);
      if (exists) {
        return current;
      }
      added = true;
      return [
        {
          id: createMemoryId(),
          projectId,
          content: nextContent.length > 120 ? `${nextContent.slice(0, 117)}...` : nextContent,
          sourceSessionId: sourceSessionId ?? null,
          sourceType,
          createdAt: now,
          updatedAt: now,
        },
        ...current,
      ].slice(0, 300);
    });
    return added;
  }, []);

  const deleteProjectMemory = useCallback((memoryId: string) => {
    let deleted = false;
    setProjectMemories((current) => {
      const next = current.filter((memory) => memory.id !== memoryId);
      deleted = next.length !== current.length;
      return deleted ? next : current;
    });
    return deleted;
  }, []);

  const clearProjectMemories = useCallback((projectId: string) => {
    if (!projectId) {
      return 0;
    }

    let removedCount = 0;
    setProjectMemories((current) => {
      const next = current.filter((memory) => memory.projectId !== projectId);
      removedCount = current.length - next.length;
      return removedCount > 0 ? next : current;
    });
    return removedCount;
  }, []);

  const updateProjectMemory = useCallback((memoryId: string, content: string) => {
    const nextContent = content.trim();
    if (!nextContent) {
      return false;
    }

    let updated = false;
    const now = Date.now();
    setProjectMemories((current) =>
      current.map((memory) => {
        if (memory.id !== memoryId) return memory;
        updated = true;
        return {
          ...memory,
          content: nextContent,
          updatedAt: now,
        };
      })
    );
    return updated;
  }, []);

  const getRelatedContextForProject = useCallback(
    (query: string) => {
      if (!activeProject) {
        return {
          summaries: [],
          memories: [],
        };
      }

      if (activeProject.memoryScope === "off") {
        return {
          summaries: [],
          memories: [],
        };
      }

      const normalizedQuery = query.trim();
      if (!normalizedQuery) {
        return {
          summaries: [],
          memories: [],
        };
      }

      const summaryMatches = searchSessionSummaries(sessionSummaries, normalizedQuery)
        .filter((item) => {
          if (activeProject.memoryScope === "session") {
            return item.sessionId === activeChatId;
          }
          return item.projectId === activeProjectId;
        })
        .slice(0, 5);
      const memoryMatches = searchProjectMemories(projectMemories, activeProjectId, normalizedQuery)
        .filter((item) => {
          if (activeProject.memoryScope === "session") {
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
    [activeProject, activeProjectId, activeChatId, projectMemories, sessionSummaries]
  );

  const commitProjectMemory = useCallback(
    (sessionId: string, conversationMessages: Message[], result: ChatExecutionResult) => {
      const project = projects.find((item) => item.id === activeProjectId) ?? activeProject;
      if (!project) {
        return;
      }

      const now = Date.now();

      const summary = result.suggestedSummary?.summary ?? buildSessionSummary(conversationMessages, result.content);
      if (summary) {
        setSessionSummaries((current) => {
          const nextTitle = result.suggestedSummary?.title?.trim() || getChatSessionTitle(conversationMessages);
          const existingIndex = current.findIndex((item) => item.sessionId === sessionId);
          if (existingIndex >= 0) {
            const next = [...current];
            next[existingIndex] = {
              ...next[existingIndex],
              projectId: project.id,
              title: nextTitle,
              summary,
              updatedAt: now,
            };
            return next;
          }

          return [
            {
              sessionId,
              projectId: project.id,
              title: nextTitle,
              summary,
              updatedAt: now,
            },
            ...current,
          ].slice(0, 200);
        });
      }

      const modelMemoryItems = (result.suggestedMemories ?? []).map((memory) => memory.content);
      const memoryItems = modelMemoryItems.length > 0 ? modelMemoryItems : extractProjectMemories(conversationMessages);
      if (memoryItems.length > 0) {
        setProjectMemories((current) => {
          const existingKeys = new Set(current.filter((item) => item.projectId === project.id).map((item) => item.content));
          const additions = memoryItems
            .filter((content) => !existingKeys.has(content))
            .map((content) => ({
              id: createMemoryId(),
              projectId: project.id,
              content,
              sourceSessionId: sessionId,
              sourceType: "auto" as const,
              createdAt: now,
              updatedAt: now,
            }));

          if (additions.length === 0) {
            return current;
          }

          return [...additions, ...current].slice(0, 300);
        });
      }
    },
    [activeProject, activeProjectId, projects]
  );

  return {
    activeProject,
    activeProjectId,
    activeChatId,
    activeSession,
    applyUsageToSession,
    projectSessions,
    projects,
    chatSessions,
    commitProjectMemory,
    createCustomProjectProfile,
    createSessionFromMessages,
    deleteChatSession,
    getChatSessionById,
    addProjectMemory,
    getProjectMemories,
    getRelatedContextForProject,
    groupedChatSessions,
    messages,
    renameChatSession,
    resetActiveChat,
    searchChatSessions,
    scheduledTasks,
    selectProject,
    selectChatSession,
    setActiveProjectId,
    setActiveChatId,
    setProjects,
    setProjectMemories,
    setChatSessions,
    setMessages,
    updateChatSessionMessages,
    setSessionSummaries,
    setScheduledTasks,
    setUserPreferences,
    toggleFavoriteChatSession,
    togglePinnedChatSession,
    deleteProjectProfile,
    deleteProjectMemory,
    clearProjectMemories,
    updateProjectMemory,
    updateProjectProfile,
  };
}
