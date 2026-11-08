import type {
  ChatImage,
  ChatToolParam,
  ContextUsageAnchor,
  Message,
} from "../adapters/types";

/**
 * DSH token-meter 的固定密度启发式。
 *
 * 这不是模型 tokenizer：它只负责低延迟、确定性、可跨 provider 复用的基础价格；
 * 最近一次 provider usage 会作为锚点覆盖这个价格，后续内容只计算增量。
 */
const CHARS_PER_TOKEN = 4;
const BLOCK_OVERHEAD = 4;
const ROLE_OVERHEAD = 4;

/**
 * Omni 的图片通道没有按路由维护图片请求价格，沿用适配层当前的视觉占位价格。
 * 文本与工具结构则严格使用 DSH 的 4 字符 / token + 结构开销口径。
 */
export const IMAGE_REQUEST_TOKENS = 256;

export interface ContextMeasurement {
  tokens: number;
  basis: "usage" | "estimated" | "none";
  deltaTokens: number;
}

/** 固定密度文本价格；空文本不产生 token。 */
export function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / CHARS_PER_TOKEN);
}

function estimateImages(images: readonly ChatImage[] | undefined): number {
  return (images?.length ?? 0) * IMAGE_REQUEST_TOKENS;
}

/**
 * 单条模型可见消息的启发式价格。
 *
 * 文本、reasoning、工具调用、工具结果和图片分别定价；消息角色统一加一个固定开销，
 * 与 DSH 的 `estimateMessage()` / `estimateContent()` 保持同一层级。
 */
export function estimateMessageTokens(message: Message): number {
  let tokens = ROLE_OVERHEAD + estimateTokens(message.content);
  tokens += estimateImages(message.images);
  if (message.reasoning) tokens += estimateTokens(message.reasoning);
  if (message.toolCallName) tokens += estimateTokens(message.toolCallName);
  for (const call of message.toolCalls ?? []) {
    tokens += estimateTokens(call.name)
      + estimateTokens(call.arguments)
      + BLOCK_OVERHEAD;
  }
  return tokens;
}

/** 一组消息的固定启发式总价。 */
export function estimatePromptTokens(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

/** system prompt 的固定启发式价格。 */
export function estimateSystemTokens(system: string | undefined): number {
  if (!system) return 0;
  return ROLE_OVERHEAD + estimateTokens(system);
}

/** tools schema 的固定启发式价格。 */
export function estimateToolsTokens(tools: readonly ChatToolParam[] | undefined): number {
  if (!tools || tools.length === 0) return 0;
  return BLOCK_OVERHEAD + estimateTokens(JSON.stringify(tools));
}

/** 一次请求的完整启发式价格：消息 + 工具 schema。 */
export function estimateRequestTokens(
  messages: readonly Message[],
  tools?: readonly ChatToolParam[],
): number {
  return estimatePromptTokens(messages) + estimateToolsTokens(tools);
}

/**
 * 真实 usage 锚点 + 当前启发式增量。
 *
 * - usage 只有在不低于同一锚点的完整启发式价格时才可信；
 * - 不可信或缺失时，退回当前内容的完整启发式价格；
 * - compaction 等导致内容减少时，锚点后的增量为有符号值。
 */
export function measureContextTokens(
  currentEstimatedTokens: number,
  anchor?: ContextUsageAnchor,
): ContextMeasurement {
  const current = Math.max(0, Math.round(currentEstimatedTokens));
  if (!anchor) return { tokens: current, basis: current > 0 ? "estimated" : "none", deltaTokens: 0 };

  const deltaTokens = current - anchor.estimatedTokens;
  if (anchor.promptTokens >= anchor.estimatedTokens) {
    return {
      tokens: Math.max(0, anchor.promptTokens + deltaTokens),
      basis: "usage",
      deltaTokens,
    };
  }
  return { tokens: current, basis: current > 0 ? "estimated" : "none", deltaTokens };
}

/**
 * 面向上下文面板的计量：provider 压力锚点 + 持久化会话 surface 增量。
 *
 * UI 无法完整复刻引擎动态组装的 system prompt；因此命中 provider 锚点时只推进
 * 用户在会话里新增的内容，header 保持锚点基线。切换模型会直接失效；header
 * 自身的变化在下一次 provider usage 返回后重新校准。
 */
export function measureContextUsage(
  currentConversationTokens: number,
  currentEstimatedTokens: number,
  anchor?: ContextUsageAnchor,
): ContextMeasurement {
  if (!anchor || anchor.promptTokens < anchor.estimatedTokens) {
    return measureContextTokens(currentEstimatedTokens, undefined);
  }
  const conversationTokens = Math.max(0, Math.round(currentConversationTokens));
  const deltaTokens = conversationTokens - anchor.conversationTokens;
  return {
    tokens: Math.max(0, anchor.promptTokens + deltaTokens),
    basis: "usage",
    deltaTokens,
  };
}

/**
 * 找到当前模型最近一次可直接复用的 provider 上下文锚点。
 * 模型切换后旧路由的 usage 不能继续锚定新路由。
 */
export function findLatestContextSample(
  messages: readonly Message[],
  model: string | undefined,
): ContextUsageAnchor | undefined {
  if (!model) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const sample = messages[index].turnUsage?.contextSample;
    if (sample?.model === model) return sample;
  }
  return undefined;
}
