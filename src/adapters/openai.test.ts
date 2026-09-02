import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAIAdapter } from "./openai";

describe("OpenAIAdapter 非流式 reasoning 字段兼容", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const makeResponse = (messageBody: Record<string, unknown>) =>
    new Response(JSON.stringify({ choices: [{ message: messageBody }], model: "test-model", usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const callAdapter = (mockResponse: Response) => {
    const adapter = new OpenAIAdapter({ apiKey: "sk-test", baseUrl: "https://example.com/v1" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));
    return adapter.chat({
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-test",
      stream: false,
    });
  };

  it("从 message.reasoning_content 取值（DeepSeek-R1 风格）", async () => {
    const response = await callAdapter(
      makeResponse({ content: "答案", reasoning_content: "思考 A" }),
    );
    expect(response.reasoning).toBe("思考 A");
  });

  it("从 message.reasoning 取值（GPT-5.6 / Responses API 中转风格）", async () => {
    const response = await callAdapter(
      makeResponse({ content: "答案", reasoning: "思考 B" }),
    );
    expect(response.reasoning).toBe("思考 B");
  });

  it("从 message.thought 取值（Gemini 中转风格）", async () => {
    const response = await callAdapter(
      makeResponse({ content: "答案", thought: "思考 C" }),
    );
    expect(response.reasoning).toBe("思考 C");
  });

  it("无 reasoning 字段时不报错且返回 undefined", async () => {
    const response = await callAdapter(
      makeResponse({ content: "普通回答" }),
    );
    expect(response.reasoning).toBeUndefined();
    expect(response.content).toBe("普通回答");
  });
});