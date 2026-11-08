import { describe, expect, it } from "vitest";
import type {
  AgentMessage,
  ModelRequest,
} from "../agent-core";
import type {
  ChatRequest,
  ChatResponse,
  ModelAdapter,
  ProviderConfig,
  StreamChunk,
} from "../adapters/types";
import { AdapterModelProvider } from "./adapter-model-provider";

const MODEL = {
  provider: "test",
  model: "test-model",
  reasoningEffort: "high" as const,
  maxTokens: 512,
  temperature: 0.2,
};

function request(messages: AgentMessage[]): ModelRequest {
  return {
    sessionId: "session-1",
    turn: 1,
    step: 1,
    messages,
    system: "system prompt",
    tools: [{
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object" },
    }],
    config: MODEL,
    signal: new AbortController().signal,
  };
}

class FakeAdapter implements ModelAdapter {
  readonly provider = "test";
  readonly models = [];
  seenRequest?: ChatRequest;

  constructor(readonly config: ProviderConfig) {}

  async chat(): Promise<ChatResponse> {
    throw new Error("not used");
  }

  async chatStream(
    chatRequest: ChatRequest,
    onChunk: (chunk: StreamChunk) => void,
  ): Promise<ChatResponse> {
    this.seenRequest = chatRequest;
    onChunk({ content: "", reasoning: "thinking", done: false, model: "test-model" });
    onChunk({ content: "hello", done: false, model: "test-model" });
    return {
      content: "hello",
      model: "test-model",
      reasoning: "thinking",
      usage: {
        promptTokens: 7,
        completionTokens: 3,
        totalTokens: 10,
        cachedPromptTokens: 2,
      },
      toolCalls: [{
        id: "call-1",
        name: "read_file",
        arguments: "{\"path\":\"README.md\"}",
      }],
    };
  }

  async validate(): Promise<boolean> {
    return true;
  }
}

describe("AdapterModelProvider", () => {
  it("maps Agent messages, stream deltas, usage, and tool calls", async () => {
    const fake = new FakeAdapter({ apiKey: "secret", protocol: "openai" });
    const provider = new AdapterModelProvider(() => fake);
    expect(provider.configureProvider({
      provider: "test",
      apiKey: "secret",
      baseUrl: "http://localhost:9999",
      protocol: "openai",
    })).toEqual({
      provider: "test",
      protocol: "openai",
      baseUrl: "http://localhost:9999",
      hasApiKey: true,
    });

    const events = [];
    for await (const event of provider.stream(request([
      {
        id: "user-1",
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "image",
            image: { src: "data:image/png;base64,AAAA", name: "shot.png" },
          },
        ],
        createdAt: 0,
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: [
          { type: "text", text: "previous" },
          { type: "reasoning", text: "prior thought" },
          {
            type: "tool-call",
            call: { id: "old-call", name: "read_file", arguments: "{}" },
          },
        ],
        createdAt: 1,
      },
      {
        id: "tool-1",
        role: "tool",
        content: [{ type: "text", text: "file contents" }],
        createdAt: 2,
        source: { callId: "old-call", name: "read_file" },
      },
    ]))) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "reasoning-delta", text: "thinking" },
      { type: "text-delta", text: "hello" },
      {
        type: "usage",
        usage: {
          promptTokens: 7,
          completionTokens: 3,
          totalTokens: 10,
          cachedPromptTokens: 2,
        },
      },
      {
        type: "finish",
        reason: {
          kind: "tool-calls",
          calls: [{
            id: "call-1",
            name: "read_file",
            arguments: "{\"path\":\"README.md\"}",
          }],
        },
      },
    ]);
    expect(fake.seenRequest).toMatchObject({
      model: "test-model",
      messages: [
        { role: "system", content: "system prompt" },
        {
          role: "user",
          content: "look",
          images: [{ src: "data:image/png;base64,AAAA", name: "shot.png" }],
        },
        {
          role: "assistant",
          content: "previous",
          reasoning: "prior thought",
          toolCalls: [{ id: "old-call", name: "read_file", arguments: "{}" }],
        },
        {
          role: "tool",
          content: "file contents",
          toolCallId: "old-call",
          toolCallName: "read_file",
        },
      ],
      options: {
        reasoningEffort: "high",
        maxTokens: 512,
        temperature: 0.2,
      },
    });
  });

  it("does not expose credentials and rejects unconfigured providers", async () => {
    const provider = new AdapterModelProvider(() => (
      new FakeAdapter({ apiKey: "secret" })
    ));
    provider.configureProvider({
      provider: "test",
      apiKey: "secret",
      protocol: "openai",
    });

    expect(provider.listProviders()).toEqual([{
      provider: "test",
      protocol: "openai",
      hasApiKey: true,
    }]);
    expect(JSON.stringify(provider.listProviders())).not.toContain("secret");
    expect(provider.removeProvider("test")).toBe(true);

    const consume = async () => {
      for await (const _event of provider.stream(request([]))) {
        // Consume the stream so the configuration error is raised.
      }
    };
    await expect(consume()).rejects.toThrow('provider "test" is not configured');
  });
});
