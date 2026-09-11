// Omni - 模型参数兼容层
//
// 背景：OpenAI 兼容请求体里的「参数支持面」因模型而异。同一个端点下，有的模型收
// temperature、有的直接拒绝。典型报文：
//   HTTP 400 - {"error":{"message":"<400> InternalError.Algo.InvalidParameter:
//     Parameter 'temperature'=0.7 is not supported for kimi-k3 model."}}
//
// 服务端往往已经在报文里点名了是哪个参数，因此不需要让用户为每个模型手工填能力表——
// 三层协作即可覆盖：
//   ① 契约修正：`ChatOptions` 里语义为「无意见」的槽位（如 `ToolChoice.Auto`）适配器
//      **不得下发**。下发即违约，也是「不支持该字段」类 400 的主要来源。
//   ② 能力声明：`ModelConfig.unsupportedParams` —— 内置目录可标注，用户也可在自定义
//      模型表单里声明（自注册模型无法靠内置目录覆盖）。
//   ③ 自动降级：运行期从「不支持参数」报错中学习，记住后不再下发（见
//      `rememberUnsupportedParam`，带 localStorage 持久化）。
//
// 有效跳过集 = ② ∪ ③，由 `resolveUnsupportedParams` 统一给出。

import type { ModelConfig, UnsupportedParam } from "./types";

export type { UnsupportedParam };

/** 各家的 wire 字段名 → 中立槽位。同时用于「从错误报文反查」与「从请求体反查」。 */
const WIRE_NAMES: Record<string, UnsupportedParam> = {
  temperature: "temperature",
  max_tokens: "maxTokens",
  max_completion_tokens: "maxTokens",
  max_output_tokens: "maxTokens",
  maxoutputtokens: "maxTokens",
  num_predict: "maxTokens",
  tool_choice: "toolChoice",
  reasoning_effort: "reasoningEffort",
  // Claude 的 thinking / Gemini 的 thinkingConfig 同属「推理力度」槽位
  thinking: "reasoningEffort",
  thinkingconfig: "reasoningEffort",
  thinkingbudget: "reasoningEffort",
};

/** 单次请求最多为「剥掉不支持参数」额外重发的次数（对应多参数不兼容时的上限）。 */
export const MAX_PARAM_FALLBACK_RETRIES = 2;

/** 运行期学到的「该模型不支持的参数」。 */
const learned = new Map<string, Set<UnsupportedParam>>();

/** 持久化键：让学到的结论跨重启生效，避免每次启动都先撞一次 400。 */
const STORAGE_KEY = "omni_model_param_compat_v1";

/** 学到的结论变化时广播，供设置界面刷新「已跳过的参数」标记。 */
export const MODEL_PARAM_COMPAT_CHANGED_EVENT = "omni-model-param-compat-changed";

function notifyCompatChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(MODEL_PARAM_COMPAT_CHANGED_EVENT));
}

let hydrated = false;

function readStore(): Record<string, UnsupportedParam[]> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, UnsupportedParam[]> = {};
    for (const [modelId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const params = value.filter((item): item is UnsupportedParam => typeof item === "string" && item in WIRE_NAMES);
      if (params.length > 0) out[modelId] = params;
    }
    return out;
  } catch {
    return {};
  }
}

function hydrateOnce(): void {
  if (hydrated) return;
  hydrated = true;
  for (const [modelId, params] of Object.entries(readStore())) {
    learned.set(modelId, new Set(params));
  }
}

