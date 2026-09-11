import { describe, it, expect } from "vitest";
import {
  OpenAIStreamToolAccumulator,
  ClaudeStreamToolAccumulator,
  parseGeminiStreamToolCalls,
  toOpenAIMessage,
  toOllamaMessage,
} from "./wireTools";
import { EXCLUDE_REASONING, type ReasoningReturnPolicy } from "./reasoningPolicy";

describe("OpenAIStreamToolAccumulator", () => {
  it("跨 chunk 累加同一 index 的 id/name/arguments 增量", () => {
    const acc = new OpenAIStreamToolAccumulator();
    acc.add([{ index: 0, id: "call_1", function: { name: "web_search", arguments: "{\"q\":" } }]);
    acc.add([{ index: 0, function: { arguments: "\"hello\"}" } }]);
    acc.add([{ index: 1, id: "call_2", function: { name: "read_file", arguments: "{}" } }]);
    const calls = acc.getToolCalls();
    expect(calls).toHaveLength(2);
    expect(calls![0]).toEqual({ id: "call_1", name: "web_search", arguments: '{"q":"hello"}' });
    expect(calls![1]).toEqual({ id: "call_2", name: "read_file", arguments: "{}" });
  });

  it("缺 name 的残片被丢弃；空输入返回 undefined", () => {
    const acc = new OpenAIStreamToolAccumulator();
    acc.add([{ index: 0, function: { arguments: "{}" } }]);
    expect(acc.getToolCalls()).toBeUndefined();
    expect(new OpenAIStreamToolAccumulator().getToolCalls()).toBeUndefined();
  });

  it("arguments 为空时补 '{}'", () => {
    const acc = new OpenAIStreamToolAccumulator();
    acc.add([{ index: 0, id: "call_x", function: { name: "noop" } }]);
    expect(acc.getToolCalls()![0].arguments).toBe("{}");
  });
});

describe("ClaudeStreamToolAccumulator", () => {
  it("content_block_start + input_json_delta + stop 拼出完整调用", () => {
    const acc = new ClaudeStreamToolAccumulator();
    acc.add({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "web_fetch" } });
    acc.add({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"url": "https://' } });
    acc.add({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'example.com"}' } });
    acc.add({ type: "content_block_stop", index: 0 });
    const calls = acc.getToolCalls();
    expect(calls).toHaveLength(1);
    expect(calls![0].name).toBe("web_fetch");
    expect(calls![0].arguments).toBe('{"url": "https://example.com"}');
  });

  it("input_json 被截断时尽力修复（包一层补全）", () => {
    const acc = new ClaudeStreamToolAccumulator();
    acc.add({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_2", name: "x" } });
    acc.add({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"a": 1' } });
    acc.add({ type: "content_block_stop", index: 0 });
    const calls = acc.getToolCalls();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls![0].arguments)).toEqual({ a: 1 });
  });
});

describe("parseGeminiStreamToolCalls", () => {
  it("从 parts 快照提取 functionCall", () => {
    const calls = parseGeminiStreamToolCalls([
      { text: "让我查一下" },
      { functionCall: { name: "web_search", args: { q: "weather" } } },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls![0].name).toBe("web_search");
    expect(JSON.parse(calls![0].arguments)).toEqual({ q: "weather" });
  });

  it("无 functionCall 返回 undefined", () => {
    expect(parseGeminiStreamToolCalls([{ text: "hi" }])).toBeUndefined();
    expect(parseGeminiStreamToolCalls(undefined)).toBeUndefined();
  });
});

describe("历史 reasoning 回传（toOpenAIMessage / toOllamaMessage）", () => {
  const policyInclude: ReasoningReturnPolicy = { include: true, placeholder: "·" };

  it("默认不回传 reasoning_content（保持现状零 token）", () => {
    const msg = { role: "assistant", content: "答案", reasoning: "我先想想" } as any;
    expect(toOpenAIMessage(msg)).not.toHaveProperty("reasoning_content");
  });

  it("policy.include 且 reasoning 非空 → 回传 reasoning_content", () => {
    const msg = { role: "assistant", content: "答案", reasoning: "我先想想" } as any;
    expect(toOpenAIMessage(msg, policyInclude)).toEqual({
      role: "assistant",
      content: "答案",
      reasoning_content: "我先想想",
    });
  });

  it("policy.include 且 reasoning 为空 → 用占位符回传（部分端点空串被拒）", () => {
    const msg = { role: "assistant", content: "答案", reasoning: "" } as any;
    expect(toOpenAIMessage(msg, policyInclude)).toEqual({
      role: "assistant",
      content: "答案",
      reasoning_content: "·",
    });
  });

  it("assistant 带 toolCalls 时 reasoning_content 一并回传", () => {
    const msg = {
      role: "assistant",
      content: "调工具",
      reasoning: "需要查文件",
      toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }],
    } as any;
    expect((toOpenAIMessage(msg, policyInclude) as any).reasoning_content).toBe("需要查文件");
  });

  it("tool 角色消息不回传 reasoning", () => {
    const msg = { role: "tool", toolCallId: "c1", content: "结果", reasoning: "x" } as any;
    expect(toOpenAIMessage(msg, policyInclude)).not.toHaveProperty("reasoning_content");
  });

  it("toOllamaMessage 同样遵循 policy", () => {
    const msg = { role: "assistant", content: "答案", reasoning: "思考" } as any;
    expect((toOllamaMessage(msg, policyInclude) as any).reasoning_content).toBe("思考");
    expect(toOllamaMessage(msg)).not.toHaveProperty("reasoning_content");
  });

  it("EXCLUDE_REASONING 常量等价于不包含", () => {
    const msg = { role: "assistant", content: "答案", reasoning: "x" } as any;
    expect(toOpenAIMessage(msg, EXCLUDE_REASONING)).not.toHaveProperty("reasoning_content");
  });
});
