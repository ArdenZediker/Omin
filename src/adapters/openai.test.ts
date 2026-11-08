import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAIAdapter } from "./openai";
import { ToolChoice } from "./chatOptions";
import { clearLearnedUnsupportedParams } from "./paramCompat";

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

describe("OpenAIAdapter 模型发现", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("读取 /models 并稳定排序；本地免鉴权端点不发送 Authorization", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        data: [
          { id: "zeta-model" },
          { id: "alpha-model", name: "Alpha Model" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    ));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenAIAdapter({ apiKey: "", baseUrl: "http://localhost:1234/v1" });
    await expect(adapter.discoverModels()).resolves.toEqual([
      { id: "alpha-model", name: "Alpha Model" },
      { id: "zeta-model", name: "zeta-model" },
    ]);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
  });
});

const TOOL = { name: "read_file", description: "读文件", parameters: { type: "object", properties: {} } };

const okResponse = () =>
  new Response(
    JSON.stringify({ choices: [{ message: { content: "hi" } }], model: "kimi-k3", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );

const paramErrorResponse = (param: string) =>
  new Response(
    JSON.stringify({ error: { message: `Parameter '${param}'=0.7 is not supported for kimi-k3 model.` } }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  );

describe("OpenAIAdapter 参数下发契约与自动降级", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearLearnedUnsupportedParams();
  });

  const run = async (options: { toolChoice?: ToolChoice; responses: Response[] }) => {
    const bodies: Record<string, unknown>[] = [];
    const queue = [...options.responses];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return queue.shift() ?? okResponse();
      })
    );
    const adapter = new OpenAIAdapter({ apiKey: "sk-test", baseUrl: "https://example.com/v1" });
    const result = await adapter.chat({
      messages: [{ role: "user", content: "hi" }],
      model: "kimi-k3",
      temperature: 0.7,
      maxTokens: 1024,
      tools: [TOOL],
      options: options.toolChoice ? { toolChoice: options.toolChoice } : undefined,
    });
    return { bodies, result };
  };

  it("ToolChoice.Auto 是「无意见」→ 不下发 tool_choice（但 tools 照发）", async () => {
    const { bodies } = await run({ responses: [okResponse()] });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toHaveProperty("tools");
    expect(bodies[0]).not.toHaveProperty("tool_choice");
  });

  it("显式指定 toolChoice 时才下发 tool_choice", async () => {
    const { bodies } = await run({ toolChoice: ToolChoice.Required, responses: [okResponse()] });
    expect(bodies[0].tool_choice).toBe("required");
  });

  it("服务端拒绝 temperature 时自动剥参重发一次并成功", async () => {
    const { bodies, result } = await run({ responses: [paramErrorResponse("temperature"), okResponse()] });
    expect(result.content).toBe("hi");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toHaveProperty("temperature");
    expect(bodies[1]).not.toHaveProperty("temperature");
  });

  it("学到的缺口在同一进程内对后续请求直接生效（不再多打一次 400）", async () => {
    await run({ responses: [paramErrorResponse("temperature"), okResponse()] });
    const second = await run({ responses: [okResponse()] });
    expect(second.bodies).toHaveLength(1);
    expect(second.bodies[0]).not.toHaveProperty("temperature");
  });
});

describe("OpenAIAdapter 流式 usage 锚点", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearLearnedUnsupportedParams();
  });

  const streamResponse = () => new Response(
    [
      'data: {"choices":[{"delta":{"content":"你"}}],"model":"kimi-k3"}',
      "",
      'data: {"choices":[],"model":"kimi-k3","usage":{"prompt_tokens":1200,"completion_tokens":34,"total_tokens":1234}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );

  it("请求 include_usage，并把末尾 usage 带回 ChatResponse", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return streamResponse();
      })
    );

    const adapter = new OpenAIAdapter({ apiKey: "sk-test", baseUrl: "https://example.com/v1" });
    const result = await adapter.chatStream({
      messages: [{ role: "user", content: "hi" }],
      model: "kimi-k3",
      stream: true,
    }, () => undefined);

    expect(bodies[0].stream_options).toEqual({ include_usage: true });
    expect(result.usage).toEqual({
      promptTokens: 1200,
      completionTokens: 34,
      totalTokens: 1234,
    });
  });

  it("端点拒绝 stream_options 时自动剥参重发", async () => {
    const bodies: Record<string, unknown>[] = [];
    const queue = [paramErrorResponse("stream_options"), streamResponse()];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return queue.shift() ?? streamResponse();
      })
    );

    const adapter = new OpenAIAdapter({ apiKey: "sk-test", baseUrl: "https://example.com/v1" });
    const result = await adapter.chatStream({
      messages: [{ role: "user", content: "hi" }],
      model: "kimi-k3",
      stream: true,
    }, () => undefined);

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toHaveProperty("stream_options");
    expect(bodies[1]).not.toHaveProperty("stream_options");
    expect(result.usage?.promptTokens).toBe(1200);
  });
});
