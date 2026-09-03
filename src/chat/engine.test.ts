import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeChatTurn } from "./engine";
import type { ChatResponse, ModelConfig, StreamChunk } from "../adapters/types";
import { modelRegistry } from "../adapters/registry";

vi.mock("./storage", () => ({
  getUsagePreferences: () => ({
    temperature: 0.7,
    maxOutputTokens: 2048,
    enableStreaming: true,
    enableVisionInput: false,
  }),
  loadPersonaConfig: async () => null,
}));

describe("executeChatTurn", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const mockModelConfig: ModelConfig = {
    id: "gpt-test",
    name: "GPT Test",
    provider: "openai",
    maxTokens: 128000,
    supportsVision: false,
    supportsStreaming: true,
    toolCalling: true,
  };

  function setupRegistry() {
    vi.spyOn(modelRegistry, "getRegisteredProviders").mockReturnValue(["openai"]);
    vi.spyOn(modelRegistry, "getAdapterForModel").mockReturnValue({} as ReturnType<typeof modelRegistry.getAdapterForModel>);
    vi.spyOn(modelRegistry, "getModelConfig").mockReturnValue(mockModelConfig);
  }

  it("有工具调用时，正文延迟到本批工具执行完成后再输出", async () => {
    setupRegistry();

    const toolCall = { id: "call-1", name: "read_file", arguments: JSON.stringify({ path: "doc.md" }) };
    const chunks: StreamChunk[] = [
      { content: "正在读取", done: false, model: "gpt-test" },
      { content: "文件", done: false, model: "gpt-test" },
    ];

    let toolStartedAt = 0;
    let toolFinishedAt = 0;
    let contentReceivedAt = 0;

    const chatStreamSpy = vi.spyOn(modelRegistry, "chatStream").mockImplementation(async (_req, onChunk) => {
      const callIndex = chatStreamSpy.mock.calls.length;
      if (callIndex === 1) {
        for (const chunk of chunks) {
          onChunk(chunk);
        }
        return { content: "正在读取文件", model: "gpt-test", toolCalls: [toolCall] } as ChatResponse;
      }
      onChunk({ content: "读取完成，这是最终答复", done: false, model: "gpt-test" });
      return { content: "读取完成，这是最终答复", model: "gpt-test" } as ChatResponse;
    });

    const chatSpy = vi.spyOn(modelRegistry, "chat").mockResolvedValue({ content: "", model: "gpt-test" } as ChatResponse);

    const chunksReceived: string[] = [];
    const toolStepStatuses: Array<{ name: string; status?: string }> = [];

    await executeChatTurn({
      model: "gpt-test",
      messages: [{ role: "user", content: "读文件" }],
      tools: [{ name: "read_file", description: "读文件" }],
      executeToolCall: async () => {
        toolStartedAt = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 30));
        toolFinishedAt = Date.now();
        return "文件内容";
      },
      onChunk: (chunk) => {
        contentReceivedAt = Date.now();
        chunksReceived.push(chunk);
      },
      onToolStep: (step) => {
        if (step.type === "tool_call") {
          toolStepStatuses.push({ name: step.name, status: step.status });
        }
      },
    });

    // 第一轮工具调用期间不应收到正文分片
    expect(toolStepStatuses.some((s) => s.name === "read_file" && s.status === "running")).toBe(true);
    expect(toolStepStatuses.some((s) => s.name === "read_file" && !s.status)).toBe(true);
    // 正文必须在工具执行开始之后、完成之后才收到
    expect(contentReceivedAt).toBeGreaterThanOrEqual(toolStartedAt);
    expect(contentReceivedAt).toBeGreaterThanOrEqual(toolFinishedAt);
    // 最终 content 应包含第二轮模型的答复
    expect(chunksReceived.join("")).toContain("最终答复");
    // 第二轮因仍支持流式，继续走 chatStream；非流式降级分支不应被触发
    expect(chatStreamSpy).toHaveBeenCalledTimes(2);
    expect(chatSpy).toHaveBeenCalledTimes(0);
  });

  it("无工具调用时，正文立即流式输出", async () => {
    setupRegistry();

    const chunks: StreamChunk[] = [
      { content: "Hello", done: false, model: "gpt-test" },
      { content: " world", done: false, model: "gpt-test" },
    ];

    vi.spyOn(modelRegistry, "chatStream").mockImplementation(async (_req, onChunk) => {
      for (const chunk of chunks) {
        onChunk(chunk);
      }
      return { content: "Hello world", model: "gpt-test" } as ChatResponse;
    });

    const chunksReceived: string[] = [];
    await executeChatTurn({
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
      onChunk: (chunk) => chunksReceived.push(chunk),
    });

    expect(chunksReceived.join("")).toBe("Hello world");
  });
});
