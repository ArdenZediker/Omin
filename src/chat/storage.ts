import type { Message } from "../adapters/types";
import type {
  AssistantMemoryScope,
  AssistantMemoryRecord,
  AssistantProfile,
  AssistantProfileDraft,
  ChatSession,
  ChatUsagePreferences,
  ChatUsageStats,
  ScheduledTaskRecord,
  SessionSummaryRecord,
  UserPreferenceRecord,
} from "./types";
import { readSqliteBackedJson, readSqliteBackedValue } from "../app/sqliteStorage";

export const CHAT_SESSIONS_STORAGE_KEY = "omni_chat_sessions";
export const CHAT_ASSISTANTS_STORAGE_KEY = "omni_chat_assistants";
export const USAGE_PREFERENCES_STORAGE_KEY = "omni_usage_preferences";
export const ASSISTANT_MEMORIES_STORAGE_KEY = "omni_assistant_memories";
export const SESSION_SUMMARIES_STORAGE_KEY = "omni_session_summaries";
export const USER_PREFERENCES_STORAGE_KEY = "omni_user_preferences";
export const SCHEDULED_TASKS_STORAGE_KEY = "omni_scheduled_tasks";
export const DEFAULT_ASSISTANT_ID = "assistant-basic-chat";
export const DEFAULT_ASSISTANT_TOOL_IDS = [
  "new",
  "clear",
  "settings",
  "pet",
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
export const DEFAULT_ASSISTANT_MEMORY_SCOPE: AssistantMemoryScope = "assistant";

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
    title: "Omni",
    description: "默认桌面助手，负责快速问答与工作台协助。",
    avatarType: "emoji",
    avatarValue: "emoji:1F4AC",
    defaultModelId: null,
    knowledgeCollectionId: null,
    systemPrompt: `## 角色定位
你是 Omni，是这个桌面 AI 工作台中的默认通用助手。

## 适用场景
- 日常问答
- 资料整理
- 简单建议
- 轻量交流
- 工作台内的快速协助
- 不需要强角色风格的通用任务

## 核心职责
- 先准确理解用户当下真正要解决的问题。
- 在最短路径内给出可执行的答复、建议或下一步。
- 保持像一个可靠、清楚、反应快的桌面助手，而不是夸张的人设角色。
- 当用户目标模糊时，帮助收敛问题；当用户目标明确时，直接推进结果。

## 回答策略
1. 如果问题清楚且简单，直接给结论。
2. 如果问题有明显缺口，只补问最关键的 1 到 2 个点。
3. 如果存在多个可行方向，给简短比较并附推荐。
4. 如果用户只是想快速拿结果，先给结果，再补充必要原因。
5. 如果问题和当前工作流、界面操作或下一步执行有关，优先按“现在就能怎么做”来回答。

## 边界与禁忌
- 不要把简单问题复杂化。
- 不要长篇铺垫、空泛说教或堆砌概念。
- 不要在不确定时装懂或编造事实。
- 不要强行代入夸张语气、陪聊语气或表演型人格。
- 不要默认替用户做过度决策，只给建议与判断依据。

## 输出要求
- 使用中文。
- 表达自然、直接、清楚。
- 优先给可执行建议。
- 需要结构时，用简短分点，不做过度展开。
- 与产品、配置、模型、助手、话题相关的问题，尽量结合当前桌面助手场景来表达。

## 优先级
准确 > 清楚 > 简洁 > 风格化`,
    allowedToolIds: [...DEFAULT_ASSISTANT_TOOL_IDS],
    allowedSkillIds: [...DEFAULT_ASSISTANT_SKILL_IDS],
    memoryScope: DEFAULT_ASSISTANT_MEMORY_SCOPE,
    autoSaveMemories: true,
    autoSaveSummaries: true,
    createdAt: now,
    updatedAt: now,
  };
}

