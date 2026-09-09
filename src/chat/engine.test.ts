import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  executeChatTurn,
  partitionToolCallsForExecution,
  compactHistoryIfNeeded,
  pruneToolResultMessages,
  stubToolResultMessages,
  isCompactionNoGain,
} from "./engine";
import type { ChatResponse, ChatToolCall, ChatStep, Message, ModelConfig, StreamChunk } from "../adapters/types";
import { modelRegistry } from "../adapters/registry";
import { estimatePromptTokens } from "./tokenEstimator";

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

  it("工具轮次间上下文再次超预算时触发步间压缩（触发双保险）", async () => {
    setupRegistry();
    // 用 tiny 窗口（预算 75）让压缩容易触发；改写 getModelConfig 返回 tinyModel
    const tinyModel: ModelConfig = {
      id: "tiny",
      name: "Tiny",
      provider: "openai",
      maxTokens: 100,
      supportsVision: false,
      supportsStreaming: false,
      toolCalling: true,
    };
    vi.spyOn(modelRegistry, "getModelConfig").mockReturnValue(tinyModel);

    const initial: Message[] = [
      { role: "system", content: "system" },
      { role: "user", content: "用户需求".repeat(40) },
      { role: "assistant", content: "助手回复".repeat(40) },
      { role: "tool", content: "Z".repeat(3000), toolCallId: "t0", toolCallName: "read_file" },
      { role: "user", content: "继续" },
    ];
    const toolCall = { id: "call-1", name: "read_file", arguments: JSON.stringify({ path: "doc.md" }) };

    const chatSpy = vi.spyOn(modelRegistry, "chat").mockImplementation(async (req) => {
      const isCompaction = req.messages?.[0]?.content?.includes("对话压缩器");
      if (isCompaction) {
        return { content: "本次调研已完成核心事项，关键结论已记录，剩余工作留待后续处理。", model: "tiny" } as ChatResponse;
      }
      // 正常轮次：尚未出现 tool 消息 → 首轮带工具调用；出现 tool 消息 → 收尾正文
      const hasToolMsg = req.messages?.some((m) => m.role === "tool");
      if (!hasToolMsg) {
        return { content: "读取中", model: "tiny", toolCalls: [toolCall] } as ChatResponse;
      }
      return { content: "最终答复", model: "tiny" } as ChatResponse;
    });

    const steps: ChatStep[] = [];
    const res = await executeChatTurn({
      model: "tiny",
      messages: initial,
      tools: [{ name: "read_file", description: "读文件" }],
      executeToolCall: async () => "W".repeat(4000), // 巨大工具结果 → 步间再次超预算
      onToolStep: (step) => steps.push(step),
    });

    // 前置压缩贡献 1 条「压缩」动作步骤；步间压缩再贡献 1 条 → 至少 2 条
    const compactionSteps = steps.filter((s) => s.type === "action" && s.label === "压缩");
    expect(compactionSteps.length).toBeGreaterThanOrEqual(2);
    // 最终答复应来自收尾轮，而非被摘要串覆盖
    expect(res.content).toContain("最终答复");
    void chatSpy;
  });
});

describe("partitionToolCallsForExecution（concurrencySafe 并行分块契约）", () => {
  const call = (id: string, name: string): ChatToolCall => ({ id, name, arguments: "{}" });
  const safe = (name: string) => name.startsWith("read") || name === "search_files";

  it("连续安全只读调用合入同一块（可并行）", () => {
    const chunks = partitionToolCallsForExecution(
      [call("1", "read_file"), call("2", "read_file"), call("3", "search_files")],
      safe
    );
    expect(chunks).toEqual([[call("1", "read_file"), call("2", "read_file"), call("3", "search_files")]]);
  });

  it("不安全调用独占成块：safe, write, safe → 三块且顺序保持", () => {
    const calls = [call("1", "read_file"), call("2", "write_file"), call("3", "read_file")];
    const chunks = partitionToolCallsForExecution(calls, safe);
    expect(chunks.map((chunk) => chunk.map((c) => c.id))).toEqual([["1"], ["2"], ["3"]]);
  });

  it("全部安全 → 单块；全部不安全 → 各自成块", () => {
    expect(partitionToolCallsForExecution([call("1", "search_files"), call("2", "search_files")], safe)).toHaveLength(1);
    expect(partitionToolCallsForExecution([call("1", "bash"), call("2", "bash")], safe).map((c) => c.length)).toEqual([1, 1]);
  });

  it("空调用列表 → 空块序列", () => {
    expect(partitionToolCallsForExecution([], safe)).toEqual([]);
  });
});

