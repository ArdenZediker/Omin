import { describe, expect, it } from "vitest";
import type { Message } from "../adapters/types";
import { createEmptyUsageStats } from "./storage";
import { deriveChatSessionStats } from "./sessionStats";

function message(overrides: Partial<Message>): Message {
  return { role: "project", content: "answer", ...overrides };
}

describe("deriveChatSessionStats", () => {
  it("counts completed turns, assistant steps and tool calls", () => {
    const messages: Message[] = [
      { role: "user", content: "q1" },
      { role: "project", content: "a1" },
      { role: "user", content: "q2" },
      message({
        content: "a2",
        toolCallResults: [
          { id: "call-1", name: "read", arguments: "{}", result: "ok" },
        ],
        turnUsage: {
          inputTokens: 1_000,
          outputTokens: 40,
          totalTokens: 1_040,
          model: "test",
          toolRounds: 1,
          cachedPromptTokens: 360,
          generationDurationMs: 2_000,
          modelDurationMs: 69_000,
          ttftDurationMs: 12_000,
          ttftSamples: 1,
        },
      }),
    ];
    const stats = deriveChatSessionStats(messages, undefined, false);

    expect(stats).toMatchObject({
      turns: 2,
      steps: 3,
      totalTokens: 1_040,
      cachedPromptTokens: 360,
      cacheObservedInputTokens: 1_000,
      generationDurationMs: 2_000,
      generationTokens: 40,
      modelDurationMs: 69_000,
      ttftDurationMs: 12_000,
      ttftSamples: 1,
      hasCacheReading: true,
    });
  });

  it("keeps the previous settled stats while the next answer is streaming", () => {
    const usage = createEmptyUsageStats();
    const messages: Message[] = [
      { role: "user", content: "q1" },
      {
        role: "project",
        content: "a1",
        turnUsage: {
          inputTokens: 100,
          outputTokens: 10,
          totalTokens: 110,
          model: "test",
          toolRounds: 0,
        },
      },
      { role: "user", content: "q2" },
      { role: "project", content: "partial" },
    ];

    const stats = deriveChatSessionStats(messages, usage, true);
    expect(stats).toMatchObject({ turns: 1, steps: 1, totalTokens: 110 });
  });
});
