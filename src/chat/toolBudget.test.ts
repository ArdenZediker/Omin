import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeChatTurn, MAX_TOOL_ROUNDS, TOOL_ROUND_SEGMENT, REPEAT_CALL_LIMIT } from "./engine";
import type { ChatResponse, ChatStep, ModelConfig } from "../adapters/types";
import { modelRegistry } from "../adapters/registry";

vi.mock("./storage", () => ({
  getUsagePreferencesForModel: () => ({
    temperature: 0.7,
    maxOutputTokens: 2048,
    enableStreaming: true,
    enableVisionInput: false,
  }),
  loadPersonaConfig: async () => null,
}));

describe("工具轮次预算（软上限续跑 + 无进展守卫）", () => {
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

  beforeEach(() => vi.restoreAllMocks());

  it("同一工具 + 同参数连续重复达阈值即中断，且该轮工具不再执行", async () => {
    setupRegistry();
    const sameCall = { id: "call-x", name: "list_files", arguments: JSON.stringify({ path: "D:/Codex" }) };
    const streamSpy = vi
      .spyOn(modelRegistry, "chatStream")
      .mockResolvedValue({ content: "", model: "gpt-test", toolCalls: [sameCall] } as ChatResponse);
    const chatSpy = vi
      .spyOn(modelRegistry, "chat")
      .mockResolvedValue({ content: "已停止。", model: "gpt-test" } as ChatResponse);

    const executed: string[] = [];
    const steps: ChatStep[] = [];
    const res = await executeChatTurn({
      model: "gpt-test",
      messages: [{ role: "user", content: "看目录" }],
      tools: [{ name: "list_files", description: "列目录" }],
      executeToolCall: async (call) => {
        executed.push(call.id);
        return "文件A 文件B";
      },
      onToolStep: (step) => steps.push(step),
    });

    // 第三次重复时命中守卫 → 只落地了前两次
    expect(REPEAT_CALL_LIMIT).toBe(3);
    expect(executed.length).toBe(REPEAT_CALL_LIMIT - 1);
    expect(streamSpy).toHaveBeenCalledTimes(REPEAT_CALL_LIMIT);
    // 上屏一条中断动作，并走「不带工具」的收尾请求
    expect(steps.some((s) => s.type === "action" && s.title === "No Progress Detected")).toBe(true);
    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(res.content).toBe("已停止。");
  });

  it("隔轮重复（a → b → a）不算连续，不误触发守卫", async () => {
    setupRegistry();
    let round = 0;
    vi.spyOn(modelRegistry, "chatStream").mockImplementation(async () => {
      round += 1;
      if (round <= 3) {
        const path = round === 2 ? "b.md" : "a.md";
        return {
          content: "",
          model: "gpt-test",
          toolCalls: [{ id: `c${round}`, name: "read_file", arguments: JSON.stringify({ path }) }],
        } as ChatResponse;
      }
      return { content: "完成", model: "gpt-test" } as ChatResponse;
    });

    const executed: string[] = [];
    const steps: ChatStep[] = [];
    const res = await executeChatTurn({
      model: "gpt-test",
      messages: [{ role: "user", content: "读文件" }],
      tools: [{ name: "read_file", description: "读文件" }],
      executeToolCall: async (call) => {
        executed.push(call.id);
        return "内容";
      },
      onToolStep: (step) => steps.push(step),
    });

    expect(executed.length).toBe(3);
    expect(steps.some((s) => s.type === "action" && s.title === "No Progress Detected")).toBe(false);
    expect(res.content).toBe("完成");
  });

  it("跑满一段预算后自动延长并继续，直到模型自己收尾", async () => {
    setupRegistry();
    let round = 0;
    vi.spyOn(modelRegistry, "chatStream").mockImplementation(async () => {
      round += 1;
      if (round <= TOOL_ROUND_SEGMENT) {
        // 每轮参数不同，避免触发无进展守卫
        return {
          content: "",
          model: "gpt-test",
          toolCalls: [{ id: `c${round}`, name: "read_file", arguments: JSON.stringify({ path: `f${round}.md` }) }],
        } as ChatResponse;
      }
      return { content: "任务完成", model: "gpt-test" } as ChatResponse;
    });

    const steps: ChatStep[] = [];
    const res = await executeChatTurn({
      model: "gpt-test",
      messages: [{ role: "user", content: "读一堆文件" }],
      tools: [{ name: "read_file", description: "读文件" }],
      executeToolCall: async () => "内容",
      onToolStep: (step) => steps.push(step),
    });

    // 第一段跑满 → 恰好上屏一次「延长」，并且跨过了一段继续跑到模型自行收尾
    const extendSteps = steps.filter((s) => s.type === "action" && s.title === "Extended Tool Budget");
    expect(extendSteps.length).toBe(1);
    expect(round).toBe(TOOL_ROUND_SEGMENT + 1);
    expect(res.content).toBe("任务完成");
  });

  it("预算常量：一段远小于硬顶，硬顶不再是一段就死", () => {
    expect(TOOL_ROUND_SEGMENT).toBe(12);
    expect(MAX_TOOL_ROUNDS).toBe(60);
    expect(MAX_TOOL_ROUNDS).toBeGreaterThan(TOOL_ROUND_SEGMENT * 3);
  });
});
