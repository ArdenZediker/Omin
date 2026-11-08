import type { TokenUsage } from "./types";

function tokenCount(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function cachedOpenAITokens(usage: any, promptTokens: number): number | undefined {
  const candidates = [
    usage?.prompt_tokens_details?.cached_tokens,
    usage?.prompt_cache_hit_tokens,
    usage?.cache_read_input_tokens,
  ];
  for (const candidate of candidates) {
    const value = tokenCount(candidate);
    if (value !== undefined) return Math.min(value, promptTokens);
  }
  return undefined;
}

/** OpenAI-compatible usage, including cache fields used by DeepSeek and relays. */
export function normalizeOpenAIUsage(raw: any): TokenUsage | undefined {
  const promptTokens = tokenCount(raw?.prompt_tokens);
  const completionTokens = tokenCount(raw?.completion_tokens);
  const totalTokens = tokenCount(raw?.total_tokens);
  if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) {
    return undefined;
  }
  const cachedPromptTokens = cachedOpenAITokens(raw, promptTokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(cachedPromptTokens === undefined ? {} : { cachedPromptTokens }),
  };
}

/** Anthropic reports cache reads/writes separately from uncached input. */
export function normalizeClaudeUsage(raw: any): TokenUsage | undefined {
  const inputTokens = tokenCount(raw?.input_tokens);
  const completionTokens = tokenCount(raw?.output_tokens);
  if (inputTokens === undefined || completionTokens === undefined) return undefined;
  const cacheReadTokens = tokenCount(raw?.cache_read_input_tokens);
  const cacheWriteTokens = tokenCount(raw?.cache_creation_input_tokens) ?? 0;
  const promptTokens = inputTokens + (cacheReadTokens ?? 0) + cacheWriteTokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    ...(cacheReadTokens === undefined ? {} : { cachedPromptTokens: cacheReadTokens }),
  };
}

/** Gemini reports cached content as a subset of the prompt-side token count. */
export function normalizeGeminiUsage(raw: any): TokenUsage | undefined {
  const promptTokens = tokenCount(raw?.promptTokenCount);
  const completionTokens = tokenCount(raw?.candidatesTokenCount);
  const totalTokens = tokenCount(raw?.totalTokenCount);
  if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) {
    return undefined;
  }
  const cachedPromptTokens = tokenCount(raw?.cachedContentTokenCount);
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(cachedPromptTokens === undefined
      ? {}
      : { cachedPromptTokens: Math.min(cachedPromptTokens, promptTokens) }),
  };
}