function persist(): void {
  if (typeof localStorage === "undefined") return;
  try {
    const data: Record<string, UnsupportedParam[]> = {};
    for (const [modelId, params] of learned.entries()) {
      if (params.size > 0) data[modelId] = [...params];
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // 持久化失败不影响本次降级行为，静默即可
  }
}

/** 记住某模型不支持的参数。 */
export function rememberUnsupportedParam(modelId: string, param: UnsupportedParam): void {
  if (!modelId) return;
  hydrateOnce();
  const set = learned.get(modelId) ?? new Set<UnsupportedParam>();
  set.add(param);
  learned.set(modelId, set);
  persist();
  notifyCompatChanged();
}

/** 读取某模型运行期学到的跳过集（副本，调用方可安全持有）。 */
export function getLearnedUnsupportedParams(modelId: string): Set<UnsupportedParam> {
  hydrateOnce();
  return new Set(learned.get(modelId) ?? []);
}

/** 取消某个参数的学习结论（恢复下发该参数）。 */
export function forgetUnsupportedParam(modelId: string, param: UnsupportedParam): void {
  if (!modelId) return;
  hydrateOnce();
  const set = learned.get(modelId);
  if (!set || !set.delete(param)) return;
  persist();
  notifyCompatChanged();
}

/** 清空学到的记录（测试用；不传 modelId 表示全清）。 */
export function clearLearnedUnsupportedParams(modelId?: string): void {
  hydrateOnce();
  if (modelId === undefined) {
    learned.clear();
    persist();
    notifyCompatChanged();
    return;
  }
  learned.delete(modelId);
  persist();
  notifyCompatChanged();
}

/** 有效跳过集 = 声明的能力缺口 ∪ 运行期学到的缺口。 */
export function resolveUnsupportedParams(
  modelId: string,
  declared?: readonly UnsupportedParam[]
): Set<UnsupportedParam> {
  const merged = new Set<UnsupportedParam>(declared ?? []);
  for (const param of getLearnedUnsupportedParams(modelId)) merged.add(param);
  return merged;
}

/** 从任意错误值里取可读报文。 */
export function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
}

/**
 * 取真正的错误文本：优先解包 `HTTP <code> - <json>` 里的 `error.message`；
 * 解析不出来就退回原文（Claude / Gemini 的报文结构各不相同，不能假设同一形状）。
 */
export function extractErrorMessage(raw: string): string {
  const body = raw.replace(/^HTTP\s+\d{3}\s*-\s*/i, "").trim();
  if (!body.startsWith("{")) return body || raw;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const nested = parsed.error as { message?: unknown } | undefined;
    const candidates: unknown[] = [
      nested?.message,
      (parsed as { message?: unknown }).message,
      Array.isArray(parsed.errors) ? (parsed.errors[0] as { message?: unknown } | undefined)?.message : undefined,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) return candidate;
    }
  } catch {
    // 非 JSON：退回原文
  }
  return body;
}

/** 「这是参数不支持/不识别类错误」的信号词。 */
const PARAM_ERROR_HINT =
  /not\s+supported|unsupported|not\s+permitted|extra\s+inputs|unknown\s+(parameter|argument|field)|invalid\s+parameter|unrecognized|unexpected\s+(parameter|argument|field)/i;

/**
 * 从错误报文里解析出「服务端拒绝的参数」。
 *
 * 两道防误判：① 报文必须含参数类信号词；② 只在引号包裹或独立成词时才算命中，
 * 免得把普通错误正文里提到同名的散文误当成参数名（那会导致无谓重发）。
 */
