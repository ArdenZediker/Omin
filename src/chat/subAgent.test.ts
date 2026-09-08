import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SUB_AGENT_TOOL_IDS,
  MAX_SUB_AGENT_DEPTH,
  MAX_SUB_AGENT_OUTPUT_CHARS,
  filterSubAgentTools,
  parseSubAgentArgs,
  truncateSubAgentOutput,
  runSubAgent,
  isSubAgentActive,
  type SubAgentRunContext,
} from "./subAgent";
import { executeChatTurn } from "./engine";

vi.mock("./engine", () => ({
  executeChatTurn: vi.fn(),
}));

const mockedExecuteChatTurn = vi.mocked(executeChatTurn);

function makeContext(overrides?: Partial<SubAgentRunContext>): SubAgentRunContext {
  return {
    model: "gpt-test",
    project: null,
    tools: [
      { name: "read_file", description: "read", parameters: { type: "object", properties: {} } },
      { name: "write_file", description: "write", parameters: { type: "object", properties: {} } },
      { name: "web_search", description: "web", parameters: { type: "object", properties: {} } },
      { name: "agent", description: "sub agent", parameters: { type: "object", properties: {} } },
      { name: "mcp__server__tool", description: "mcp", parameters: { type: "object", properties: {} } },
    ],
    executeToolCall: vi.fn(async () => "工具结果"),
    onToolStep: vi.fn(),
    ...overrides,
  };
}

describe("parseSubAgentArgs", () => {
  it("解析 {task} JSON 入参", () => {
    expect(parseSubAgentArgs(JSON.stringify({ task: "调研 src/chat 目录" }))).toEqual({
      task: "调研 src/chat 目录",
    });
  });

  it("纯 JSON 字符串整段作为任务", () => {
    expect(parseSubAgentArgs(JSON.stringify("梳理架构"))).toEqual({ task: "梳理架构" });
  });

  it("非 JSON 文本宽容当作任务描述", () => {
    expect(parseSubAgentArgs("统计仓库里 TODO 的数量")).toEqual({ task: "统计仓库里 TODO 的数量" });
  });

  it("空入参 / 缺 task 字段返回 error", () => {
    expect(parseSubAgentArgs("")).toHaveProperty("error");
    expect(parseSubAgentArgs(JSON.stringify({ goal: "x" }))).toHaveProperty("error");
    expect(parseSubAgentArgs(JSON.stringify({ task: "   " }))).toHaveProperty("error");
  });
});

describe("filterSubAgentTools", () => {
  it("只保留只读白名单内的工具，排除写类/agent 自身/MCP 工具", () => {
    const filtered = filterSubAgentTools(makeContext().tools);
    expect(filtered.map((t) => t.name)).toEqual(["read_file", "web_search"]);
    const whitelist = new Set<string>(SUB_AGENT_TOOL_IDS);
    for (const tool of filtered) {
      expect(whitelist.has(tool.name)).toBe(true);
    }
  });

  it("父运行未启用的白名单工具不会出现在子 Agent 工具集里", () => {
    const filtered = filterSubAgentTools([{ name: "read_file", parameters: { type: "object", properties: {} } }]);
    expect(filtered.map((t) => t.name)).toEqual(["read_file"]);
  });
});

describe("truncateSubAgentOutput", () => {
  it("不超过上限时原样返回", () => {
    expect(truncateSubAgentOutput("短报告")).toBe("短报告");
  });

  it("超长时截断并附提示", () => {
    const long = "x".repeat(MAX_SUB_AGENT_OUTPUT_CHARS + 100);
    const truncated = truncateSubAgentOutput(long);
    expect(truncated.length).toBeLessThanOrEqual(MAX_SUB_AGENT_OUTPUT_CHARS + 40);
    expect(truncated).toContain("已截断");
  });
});

describe("runSubAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("以独立上下文调用引擎：白名单工具集、无知识检索/记忆抽取、任务作为 user 消息", async () => {
    mockedExecuteChatTurn.mockResolvedValue({ content: "子任务报告正文", toolRounds: 2 } as never);
    const context = makeContext();
    const { outputText } = await runSubAgent({
      args: JSON.stringify({ task: "调研项目结构" }),
      context,
    });

    expect(outputText).toContain("子 Agent 报告（2 轮工具调用）");
    expect(outputText).toContain("子任务报告正文");
    expect(mockedExecuteChatTurn).toHaveBeenCalledTimes(1);
    const call = mockedExecuteChatTurn.mock.calls[0][0];
    expect(call.model).toBe("gpt-test");
    expect(call.messages).toEqual([{ role: "user", content: "调研项目结构" }]);
    expect(call.tools?.map((t) => t.name)).toEqual(["read_file", "web_search"]);
    expect(call.enableKnowledgeContext).toBe(false);
    expect(call.enableMemoryExtraction).toBe(false);
    expect(call.enableSummaryExtraction).toBe(false);
    expect(context.executeToolCall).not.toHaveBeenCalled();
  });

  it("推送开始/完成动作步骤到父运行时间线", async () => {
    mockedExecuteChatTurn.mockResolvedValue({ content: "报告", toolRounds: 1 } as never);
    const onToolStep = vi.fn();
    await runSubAgent({ args: "做点调研", context: makeContext({ onToolStep }) });
    const labels = onToolStep.mock.calls.map(([step]) => (step as { label: string }).label);
    expect(labels[0]).toBe("派出子Agent");
    expect(labels[labels.length - 1]).toBe("子Agent完成");
  });

  it("嵌套调用被拒绝（深度守卫）", async () => {
    const context = makeContext({
      // 子 Agent 内部再次发起 agent 调用 → 走同一 runSubAgent 路径
      executeToolCall: async (toolCall) => {
        const inner = await runSubAgent({ args: toolCall.arguments, context });
        return inner.outputText;
      },
    });
    mockedExecuteChatTurn.mockImplementation(async (options) => {
      // 模拟子 Agent 的模型又发起了 agent 工具调用
      const result = await options.executeToolCall!({
        id: "call-nested",
        name: "agent",
        arguments: JSON.stringify({ task: "再嵌套一层" }),
      });
      return { content: result as string, toolRounds: 2 } as never;
    });

    const { outputText } = await runSubAgent({ args: "外层任务", context });
    expect(outputText).toContain("嵌套调用被拒绝");
    expect(isSubAgentActive()).toBe(false);
  });

  it("引擎无内容返回时给出兜底提示", async () => {
    mockedExecuteChatTurn.mockResolvedValue({ content: "  ", toolRounds: 1 } as never);
    const { outputText } = await runSubAgent({ args: "任务", context: makeContext() });
    expect(outputText).toContain("未返回有效报告");
  });

  it("引擎抛错时以错误文本返回（不向外抛出）", async () => {
    mockedExecuteChatTurn.mockRejectedValue(new Error("模型不可用"));
    const { outputText } = await runSubAgent({ args: "任务", context: makeContext() });
    expect(outputText).toContain("子 Agent 执行失败");
    expect(outputText).toContain("模型不可用");
  });

  it("缺工具场景：父运行没有任何白名单只读工具时拒绝委派", async () => {
    const { outputText } = await runSubAgent({
      args: "任务",
      context: makeContext({ tools: [{ name: "write_file", parameters: { type: "object", properties: {} } }] }),
    });
    expect(outputText).toContain("无可用工具");
    expect(mockedExecuteChatTurn).not.toHaveBeenCalled();
  });
});

describe("MAX_SUB_AGENT_DEPTH", () => {
  it("只允许一层嵌套深度", () => {
    expect(MAX_SUB_AGENT_DEPTH).toBe(1);
  });
});
