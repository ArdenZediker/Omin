import { describe, it, expect } from "vitest";
import { resolveReasoningReturnPolicy } from "./reasoningPolicy";

// 对齐 atomcode 的 per-model ReasoningPolicy：只有能安全接受纯文本 reasoning_content
// 的 OpenAI 兼容端点才 Include；其余默认 Exclude（保持现状零 token）。
describe("resolveReasoningReturnPolicy", () => {
  it("默认不回传（保持现状零 token）", () => {
    expect(resolveReasoningReturnPolicy("openai", "gpt-4o")).toEqual({ include: false, placeholder: null });
    expect(resolveReasoningReturnPolicy("deepseek", "deepseek-chat")).toEqual({ include: false, placeholder: null });
  });

  it("OpenAI o 系推理模型回传会 400 → Exclude", () => {
    expect(resolveReasoningReturnPolicy("openai", "o1")).toEqual({ include: false, placeholder: null });
    expect(resolveReasoningReturnPolicy("openai", "o3-mini")).toEqual({ include: false, placeholder: null });
  });

  it("deepseek-reasoner (R1) 回传会 400 → Exclude", () => {
    expect(resolveReasoningReturnPolicy("deepseek", "deepseek-reasoner")).toEqual({ include: false, placeholder: null });
  });

  it("GLM 回传会 400 → Exclude", () => {
    expect(resolveReasoningReturnPolicy("openai", "glm-4-plus")).toEqual({ include: false, placeholder: null });
  });

  it("kimi / moonshot / mimo 工具轮必须回传 → Include（空串用占位符）", () => {
    expect(resolveReasoningReturnPolicy("openai", "kimi-k2")).toEqual({ include: true, placeholder: "·" });
    expect(resolveReasoningReturnPolicy("openai", "moonshot-v1-8k")).toEqual({ include: true, placeholder: "·" });
    expect(resolveReasoningReturnPolicy("openai", "mini-max-m1")).toEqual({ include: true, placeholder: "·" });
  });

  it("deepseek-v4 工具轮必须回传 → Include", () => {
    expect(resolveReasoningReturnPolicy("deepseek", "deepseek-v4")).toEqual({ include: true, placeholder: "·" });
  });

  it("Ollama 本地模型一律不回传（不识别 reasoning_content）", () => {
    expect(resolveReasoningReturnPolicy("ollama", "llama3")).toEqual({ include: false, placeholder: null });
    expect(resolveReasoningReturnPolicy("ollama", "kimi-k2")).toEqual({ include: false, placeholder: null });
  });

  it("显式覆盖优先于关键字派生", () => {
    expect(resolveReasoningReturnPolicy("openai", "gpt-4o", true)).toEqual({ include: true, placeholder: "·" });
    expect(resolveReasoningReturnPolicy("openai", "kimi-k2", false)).toEqual({ include: false, placeholder: null });
  });
});
