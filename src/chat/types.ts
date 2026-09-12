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
  /**
   * 项目可用的 MCP 连接器白名单（存连接器 manifest id）。
   *
   * **空 / 缺省 = 不限**（放行全部已信任连接器），只有填了才是收窄。这样定有两个理由：
   * ①存量项目没有这个字段，若把「空」读成「一个都不启用」，升级后会静默丢掉全部 MCP 工具；
   * ②「不限」恰好等于本字段引入前的行为，所以老数据不需要迁移。
   *
   * ⚠️ 别跟 `boundExpertIds` 混为一谈 —— 那个字段**空 = 一个都不派**，与这里相反。
   * 旧注释写的「语义与 boundExpertIds 一致」是错的，也是 UI 那句「留空则不限制」的源头。
   */
  allowedConnectorIds?: string[];
  /**
   * 项目绑定的专家（子 Agent 委派白名单）。
   *
   * **空 / 缺省 = 一个都不派**，不是「不限」：`expertDelegation.ts::isExpertBound`
   * 对空列表一律返回 false，`chatRuntimeHelpers.ts::buildExpertAgentHint` 于是给出空名册
   * （提示词里直接写 `EXPERTS: none available right now`）。要放宽须在
   * 「设置 → 子 Agent 模型」打开 `allowAnyExpertDelegation`。
   *
   * 另注：用户在输入框手动 `@专家` 属于本人显式选择，**不受**该白名单约束。
   */
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
  /** 项目可用的 MCP 连接器白名单；空 / 缺省 = 不限（口径同 `ProjectDraft.allowedConnectorIds`） */
  allowedConnectorIds?: string[];
  /** 项目绑定的专家（子 Agent 委派白名单）；**空 / 缺省 = 不派任何专家**（非「不限」，见 `ProjectDraft.boundExpertIds`） */
  boundExpertIds?: string[];
  memoryScope: ProjectMemoryScope;
  createdAt: number;
  updatedAt: number;
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