describe("pruneToolResultMessages（model-free 工具结果剪枝，吸 DSH toolResultPruner）", () => {
  it("超长工具结果被截断并保留 toolCallId", () => {
    const messages: Message[] = [
      { role: "tool", content: "X".repeat(3000), toolCallId: "t1", toolCallName: "read_file" },
    ];
    const result = pruneToolResultMessages(messages);
    expect(result[0].content.length).toBeLessThan(3000);
    expect(result[0].content).toContain("工具结果已截断");
    expect(result[0].toolCallId).toBe("t1");
    expect(result[0].toolCallName).toBe("read_file");
  });

  it("未超长工具结果原样返回", () => {
    const messages: Message[] = [{ role: "tool", content: "短结果", toolCallId: "t2" }];
    const result = pruneToolResultMessages(messages);
    expect(result[0].content).toBe("短结果");
    expect(result[0].toolCallId).toBe("t2");
  });

  it("非工具消息（即便很长）不被剪枝", () => {
    const messages: Message[] = [{ role: "user", content: "Y".repeat(5000) }];
    expect(pruneToolResultMessages(messages)[0].content.length).toBe(5000);
  });

  it("全部未超长时返回原数组引用（不变更）", () => {
    const messages: Message[] = [{ role: "user", content: "hi" }];
    expect(pruneToolResultMessages(messages)).toBe(messages);
  });
});

describe("isCompactionNoGain（无收益守卫，吸 atomcode committed/refused）", () => {
  it("摘要远小于原文 → 有收益（不触发）", () => {
    expect(isCompactionNoGain("摘要内容", 200)).toBe(false);
  });

  it("摘要接近原文 token 数 → 无收益（触发）", () => {
    expect(isCompactionNoGain("摘要".repeat(200), 200)).toBe(true);
  });

  it("原文为 0 token → 不误判无收益", () => {
    expect(isCompactionNoGain("摘要", 0)).toBe(false);
  });
});

describe("stubToolResultMessages（三级压缩第 1 档：stub 旧工具结果）", () => {
  it("把历史超长工具结果改写成单行 stub，保留 active turn 与 read_file 豁免", () => {
    const messages: Message[] = [
      { role: "system", content: "system" },
      { role: "user", content: "需求" },
      { role: "assistant", content: "已处理" },
      { role: "tool", content: "Y".repeat(3000), toolCallId: "t1", toolCallName: "bash" },
      { role: "user", content: "追问" },
      { role: "assistant", content: "继续" },
      { role: "tool", content: "Z".repeat(3000), toolCallId: "t2", toolCallName: "read_file" },
    ];
    // 最近一条 user 是「追问」(idx4)，其后的 read_file 属 active turn 不被压缩；
    // 历史里的 bash 结果(idx3)应被 stub。
    const res = stubToolResultMessages(messages);
    expect(res.changed).toBe(true);
    expect(res.stubbedCount).toBe(1);
    expect(res.messages[3].content.startsWith("[bash ok:")).toBe(true);
    // read_file 豁免：原样保留
    expect(res.messages[6].content).toBe("Z".repeat(3000));
    expect(res.messages[6].content.length).toBe(3000);
  });

  it("历史中的 read_file 结果被豁免（即便超长）", () => {
    const messages: Message[] = [
      { role: "user", content: "u" },
      { role: "tool", content: "A".repeat(3000), toolCallId: "t1", toolCallName: "read_file" },
      { role: "user", content: "最后一条" },
    ];
    const res = stubToolResultMessages(messages);
    expect(res.changed).toBe(false);
    expect(res.messages[1].content).toBe("A".repeat(3000));
  });

  it("全部未超长或无可压缩历史时返回原数组引用（不变更）", () => {
    const messages: Message[] = [
      { role: "user", content: "u" },
      { role: "tool", content: "短结果", toolCallId: "t1", toolCallName: "bash" },
    ];
    const res = stubToolResultMessages(messages);
    expect(res.changed).toBe(false);
    expect(res.messages).toBe(messages);
  });
});

describe("compactHistoryIfNeeded 三级阶梯（stub → truncate → summarize）", () => {
  // 用小窗口模型把预算压到 75 token，便于稳定触发压缩
  const tinyModel: ModelConfig = {
    id: "tiny",
    name: "Tiny",
    provider: "openai",
    maxTokens: 100,
    supportsVision: false,
    supportsStreaming: false,
    toolCalling: true,
  };

  // 隔离：同文件其它 describe 会 spy modelRegistry.chat 且不跨 describe restore，
  // 这里在每个用例前清掉残留 spy，避免复用持久 mock 导致调用计数污染。
  beforeEach(() => vi.restoreAllMocks());

  function buildOldBashOverflow(): Message[] {
    return [
      { role: "system", content: "s" },
      { role: "user", content: "需求" },
      { role: "assistant", content: "已处理" },
      { role: "tool", content: "X".repeat(3000), toolCallId: "t1", toolCallName: "bash" },
      { role: "user", content: "追问" },
    ];
  }

  it("第 1 档 stub 即可压到预算内时，零 LLM 调用且不插入摘要", async () => {
    const chatSpy = vi.spyOn(modelRegistry, "chat").mockRejectedValue(new Error("不应被调用"));
    const res = await compactHistoryIfNeeded({ model: "tiny", requestMessages: buildOldBashOverflow(), modelConfig: tinyModel });
    // stub 把 3000 字符 bash 结果压成单行 → 整体进入预算，无需召摘要
    expect(chatSpy).not.toHaveBeenCalled();
    expect(res.compaction?.fallback).toBe(false);
    expect(res.compaction?.removedCount).toBe(0);
    // 摘要不应出现
    expect(res.messages.some((m) => m.content.startsWith("【历史对话摘要】"))).toBe(false);
    // 工具结果已被 stub 成单行
    const toolMsg = res.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content.startsWith("[bash ok:")).toBe(true);
    expect(estimatePromptTokens(res.messages)).toBeLessThanOrEqual(Math.floor(100 * 0.75));
  });
});

