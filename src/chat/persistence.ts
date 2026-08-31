import { invoke } from "@tauri-apps/api/core";
import { loadAutomationStorage, loadMemoryStorage, saveAutomationStorage, saveMemoryStorage } from "../app/sqliteStorage";
import type {
  ProjectMemoryRecord,
  Project,
  ChatSession,
  ScheduledTaskRecord,
  SessionSummaryRecord,
  UserPreferenceRecord,
} from "./types";
import {
  PROJECT_MEMORIES_STORAGE_KEY,
  CHAT_PROJECTS_STORAGE_KEY,
  CHAT_SESSIONS_STORAGE_KEY,
  getInitialProjects,
  getInitialChatSessions,
  parseProjectMemoriesSnapshot,
  parseProjectsSnapshot,
  parseChatSessionsSnapshot,
  parseSessionSummariesSnapshot,
  parseScheduledTasksSnapshot,
  parseUserPreferencesSnapshot,
  serializeProjectMemoriesSnapshot,
  serializeProjectsSnapshot,
  serializeChatSessionsSnapshot,
  serializeSessionSummariesSnapshot,
  serializeScheduledTasksSnapshot,
  serializeUserPreferencesSnapshot,
  SCHEDULED_TASKS_STORAGE_KEY,
  SESSION_SUMMARIES_STORAGE_KEY,
  USER_PREFERENCES_STORAGE_KEY,
} from "./storage";

type ChatStoragePayload = {
  projectsJson?: string | null;
  sessionsJson?: string | null;
};

type PersistedChatState = {
  projects: Project[];
  sessions: ChatSession[];
  projectMemories: ProjectMemoryRecord[];
  sessionSummaries: SessionSummaryRecord[];
  userPreferences: UserPreferenceRecord[];
  scheduledTasks: ScheduledTaskRecord[];
};

function canUseTauriStorage() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function getLegacyProjectsJson() {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(CHAT_PROJECTS_STORAGE_KEY);
}

function getLegacySessionsJson() {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(CHAT_SESSIONS_STORAGE_KEY);
}

function getLegacyProjectMemoriesJson() {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(PROJECT_MEMORIES_STORAGE_KEY);
}

function getLegacySessionSummariesJson() {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(SESSION_SUMMARIES_STORAGE_KEY);
}

function getLegacyUserPreferencesJson() {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(USER_PREFERENCES_STORAGE_KEY);
}

function getLegacyScheduledTasksJson() {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(SCHEDULED_TASKS_STORAGE_KEY);
}

