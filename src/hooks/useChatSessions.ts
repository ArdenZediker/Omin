import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Message } from "../adapters/types";
import { requestConfirmation } from "../chat/confirmationGate";
import {
  getInitialProjectMemories,
  createChatSession,
  createCustomProject,
  DEFAULT_PROJECT_ID,
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
import {
  loadPersistedChatState,
  savePersistedChatSessions,
  savePersistedChatState,
  savePersistedMemoryState,
} from "../chat/persistence";
import { savePersistedAutomationState } from "../chat/persistence";
import {
  broadcastChatStorageSync,
  collectOwnedSessionUpdates,
  diffSyncCollection,
  getChatSyncSource,
  isProjectSynced,
  isSessionSynced,
  mergeRemoteCollection,
  shouldAdoptRemoteProject,
  shouldAdoptRemoteSession,
  subscribeToChatStorageSync,
  type ChatStorageSyncRole,
} from "../chat/crossWindowSync";
import { clearProjectArtifacts, clearSessionArtifacts } from "../chat/artifacts";
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
  /**
   * 持久化角色（详见 `chat/crossWindowSync.ts`）：
   * - `owner`（默认，主窗）：唯一持有**整快照写权**，负责幽灵清理；
   * - `follower`（紧凑窗）：只**窄写**自己创建的会话，其余状态只跟随 owner 广播。
   *
   * ⚠️ 两个窗口都用 `owner` 会互相整快照覆盖 ⇒ 会话「删了又自己回来」。
   */
  role?: ChatStorageSyncRole;
};

