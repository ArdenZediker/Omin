/**
 * 跨适配器的「历史 reasoning 回传策略」（对齐 atomcode 的 per-model ReasoningPolicy）。
 *
 * 核心原则：只有「能安全接受纯文本 reasoning_content 的 OpenAI 兼容端点」才 Include；
 * Claude / Gemini 的 thinking 回传需要带签名的原生 block（Omni 未存储 signature），
 * 纯文本回传会被 API 拒绝，因此这两条线路由各自的适配器直接不回传，不进本策略。
 *
 * 派生逻辑（按 provider + 模型名关键字）：
 * - 命中 Exclude 关键字（R1 / reasoner / GLM / OpenAI o 系）：回传会 400 → Exclude
 * - 命中 Include 关键字（v4 / kimi / moonshot / mimo）：工具轮必须回传否则 400 → Include
 *   （空串被部分端点拒绝，用占位符 '·' 代替）
 * - 其它：默认 Exclude（保持现状零 token，且避免多数 OpenAI 兼容端点拒绝未知字段）
 *
 * 显式覆盖：ModelConfig.returnReasoning 为 true / false 时跳过关键字派生。
 */

export interface ReasoningReturnPolicy {
  /** 是否把历史 assistant 消息的 reasoning 回传给模型（影响 token + 多轮思考连续性） */
  include: boolean;
  /**
   * include 且某条消息的 reasoning 为空时，用此占位符回传。
   * 部分端点（如 deepseek-v4）工具轮空串 reasoning_content 被拒，必须用非空占位符。
   * 为 null 时不补占位符（直接跳过该条回传）。
   */
  placeholder: string | null;
}

const INCLUDE_HINTS = ["v4", "kimi", "moonshot", "mimo", "minimax", "mini-max"];
const EXCLUDE_HINTS = ["r1", "reasoner", "glm", "o1", "o3", "o4", "o-"];

/** 永远不回传的常量策略（Claude / Gemini 适配器直接复用，避免重复构造）。 */
export const EXCLUDE_REASONING: ReasoningReturnPolicy = { include: false, placeholder: null };

/**
 * 按 provider + 模型名派生回传策略。
 * @param explicit ModelConfig.returnReasoning 显式覆盖（true=强制 Include，false=强制 Exclude）；缺省走关键字派生。
 */
export function resolveReasoningReturnPolicy(
  provider: string,
  modelId: string,
  explicit?: boolean | null
): ReasoningReturnPolicy {
  if (explicit != null) {
    return explicit ? { include: true, placeholder: "·" } : { include: false, placeholder: null };
  }
  const p = provider.toLowerCase();
  // Ollama 本地模型不识别 reasoning_content（且多为非推理模型），一律不回传，避免异常。
  if (p === "ollama") return { include: false, placeholder: null };
  const m = String(modelId).toLowerCase();
  if (EXCLUDE_HINTS.some((h) => m.includes(h))) return { include: false, placeholder: null };
  if (INCLUDE_HINTS.some((h) => m.includes(h))) return { include: true, placeholder: "·" };
  return { include: false, placeholder: null };
}
