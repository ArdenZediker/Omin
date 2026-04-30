import type { Message } from "../adapters/types";
import type { AssistantProfile, ChatSession, ChatUsagePreferences, ChatUsageStats } from "./types";

export const CHAT_SESSIONS_STORAGE_KEY = "omni_chat_sessions";
export const CHAT_ASSISTANTS_STORAGE_KEY = "omni_chat_assistants";
export const USAGE_PREFERENCES_STORAGE_KEY = "omni_usage_preferences";
export const DEFAULT_ASSISTANT_ID = "assistant-basic-chat";
export const DEFAULT_ASSISTANT_TOOL_IDS = [
  "new",
  "clear",
  "settings",
  "rename",
  "pin",
  "model",
  "search_sessions",
  "read_session",
  "list_files",
  "read_file",
  "search_files",
  "analyze_files",
];
export const DEFAULT_ASSISTANT_SKILL_IDS = [
  "summarize",
  "translate",
  "rewrite",
  "explain",
  "compare",
];

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

export function createDefaultAssistant(): AssistantProfile {
  const now = Date.now();
  return {
    id: DEFAULT_ASSISTANT_ID,
    kind: "basic",
    title: "基础聊天",
    description: "通用问答与基础对话入口",
    defaultModelId: null,
    systemPrompt: "",
    allowedToolIds: [...DEFAULT_ASSISTANT_TOOL_IDS],
    allowedSkillIds: [...DEFAULT_ASSISTANT_SKILL_IDS],
    createdAt: now,
    updatedAt: now,
  };
}

export function createCustomAssistant(input?: Partial<AssistantProfile>): AssistantProfile {
  const now = Date.now();
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? `assistant-${crypto.randomUUID()}`
      : `assistant-${now}-${Math.random().toString(16).slice(2)}`;

  return {
    id,
    kind: "custom",
    title: input?.title?.trim() || "自定义助手",
    description: input?.description?.trim() || "可配置系统提示词、模型和工具权限",
    systemPrompt: input?.systemPrompt ?? "",
    defaultModelId: input?.defaultModelId ?? null,
    allowedToolIds: input?.allowedToolIds?.length ? [...input.allowedToolIds] : [...DEFAULT_ASSISTANT_TOOL_IDS],
    allowedSkillIds: input?.allowedSkillIds?.length ? [...input.allowedSkillIds] : [...DEFAULT_ASSISTANT_SKILL_IDS],
    createdAt: now,
    updatedAt: now,
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

export function createChatSession(messages: Message[] = [], assistantId = DEFAULT_ASSISTANT_ID): ChatSession {
  const now = Date.now();
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `chat-${now}-${Math.random().toString(16).slice(2)}`;

  return {
    id,
    assistantId,
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

function normalizeAssistant(input: Partial<AssistantProfile> & Pick<AssistantProfile, "id" | "title" | "kind">): AssistantProfile {
  const createdAt = typeof input.createdAt === "number" ? input.createdAt : Date.now();
  const updatedAt = typeof input.updatedAt === "number" ? input.updatedAt : createdAt;

  return {
    id: input.id,
    kind: input.kind,
    title: input.title.trim() || (input.kind === "basic" ? "基础聊天" : "自定义助手"),
    description:
      typeof input.description === "string" && input.description.trim()
        ? input.description
        : input.kind === "basic"
          ? "通用问答与基础对话入口"
          : "可配置系统提示词、模型和工具权限",
    systemPrompt: typeof input.systemPrompt === "string" ? input.systemPrompt : "",
    defaultModelId: input.defaultModelId ?? null,
    allowedToolIds: Array.isArray(input.allowedToolIds) && input.allowedToolIds.length > 0 ? [...input.allowedToolIds] : [...DEFAULT_ASSISTANT_TOOL_IDS],
    allowedSkillIds: Array.isArray(input.allowedSkillIds) && input.allowedSkillIds.length > 0 ? [...input.allowedSkillIds] : [...DEFAULT_ASSISTANT_SKILL_IDS],
    createdAt,
    updatedAt,
  };
}

function normalizeSession(
  input: Partial<ChatSession> & Pick<ChatSession, "id" | "messages">,
  fallbackAssistantId = DEFAULT_ASSISTANT_ID
): ChatSession {
  const createdAt = typeof input.createdAt === "number" ? input.createdAt : Date.now();
  const updatedAt = typeof input.updatedAt === "number" ? input.updatedAt : createdAt;

  return {
    id: input.id,
    assistantId: typeof input.assistantId === "string" && input.assistantId.trim() ? input.assistantId : fallbackAssistantId,
    title: typeof input.title === "string" && input.title.trim() ? input.title : getChatSessionTitle(input.messages),
    messages: input.messages,
    pinned: Boolean(input.pinned),
    favorite: Boolean(input.favorite),
    createdAt,
    updatedAt,
    usage: normalizeUsageStats(input.usage),
  };
}

export function getInitialAssistants(): AssistantProfile[] {
  if (typeof window === "undefined") return [createDefaultAssistant()];

  try {
    const raw = localStorage.getItem(CHAT_ASSISTANTS_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Array<Partial<AssistantProfile>>) : [];
    const normalized = parsed
      .filter((assistant): assistant is Partial<AssistantProfile> & Pick<AssistantProfile, "id" | "title" | "kind"> => {
        return typeof assistant?.id === "string" && typeof assistant?.title === "string" && (assistant.kind === "basic" || assistant.kind === "custom");
      })
      .map(normalizeAssistant);

    if (!normalized.some((assistant) => assistant.id === DEFAULT_ASSISTANT_ID)) {
      normalized.unshift(createDefaultAssistant());
    }

    return normalized;
  } catch {
    return [createDefaultAssistant()];
  }
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
      .map((session) => normalizeSession(session));
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
  if (dayDiff <= 7) return "7天内";
  if (dayDiff <= 30) return "30天内";
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
