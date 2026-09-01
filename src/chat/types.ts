import type { Message } from "../adapters/types";
import type { KnowledgeContextResult } from "./knowledgeTypes";

export type ChatUsagePreferences = {
  enableStreaming: boolean;
  enableVisionInput: boolean;
  temperature: number;
  maxOutputTokens: number;
};

export type PersonaStyle =
  | "default"
  | "professional"
  | "friendly"
  | "direct"
  | "creative"
  | "efficient"
  | "snarky"
  | "socratic";

export type PersonaConfig = {
  style: PersonaStyle;
  customInstruction: string;
  userName: string;
  assistantName: string;
  personaDescription: string;
  longTermMemory: string;
  /** 来自 AGENTS.md / AGENTS.override.md 的自由格式指令内容（仿 codex / deepseek 的指令文件约定）。 */
  agentsMd: string;
};

export type ChatUsageStats = {
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  lastModel: string | null;
  lastUsedAt: number | null;
  hasEstimatedUsage: boolean;
  /** 累计工具调用轮数（无工具对话为 0） */
  toolRounds: number;
};

export type ProjectKind = "basic" | "custom";

export type ProjectMemoryScope = "off" | "session" | "project";

export type ProjectDraft = {
  title?: string;
  description?: string;
  workspacePath?: string;
  groupName?: string | null;
  avatarType?: "emoji" | "image";
  avatarValue?: string;
  systemPrompt?: string;
  defaultModelId?: string | null;
  knowledgeCollectionId?: string | null;
  allowedToolIds?: string[];
  allowedSkillIds?: string[];
  memoryScope?: ProjectMemoryScope;
  autoSaveMemories?: boolean;
  autoSaveSummaries?: boolean;
};

export type Project = {
  id: string;
  kind: ProjectKind;
  title: string;
  description: string;
  workspacePath: string;
  groupName?: string | null;
  avatarType?: "emoji" | "image";
  avatarValue?: string;
  systemPrompt?: string;
  defaultModelId?: string | null;
  knowledgeCollectionId?: string | null;
  allowedToolIds: string[];
  allowedSkillIds: string[];
  memoryScope: ProjectMemoryScope;
  autoSaveMemories: boolean;
  autoSaveSummaries: boolean;
  createdAt: number;
  updatedAt: number;
};

export type ProjectPresetRecord = {
  id: string;
  title: string;
  description: string;
  avatarCode?: string | null;
  systemPrompt?: string;
  defaultModelId?: string | null;
  allowedToolIds: string[];
  allowedSkillIds: string[];
};

export type ManifestStorageSnapshot = {
  projectPresets: ProjectPresetRecord[];
  toolManifests: Array<Record<string, unknown>>;
  skillManifests: Array<Record<string, unknown>>;
};

export type SessionSummaryRecord = {
  sessionId: string;
  projectId: string;
  title: string;
  summary: string;
  updatedAt: number;
};

export type ProjectMemorySourceType = "auto" | "manual" | "command" | "legacy";

export type ProjectMemoryRecord = {
  id: string;
  projectId: string;
  content: string;
  sourceSessionId?: string | null;
  sourceType?: ProjectMemorySourceType;
  createdAt: number;
  updatedAt: number;
};

export type SuggestedProjectMemory = {
  content: string;
  reason?: string | null;
};

export type SuggestedSessionSummary = {
  title?: string | null;
  summary: string;
};

export type UserPreferenceRecord = {
  key: string;
  value: string;
  updatedAt: number;
};

export type ScheduledTaskRecord = {
  id: string;
  title: string;
  prompt: string;
  cron: string;
  target: "desktop" | "notification" | "session";
  sessionId?: string | null;
  enabled: boolean;
  lastRunAt?: number | null;
  createdAt: number;
  updatedAt: number;
};

export type ChatSession = {
  id: string;
  projectId: string;
  title: string;
  messages: Message[];
  pinned?: boolean;
  favorite?: boolean;
  createdAt: number;
  updatedAt: number;
  usage: ChatUsageStats;
};

export type ChatExecutionResult = {
  content: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  estimated: boolean;
  costUsd: number;
  knowledgeContext?: KnowledgeContextResult | null;
  suggestedMemories?: SuggestedProjectMemory[];
  suggestedSummary?: SuggestedSessionSummary | null;
  /** 推理模型的思考链全文（如 R1 / Gemini 2.5 thinking） */
  reasoning?: string;
  /** 工具循环实际执行轮数（无工具时为 0） */
  toolRounds?: number;
};

export type ChatSendOptions = {
  hiddenContext?: string;
  knowledgeCollectionId?: string | null;
};

export type SlashSkill = {
  id: string;
  command: string;
  title: string;
  description: string;
  systemPrompt?: string;
  promptPrefix?: string;
};