export function parseUnsupportedParam(rawMessage: string): UnsupportedParam | undefined {
  if (!rawMessage) return undefined;
  const text = extractErrorMessage(rawMessage);
  if (!text || !PARAM_ERROR_HINT.test(text)) return undefined;
  const lower = text.toLowerCase();

  // ① 优先取引号包裹的字段名：Parameter 'temperature'=0.7 is not supported ...
  for (const match of lower.matchAll(/['"`]([a-z_][a-z0-9_]*)['"`]/g)) {
    const hit = WIRE_NAMES[match[1]];
    if (hit) return hit;
  }

  // ② 回退到裸词扫描（按名长度降序，避免长名被短名抢先命中）
  const names = Object.keys(WIRE_NAMES).sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (new RegExp(`(^|[^a-z0-9_])${name}([^a-z0-9_]|$)`).test(lower)) return WIRE_NAMES[name];
  }
  return undefined;
}

/** 反查请求体里实际下发了哪些中立槽位（覆盖 OpenAI 顶层 / Ollama options / Gemini generationConfig 三种摆放位置）。 */
export function sentParamsOf(body: Record<string, unknown>): Set<UnsupportedParam> {
  const sent = new Set<UnsupportedParam>();
  const scanFlat = (source: Record<string, unknown>) => {
    if ("temperature" in source) sent.add("temperature");
    if (
      "max_tokens" in source ||
      "max_completion_tokens" in source ||
      "max_output_tokens" in source ||
      "maxOutputTokens" in source ||
      "num_predict" in source
    ) {
      sent.add("maxTokens");
    }
    if ("tool_choice" in source || "toolConfig" in source || "functionCallingConfig" in source) {
      sent.add("toolChoice");
    }
    if ("reasoning_effort" in source || "thinking" in source || "thinkingConfig" in source) {
      sent.add("reasoningEffort");
    }
  };
  scanFlat(body);
  if (body.options && typeof body.options === "object") {
    scanFlat(body.options as Record<string, unknown>);
  }
  if (body.generationConfig && typeof body.generationConfig === "object") {
    scanFlat(body.generationConfig as Record<string, unknown>);
  }
  return sent;
}

/**
 * 带「不支持参数自动降级」的请求发送器。
 *
 * 行为约定：
 * - `buildBody(skip)` 每次重试都会重新构造请求体，因此能立刻读到刚学到的跳过项；
 * - 只对「报文点名了 + 我们确实下发过 + 尚未跳过」的参数重发，因此鉴权/额度/上下文
 *   超限这类 400 不会被无谓重试；
 * - `hasEmittedContent()` 为 true 时不再重试（流式已吐字，重发会重复输出）。
 */
export async function sendWithParamCompat<T>(options: {
  modelId: string;
  declared?: readonly UnsupportedParam[];
  buildBody: (skip: Set<UnsupportedParam>) => Record<string, unknown>;
  send: (body: Record<string, unknown>) => Promise<T>;
  hasEmittedContent?: () => boolean;
}): Promise<T> {
  const { modelId, declared, buildBody, send, hasEmittedContent } = options;
  let retries = 0;
  for (;;) {
    const skip = resolveUnsupportedParams(modelId, declared);
    const body = buildBody(skip);
    try {
      return await send(body);
    } catch (error) {
      if (retries >= MAX_PARAM_FALLBACK_RETRIES || hasEmittedContent?.()) throw error;
      const param = parseUnsupportedParam(errorMessageOf(error));
      if (!param) throw error;
      // 没下发过 → 不是它的锅；已跳过仍失败 → 也不是它的锅（防死循环）
      if (!sentParamsOf(body).has(param)) throw error;
      if (skip.has(param)) throw error;
      rememberUnsupportedParam(modelId, param);
      retries += 1;
    }
  }
}

/** 供 UI / 调试用：把跳过集转成显示名。 */
/** 参数槽位 → 界面用的 { wire, title }：wire 是下发的原始字段名，title 是中文短名。 */
export function unsupportedParamParts(param: UnsupportedParam): { wire: string; title: string } {
  switch (param) {
    case "temperature":
      return { wire: "temperature", title: "采样温度" };
    case "maxTokens":
      return { wire: "max_tokens", title: "输出上限" };
    case "toolChoice":
      return { wire: "tool_choice", title: "工具选择" };
    case "reasoningEffort":
      return { wire: "reasoning_effort", title: "推理力度" };
    default:
      return { wire: param, title: param };
  }
}

export function describeUnsupportedParam(param: UnsupportedParam): string {
  const { wire, title } = unsupportedParamParts(param);
  return wire === title ? wire : `${wire}（${title}）`;
}

/**
 * 模型列表徽标数据源：该模型实际会被跳过的参数（显式声明 ∪ 运行期学到）。
 * 无跳过项时返回 null，便于 UI 直接条件渲染。
 */
export function describeSkippedParams(
  modelId: string,
  declared?: readonly UnsupportedParam[]
): { count: number; names: string[] } | null {
  const merged = resolveUnsupportedParams(modelId, declared);
  if (merged.size === 0) return null;
  return {
    count: merged.size,
    names: [...merged].map((param) => unsupportedParamParts(param).title),
  };
}

/** 全部可声明槽位（UI 渲染顺序即此顺序）。 */
export const ALL_UNSUPPORTED_PARAMS: readonly UnsupportedParam[] = [
  "temperature",
  "maxTokens",
  "toolChoice",
  "reasoningEffort",
];

/** 便捷判定：某模型配置是否声明了给定槽位不支持。 */
export function declaresUnsupported(model: ModelConfig | undefined, param: UnsupportedParam): boolean {
  return Boolean(model?.unsupportedParams?.includes(param));
}
