import type { ChatAttachment, ChatStep, ChatToolCallResult, Message } from "../adapters/types";
import type { KnowledgeContextResult } from "./knowledgeTypes";

export type { ChatAttachment, ChatStep, ChatToolCallResult };

export type ChatUsagePreferences = {
  enableStreaming: boolean;
  enableVisionInput: boolean;
  temperature: number;
  maxOutputTokens: number;
  /**
   * 省算力压缩：开启后上下文溢出时跳过 LLM 摘要、直接丢弃最旧历史（TokenBudget 滑动窗口），
   * 用上下文损失换算力。缺省 false（保真摘要）。
   */
  costSaverCompaction?: boolean;
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
  /** 项目绑定的专家（子 Agent 委派白名单）；空/缺省 = 不限，暴露全部已装专家 */
  boundExpertIds?: string[];
  memoryScope?: ProjectMemoryScope;
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
  /** 项目绑定的专家（子 Agent 委派白名单）；空/缺省 = 不限 */
  boundExpertIds?: string[];
  memoryScope: ProjectMemoryScope;
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
  /** 会话固化的工作目录（effective workspace）。与 codex 一致：即使未显式绑定工作空间，
   *  也会落盘为一个兜底目录，保证「永远有 cwd」。空字符串表示尚未固化（落盘时由 Rust 补全）。 */
  workspacePath?: string;
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
  /** 工具循环内全部步骤的结果汇总（按轮次/调用顺序），挂到 assistant 消息用于 UI 思考块 */
  toolCallResults?: ChatToolCallResult[];
  /** 工具循环内按轮交错的 steps 流（reasoning 段 + 工具步骤）；存在时 UI 优先按 steps 渲染 */
  steps?: ChatStep[];
};

export type ChatSendOptions = {
  hiddenContext?: string;
  knowledgeCollectionId?: string | null;
  /** 本次对话指定专家（@专家角色切换）：用专家提示词/工具/技能集驱动本轮 */
  expertId?: string | null;
  /** 本次发送附带的本地文件（绝对路径引用，不内联内容） */
  attachments?: ChatAttachment[];
};

export type SlashSkill = {
  id: string;
  command: string;
  title: string;
  description: string;
  systemPrompt?: string;
  promptPrefix?: string;
};
