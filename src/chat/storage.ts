import type { Message } from "../adapters/types";
import type { ChatSession, ChatUsagePreferences, ChatUsageStats } from "./types";

export const CHAT_SESSIONS_STORAGE_KEY = "omni_chat_sessions";
export const USAGE_PREFERENCES_STORAGE_KEY = "omni_usage_preferences";

export const DEFAULT_USAGE_PREFERENCES: ChatUsagePreferences = {
  enableStreaming: true,
  enableVisionInput: true,
  temperature: 0.7,
  maxOutputTokens: 4096,
};

export function createEmptyUsageStats(): ChatUsageStats {
  return {
    requestCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    lastModel: null,
    lastUsedAt: null,
    hasEstimatedUsage: false,
  };
}

export function getUsagePreferences(): ChatUsagePreferences {
  try {
    return {
      ...DEFAULT_USAGE_PREFERENCES,
      ...JSON.parse(localStorage.getItem(USAGE_PREFERENCES_STORAGE_KEY) || "{}"),
    };
  } catch {
    return DEFAULT_USAGE_PREFERENCES;
  }
}

export function getChatSessionTitle(messages: Message[]) {
  const firstUserMessage = messages.find((message) => message.role === "user");
  const content = firstUserMessage?.content?.trim();
  if (!content) return "新对话";
  return content.length > 18 ? `${content.slice(0, 18)}...` : content;
}

export function createChatSession(messages: Message[] = []): ChatSession {
  const now = Date.now();
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `chat-${now}-${Math.random().toString(16).slice(2)}`;

  return {
    id,
    title: getChatSessionTitle(messages),
    messages,
    createdAt: now,
    updatedAt: now,
    usage: createEmptyUsageStats(),
  };
}

function normalizeUsageStats(input: Partial<ChatUsageStats> | undefined): ChatUsageStats {
  return {
    ...createEmptyUsageStats(),
    ...input,
  };
}

function normalizeSession(input: Partial<ChatSession> & Pick<ChatSession, "id" | "messages">): ChatSession {
  const createdAt = typeof input.createdAt === "number" ? input.createdAt : Date.now();
  const updatedAt = typeof input.updatedAt === "number" ? input.updatedAt : createdAt;

  return {
    id: input.id,
    title: typeof input.title === "string" && input.title.trim() ? input.title : getChatSessionTitle(input.messages),
    messages: input.messages,
    pinned: Boolean(input.pinned),
    createdAt,
    updatedAt,
    usage: normalizeUsageStats(input.usage),
  };
}

export function getInitialChatSessions(): ChatSession[] {
  if (typeof window === "undefined") return [];

  try {
    const raw = localStorage.getItem(CHAT_SESSIONS_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Array<Partial<ChatSession>>) : [];
    return parsed
      .filter((session): session is Partial<ChatSession> & Pick<ChatSession, "id" | "messages"> => {
        return typeof session?.id === "string" && Array.isArray(session.messages);
      })
      .map(normalizeSession);
  } catch {
    return [];
  }
}

export function getChatSessionGroupLabel(updatedAt: number) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const target = new Date(updatedAt);
  const targetDay = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
  const dayDiff = Math.floor((today - targetDay) / 86400000);

  if (dayDiff <= 0) return "今天";
  if (dayDiff === 1) return "昨天";
  if (dayDiff <= 7) return "7 天内";
  if (dayDiff <= 30) return "30 天内";
  return "更早";
}

export function formatUsageLabel(usage: ChatUsageStats) {
  if (usage.requestCount <= 0 || usage.totalTokens <= 0) {
    return "未统计";
  }

  const tokenLabel = usage.totalTokens >= 1000 ? `${(usage.totalTokens / 1000).toFixed(1)}k tokens` : `${usage.totalTokens} tokens`;
  const costLabel = usage.totalCostUsd > 0 ? ` · $${usage.totalCostUsd.toFixed(4)}` : "";
  const estimatedLabel = usage.hasEstimatedUsage ? " · 估算" : "";
  return `${tokenLabel}${costLabel}${estimatedLabel}`;
}
