import { invoke } from "@tauri-apps/api/core";
import type { AssistantProfile, ChatSession } from "./types";
import {
  CHAT_ASSISTANTS_STORAGE_KEY,
  CHAT_SESSIONS_STORAGE_KEY,
  getInitialAssistants,
  getInitialChatSessions,
  parseAssistantsSnapshot,
  parseChatSessionsSnapshot,
  serializeAssistantsSnapshot,
  serializeChatSessionsSnapshot,
} from "./storage";

type ChatStoragePayload = {
  assistantsJson?: string | null;
  sessionsJson?: string | null;
};

type PersistedChatState = {
  assistants: AssistantProfile[];
  sessions: ChatSession[];
};

function getLegacyAssistantsJson() {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(CHAT_ASSISTANTS_STORAGE_KEY);
}

function getLegacySessionsJson() {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(CHAT_SESSIONS_STORAGE_KEY);
}

export async function loadPersistedChatState(): Promise<PersistedChatState> {
  try {
    const payload = await invoke<ChatStoragePayload>("load_chat_storage", {
      legacyAssistantsJson: getLegacyAssistantsJson(),
      legacySessionsJson: getLegacySessionsJson(),
    });

    return {
      assistants: payload.assistantsJson ? parseAssistantsSnapshot(payload.assistantsJson) : getInitialAssistants(),
      sessions: payload.sessionsJson ? parseChatSessionsSnapshot(payload.sessionsJson) : getInitialChatSessions(),
    };
  } catch {
    return {
      assistants: getInitialAssistants(),
      sessions: getInitialChatSessions(),
    };
  }
}

export async function savePersistedChatState(assistants: AssistantProfile[], sessions: ChatSession[]) {
  const assistantsJson = serializeAssistantsSnapshot(assistants);
  const sessionsJson = serializeChatSessionsSnapshot(sessions);

  if (typeof window !== "undefined") {
    localStorage.setItem(CHAT_ASSISTANTS_STORAGE_KEY, assistantsJson);
    localStorage.setItem(CHAT_SESSIONS_STORAGE_KEY, sessionsJson);
  }

  try {
    await invoke("save_chat_storage", {
      assistantsJson,
      sessionsJson,
    });
  } catch {
    // 浏览器或异常环境继续保留 localStorage
  }
}
