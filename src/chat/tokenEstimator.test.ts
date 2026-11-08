import { describe, expect, it } from "vitest";
import type { Message } from "../adapters/types";
import {
  estimateMessageTokens,
  estimatePromptTokens,
  estimateRequestTokens,
  estimateSystemTokens,
  estimateTokens,
  estimateToolsTokens,
  findLatestContextSample,
  measureContextTokens,
  measureContextUsage,
} from "./tokenEstimator";

describe("DSH 固定字符启发式", () => {
  it("文本按 4 字符 1 token，包含中文也不做隐藏倍率", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("你好世界")).toBe(1);
  });

  it("消息包含 role 与内容块结构开销", () => {
    expect(estimateMessageTokens({ role: "user", content: "abcdefgh" })).toBe(6);
  });

  it("工具调用与 tools schema 使用 JSON 结构价格", () => {
    const callMessage: Message = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "1", name: "read_file", arguments: "{\"path\":\"a\"}" }],
    };
    expect(estimateMessageTokens(callMessage)).toBeGreaterThan(4);
    expect(estimateToolsTokens([{ name: "read_file", parameters: { type: "object" } }])).toBeGreaterThan(4);
  });

  it("system 与一轮请求使用同一套基础价格", () => {
    const messages: Message[] = [{ role: "user", content: "abcdefgh" }];
    expect(estimateSystemTokens("system")).toBe(6);
    expect(estimatePromptTokens(messages)).toBe(6);
    expect(estimateRequestTokens(messages, [{ name: "tool" }])).toBeGreaterThan(6);
  });

  it("图片沿用 Omni 适配层声明的固定视觉价格", () => {
    const noImage = estimatePromptTokens([{ role: "user", content: "看图" }]);
    const image = estimatePromptTokens([{
      role: "user",
      content: "看图",
      images: [{ src: "data:image/png;base64,xxx" }],
    }]);
    expect(image).toBe(noImage + 256);
  });
});

describe("provider usage 锚点 + 启发式增量", () => {
  it("可信 provider usage 覆盖锚点价格，只计算会话增量", () => {
    const measurement = measureContextTokens(1_200, {
      promptTokens: 1_100,
      conversationTokens: 900,
      estimatedTokens: 1_000,
      model: "model-a",
    });
    expect(measurement).toEqual({
      tokens: 1_300,
      basis: "usage",
      deltaTokens: 200,
    });
  });

  it("UI 以 provider 压力为基线，只推进持久化会话 surface", () => {
    const measurement = measureContextUsage(1_050, 8_000, {
      promptTokens: 10_000,
      conversationTokens: 900,
      estimatedTokens: 9_000,
      model: "model-a",
    });
    expect(measurement.tokens).toBe(10_150);
    expect(measurement.basis).toBe("usage");
  });

  it("provider usage 低于完整启发式价格时回退当前估算", () => {
    const measurement = measureContextTokens(900, {
      promptTokens: 700,
      conversationTokens: 800,
      estimatedTokens: 1_000,
      model: "model-a",
    });
    expect(measurement.tokens).toBe(900);
    expect(measurement.basis).toBe("estimated");
  });

  it("压缩导致内容减少时，增量可为负数且总量不会低于 0", () => {
    expect(measureContextTokens(400, {
      promptTokens: 1_400,
      conversationTokens: 300,
      estimatedTokens: 1_200,
      model: "model-a",
    }).tokens).toBe(600);
    expect(measureContextTokens(0, {
      promptTokens: 100,
      conversationTokens: 0,
      estimatedTokens: 1_200,
      model: "model-a",
    }).tokens).toBe(0);
  });

  it("只复用当前模型的最近锚点", () => {
    const messages: Message[] = [
      {
        role: "project",
        content: "old",
        turnUsage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          model: "old-model",
          toolRounds: 0,
          contextSample: {
            promptTokens: 100,
            conversationTokens: 70,
            estimatedTokens: 90,
            model: "old-model",
          },
        },
      },
      {
        role: "project",
        content: "new",
        turnUsage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          model: "new-model",
          toolRounds: 0,
          contextSample: {
            promptTokens: 200,
            conversationTokens: 160,
            estimatedTokens: 180,
            model: "new-model",
          },
        },
      },
    ];
    expect(findLatestContextSample(messages, "new-model")?.promptTokens).toBe(200);
    expect(findLatestContextSample(messages, "missing-model")).toBeUndefined();
  });
});