export function createCustomAssistant(input?: AssistantProfileDraft): AssistantProfile {
  const now = Date.now();
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? `assistant-${crypto.randomUUID()}`
      : `assistant-${now}-${Math.random().toString(16).slice(2)}`;

  return {
    id,
    kind: "custom",
    sourcePresetId: input?.sourcePresetId ?? null,
    title: input?.title?.trim() || "自定义助手",
    description: input?.description?.trim() || "可配置角色设定、模型和工具权限",
    groupName: typeof input?.groupName === "string" && input.groupName.trim() ? input.groupName.trim() : null,
    avatarType: input?.avatarType ?? "emoji",
    avatarValue: input?.avatarValue ?? "emoji:1F916",
    systemPrompt: input?.systemPrompt ?? "",
    defaultModelId: input?.defaultModelId ?? null,
    knowledgeCollectionId: input?.knowledgeCollectionId?.trim() || null,
    allowedToolIds: input?.allowedToolIds?.length ? [...input.allowedToolIds] : [...DEFAULT_ASSISTANT_TOOL_IDS],
    allowedSkillIds: input?.allowedSkillIds?.length ? [...input.allowedSkillIds] : [...DEFAULT_ASSISTANT_SKILL_IDS],
    memoryScope: input?.memoryScope ?? DEFAULT_ASSISTANT_MEMORY_SCOPE,
    autoSaveMemories: input?.autoSaveMemories ?? true,
    autoSaveSummaries: input?.autoSaveSummaries ?? true,
    createdAt: now,
    updatedAt: now,
  };
}

