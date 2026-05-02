import { invoke } from "@tauri-apps/api/core";
import { loadAutomationStorage, loadMemoryStorage, saveAutomationStorage, saveMemoryStorage } from "../app/sqliteStorage";
import type {
  AssistantMemoryRecord,
  AssistantProfile,
  ChatSession,
  ScheduledTaskRecord,
  SessionSummaryRecord,
  UserPreferenceRecord,
} from "./types";
import {
  ASSISTANT_MEMORIES_STORAGE_KEY,
  CHAT_ASSISTANTS_STORAGE_KEY,
  CHAT_SESSIONS_STORAGE_KEY,
  getInitialAssistantMemories,
  getInitialAssistants,
  getInitialChatSessions,
  getInitialSessionSummaries,
  getInitialUserPreferences,
  parseAssistantMemoriesSnapshot,
  parseAssistantsSnapshot,
  parseChatSessionsSnapshot,
  parseSessionSummariesSnapshot,
  parseScheduledTasksSnapshot,
  parseUserPreferencesSnapshot,
  serializeAssistantMemoriesSnapshot,
  serializeAssistantsSnapshot,
  serializeChatSessionsSnapshot,
  serializeSessionSummariesSnapshot,
  serializeScheduledTasksSnapshot,
  serializeUserPreferencesSnapshot,
  SCHEDULED_TASKS_STORAGE_KEY,
  SESSION_SUMMARIES_STORAGE_KEY,
  USER_PREFERENCES_STORAGE_KEY,
} from "./storage";

type ChatStoragePayload = {
  assistantsJson?: string | null;
  sessionsJson?: string | null;
};

type PersistedChatState = {
  assistants: AssistantProfile[];
  sessions: ChatSession[];
  assistantMemories: AssistantMemoryRecord[];
  sessionSummaries: SessionSummaryRecord[];
  userPreferences: UserPreferenceRecord[];
  scheduledTasks: ScheduledTaskRecord[];
};

function canUseTauriStorage() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function getLegacyAssistantsJson() {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(CHAT_ASSISTANTS_STORAGE_KEY);
}

function getLegacySessionsJson() {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(CHAT_SESSIONS_STORAGE_KEY);
}

function getLegacyAssistantMemoriesJson() {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(ASSISTANT_MEMORIES_STORAGE_KEY);
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
  try {
    const [payload, memoryPayload, automationPayload] = await Promise.all([
      invoke<ChatStoragePayload>("load_chat_storage", {
        legacyAssistantsJson: getLegacyAssistantsJson(),
        legacySessionsJson: getLegacySessionsJson(),
      }),
      loadMemoryStorage(),
      loadAutomationStorage(),
    ]);

    return {
      assistants: payload.assistantsJson ? parseAssistantsSnapshot(payload.assistantsJson) : getInitialAssistants(),
      sessions: payload.sessionsJson ? parseChatSessionsSnapshot(payload.sessionsJson) : getInitialChatSessions(),
      assistantMemories: memoryPayload.assistantMemoriesJson
        ? parseAssistantMemoriesSnapshot(memoryPayload.assistantMemoriesJson)
        : getInitialAssistantMemories(),
      sessionSummaries: memoryPayload.sessionSummariesJson
        ? parseSessionSummariesSnapshot(memoryPayload.sessionSummariesJson)
        : getInitialSessionSummaries(),
      userPreferences: memoryPayload.userPreferencesJson
        ? parseUserPreferencesSnapshot(memoryPayload.userPreferencesJson)
        : getInitialUserPreferences(),
      scheduledTasks: automationPayload.scheduledTasksJson ? parseScheduledTasksSnapshot(automationPayload.scheduledTasksJson) : [],
    };
  } catch {
    return {
      assistants: getInitialAssistants(),
      sessions: getInitialChatSessions(),
      assistantMemories: parseAssistantMemoriesSnapshot(getLegacyAssistantMemoriesJson()),
      sessionSummaries: parseSessionSummariesSnapshot(getLegacySessionSummariesJson()),
      userPreferences: parseUserPreferencesSnapshot(getLegacyUserPreferencesJson()),
      scheduledTasks: parseScheduledTasksSnapshot(getLegacyScheduledTasksJson()),
    };
  }
}

export async function savePersistedChatState(assistants: AssistantProfile[], sessions: ChatSession[]) {
  const assistantsJson = serializeAssistantsSnapshot(assistants);
  const sessionsJson = serializeChatSessionsSnapshot(sessions);

  if (typeof window !== "undefined" && !canUseTauriStorage()) {
    localStorage.setItem(CHAT_ASSISTANTS_STORAGE_KEY, assistantsJson);
    localStorage.setItem(CHAT_SESSIONS_STORAGE_KEY, sessionsJson);
  }

  try {
    await invoke("save_chat_storage", {
      assistantsJson,
      sessionsJson,
    });
    if (typeof window !== "undefined" && canUseTauriStorage()) {
      localStorage.removeItem(CHAT_ASSISTANTS_STORAGE_KEY);
      localStorage.removeItem(CHAT_SESSIONS_STORAGE_KEY);
    }
  } catch {
    if (typeof window !== "undefined") {
      localStorage.setItem(CHAT_ASSISTANTS_STORAGE_KEY, assistantsJson);
      localStorage.setItem(CHAT_SESSIONS_STORAGE_KEY, sessionsJson);
    }
  }
}

export async function savePersistedMemoryState(
  assistantMemories: AssistantMemoryRecord[],
  sessionSummaries: SessionSummaryRecord[],
  userPreferences: UserPreferenceRecord[]
) {
  const assistantMemoriesJson = serializeAssistantMemoriesSnapshot(assistantMemories);
  const sessionSummariesJson = serializeSessionSummariesSnapshot(sessionSummaries);
  const userPreferencesJson = serializeUserPreferencesSnapshot(userPreferences);

  if (typeof window !== "undefined" && !canUseTauriStorage()) {
    localStorage.setItem(ASSISTANT_MEMORIES_STORAGE_KEY, assistantMemoriesJson);
    localStorage.setItem(SESSION_SUMMARIES_STORAGE_KEY, sessionSummariesJson);
    localStorage.setItem(USER_PREFERENCES_STORAGE_KEY, userPreferencesJson);
  }

  try {
    await saveMemoryStorage({
      assistantMemoriesJson,
      sessionSummariesJson,
      userPreferencesJson,
    });
    if (typeof window !== "undefined" && canUseTauriStorage()) {
      localStorage.removeItem(ASSISTANT_MEMORIES_STORAGE_KEY);
      localStorage.removeItem(SESSION_SUMMARIES_STORAGE_KEY);
      localStorage.removeItem(USER_PREFERENCES_STORAGE_KEY);
    }
  } catch {
    if (typeof window !== "undefined") {
      localStorage.setItem(ASSISTANT_MEMORIES_STORAGE_KEY, assistantMemoriesJson);
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

