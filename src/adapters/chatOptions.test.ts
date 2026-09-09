import { describe, it, expect } from "vitest";
import {
  ReasoningEffort,
  ToolChoice,
  reasoningEffortFromConfig,
  resolveRequestOptions,
  resolveContextWindow,
  MIN_CONTEXT_WINDOW,
  defaultChatOptions,
  claudeThinkingConfig,
  geminiThinkingConfig,
  openAIToolChoice,
  claudeToolChoice,
  geminiToolConfig,
  ollamaToolChoice,
} from "./chatOptions";
import type { ChatRequest, ModelConfig } from "./types";

const thinkingModel = (over: Partial<ModelConfig> = {}): ModelConfig => ({
  id: "m",
  name: "M",
  provider: "openai",
  maxTokens: 200000,
  maxOutput: 100000,
  supportsVision: false,
  supportsStreaming: true,
  thinking: true,
  ...over,
});

describe("reasoningEffortFromConfig", () => {
  it("解析标准等级（大小写不敏感）", () => {
    expect(reasoningEffortFromConfig("low")).toBe(ReasoningEffort.Low);
    expect(reasoningEffortFromConfig("MEDIUM")).toBe(ReasoningEffort.Medium);
    expect(reasoningEffortFromConfig("High")).toBe(ReasoningEffort.High);
    expect(reasoningEffortFromConfig("xhigh")).toBe(ReasoningEffort.XHigh);
    expect(reasoningEffortFromConfig("MAX")).toBe(ReasoningEffort.Max);
  });
  it("off / 空 / 未知 ⇒ 无意见（undefined），不抛错", () => {
    expect(reasoningEffortFromConfig("off")).toBeUndefined();
    expect(reasoningEffortFromConfig("")).toBeUndefined();
    expect(reasoningEffortFromConfig(null)).toBeUndefined();
    expect(reasoningEffortFromConfig("bogus")).toBeUndefined();
  });
});

describe("resolveRequestOptions", () => {
  it("options 优先于遗留 flat 字段", () => {
    const req: ChatRequest = {
      messages: [],
      model: "m",
      temperature: 0.9,
      maxTokens: 123,
      options: { temperature: 0.3, reasoningEffort: ReasoningEffort.High, toolChoice: ToolChoice.Required },
    };
    const r = resolveRequestOptions(req);
    expect(r.temperature).toBe(0.3);
    expect(r.maxTokens).toBe(123); // flat 回退
    expect(r.reasoningEffort).toBe(ReasoningEffort.High);
    expect(r.toolChoice).toBe(ToolChoice.Required);
  });
  it("无 options 时回落 flat（行为与改造前一致）", () => {
    const req: ChatRequest = { messages: [], model: "m", temperature: 0.7, maxTokens: 4096 };
    const r = resolveRequestOptions(req);
    expect(r.temperature).toBe(0.7);
    expect(r.maxTokens).toBe(4096);
    expect(r.toolChoice).toBe(ToolChoice.Auto);
    expect(r.reasoningEffort).toBeUndefined();
  });
});

describe("defaultChatOptions", () => {
  it("thinking 模型默认带 Medium 推理力度；非 thinking 不带", () => {
    const t = defaultChatOptions(thinkingModel(), { temperature: 0.7, maxOutputTokens: 8000 });
    expect(t.reasoningEffort).toBe(ReasoningEffort.Medium);
    const n = defaultChatOptions(thinkingModel({ thinking: false }), { temperature: 0.7, maxOutputTokens: 8000 });
    expect(n.reasoningEffort).toBeUndefined();
  });
  it("explicit 推理力度覆盖默认", () => {
    const t = defaultChatOptions(thinkingModel(), { temperature: 0.7, maxOutputTokens: 8000 }, { reasoningEffort: ReasoningEffort.Low });
    expect(t.reasoningEffort).toBe(ReasoningEffort.Low);
  });
});

describe("claudeThinkingConfig", () => {
  it("预算必须严格小于 max_tokens 且不低于 1024", () => {
    const cfg = claudeThinkingConfig(ReasoningEffort.Medium, 4096);
    expect(cfg?.type).toBe("enabled");
    expect(cfg?.budget_tokens).toBeLessThan(4096);
    expect(cfg?.budget_tokens).toBeGreaterThanOrEqual(1024);
  });
  it("max_tokens 过小（<=1024）时不开启 thinking", () => {
    expect(claudeThinkingConfig(ReasoningEffort.Medium, 1024)).toBeUndefined();
  });
  it("无力度 ⇒ undefined", () => {
    expect(claudeThinkingConfig(undefined, 32000)).toBeUndefined();
  });
});