export function getUsagePreferences(): ChatUsagePreferences {
  return readSqliteBackedJson(USAGE_PREFERENCES_STORAGE_KEY, DEFAULT_USAGE_PREFERENCES);
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

export function serializeAssistantsSnapshot(assistants: AssistantProfile[]) {
  return JSON.stringify(assistants);
}

export function serializeChatSessionsSnapshot(sessions: ChatSession[]) {
  return JSON.stringify(sessions);
}

export function serializeAssistantMemoriesSnapshot(memories: AssistantMemoryRecord[]) {
  return JSON.stringify(memories);
}

export function serializeSessionSummariesSnapshot(summaries: SessionSummaryRecord[]) {
  return JSON.stringify(summaries);
}

export function serializeUserPreferencesSnapshot(preferences: UserPreferenceRecord[]) {
  return JSON.stringify(preferences);
}

export function serializeScheduledTasksSnapshot(tasks: ScheduledTaskRecord[]) {
  return JSON.stringify(tasks);
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
  const defaultAssistant = createDefaultAssistant();

  return {
    id: input.id,
    kind: input.kind,
    sourcePresetId: typeof input.sourcePresetId === "string" ? input.sourcePresetId : null,
    title:
      input.kind === "basic"
        ? defaultAssistant.title
        : input.title.trim() || "自定义助手",
    description:
      typeof input.description === "string" && input.description.trim()
        ? input.description
        : input.kind === "basic"
          ? "默认桌面助手，负责快速问答与工作台协助。"
          : "可配置角色设定、模型和工具权限",
    groupName:
      input.kind === "basic"
        ? null
        : typeof input.groupName === "string" && input.groupName.trim()
        ? input.groupName.trim()
        : null,
    avatarType: input.avatarType === "image" ? "image" : "emoji",
    avatarValue:
      input.kind === "basic"
        ? defaultAssistant.avatarValue
        : typeof input.avatarValue === "string" && input.avatarValue.trim()
        ? input.avatarValue
        : "emoji:1F916",
    systemPrompt:
      input.kind === "basic"
        ? defaultAssistant.systemPrompt
        : typeof input.systemPrompt === "string"
          ? input.systemPrompt
          : "",
    defaultModelId: input.defaultModelId ?? null,
    knowledgeCollectionId: typeof input.knowledgeCollectionId === "string" && input.knowledgeCollectionId.trim() ? input.knowledgeCollectionId.trim() : null,
    allowedToolIds: Array.isArray(input.allowedToolIds) && input.allowedToolIds.length > 0 ? [...input.allowedToolIds] : [...DEFAULT_ASSISTANT_TOOL_IDS],
    allowedSkillIds: Array.isArray(input.allowedSkillIds) && input.allowedSkillIds.length > 0 ? [...input.allowedSkillIds] : [...DEFAULT_ASSISTANT_SKILL_IDS],
    memoryScope:
      input.memoryScope === "off" || input.memoryScope === "session" || input.memoryScope === "assistant"
        ? input.memoryScope
        : DEFAULT_ASSISTANT_MEMORY_SCOPE,
    autoSaveMemories: typeof input.autoSaveMemories === "boolean" ? input.autoSaveMemories : true,
    autoSaveSummaries: typeof input.autoSaveSummaries === "boolean" ? input.autoSaveSummaries : true,
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

export function parseAssistantsSnapshot(raw: string | null | undefined): AssistantProfile[] {
  try {
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

export function parseChatSessionsSnapshot(raw: string | null | undefined): ChatSession[] {
  try {
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

export function parseAssistantMemoriesSnapshot(raw: string | null | undefined): AssistantMemoryRecord[] {
  try {
    const parsed = raw ? (JSON.parse(raw) as AssistantMemoryRecord[]) : [];
    return parsed.filter((item) => typeof item?.id === "string" && typeof item?.assistantId === "string" && typeof item?.content === "string");
  } catch {
    return [];
  }
}

export function parseSessionSummariesSnapshot(raw: string | null | undefined): SessionSummaryRecord[] {
  try {
    const parsed = raw ? (JSON.parse(raw) as SessionSummaryRecord[]) : [];
    return parsed.filter((item) => typeof item?.sessionId === "string" && typeof item?.assistantId === "string" && typeof item?.summary === "string");
  } catch {
    return [];
  }
}

export function parseUserPreferencesSnapshot(raw: string | null | undefined): UserPreferenceRecord[] {
  try {
    const parsed = raw ? (JSON.parse(raw) as UserPreferenceRecord[]) : [];
    return parsed.filter((item) => typeof item?.key === "string" && typeof item?.value === "string");
  } catch {
    return [];
  }
}

export function parseScheduledTasksSnapshot(raw: string | null | undefined): ScheduledTaskRecord[] {
  try {
    const parsed = raw ? (JSON.parse(raw) as ScheduledTaskRecord[]) : [];
    return parsed.filter(
      (item) =>
        typeof item?.id === "string" &&
        typeof item?.title === "string" &&
        typeof item?.prompt === "string" &&
        typeof item?.cron === "string"
    );
  } catch {
    return [];
  }
}

export function getInitialAssistants(): AssistantProfile[] {
  if (typeof window === "undefined") return [createDefaultAssistant()];
  return parseAssistantsSnapshot(readSqliteBackedValue(CHAT_ASSISTANTS_STORAGE_KEY));
}

export function getInitialChatSessions(): ChatSession[] {
  if (typeof window === "undefined") return [];
  return parseChatSessionsSnapshot(readSqliteBackedValue(CHAT_SESSIONS_STORAGE_KEY));
}

export function getInitialAssistantMemories(): AssistantMemoryRecord[] {
  if (typeof window === "undefined") return [];
  return parseAssistantMemoriesSnapshot(readSqliteBackedValue(ASSISTANT_MEMORIES_STORAGE_KEY));
}

export function getInitialSessionSummaries(): SessionSummaryRecord[] {
  if (typeof window === "undefined") return [];
  return parseSessionSummariesSnapshot(readSqliteBackedValue(SESSION_SUMMARIES_STORAGE_KEY));
}

export function getInitialUserPreferences(): UserPreferenceRecord[] {
  if (typeof window === "undefined") return [];
  return parseUserPreferencesSnapshot(readSqliteBackedValue(USER_PREFERENCES_STORAGE_KEY));
}

export function getInitialScheduledTasks(): ScheduledTaskRecord[] {
  if (typeof window === "undefined") return [];
  return parseScheduledTasksSnapshot(readSqliteBackedValue(SCHEDULED_TASKS_STORAGE_KEY));
}

export function searchSessionSummaries(summaries: SessionSummaryRecord[], query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return summaries;
  return summaries.filter((item) => item.title.toLowerCase().includes(normalizedQuery) || item.summary.toLowerCase().includes(normalizedQuery));
}

export function searchAssistantMemories(memories: AssistantMemoryRecord[], assistantId: string, query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  const scoped = memories.filter((item) => item.assistantId === assistantId);
  if (!normalizedQuery) return scoped;
  return scoped.filter((item) => item.content.toLowerCase().includes(normalizedQuery));
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
  const costLabel = usage.totalCostUsd > 0 ? ` / $${usage.totalCostUsd.toFixed(4)}` : "";
  const estimatedLabel = usage.hasEstimatedUsage ? " / 估算" : "";
  return `${tokenLabel}${costLabel}${estimatedLabel}`;
}
