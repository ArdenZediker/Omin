import { describe, it, expect } from "vitest";
import { estimateTokens, estimatePromptTokens } from "./tokenEstimator";
import type { Message } from "../adapters/types";

describe("estimateTokens", () => {
  it("空串返回 0", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("   ")).toBe(0);
  });

  it("纯中文按 ~1.1 token/字", () => {
    const tokens = estimateTokens("你好世界");
    expect(tokens).toBe(5); // ceil(4 * 1.1) = ceil(4.4) = 5
  });

  it("纯英文按 4 字符 1 token", () => {
    expect(estimateTokens("abcdefgh")).toBe(2);
  });
});

describe("estimatePromptTokens", () => {
  it("累计消息内容 token", () => {
    const messages: Message[] = [
      { role: "user", content: "你好" },
      { role: "assistant", content: "hi" },
    ];
    expect(estimatePromptTokens(messages)).toBeGreaterThan(0);
  });

  it("图片按每张 256 token 计", () => {
    const messages: Message[] = [{ role: "user", content: "看图", images: [{ src: "data:image/png;base64,xxx" }] }];
    const noImage = estimatePromptTokens([{ role: "user", content: "看图" }]);
    expect(estimatePromptTokens(messages)).toBe(noImage + 256);
  });
});