describe("geminiThinkingConfig", () => {
  it("映射力度到 thinkingBudget + includeThoughts", () => {
    const cfg = geminiThinkingConfig(ReasoningEffort.High);
    expect(cfg).toEqual({ thinkingBudget: 8192, includeThoughts: true });
    expect(geminiThinkingConfig(undefined)).toBeUndefined();
  });
});

describe("toolChoice 映射", () => {
  it("OpenAI", () => {
    expect(openAIToolChoice(ToolChoice.Auto)).toBe("auto");
    expect(openAIToolChoice(ToolChoice.Required)).toBe("required");
    expect(openAIToolChoice(ToolChoice.None)).toBe("none");
    expect(openAIToolChoice(ToolChoice.Specific, "foo")).toEqual({ type: "function", function: { name: "foo" } });
  });
  it("Claude：None 由调用方省略 tools；其余映射到 tool_choice 对象", () => {
    expect(claudeToolChoice(ToolChoice.Auto)).toEqual({ type: "auto" });
    expect(claudeToolChoice(ToolChoice.Required)).toEqual({ type: "any" });
    expect(claudeToolChoice(ToolChoice.Specific, "b")).toEqual({ type: "tool", name: "b" });
  });
  it("Gemini：mode 映射", () => {
    expect(geminiToolConfig(ToolChoice.Auto)).toEqual({ functionCallingConfig: { mode: "AUTO" } });
    expect(geminiToolConfig(ToolChoice.Required)).toEqual({ functionCallingConfig: { mode: "ANY" } });
    expect(geminiToolConfig(ToolChoice.None)).toEqual({ functionCallingConfig: { mode: "NONE" } });
    expect(geminiToolConfig(ToolChoice.Specific, "x")).toEqual({
      functionCallingConfig: { mode: "SPECIFIC", allowedFunctionNames: ["x"] },
    });
  });
  it("Ollama：仅支持 auto/required/none，Specific 回落 required", () => {
    expect(ollamaToolChoice(ToolChoice.Auto)).toBeUndefined();
    expect(ollamaToolChoice(ToolChoice.Required)).toBe("required");
    expect(ollamaToolChoice(ToolChoice.None)).toBe("none");
    expect(ollamaToolChoice(ToolChoice.Specific)).toBe("required");
  });
});

describe("resolveContextWindow（双字段 + 兜底，对齐 atomcode/codex-main）", () => {
  it("显式 maxTokens 优先采用", () => {
    expect(resolveContextWindow({ maxTokens: 8192 })).toBe(8192);
  });
  it("maxTokens 缺失时回落 maxContextWindow（即便很小也如实返回，不抬高到 128k）", () => {
    expect(resolveContextWindow({ maxContextWindow: 4096 })).toBe(4096);
  });
  it("两者皆缺失/为 0 ⇒ 兜底 MIN_CONTEXT_WINDOW(128k)", () => {
    expect(resolveContextWindow()).toBe(MIN_CONTEXT_WINDOW);
    expect(resolveContextWindow({})).toBe(MIN_CONTEXT_WINDOW);
    expect(resolveContextWindow({ maxTokens: 0, maxContextWindow: 0 })).toBe(MIN_CONTEXT_WINDOW);
  });
  it("maxTokens 为 0 视为缺失 ⇒ 回落 maxContextWindow", () => {
    expect(resolveContextWindow({ maxTokens: 0, maxContextWindow: 32768 })).toBe(32768);
  });
  it("maxTokens 存在时不得越过硬上限（裁剪到 max，对齐 Codex）", () => {
    expect(resolveContextWindow({ maxTokens: 200000, maxContextWindow: 64000 })).toBe(64000);
  });
  it("显式小窗口不被强制抬到下限（保护 Ollama 4k/8k 本地模型）", () => {
    expect(resolveContextWindow({ maxTokens: 4096 })).toBe(4096);
    expect(resolveContextWindow({ maxTokens: 8192, maxContextWindow: 8192 })).toBe(8192);
  });
});
