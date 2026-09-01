import type { Message } from "../adapters/types";
import type {
  ProjectMemoryScope,
  ProjectMemoryRecord,
  Project,
  ProjectDraft,
  ChatSession,
  ChatUsagePreferences,
  ChatUsageStats,
  PersonaConfig,
  ScheduledTaskRecord,
  SessionSummaryRecord,
  UserPreferenceRecord,
} from "./types";
import { readSqliteBackedJson, readSqliteBackedValue } from "../app/sqliteStorage";

export const CHAT_SESSIONS_STORAGE_KEY = "omni_chat_sessions";
export const CHAT_PROJECTS_STORAGE_KEY = "omni_chat_assistants";
export const USAGE_PREFERENCES_STORAGE_KEY = "omni_usage_preferences";
export const PROJECT_MEMORIES_STORAGE_KEY = "omni_assistant_memories";
export const SESSION_SUMMARIES_STORAGE_KEY = "omni_session_summaries";
export const USER_PREFERENCES_STORAGE_KEY = "omni_user_preferences";
export const SCHEDULED_TASKS_STORAGE_KEY = "omni_scheduled_tasks";
export const PERSONALIZATION_STORAGE_KEY = "omni_personalization";

export type PersonaFieldKey =
  | "style"
  | "userName"
  | "assistantName"
  | "personaDescription"
  | "customInstruction"
  | "longTermMemory"
  | "agentsMd";
export const DEFAULT_PROJECT_ID = "project-basic-chat";
export const DEFAULT_PROJECT_TOOL_IDS = [
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
  "read_persona",
  "update_persona",
];
export const DEFAULT_PROJECT_SKILL_IDS: string[] = [];
export const DEFAULT_PROJECT_MEMORY_SCOPE: ProjectMemoryScope = "project";

export const DEFAULT_USAGE_PREFERENCES: ChatUsagePreferences = {
  enableStreaming: true,
  enableVisionInput: true,
  temperature: 0.7,
  maxOutputTokens: 4096,
};

export const DEFAULT_PERSONA_CONFIG: PersonaConfig = {
  style: "default",
  customInstruction: "",
  userName: "",
  assistantName: "",
  personaDescription: "",
  longTermMemory: "",
  agentsMd: "",
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

export function createDefaultProject(): Project {
  const now = Date.now();
  return {
    id: DEFAULT_PROJECT_ID,
    kind: "basic",
    title: "Omni",
    description: "默认桌面助手，负责快速问答与工作台协助。",
    workspacePath: "",
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
    allowedToolIds: [...DEFAULT_PROJECT_TOOL_IDS],
    allowedSkillIds: [...DEFAULT_PROJECT_SKILL_IDS],
    memoryScope: DEFAULT_PROJECT_MEMORY_SCOPE,
    autoSaveMemories: true,
    autoSaveSummaries: true,
    createdAt: now,
    updatedAt: now,
  };
}

export function createCustomProject(input?: ProjectDraft): Project {
  const now = Date.now();
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? `project-${crypto.randomUUID()}`
      : `project-${now}-${Math.random().toString(16).slice(2)}`;

  return {
    id,
    kind: "custom",
    title: input?.title?.trim() || "自定义助手",
    description: input?.description?.trim() || "可配置角色设定、模型和工具权限",
    workspacePath: input?.workspacePath?.trim() || "",
    groupName: typeof input?.groupName === "string" && input.groupName.trim() ? input.groupName.trim() : null,
    avatarType: input?.avatarType ?? "emoji",
    avatarValue: input?.avatarValue ?? "emoji:1F916",
    systemPrompt: input?.systemPrompt ?? "",
    defaultModelId: input?.defaultModelId ?? null,
    knowledgeCollectionId: input?.knowledgeCollectionId?.trim() || null,
    allowedToolIds: input?.allowedToolIds?.length ? [...input.allowedToolIds] : [...DEFAULT_PROJECT_TOOL_IDS],
    allowedSkillIds: input?.allowedSkillIds?.length ? [...input.allowedSkillIds] : [...DEFAULT_PROJECT_SKILL_IDS],
    memoryScope: input?.memoryScope ?? DEFAULT_PROJECT_MEMORY_SCOPE,
    autoSaveMemories: input?.autoSaveMemories ?? true,
    autoSaveSummaries: input?.autoSaveSummaries ?? true,
    createdAt: now,
    updatedAt: now,
  };
}

export function getUsagePreferences(): ChatUsagePreferences {
  return readSqliteBackedJson(USAGE_PREFERENCES_STORAGE_KEY, DEFAULT_USAGE_PREFERENCES);
}

/** 从 Rust 端的 persona md 文件读取个性化配置（异步）。 */
export async function loadPersonaConfig(): Promise<PersonaConfig> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    const dto = await invoke<PersonaConfig>("read_persona_files");
    return {
      style: (dto.style as PersonaConfig["style"]) ?? DEFAULT_PERSONA_CONFIG.style,
      customInstruction: dto.customInstruction ?? "",
      userName: dto.userName ?? "",
      assistantName: dto.assistantName ?? "",
      personaDescription: dto.personaDescription ?? "",
      longTermMemory: dto.longTermMemory ?? "",
      agentsMd: dto.agentsMd ?? "",
    };
  } catch {
    return DEFAULT_PERSONA_CONFIG;
  }
}

