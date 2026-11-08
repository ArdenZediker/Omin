import { describe, expect, it } from "vitest";
import {
  normalizeClaudeUsage,
  normalizeGeminiUsage,
  normalizeOpenAIUsage,
} from "./usage";

describe("provider usage normalization", () => {
  it("reads OpenAI-compatible cache details and DeepSeek cache hit tokens", () => {
    expect(normalizeOpenAIUsage({
      prompt_tokens: 1_000,
      completion_tokens: 50,
      total_tokens: 1_050,
      prompt_tokens_details: { cached_tokens: 360 },
    })).toEqual({
      promptTokens: 1_000,
      completionTokens: 50,
      totalTokens: 1_050,
      cachedPromptTokens: 360,
    });

    expect(normalizeOpenAIUsage({
      prompt_tokens: 2_000,
      completion_tokens: 80,
      total_tokens: 2_080,
      prompt_cache_hit_tokens: 1_500,
    })?.cachedPromptTokens).toBe(1_500);
  });

  it("keeps Anthropic cache reads disjoint from uncached input", () => {
    expect(normalizeClaudeUsage({
      input_tokens: 200,
      output_tokens: 40,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 100,
    })).toEqual({
      promptTokens: 1_100,
      completionTokens: 40,
      totalTokens: 1_140,
      cachedPromptTokens: 800,
    });
  });

  it("reads Gemini cached content tokens", () => {
    expect(normalizeGeminiUsage({
      promptTokenCount: 500,
      candidatesTokenCount: 20,
      totalTokenCount: 520,
      cachedContentTokenCount: 125,
    })?.cachedPromptTokens).toBe(125);
  });
});