export async function loadPersistedChatState(): Promise<PersistedChatState> {
  // 聊天、记忆、自动化三种存储独立加载，避免任意一种失败导致整个加载被判定为失败，
  // 从而禁用后续保存（这正是「重启后数据消失」的常见根因）。
  let payload: ChatStoragePayload | null = null;
  let memoryPayload: Awaited<ReturnType<typeof loadMemoryStorage>> | null = null;
  let automationPayload: Awaited<ReturnType<typeof loadAutomationStorage>> | null = null;

  if (canUseTauriStorage()) {
    try {
      payload = await invoke<ChatStoragePayload>("load_chat_storage", {
        legacyProjectsJson: getLegacyProjectsJson(),
        legacySessionsJson: getLegacySessionsJson(),
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("loadPersistedChatState: load_chat_storage failed", error);
    }
  }

  try {
    memoryPayload = await loadMemoryStorage();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("loadPersistedChatState: loadMemoryStorage failed", error);
  }

  try {
    automationPayload = await loadAutomationStorage();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("loadPersistedChatState: loadAutomationStorage failed", error);
  }

  return {
    projects: payload?.projectsJson ? parseProjectsSnapshot(payload.projectsJson) : getInitialProjects(),
    sessions: payload?.sessionsJson ? parseChatSessionsSnapshot(payload.sessionsJson) : getInitialChatSessions(),
    projectMemories: memoryPayload?.projectMemoriesJson
      ? parseProjectMemoriesSnapshot(memoryPayload.projectMemoriesJson)
      : parseProjectMemoriesSnapshot(getLegacyProjectMemoriesJson()),
    sessionSummaries: memoryPayload?.sessionSummariesJson
      ? parseSessionSummariesSnapshot(memoryPayload.sessionSummariesJson)
      : parseSessionSummariesSnapshot(getLegacySessionSummariesJson()),
    userPreferences: memoryPayload?.userPreferencesJson
      ? parseUserPreferencesSnapshot(memoryPayload.userPreferencesJson)
      : parseUserPreferencesSnapshot(getLegacyUserPreferencesJson()),
    scheduledTasks: automationPayload?.scheduledTasksJson
      ? parseScheduledTasksSnapshot(automationPayload.scheduledTasksJson)
      : parseScheduledTasksSnapshot(getLegacyScheduledTasksJson()),
  };
}

export async function savePersistedChatState(projects: Project[], sessions: ChatSession[]) {
  const projectsJson = serializeProjectsSnapshot(projects);
  const sessionsJson = serializeChatSessionsSnapshot(sessions);

  if (typeof window !== "undefined" && !canUseTauriStorage()) {
    localStorage.setItem(CHAT_PROJECTS_STORAGE_KEY, projectsJson);
    localStorage.setItem(CHAT_SESSIONS_STORAGE_KEY, sessionsJson);
  }

  if (canUseTauriStorage()) {
    try {
      await invoke("save_chat_storage", {
        projectsJson,
        sessionsJson,
      });
      if (typeof window !== "undefined") {
        localStorage.removeItem(CHAT_PROJECTS_STORAGE_KEY);
        localStorage.removeItem(CHAT_SESSIONS_STORAGE_KEY);
      }
      return;
    } catch {
      // Fall back to localStorage below.
    }
  }
  if (typeof window !== "undefined") {
    localStorage.setItem(CHAT_PROJECTS_STORAGE_KEY, projectsJson);
    localStorage.setItem(CHAT_SESSIONS_STORAGE_KEY, sessionsJson);
  }
}

export async function savePersistedMemoryState(
  projectMemories: ProjectMemoryRecord[],
  sessionSummaries: SessionSummaryRecord[],
  userPreferences: UserPreferenceRecord[]
) {
  const projectMemoriesJson = serializeProjectMemoriesSnapshot(projectMemories);
  const sessionSummariesJson = serializeSessionSummariesSnapshot(sessionSummaries);
  const userPreferencesJson = serializeUserPreferencesSnapshot(userPreferences);

  if (typeof window !== "undefined" && !canUseTauriStorage()) {
    localStorage.setItem(PROJECT_MEMORIES_STORAGE_KEY, projectMemoriesJson);
    localStorage.setItem(SESSION_SUMMARIES_STORAGE_KEY, sessionSummariesJson);
    localStorage.setItem(USER_PREFERENCES_STORAGE_KEY, userPreferencesJson);
  }

  try {
    await saveMemoryStorage({
      projectMemoriesJson,
      sessionSummariesJson,
      userPreferencesJson,
    });
    if (typeof window !== "undefined" && canUseTauriStorage()) {
      localStorage.removeItem(PROJECT_MEMORIES_STORAGE_KEY);
      localStorage.removeItem(SESSION_SUMMARIES_STORAGE_KEY);
      localStorage.removeItem(USER_PREFERENCES_STORAGE_KEY);
    }
  } catch {
    if (typeof window !== "undefined") {
      localStorage.setItem(PROJECT_MEMORIES_STORAGE_KEY, projectMemoriesJson);
      localStorage.setItem(SESSION_SUMMARIES_STORAGE_KEY, sessionSummariesJson);
      localStorage.setItem(USER_PREFERENCES_STORAGE_KEY, userPreferencesJson);
    }
  }
}

export async function savePersistedAutomationState(tasks: ScheduledTaskRecord[]) {
  const scheduledTasksJson = serializeScheduledTasksSnapshot(tasks);

  if (typeof window !== "undefined" && !canUseTauriStorage()) {
    localStorage.setItem(SCHEDULED_TASKS_STORAGE_KEY, scheduledTasksJson);
  }

  try {
    await saveAutomationStorage({
      scheduledTasksJson,
    });
    if (typeof window !== "undefined" && canUseTauriStorage()) {
      localStorage.removeItem(SCHEDULED_TASKS_STORAGE_KEY);
    }
  } catch {
    if (typeof window !== "undefined") {
      localStorage.setItem(SCHEDULED_TASKS_STORAGE_KEY, scheduledTasksJson);
    }
  }
}

