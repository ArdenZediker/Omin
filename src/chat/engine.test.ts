import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  executeChatTurn,
  partitionToolCallsForExecution,
  compactHistoryIfNeeded,
  pruneToolResultMessages,
  stubToolResultMessages,
  shouldPruneToolResults,
  isCompactionNoGain,
} from "./engine";
import type { ChatResponse, ChatToolCall, ChatStep, Message, ModelConfig, StreamChunk } from "../adapters/types";
import { modelRegistry } from "../adapters/registry";
import { estimatePromptTokens } from "./tokenEstimator";
import { FirstByteTimeoutError } from "../adapters/http";

vi.mock("./storage", () => ({
  getUsagePreferencesForModel: () => ({
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
      { role: "tool", content: "Z".repeat(9000), toolCallId: "t0", toolCallName: "read_file" },
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
      executeToolCall: async () => "W".repeat(9000), // 超剪枝阈值(8192) 且超窗口预算 → 步间剪枝
      onToolStep: (step) => steps.push(step),
    });

    // 前置压缩贡献 1 条「Context Compaction」；步间预算门放行后剪掉超阈值工具结果，
    // 再贡献 1 条「Context Prune」→ 至少 2 条
    const compactionSteps = steps.filter((s) => s.type === "action" && s.label === "压缩");
    expect(compactionSteps.length).toBeGreaterThanOrEqual(2);
    // 最终答复应来自收尾轮，而非被摘要串覆盖
    expect(res.content).toContain("最终答复");
    void chatSpy;
  });

  // 回归：用户实测「压缩 / Context Prune 触发太频繁」。根因是剪枝被无条件每轮调用，
  // 而它的文案却写「上下文再次超出预算」。128k 窗口下预算 96k token，一次 9000 字符的
  // 工具结果连 1% 都占不到，本就不该剪 —— 更不该上屏。
  it("窗口宽裕时不做步间剪枝，也不上屏「压缩」（不再刷屏）", async () => {
    setupRegistry();
    vi.spyOn(modelRegistry, "getModelConfig").mockReturnValue({
      id: "big",
      name: "Big",
      provider: "openai",
      maxTokens: 128_000,
      supportsVision: false,
      supportsStreaming: false,
      toolCalling: true,
    } as ModelConfig);

    const toolCall = { id: "call-1", name: "read_file", arguments: JSON.stringify({ path: "doc.md" }) };
    vi.spyOn(modelRegistry, "chat").mockImplementation(async (req) => {
      const hasToolMsg = req.messages?.some((m) => m.role === "tool");
      if (!hasToolMsg) {
        return { content: "读取中", model: "big", toolCalls: [toolCall] } as ChatResponse;
      }
      return { content: "最终答复", model: "big" } as ChatResponse;
    });

    const steps: ChatStep[] = [];
    const res = await executeChatTurn({
      model: "big",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "读一下这个文件" },
      ],
      tools: [{ name: "read_file", description: "读文件" }],
      executeToolCall: async () => "W".repeat(9000), // 远超剪枝阈值，但仍远低于 128k 窗口预算
      onToolStep: (step) => steps.push(step),
    });

    expect(steps.filter((s) => s.type === "action" && s.label === "压缩")).toHaveLength(0);
    expect(res.content).toContain("最终答复");
  });

  it("普通流式请求首包超时 60s，thinking 模型 / 非流式请求首包超时 300s", async () => {
    setupRegistry();

    const chatStreamSpy = vi.spyOn(modelRegistry, "chatStream").mockResolvedValue({ content: "ok", model: "gpt-test" } as ChatResponse);
    const chatSpy = vi.spyOn(modelRegistry, "chat").mockResolvedValue({ content: "ok", model: "gpt-test" } as ChatResponse);

    // 普通模型 + 流式 → 60s
    await executeChatTurn({ model: "gpt-test", messages: [{ role: "user", content: "hi" }], onChunk: (c) => void c });
    expect(chatStreamSpy.mock.calls[0]?.[0].timeoutMs).toBe(60_000);

    // thinking 模型 + 流式 → 300s
    vi.spyOn(modelRegistry, "getModelConfig").mockReturnValue({ ...mockModelConfig, thinking: true });
    await executeChatTurn({ model: "gpt-test", messages: [{ role: "user", content: "hi" }], onChunk: (c) => void c });
    expect(chatStreamSpy.mock.calls[1]?.[0].timeoutMs).toBe(300_000);

    // 非流式模型 → chat 而非 chatStream，超时 300s
    vi.spyOn(modelRegistry, "getModelConfig").mockReturnValue({ ...mockModelConfig, supportsStreaming: false });
    await executeChatTurn({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] });
    expect(chatSpy.mock.calls[0]?.[0].timeoutMs).toBe(300_000);
    expect(chatSpy.mock.calls[0]?.[0].stream).toBe(false);
  });
});

