import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeAdapter } from "./claude";
import { GeminiAdapter } from "./gemini";
import { OllamaAdapter } from "./ollama";

function sse(lines: string[]) {
  return new Response(lines.join("\n"), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("流式 provider usage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("Claude 聚合 message_start 输入与 message_delta 输出", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse([
      'data: {"type":"message_start","message":{"model":"claude-test","usage":{"input_tokens":100,"cache_read_input_tokens":20}}}',
      "",
      'data: {"type":"message_delta","usage":{"output_tokens":30}}',
      "",
      'data: {"type":"message_stop"}',
      "",
    ])));

    const adapter = new ClaudeAdapter({ apiKey: "x", baseUrl: "https://example.com" });
    const result = await adapter.chatStream({
      messages: [{ role: "user", content: "hi" }],
      model: "claude-test",
      stream: true,
    }, () => undefined);

    expect(result.usage).toEqual({
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
      cachedPromptTokens: 20,
    });
  });

  it("Gemini 读取最后一块 usageMetadata", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse([
      'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}',
      "",
      'data: {"candidates":[{"content":{"parts":[{"text":""}]}}],"usageMetadata":{"promptTokenCount":80,"candidatesTokenCount":12,"totalTokenCount":92}}',
      "",
    ])));

    const adapter = new GeminiAdapter({ apiKey: "x", baseUrl: "https://example.com" });
    const result = await adapter.chatStream({
      messages: [{ role: "user", content: "hi" }],
      model: "gemini-test",
      stream: true,
    }, () => undefined);

    expect(result.usage).toEqual({
      promptTokens: 80,
      completionTokens: 12,
      totalTokens: 92,
    });
  });

  it("Ollama 读取 done 块的 prompt_eval_count / eval_count", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response([
      '{"message":{"content":"hi"},"done":false}',
      '{"message":{"content":""},"done":true,"prompt_eval_count":40,"eval_count":7}',
      "",
    ].join("\n"), {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    })));

    const adapter = new OllamaAdapter({ apiKey: "", baseUrl: "http://localhost:11434" });
    const result = await adapter.chatStream({
      messages: [{ role: "user", content: "hi" }],
      model: "ollama-test",
      stream: true,
    }, () => undefined);

    expect(result.usage).toEqual({
      promptTokens: 40,
      completionTokens: 7,
      totalTokens: 47,
    });
  });
});