export function useChatSessions({ persist, role = "owner" }: UseChatSessionsOptions) {
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
  /** 本窗口创建的会话 id —— follower 只窄写这些（其余会话都是 owner 的副本）。 */
  const ownedSessionIdsRef = useRef<Set<string>>(new Set());
  /** 跨窗口增量同步的游标：上一轮广播出去的状态（只在 owner 侧使用）。 */
  const syncCursorRef = useRef<{ sessions: ChatSession[]; projects: Project[] } | null>(null);
  /** follower 侧：上一轮广播过的「自己拥有的会话」，用于避免重复广播。 */
  const lastBroadcastOwnedRef = useRef<Map<string, ChatSession>>(new Map());
  const [syncSource] = useState(() => getChatSyncSource());

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
    }, 90);
  }, [activeChatId, messages, persist]);

  useEffect(() => {
    if (!persist) return;

    let cancelled = false;

    void loadPersistedChatState()
      .then(({ projects: nextProjects, sessions: loadedSessions, projectMemories: nextMemories, sessionSummaries: nextSummaries, userPreferences: nextPreferences, scheduledTasks: nextScheduledTasks }) => {
        if (cancelled) return;

        hydratedWithDataRef.current = true;

        const nextSessions = loadedSessions;

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

        // 以「刚加载到的状态」作为跨窗口增量同步的基线：另一个窗口此刻持有同一份
        // 基线，所以此后只需要广播变化量，不必每次广播整份快照。
        syncCursorRef.current = { sessions: nextSessions, projects: nextProjects };
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

  /**
   * 一次「本地状态 → 磁盘」的落盘。
   * owner：整快照（含幽灵清理）；follower：只窄写自己拥有的会话。
   */
  const persistLocalState = useCallback(
    (state: {
      projects: Project[];
      sessions: ChatSession[];
      memories: ProjectMemoryRecord[];
      summaries: SessionSummaryRecord[];
      preferences: UserPreferenceRecord[];
      tasks: ScheduledTaskRecord[];
    }) => {
      if (role === "follower") {
        // 紧凑窗内存里的快照不完整：可能缺少主窗新建的会话，也可能残留已被删除的会话。
        // 整快照落盘会把这两类错误原样写回数据库（幽灵复活 / 幽灵清理）—— 只写自己创建的。
        const owned = state.sessions.filter((session) => ownedSessionIdsRef.current.has(session.id));
        if (owned.length > 0) {
          void savePersistedChatSessions(owned);
        }
        // 记忆 / 自动化同理：真相源在主窗，紧凑窗手里的是启动时加载的陈旧副本，
        // 写回去只会把主窗刚提交的摘要、记忆、偏好整批覆盖掉。
        return;
      }

      void savePersistedChatState(state.projects, state.sessions);
      void savePersistedMemoryState(state.memories, state.summaries, state.preferences);
      void savePersistedAutomationState(state.tasks);
    },
    [role]
  );

  /**
   * 把本地变化广播给另一个窗口（详见 `chat/crossWindowSync.ts`）。
   * owner 广播「会话/项目的增量 + 删除」；follower 只广播自己拥有的会话。
   * 关键是让**对方知道某会话已被删除** —— 否则对方内存里的陈旧副本还会被写回数据库。
   */
  const broadcastLocalChanges = useCallback(
    (projectsArg: Project[], sessionsArg: ChatSession[]) => {
      if (role === "follower") {
        const upserts = collectOwnedSessionUpdates(
          ownedSessionIdsRef.current,
          sessionsArg,
          lastBroadcastOwnedRef.current
        );
        if (upserts.length === 0) return;
        broadcastChatStorageSync({
          source: syncSource,
          role,
          sessionUpserts: upserts,
          sessionDeletes: [],
          projectUpserts: [],
          projectDeletes: [],
        });
        return;
      }

      const previous = syncCursorRef.current;
      syncCursorRef.current = { sessions: sessionsArg, projects: projectsArg };
      if (!previous) return;

      const sessionDelta = diffSyncCollection(previous.sessions, sessionsArg, isSessionSynced);
      const projectDelta = diffSyncCollection(previous.projects, projectsArg, isProjectSynced);
      if (
        sessionDelta.upserts.length === 0 &&
        sessionDelta.deletes.length === 0 &&
        projectDelta.upserts.length === 0 &&
        projectDelta.deletes.length === 0
      ) {
        return;
      }

      broadcastChatStorageSync({
        source: syncSource,
        role,
        sessionUpserts: sessionDelta.upserts,
        sessionDeletes: sessionDelta.deletes,
        projectUpserts: projectDelta.upserts,
        projectDeletes: projectDelta.deletes,
      });
    },
    [role, syncSource]
  );

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
      persistLocalState({
        projects,
        sessions: chatSessions,
        memories: projectMemories,
        summaries: sessionSummaries,
        preferences: userPreferences,
        tasks: scheduledTasks,
      });
      broadcastLocalChanges(projects, chatSessions);
    }, 260);
  }, [
    projects,
    chatSessions,
    projectMemories,
    sessionSummaries,
    scheduledTasks,
    userPreferences,
    isStorageHydrated,
    persist,
    persistLocalState,
    broadcastLocalChanges,
  ]);

  // 关闭窗口时尽力把最新状态写回，避免 260ms 防抖窗口内退出导致丢数据。
  useEffect(() => {
    const flush = () => {
      if (!hydratedWithDataRef.current) return;
      persistLocalState({
        projects,
        sessions: chatSessions,
        memories: projectMemories,
        summaries: sessionSummaries,
        preferences: userPreferences,
        tasks: scheduledTasks,
      });
      broadcastLocalChanges(projects, chatSessions);
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
    };
  }, [
    projects,
    chatSessions,
    projectMemories,
    sessionSummaries,
    scheduledTasks,
    userPreferences,
    persistLocalState,
    broadcastLocalChanges,
  ]);

  // 接收另一个窗口的增量并并入内存，使两窗快照收敛。
  // 合并走 functional updater（永远基于最新 state），无变化时返回原数组，
  // 避免「相同数据反复 setState → 再广播 → 回声」的死循环。
  useEffect(() => {
    if (!persist) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void subscribeToChatStorageSync((payload) => {
      if (disposed || payload.source === syncSource) return;

      const remoteSessions = {
        upserts: payload.sessionUpserts ?? [],
        deletes: payload.sessionDeletes ?? [],
      };
      const remoteProjects = {
        upserts: payload.projectUpserts ?? [],
        deletes: payload.projectDeletes ?? [],
      };

      // 被远端删除的会话要同步从「本窗口拥有的会话」里摘掉，
      // 否则 follower 的窄写会在下一轮把它重新 upsert 回数据库（复活路径之一）。
      for (const id of remoteSessions.deletes) {
        ownedSessionIdsRef.current.delete(id);
      }

      if (remoteSessions.upserts.length > 0 || remoteSessions.deletes.length > 0) {
        setChatSessions(
          (current) => mergeRemoteCollection(current, remoteSessions, shouldAdoptRemoteSession) ?? current
        );
      }
      if (remoteProjects.upserts.length > 0 || remoteProjects.deletes.length > 0) {
        // 远端删掉的项目若正好是本窗口的活动项目，把活动项目让回一个仍然存在的项目：
        // 否则紧凑窗后续新建的宠物会话会挂到一个已不存在的项目上（孤儿会话）。
        if (remoteProjects.deletes.includes(activeProjectIdRef.current)) {
          const fallbackProjectId =
            projectsRef.current.find((project) => !remoteProjects.deletes.includes(project.id))?.id ??
            DEFAULT_PROJECT_ID;
          activeProjectIdRef.current = fallbackProjectId;
          setActiveProjectId(fallbackProjectId);
        }
        setProjects(
          (current) => mergeRemoteCollection(current, remoteProjects, shouldAdoptRemoteProject) ?? current
        );
      }
    })
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [persist, syncSource]);

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
      // 记下「本窗口创建的会话」：follower 只窄写这些，其余会话是 owner 的副本。
      ownedSessionIdsRef.current.add(nextSession.id);
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
      // 会话不存在就**什么都不做**。此前这里会顺手用同一个 id 重建会话：已删会话若还有
      // 在飞的流式回调（停止 / 删除竞态），会被悄悄塞回内存并随快照落盘 —— 复活路径之一。
      // 会话的创建只应经 `createSessionFromMessages`。
      if (!current) {
        return sessions;
      }

      const messagesForSession = typeof nextMessages === "function" ? nextMessages(current.messages) : nextMessages;
      const updated: ChatSession = {
        ...current,
        title: getChatSessionTitle(messagesForSession),
        messages: messagesForSession,
        updatedAt: now,
      };

      const nextSessions = sessions.map((session) => (session.id === sessionId ? updated : session));

      // 在 setChatSessions 的 functional updater 内读取真实最新状态并同步更新 ref，
      // 保证同一 React 批次内多次调用 updateChatSessionMessages 时，后续调用能读到
      // 前一次的结果，避免 running 工具步骤被后续 settlement 等 updater 覆盖/误判为已中断。
      chatSessionsRef.current = nextSessions;

      if (isActiveTarget) {
        setMessages(messagesForSession);
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
      // 这些会话连同项目一起消失，本窗口不再拥有它们（否则 follower 的窄写会写回已删会话）。
      for (const id of relatedSessionIds) {
        ownedSessionIdsRef.current.delete(id);
      }

      // 一并清掉该项目的产物记录。clearProjectArtifacts 此前导出后无人调用，属漏接的一环级联；
      // 产物文件都在各会话目录内，已随 delete_project 删除的会话目录一并消失。
      clearProjectArtifacts(projectId);

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

      persistLocalState({
        projects: nextProjects,
        sessions: nextSessions,
        memories: nextMemories,
        summaries: nextSummaries,
        preferences: userPreferences,
        tasks: nextTasks,
      });
      // 广播删除（项目 + 它的全部会话）：否则另一个窗口的陈旧快照会把它们带回来。
      broadcastLocalChanges(nextProjects, nextSessions);

      return true;
    },
    [
      activeProjectId,
      activeChatId,
      projects,
      chatSessions,
      projectMemories,
      sessionSummaries,
      scheduledTasks,
      userPreferences,
      persistLocalState,
      broadcastLocalChanges,
    ]
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
      // 一并清掉该会话的摘要记录：否则它会一直留在 sessionSummaries 里，继续被
      // `getRelatedContextForProject` 当作上下文喂回模型（deleteProjectProfile 早已这么做，
      // 这里此前漏了 —— 实证：app_kv 的摘要快照里残留着已不存在的会话 id）。
      const nextSummaries = sessionSummaries.filter((summary) => summary.sessionId !== sessionId);
      setChatSessions(nextSessions);
      if (nextSummaries.length !== sessionSummaries.length) {
        setSessionSummaries(nextSummaries);
      }
      // 本窗口不再拥有它：follower 的窄写必须就此停手，否则会把已删会话写回数据库。
      ownedSessionIdsRef.current.delete(sessionId);
      if (sessionId === activeChatId) {
        activeChatIdRef.current = null;
        setActiveChatId(null);
        setMessages([]);
      }

      try {
        await invoke("delete_chat_session", { id: sessionId });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("deleteChatSession: delete_chat_session failed", error);
      }

      // 收尾产物记录：会话数据（含附件快照）由上面的 delete_chat_session → remove_dir_all 删除；
      // 但导出产物落在会话的工作目录里，属于用户的项目文件，删会话时**不**动它（对齐 codex /
      // atomcode / deepseek-harness 的做法）。这里只清 sqlite 记录，否则「产物」面板会留下死卡。
      clearSessionArtifacts(session?.projectId, sessionId);

      persistLocalState({
        projects,
        sessions: nextSessions,
        memories: projectMemories,
        summaries: nextSummaries,
        preferences: userPreferences,
        tasks: scheduledTasks,
      });
      // 把删除事件广播出去 —— 这是「删除」能真正生效的关键：另一个窗口内存里的陈旧副本
      // 只要不知道这条会话已删，就会在它下一次整快照/窄写时把它带回来。
      broadcastLocalChanges(projects, nextSessions);
    },
    [
      activeChatId,
      projects,
      chatSessions,
      projectMemories,
      sessionSummaries,
      scheduledTasks,
      userPreferences,
      persistLocalState,
      broadcastLocalChanges,
    ]
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