describe("首包超时自动续跑（withFirstByteRetry）", () => {
  beforeEach(() => vi.restoreAllMocks());

  const cfg: ModelConfig = {
    id: "gpt-test",
    name: "GPT Test",
    provider: "openai",
    maxTokens: 128000,
    supportsVision: false,
    supportsStreaming: true,
    toolCalling: true,
  };

  function setup() {
    vi.spyOn(modelRegistry, "getRegisteredProviders").mockReturnValue(["openai"]);
    vi.spyOn(modelRegistry, "getAdapterForModel").mockReturnValue({} as ReturnType<typeof modelRegistry.getAdapterForModel>);
    vi.spyOn(modelRegistry, "getModelConfig").mockReturnValue(cfg);
  }

  it(
    "首包超时：首次之外最多再试 2 次，第 3 次成功则正常返回",
    async () => {
      setup();
      const spy = vi
        .spyOn(modelRegistry, "chatStream")
        .mockRejectedValueOnce(new FirstByteTimeoutError(60_000))
        .mockRejectedValueOnce(new FirstByteTimeoutError(60_000))
        .mockImplementationOnce(async (_req, onChunk) => {
          onChunk({ content: "最终答复", done: false, model: "gpt-test" });
          return { content: "最终答复", model: "gpt-test" } as ChatResponse;
        });

      const received: string[] = [];
      const res = await executeChatTurn({
        model: "gpt-test",
        messages: [{ role: "user", content: "hi" }],
        onChunk: (c) => received.push(c),
      });

      // 首包超时不会丢弃任何已产出内容，故安全重连：共发 3 次（1 失败 + 1 失败 + 1 成功）
      expect(spy).toHaveBeenCalledTimes(3);
      expect(received.join("")).toContain("最终答复");
      expect(res.content).toContain("最终答复");
    },
    20000
  );

  it("非首包错误（如 HTTP 401）不重试，直接抛出", async () => {
    setup();
    const spy = vi.spyOn(modelRegistry, "chatStream").mockRejectedValue(new Error("HTTP 401 - bad key"));
    await expect(
      executeChatTurn({ model: "gpt-test", messages: [{ role: "user", content: "hi" }], onChunk: () => {} })
    ).rejects.toThrow(/HTTP 401/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("用户取消（超时期间点了停止）不续跑，直接抛出 AbortError", async () => {
    setup();
    const controller = new AbortController();
    // 模拟「首包超时 + 用户在这个过程中取消」：首次调用时标记取消，并抛首包超时。
    const spy = vi.spyOn(modelRegistry, "chatStream").mockImplementationOnce(async () => {
      controller.abort();
      throw new FirstByteTimeoutError(60_000);
    });
    await expect(
      executeChatTurn({
        model: "gpt-test",
        messages: [{ role: "user", content: "hi" }],
        signal: controller.signal,
        onChunk: () => {},
      })
    ).rejects.toBeInstanceOf(DOMException);
    // 重试前检测到已取消 → 不再发第 2 次，仅调用 1 次
    expect(spy).toHaveBeenCalledTimes(1);
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
  // 阈值 = 8192（对齐 DSH 的 thresholdChars 默认）；9000 保证确实越过阈值。
  it("超长工具结果被截断并保留 toolCallId", () => {
    const messages: Message[] = [
      { role: "tool", content: "X".repeat(9000), toolCallId: "t1", toolCallName: "read_file" },
    ];
    const result = pruneToolResultMessages(messages);
    expect(result[0].content.length).toBeLessThan(9000);
    expect(result[0].content).toContain("工具结果已截断");
    expect(result[0].toolCallId).toBe("t1");
    expect(result[0].toolCallName).toBe("read_file");
  });

  // 回归：工具输出里最有诊断价值的是尾部（报错栈末行 / N failed / 退出提示），只留头部会把结论砍掉。
  it("超长工具结果保留结尾（尾部错误不被砍掉）", () => {
    const head = "编译开始\n";
    const tail = "error TS2345: 参数类型不匹配";
    const messages: Message[] = [
      { role: "tool", content: head + "编译日志行\n".repeat(1600) + tail, toolCallId: "t9" },
    ];

    const result = pruneToolResultMessages(messages);

    expect(result[0].content.startsWith(head)).toBe(true);
    expect(result[0].content).toContain(tail);
    expect(result[0].content).toContain("中间省略");
  });

  it("已带截断标记的结果保持幂等（不二次截断）", () => {
    const already = `${"Y".repeat(2000)}\n[工具结果已截断：原 3000 字符，已省略中间 600 字符，保留开头与结尾]`;
    const messages: Message[] = [{ role: "tool", content: already, toolCallId: "t10" }];

    expect(pruneToolResultMessages(messages)[0].content).toBe(already);
  });

  it("未超长工具结果原样返回", () => {
    const messages: Message[] = [{ role: "tool", content: "短结果", toolCallId: "t2" }];
    const result = pruneToolResultMessages(messages);
    expect(result[0].content).toBe("短结果");
    expect(result[0].toolCallId).toBe("t2");
  });

  // 回归：阈值必须是「一次常规工具输出撞不到」的量级。旧值 2400 会让一次普通 read_file /
  // bash 输出也被剪掉中间 —— 既是无谓的信息损失，也让「压缩」步骤频繁上屏。
  it("阈值内的长结果不被剪（8000 字符保留原文）", () => {
    const content = "L".repeat(8000);
    const messages: Message[] = [{ role: "tool", content, toolCallId: "t3" }];
    expect(pruneToolResultMessages(messages)[0].content).toBe(content);
  });

  it("恰超阈值即剪（8193 字符被截断）", () => {
    const messages: Message[] = [{ role: "tool", content: "M".repeat(8193), toolCallId: "t4" }];
    const out = pruneToolResultMessages(messages)[0].content;
    expect(out).toContain("工具结果已截断");
    expect(out).toContain("中间省略");
    // 保留量受阈值约束（截断注记本身占几十字符，故略高于阈值），远小于原文规模
    expect(out.length).toBeLessThan(8300);
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

// 剪枝的**会话级预算门**：DSH 的 pruner 只在 compaction 流程里跑，pressure 路径还要先比
// 「总占用 vs 窗口压力阈值」，未到阈值直接 return（根本不调用 pruner）。此前 Omni 把这个
// pruner 提到工具循环里每轮无条件调用，导致「压缩 / Context Prune」步骤的文案说
// 「上下文再次超出预算」而代码里没有任何预算判断 —— 这就是用户实测到的刷屏。
describe("shouldPruneToolResults（剪枝的会话级预算门）", () => {
  /** 极小窗口：预算 = 100 × 0.75 = 75 token，便于稳定触发 */
  const tinyModel = { id: "tiny", name: "Tiny", provider: "openai", maxTokens: 100 } as ModelConfig;

  it("窗口宽裕 ⇒ 不剪（9000 字符的工具结果也不剪）", () => {
    const messages: Message[] = [{ role: "tool", content: "X".repeat(9000), toolCallId: "t1" }];
    expect(shouldPruneToolResults(messages)).toBe(false);
  });

  it("超过 0.75 × 窗口预算 ⇒ 剪", () => {
    const messages: Message[] = [{ role: "tool", content: "X".repeat(9000), toolCallId: "t1" }];
    expect(shouldPruneToolResults(messages, tinyModel)).toBe(true);
  });

  it("小窗口模型下普通内容也会触发（预算被窗口而非内容决定）", () => {
    const messages: Message[] = [{ role: "user", content: "字".repeat(200) }];
    expect(shouldPruneToolResults(messages, tinyModel)).toBe(true);
  });

  it("无模型信息时回落 128k 窗口 ⇒ 常规对话不触发", () => {
    const messages: Message[] = [
      { role: "user", content: "帮我改一下这个功能" },
      { role: "assistant", content: "好的，我先看一下代码" },
    ];
    expect(shouldPruneToolResults(messages)).toBe(false);
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

describe("compactHistoryIfNeeded（TokenBudget 模式：零 LLM 滑动窗口重置）", () => {
  const tinyModel: ModelConfig = {
    id: "tiny",
    name: "Tiny",
    provider: "openai",
    maxTokens: 100,
    supportsVision: false,
    supportsStreaming: false,
    toolCalling: true,
  };

  beforeEach(() => vi.restoreAllMocks());

  function buildLongHistory(): Message[] {
    return [
      { role: "system", content: "s" },
      { role: "user", content: "很长的需求问题描述".repeat(40) },
      { role: "assistant", content: "很长的助手回复内容".repeat(40) },
      { role: "user", content: "追问" },
    ];
  }

  it("token_budget 模式丢弃最旧历史、保近端窗口，且零 LLM 调用", async () => {
    const chatSpy = vi.spyOn(modelRegistry, "chat").mockRejectedValue(new Error("不应被调用"));
    const res = await compactHistoryIfNeeded({
      model: "tiny",
      requestMessages: buildLongHistory(),
      modelConfig: tinyModel,
      compactionStrategy: "token_budget",
    });
    // 关键：绝不应召 LLM 摘要
    expect(chatSpy).not.toHaveBeenCalled();
    // 最旧的两轮（长 user + 长 assistant）被丢弃，仅保留 system + 近端追问
    expect(res.compaction?.fallback).toBe(true);
    expect(res.compaction?.removedCount).toBe(2);
    expect(res.messages.some((m) => m.content.includes("很长的需求问题描述"))).toBe(false);
    // 系统前缀与最近追问仍在
    expect(res.messages[0].role).toBe("system");
    expect(res.messages.some((m) => m.content === "追问")).toBe(true);
    expect(estimatePromptTokens(res.messages)).toBeLessThanOrEqual(Math.floor(100 * 0.75));
  });

  it("summarize 模式（默认）在同口径下仍会召 LLM 摘要，对比验证策略生效", async () => {
    const chatSpy = vi
      .spyOn(modelRegistry, "chat")
      .mockResolvedValue({ content: "很久以前用户提了一个很长很长的需求，涉及多个模块的改造与联调", model: "tiny" } as ChatResponse);
    const res = await compactHistoryIfNeeded({
      model: "tiny",
      requestMessages: buildLongHistory(),
      modelConfig: tinyModel,
      compactionStrategy: "summarize",
    });
    expect(chatSpy).toHaveBeenCalled();
    expect(res.messages.some((m) => m.content.startsWith("【历史对话摘要】"))).toBe(true);
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