describe("compactHistoryIfNeeded（改造4：剪枝 + 无收益守卫）", () => {
  // 用小窗口模型把预算压到 75 token，便于稳定触发压缩
  const tinyModel: ModelConfig = {
    id: "tiny",
    name: "Tiny",
    provider: "openai",
    maxTokens: 100,
    supportsVision: false,
    supportsStreaming: false,
    toolCalling: true,
  };

  function buildOverflowMessages(): Message[] {
    return [
      { role: "system", content: "system prompt" },
      { role: "user", content: "用户第一条很长的需求".repeat(10) },
      { role: "assistant", content: "助手回复".repeat(10) },
      { role: "tool", content: "Z".repeat(3000), toolCallId: "t1", toolCallName: "read_file" },
      { role: "user", content: "用户第二条短问" },
    ];
  }

  it("未超预算时不压缩，原样返回", async () => {
    vi.spyOn(modelRegistry, "chat").mockResolvedValue({ content: "摘要", model: "tiny" } as ChatResponse);
    const small: Message[] = [
      { role: "system", content: "s" },
      { role: "user", content: "hi" },
    ];
    const res = await compactHistoryIfNeeded({ model: "tiny", requestMessages: small, modelConfig: tinyModel });
    expect(res.compaction).toBeUndefined();
    expect(res.messages).toBe(small);
  });

  it("摘要成功：插入摘要、溢出重试压到预算内、工具结果被剪枝或并入摘要", async () => {
    vi.spyOn(modelRegistry, "chat").mockResolvedValue({ content: "本次调研已完成核心事项，关键结论已记录，剩余工作留待后续处理。", model: "tiny" } as ChatResponse);
    const res = await compactHistoryIfNeeded({ model: "tiny", requestMessages: buildOverflowMessages(), modelConfig: tinyModel });
    expect(res.compaction?.fallback).toBe(false);
    expect(res.compaction?.removedCount).toBe(2);
    const summaryMsg = res.messages.find((m) => m.role === "assistant" && m.content.startsWith("【历史对话摘要】"));
    expect(summaryMsg).toBeTruthy();
    // 溢出重试后必须进入预算（tiny 窗口 100、预算 75）；tiny 窗口下工具结果常被二次压缩并入摘要
    expect(estimatePromptTokens(res.messages)).toBeLessThanOrEqual(Math.floor(100 * 0.75));
    // 仍保留的工具结果应已被剪枝；若已被并入摘要则不复存在，二者皆可
    const toolMsg = res.messages.find((m) => m.role === "tool");
    if (toolMsg) {
      expect(toolMsg.content.length).toBeLessThan(3000);
      expect(toolMsg.content).toContain("工具结果已截断");
    }
  });

  it("摘要几乎与原文等长 → 无收益，回退丢最旧一轮", async () => {
    vi.spyOn(modelRegistry, "chat").mockResolvedValue({ content: "摘要".repeat(200), model: "tiny" } as ChatResponse);
    const res = await compactHistoryIfNeeded({ model: "tiny", requestMessages: buildOverflowMessages(), modelConfig: tinyModel });
    expect(res.compaction?.fallback).toBe(true);
    expect(res.compaction?.removedCount).toBe(2);
    expect(res.messages.some((m) => m.content.startsWith("【历史对话摘要】"))).toBe(false);
  });

  it("摘要请求失败 → 兜底丢最旧一轮", async () => {
    vi.spyOn(modelRegistry, "chat").mockRejectedValue(new Error("network"));
    const res = await compactHistoryIfNeeded({ model: "tiny", requestMessages: buildOverflowMessages(), modelConfig: tinyModel });
    expect(res.compaction?.fallback).toBe(true);
    expect(res.compaction?.removedCount).toBe(2);
  });

  it("溢出重试：单次压缩仍超预算时循环再压，直至进入预算", async () => {
    const chatSpy = vi.spyOn(modelRegistry, "chat").mockResolvedValue({
      content: "本次调研已完成核心事项，关键结论已记录，剩余工作留待后续处理。",
      model: "tiny",
    } as ChatResponse);
    const res = await compactHistoryIfNeeded({ model: "tiny", requestMessages: buildOverflowMessages(), modelConfig: tinyModel });
    // tiny 窗口 100、预算 75；原 3000 字符工具结果 + 长对话单次 60% 压缩仍超预算，需多次压缩
    expect(chatSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(estimatePromptTokens(res.messages)).toBeLessThanOrEqual(Math.floor(100 * 0.75));
  });
});