/** 把单个个性化字段写入对应的 persona md 文件（异步）。 */
export async function savePersonaField(key: PersonaFieldKey, value: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("write_persona_file", { key, content: value });
}

export function getChatSessionTitle(messages: Message[]) {
  const firstUserMessage = messages.find((message) => message.role === "user");
  const content = firstUserMessage?.content?.trim();
  if (!content) return "新对话";
  return content.length > 18 ? `${content.slice(0, 18)}...` : content;
}

export function createChatSession(messages: Message[] = [], projectId = DEFAULT_PROJECT_ID): ChatSession {
  const now = Date.now();
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `chat-${now}-${Math.random().toString(16).slice(2)}`;

  return {
    id,
    projectId,
    title: getChatSessionTitle(messages),
    messages,
    createdAt: now,
    updatedAt: now,
    usage: createEmptyUsageStats(),
  };
}

export function serializeProjectsSnapshot(projects: Project[]) {
  return JSON.stringify(projects);
}

export function serializeChatSessionsSnapshot(sessions: ChatSession[]) {
  return JSON.stringify(sessions);
}

export function serializeProjectMemoriesSnapshot(memories: ProjectMemoryRecord[]) {
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

function normalizeProject(input: Partial<Project> & Pick<Project, "id" | "title" | "kind">): Project {
  const createdAt = typeof input.createdAt === "number" ? input.createdAt : Date.now();
  const updatedAt = typeof input.updatedAt === "number" ? input.updatedAt : createdAt;
  const defaultProject = createDefaultProject();

  return {
    id: input.id,
    kind: input.kind,
    title:
      input.kind === "basic"
        ? defaultProject.title
        : input.title.trim() || "自定义助手",
    description:
      typeof input.description === "string" && input.description.trim()
        ? input.description
        : input.kind === "basic"
          ? "默认桌面助手，负责快速问答与工作台协助。"
          : "可配置角色设定、模型和工具权限",
    workspacePath: typeof input.workspacePath === "string" ? input.workspacePath : "",
    groupName:
      input.kind === "basic"
        ? null
        : typeof input.groupName === "string" && input.groupName.trim()
        ? input.groupName.trim()
        : null,
    avatarType: input.avatarType === "image" ? "image" : "emoji",
    avatarValue:
      input.kind === "basic"
        ? defaultProject.avatarValue
        : typeof input.avatarValue === "string" && input.avatarValue.trim()
        ? input.avatarValue
        : "emoji:1F916",
    systemPrompt:
      input.kind === "basic"
        ? defaultProject.systemPrompt
        : typeof input.systemPrompt === "string"
          ? input.systemPrompt
          : "",
    defaultModelId: input.defaultModelId ?? null,
    knowledgeCollectionId: typeof input.knowledgeCollectionId === "string" && input.knowledgeCollectionId.trim() ? input.knowledgeCollectionId.trim() : null,
    allowedToolIds: Array.isArray(input.allowedToolIds) && input.allowedToolIds.length > 0 ? [...input.allowedToolIds] : [...DEFAULT_PROJECT_TOOL_IDS],
    allowedSkillIds: Array.isArray(input.allowedSkillIds) && input.allowedSkillIds.length > 0 ? [...input.allowedSkillIds] : [...DEFAULT_PROJECT_SKILL_IDS],
    memoryScope:
      input.memoryScope === "off" || input.memoryScope === "session" || input.memoryScope === "project"
        ? input.memoryScope
        : DEFAULT_PROJECT_MEMORY_SCOPE,
    autoSaveMemories: typeof input.autoSaveMemories === "boolean" ? input.autoSaveMemories : true,
    autoSaveSummaries: typeof input.autoSaveSummaries === "boolean" ? input.autoSaveSummaries : true,
    createdAt,
    updatedAt,
  };
}

function normalizeSession(
  input: Partial<ChatSession> & Pick<ChatSession, "id" | "messages">,
  fallbackProjectId = DEFAULT_PROJECT_ID
): ChatSession {
  const createdAt = typeof input.createdAt === "number" ? input.createdAt : Date.now();
  const updatedAt = typeof input.updatedAt === "number" ? input.updatedAt : createdAt;

  return {
    id: input.id,
    projectId: typeof input.projectId === "string" && input.projectId.trim() ? input.projectId : fallbackProjectId,
    title: typeof input.title === "string" && input.title.trim() ? input.title : getChatSessionTitle(input.messages),
    messages: input.messages,
    pinned: Boolean(input.pinned),
    favorite: Boolean(input.favorite),
    createdAt,
    updatedAt,
    usage: normalizeUsageStats(input.usage),
  };
}

export function parseProjectsSnapshot(raw: string | null | undefined): Project[] {
  try {
    const parsed = raw ? (JSON.parse(raw) as Array<Partial<Project>>) : [];
    const normalized = parsed
      .filter((project): project is Partial<Project> & Pick<Project, "id" | "title" | "kind"> => {
        return typeof project?.id === "string" && typeof project?.title === "string" && (project.kind === "basic" || project.kind === "custom");
      })
      .map(normalizeProject);

    if (!normalized.some((project) => project.id === DEFAULT_PROJECT_ID)) {
      normalized.unshift(createDefaultProject());
    }

    return normalized;
  } catch {
    return [createDefaultProject()];
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

export function parseProjectMemoriesSnapshot(raw: string | null | undefined): ProjectMemoryRecord[] {
  try {
    const parsed = raw ? (JSON.parse(raw) as ProjectMemoryRecord[]) : [];
    return parsed
      .filter((item) => typeof item?.id === "string" && typeof item?.projectId === "string" && typeof item?.content === "string")
      .map((item) => ({
        ...item,
        sourceType:
          item.sourceType === "auto" || item.sourceType === "manual" || item.sourceType === "command" || item.sourceType === "legacy"
            ? item.sourceType
            : "legacy",
      }));
  } catch {
    return [];
  }
}

export function parseSessionSummariesSnapshot(raw: string | null | undefined): SessionSummaryRecord[] {
  try {
    const parsed = raw ? (JSON.parse(raw) as SessionSummaryRecord[]) : [];
    return parsed.filter((item) => typeof item?.sessionId === "string" && typeof item?.projectId === "string" && typeof item?.summary === "string");
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

export function getInitialProjects(): Project[] {
  if (typeof window === "undefined") return [createDefaultProject()];
  // CHAT_PROJECTS_STORAGE_KEY 的值仍是历史键 "omni_chat_assistants"，
  // 因此旧版助手数据会被原样读取，再由 normalizeProject 补全 workspacePath 等新字段。
  const raw = readSqliteBackedValue(CHAT_PROJECTS_STORAGE_KEY);
  if (raw && raw.trim()) {
    return parseProjectsSnapshot(raw);
  }
  return [createDefaultProject()];
}

export function getInitialChatSessions(): ChatSession[] {
  if (typeof window === "undefined") return [];
  return parseChatSessionsSnapshot(readSqliteBackedValue(CHAT_SESSIONS_STORAGE_KEY));
}

export function getInitialProjectMemories(): ProjectMemoryRecord[] {
  if (typeof window === "undefined") return [];
  return parseProjectMemoriesSnapshot(readSqliteBackedValue(PROJECT_MEMORIES_STORAGE_KEY));
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

export function searchProjectMemories(memories: ProjectMemoryRecord[], projectId: string, query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  const scoped = memories.filter((item) => item.projectId === projectId);
  if (!normalizedQuery) return scoped;
  return scoped.filter((item) => `${item.content} ${item.sourceType ?? "legacy"}`.toLowerCase().includes(normalizedQuery));
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
