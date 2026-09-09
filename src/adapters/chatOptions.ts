// Omni - 中性 per-call 请求选项（吸收 atomcode 的 ChatOptions 抽象）
//
// 设计原则（对齐 atomcode kernel）：
// - `ChatOptions` 是 SLOT（槽位），不是 POLICY（策略）。它只承载「引擎这一轮想对模型
//   说什么」的中性旋钮（推理力度 / 输出上限 / 温度 / 工具选择方式），不携带任何
//   供应商特定的字段。
// - 这些旋钮的「线上含义」由 L1 适配器负责：每个适配器把中性旋钮映射到自己的 wire 格式
//   （例如 reasoning_effort → OpenAI 的 `reasoning_effort` 字符串，Anthropic 的
//   thinking `budget_tokens`，Gemini 的 `thinkingConfig.thinkingBudget`），不支持的旋钮
//   适配器可直接忽略。
// - 引擎（kernel）只负责「设置」这些中性值，「解释」模型旋钮含义的是适配器。
// - `ChatOptions` 全 `None` 即「无意见」中性请求：温度/上限走模型/偏好默认，工具模型自决。
//
// 这样 Omni 的模型调用就与具体供应商解耦：新增一个支持推理力度的模型，只需在目录里把
// `thinking: true` 标上，引擎会自动带推理力度，适配器负责落地，业务层零改动。

import type { ChatRequest, ModelConfig } from "./types";

/**
 * 中性推理/思考力度等级。适配器映射到后端 wire 格式：
 *  - OpenAI 系（含 DeepSeek / o 系列 / 中转）：`reasoning_effort` 字符串
 *  - Anthropic：thinking `budget_tokens`
 *  - Gemini：`thinkingConfig.thinkingBudget`
 * 不支持的适配器忽略即可。
 */
export enum ReasoningEffort {
  Low = "low",
  Medium = "medium",
  High = "high",
  /** 介于标准 high 与天花板 max 之间（部分端点如 AtomGit Qwen 接受） */
  XHigh = "xhigh",
  /** 最高力度（DeepSeek V4 等接受 "max"） */
  Max = "max",
}

/**
 * 把配置字符串（"low"|"medium"|"high"|"xhigh"|"max"，大小写不敏感）解析为力度等级。
 * `None` / 空 / "off" / 未知值 ⇒ `undefined`（无意见，回落适配器默认）。
 * 力度是非关键优化项，未知值降级而非报错。
 */
export function reasoningEffortFromConfig(value?: string | null): ReasoningEffort | undefined {
  switch ((value ?? "").trim().toLowerCase()) {
    case "low":
      return ReasoningEffort.Low;
    case "medium":
      return ReasoningEffort.Medium;
    case "high":
      return ReasoningEffort.High;
    case "xhigh":
      return ReasoningEffort.XHigh;
    case "max":
      return ReasoningEffort.Max;
    default:
      return undefined;
  }
}

/** 中性工具使用指令。适配器映射到后端 tool_choice：OpenAI/Claude/Ollama 的 tool_choice，Gemini 的 functionCallingConfig.mode。 */
export enum ToolChoice {
  /** 无意见，模型自行决定是否调用工具（中性默认） */
  Auto = "auto",
  /** 模型本轮必须调用至少一个工具 */
  Required = "required",
  /** 模型本轮不得调用任何工具 */
  None = "none",
  /** 模型本轮必须调用指定名称的工具 */
  Specific = "specific",
}

/** 中性 per-call 请求旋钮集合（SLOT，非 POLICY）。 */
export interface ChatOptions {
  /** 推理/思考力度；`undefined` = 无意见（适配器默认） */
  reasoningEffort?: ReasoningEffort;
  /** 单次输出上限（token）；`undefined` = 无意见（适配器/modelConfig 默认） */
  maxTokens?: number;
  /** 采样温度；`undefined` = 无意见（适配器默认，多为 0.7） */
  temperature?: number;
  /** 工具选择方式；缺省 Auto */
  toolChoice?: ToolChoice;
  /** 当 toolChoice 为 Specific 时，要求模型调用的工具名 */
  toolChoiceName?: string;
}

/**
 * 合并中性选项与遗留 flat 字段：options 优先，回退到 ChatRequest 上的 temperature/maxTokens。
 * 保证「只设了老 flat 字段」的调用方（含测试）行为不变。
 */
export function resolveRequestOptions(request: ChatRequest): {
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
  toolChoice: ToolChoice;
  toolChoiceName?: string;
} {
  const o = request.options;
  return {
    temperature: o?.temperature ?? request.temperature,
    maxTokens: o?.maxTokens ?? request.maxTokens,
    reasoningEffort: o?.reasoningEffort,
    toolChoice: o?.toolChoice ?? ToolChoice.Auto,
    toolChoiceName: o?.toolChoiceName,
  };
}

