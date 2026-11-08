import type { ChatTurnUsage, ContextUsageAnchor } from "../adapters/types";
import type { ChatExecutionResult } from "./types";

function isTokenCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizeContextSample(sample: ContextUsageAnchor | undefined): ContextUsageAnchor | undefined {
  if (!sample) return undefined;
  const model = sample.model.trim();
  if (
    !model
    || !isTokenCount(sample.promptTokens)
    || !isTokenCount(sample.conversationTokens)
    || !isTokenCount(sample.estimatedTokens)
  ) {
    return undefined;
  }
  return {
    promptTokens: sample.promptTokens,
    conversationTokens: sample.conversationTokens,
    estimatedTokens: sample.estimatedTokens,
    model,
  };
}

/** 把本轮 usage 固化到消息；provider 未返回精确 usage 时保留本地估算值并明确标记。 */
export function createTurnUsage(result: ChatExecutionResult | null | undefined): ChatTurnUsage | undefined {
  if (!result) return undefined;
  const { promptTokens, completionTokens, totalTokens } = result.usage;
  if (!isTokenCount(promptTokens) || !isTokenCount(completionTokens) || !isTokenCount(totalTokens)) {
    return undefined;
  }
  if (totalTokens <= 0 || totalTokens < completionTokens) return undefined;
  const model = result.model.trim();
  if (!model) return undefined;
  const contextSample = normalizeContextSample(result.contextSample);
  const cachedPromptTokens = result.usage.cachedPromptTokens;
  const generationDurationMs = result.generationDurationMs;
  const modelDurationMs = result.modelDurationMs;
  const ttftDurationMs = result.ttftDurationMs;
  const ttftSamples = result.ttftSamples;
  return {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    totalTokens,
    model,
    toolRounds: isTokenCount(result.toolRounds ?? 0) ? result.toolRounds ?? 0 : 0,
    ...(isTokenCount(cachedPromptTokens ?? -1) && (cachedPromptTokens ?? 0) <= promptTokens
      ? { cachedPromptTokens }
      : {}),
    ...(typeof generationDurationMs === "number"
      && Number.isFinite(generationDurationMs)
      && generationDurationMs > 0
      ? { generationDurationMs }
      : {}),
    ...(typeof modelDurationMs === "number"
      && Number.isFinite(modelDurationMs)
      && modelDurationMs > 0
      ? { modelDurationMs }
      : {}),
    ...(typeof ttftDurationMs === "number"
      && Number.isFinite(ttftDurationMs)
      && ttftDurationMs >= 0
      ? { ttftDurationMs }
      : {}),
    ...(isTokenCount(ttftSamples ?? -1)
      ? { ttftSamples }
      : {}),
    ...(result.estimated ? { estimated: true } : {}),
    ...(contextSample ? { contextSample } : {}),
  };
}

function scaleCompactCount(value: number): string {
  return value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
}

/** 571 / 12.2K / 517K / 1.2M，与 DSH 的本轮用量胶囊一致。 */
export function formatCompactTokenCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${scaleCompactCount(value / 1_000)}K`;
  return `${scaleCompactCount(value / 1_000_000)}M`;
}

/** 明细弹层使用完整整数和千分位，不做四舍五入。 */
export function formatExactTokenCount(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

/** Whole tok/s from 10 upward, one decimal below, matching DSH. */
export function formatTokensPerSecond(value: number): string {
  const clamped = Math.max(0, value);
  return clamped >= 10
    ? String(Math.round(clamped))
    : String(Math.round(clamped * 10) / 10);
}

/** Compact cache-hit percentage; very high ratios retain enough precision to stay below 100. */
export function formatCacheHitPercent(cachedTokens: number, inputTokens: number): string | null {
  if (inputTokens <= 0) return null;
  const percent = Math.min(100, Math.max(0, (cachedTokens / inputTokens) * 100));
  if (percent >= 100) return "100";
  if (percent >= 99.99) return percent.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  if (percent >= 99.9) return percent.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  if (percent >= 10) return String(Math.round(percent));
  return String(Math.round(percent * 10) / 10);
}
