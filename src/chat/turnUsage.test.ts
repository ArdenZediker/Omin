import { describe, expect, it } from "vitest";
import type { ChatExecutionResult } from "./types";
import {
  createTurnUsage,
  formatCacheHitPercent,
  formatCompactTokenCount,
  formatExactTokenCount,
  formatTokensPerSecond,
} from "./turnUsage";

function result(overrides: Partial<ChatExecutionResult> = {}): ChatExecutionResult {
  return {
    content: "完成",
    model: "deepseek-v3",
    usage: {
      promptTokens: 48_200,
      completionTokens: 2_900,
      totalTokens: 51_100,
    },
    estimated: false,
    costUsd: 0,
    toolRounds: 3,
    ...overrides,
  };
}

describe("createTurnUsage", () => {
  it("把 provider 完整返回的 usage 固化到本轮消息", () => {
    expect(createTurnUsage(result())).toEqual({
      inputTokens: 48_200,
      outputTokens: 2_900,
      totalTokens: 51_100,
      model: "deepseek-v3",
      toolRounds: 3,
    });
  });

  it("provider 未返回 usage 时保留估算值并标记口径", () => {
    expect(createTurnUsage(result({ estimated: true }))).toEqual({
      inputTokens: 48_200,
      outputTokens: 2_900,
      totalTokens: 51_100,
      model: "deepseek-v3",
      toolRounds: 3,
      estimated: true,
    });
  });

  it("保留 provider 上下文锚点供后续请求增量计量", () => {
    expect(createTurnUsage(result({
      contextSample: {
        promptTokens: 48_200,
        conversationTokens: 45_000,
        estimatedTokens: 50_000,
        model: "deepseek-v3",
      },
    }))?.contextSample).toEqual({
      promptTokens: 48_200,
      conversationTokens: 45_000,
      estimatedTokens: 50_000,
      model: "deepseek-v3",
    });
  });

  it("保存缓存命中和生成耗时供 DSH 状态条汇总", () => {
    expect(createTurnUsage(result({
      usage: {
        promptTokens: 1_000,
        completionTokens: 40,
        totalTokens: 1_040,
        cachedPromptTokens: 360,
      },
      generationDurationMs: 2_000,
      modelDurationMs: 69_000,
      ttftDurationMs: 12_000,
      ttftSamples: 1,
    }))).toMatchObject({
      cachedPromptTokens: 360,
      generationDurationMs: 2_000,
      modelDurationMs: 69_000,
      ttftDurationMs: 12_000,
      ttftSamples: 1,
    });
  });

  it("token 计数无效或没有总量时不展示", () => {
    expect(createTurnUsage(result({
      usage: { promptTokens: -1, completionTokens: 2, totalTokens: 1 },
    }))).toBeUndefined();
    expect(createTurnUsage(result({
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 0 },
    }))).toBeUndefined();
  });
});

describe("token 数量格式化", () => {
  it("胶囊使用 DSH 的 K/M 规则", () => {
    expect(formatCompactTokenCount(999)).toBe("999");
    expect(formatCompactTokenCount(51_100)).toBe("51.1K");
    expect(formatCompactTokenCount(517_000)).toBe("517K");
    expect(formatCompactTokenCount(1_200_000)).toBe("1.2M");
  });

  it("明细保持完整整数和千分位", () => {
    expect(formatExactTokenCount(51_100)).toBe("51,100");
  });

  it("速度和缓存命中使用 DSH 紧凑格式", () => {
    expect(formatTokensPerSecond(9.84)).toBe("9.8");
    expect(formatTokensPerSecond(18.6)).toBe("19");
    expect(formatCacheHitPercent(360, 1_000)).toBe("36");
    expect(formatCacheHitPercent(999, 1_000)).toBe("99.9");
    expect(formatCacheHitPercent(1_000, 1_000)).toBe("100");
    expect(formatCacheHitPercent(0, 0)).toBeNull();
  });
});