/**
 * 由模型能力 + 用户偏好构造默认中性选项。
 * - thinking 模型默认带 Medium 推理力度（可被 explicit.reasoningEffort 覆盖）；
 *   非 thinking 模型不携带推理力度 → 适配器不会发供应商不支持的字段 → 零行为变化。
 * - 温度/上限来自偏好（与原行为一致）。
 */
export function defaultChatOptions(
  model: ModelConfig | undefined,
  prefs: { temperature: number; maxOutputTokens: number },
  explicit?: { reasoningEffort?: ReasoningEffort; toolChoice?: ToolChoice; toolChoiceName?: string }
): ChatOptions {
  const reasoningEffort =
    explicit?.reasoningEffort ?? (model?.thinking ? ReasoningEffort.Medium : undefined);
  return {
    temperature: prefs.temperature,
    maxTokens: prefs.maxOutputTokens,
    reasoningEffort,
    toolChoice: explicit?.toolChoice ?? ToolChoice.Auto,
    toolChoiceName: explicit?.toolChoiceName,
  };
}

// ───────────────────────── 适配器 wire 映射助手 ─────────────────────────

/** 推理力度 → OpenAI 系 `reasoning_effort` 字符串。 */
export function reasoningEffortToOpenAI(effort?: ReasoningEffort): string | undefined {
  return effort;
}

/** 推理力度 → Anthropic thinking `budget_tokens`（须 < max_tokens 且 >= 1024）。 */
export function claudeThinkingConfig(
  effort?: ReasoningEffort,
  maxTokens?: number
): { type: "enabled"; budget_tokens: number } | undefined {
  if (!effort) return undefined;
  const max = maxTokens && maxTokens > 0 ? maxTokens : 0;
  // Claude 约束：budget 必须 >= 1024 且严格 < max_tokens。因此 max_tokens 必须 > 1024 才有空间容纳。
  if (max <= 1024) return undefined;
  const derived =
    effort === ReasoningEffort.Low
      ? 2000
      : effort === ReasoningEffort.Medium
      ? 8000
      : effort === ReasoningEffort.High
      ? 16000
      : effort === ReasoningEffort.XHigh
      ? 24000
      : 32000;
  const budget = Math.min(derived, max - 1);
  return { type: "enabled", budget_tokens: budget };
}

/** 推理力度 → Gemini `thinkingConfig`（thinkingBudget + 回传 thoughts）。 */
export function geminiThinkingConfig(
  effort?: ReasoningEffort
): { thinkingBudget: number; includeThoughts: boolean } | undefined {
  if (!effort) return undefined;
  const budget =
    effort === ReasoningEffort.Low
      ? 1024
      : effort === ReasoningEffort.Medium
      ? 4096
      : effort === ReasoningEffort.High
      ? 8192
      : effort === ReasoningEffort.XHigh
      ? 12288
      : 16384;
  return { thinkingBudget: budget, includeThoughts: true };
}

/** 中性 toolChoice → OpenAI `tool_choice` 值。None 映射为 "none"。 */
export function openAIToolChoice(tc: ToolChoice, name?: string): unknown {
  switch (tc) {
    case ToolChoice.Required:
      return "required";
    case ToolChoice.None:
      return "none";
    case ToolChoice.Specific:
      return name ? { type: "function", function: { name } } : "required";
    case ToolChoice.Auto:
    default:
      return "auto";
  }
}

/** 中性 toolChoice → Anthropic `tool_choice`。返回 undefined 表示随模型自决。None 在 Claude 无法直接表达，调用方应据此省略 tools。 */
export function claudeToolChoice(tc: ToolChoice, name?: string): Record<string, unknown> | undefined {
  switch (tc) {
    case ToolChoice.Required:
      return { type: "any" };
    case ToolChoice.Specific:
      return name ? { type: "tool", name } : { type: "any" };
    case ToolChoice.Auto:
    default:
      return { type: "auto" };
  }
}

/** 中性 toolChoice → Gemini `functionCallingConfig`。 */
export function geminiToolConfig(tc: ToolChoice, name?: string): Record<string, unknown> | undefined {
  switch (tc) {
    case ToolChoice.Required:
      return { functionCallingConfig: { mode: "ANY" } };
    case ToolChoice.None:
      return { functionCallingConfig: { mode: "NONE" } };
    case ToolChoice.Specific:
      return name
        ? { functionCallingConfig: { mode: "SPECIFIC", allowedFunctionNames: [name] } }
        : { functionCallingConfig: { mode: "ANY" } };
    case ToolChoice.Auto:
    default:
      return { functionCallingConfig: { mode: "AUTO" } };
  }
}

/** 中性 toolChoice → Ollama `tool_choice` 字符串（Ollama 仅支持 auto/required/none）。Specific 回落 required。 */
export function ollamaToolChoice(tc: ToolChoice): string | undefined {
  switch (tc) {
    case ToolChoice.Required:
    case ToolChoice.Specific:
      return "required";
    case ToolChoice.None:
      return "none";
    case ToolChoice.Auto:
    default:
      return undefined;
  }
}
