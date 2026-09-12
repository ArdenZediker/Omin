import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginManifest } from "../plugins/types";
import type { Project } from "./types";
import {
  SUB_AGENT_TOOL_IDS,
  MAX_SUB_AGENT_DEPTH,
  MAX_SUB_AGENT_OUTPUT_CHARS,
  MAX_SUB_AGENT_BATCH,
  filterSubAgentTools,
  parseSubAgentArgs,
  parseSubAgentBatchArgs,
  parseSubAgentTier,
  resolveSubAgentModel,
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
      { name: "export_md", description: "export", parameters: { type: "object", properties: {} } },
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

  it("携带 expertId 时一并解析", () => {
    expect(parseSubAgentArgs(JSON.stringify({ task: "写周报", expertId: "writer-expert" }))).toEqual({
      task: "写周报",
      expertId: "writer-expert",
    });
  });

  it("携带 tier 时一并解析（fast / capable）", () => {
    expect(parseSubAgentArgs(JSON.stringify({ task: "快查", tier: "fast" }))).toEqual({ task: "快查", tier: "fast" });
    expect(parseSubAgentArgs(JSON.stringify({ task: "深研", tier: "capable" }))).toEqual({ task: "深研", tier: "capable" });
  });

  it("空入参 / 缺 task 字段返回 error", () => {
    expect(parseSubAgentArgs("")).toHaveProperty("error");
    expect(parseSubAgentArgs(JSON.stringify({ goal: "x" }))).toHaveProperty("error");
    expect(parseSubAgentArgs(JSON.stringify({ task: "   " }))).toHaveProperty("error");
  });
});

describe("parseSubAgentBatchArgs", () => {
  it("批量形态：tasks 数组解析为多个子任务（对象/字符串混排 + expertId）", () => {
    const parsed = parseSubAgentBatchArgs(
      JSON.stringify({
        tasks: [{ task: "调研 A", expertId: "writer-expert" }, "调研 B", { task: "调研 C" }],
      })
    );
    expect(parsed).toEqual({
      tasks: [
        { task: "调研 A", expertId: "writer-expert" },
        { task: "调研 B" },
        { task: "调研 C" },
      ],
    });
  });

  it("单任务形态 / 纯文本自动包装为单元素批量", () => {
    expect(parseSubAgentBatchArgs(JSON.stringify({ task: "单任务" }))).toEqual({ tasks: [{ task: "单任务" }] });
    expect(parseSubAgentBatchArgs("纯文本任务")).toEqual({ tasks: [{ task: "纯文本任务" }] });
  });

  it("无效条目 / 空数组 / 超上限返回 error", () => {
    expect(parseSubAgentBatchArgs(JSON.stringify({ tasks: [{ goal: "x" }] }))).toHaveProperty("error");
    expect(parseSubAgentBatchArgs(JSON.stringify({ tasks: [] }))).toHaveProperty("error");
    const tooMany = parseSubAgentBatchArgs(
      JSON.stringify({ tasks: Array.from({ length: MAX_SUB_AGENT_BATCH + 1 }, (_, i) => ({ task: `任务 ${i}` })) })
    );
    expect(tooMany).toHaveProperty("error");
  });

  it("上限边界值恰好可派发", () => {
    const atLimit = parseSubAgentBatchArgs(
      JSON.stringify({ tasks: Array.from({ length: MAX_SUB_AGENT_BATCH }, (_, i) => ({ task: `任务 ${i}` })) })
    );
    expect(atLimit).toHaveProperty("tasks");
  });

  it("批量/单任务形态携带 tier 并透传给规格", () => {
    const batch = parseSubAgentBatchArgs(
      JSON.stringify({ tasks: [{ task: "A", tier: "fast" }, { task: "B", expertId: "e", tier: "capable" }] })
    );
    expect(batch).toEqual({
      tasks: [
        { task: "A", tier: "fast" },
        { task: "B", expertId: "e", tier: "capable" },
      ],
    });
    const single = parseSubAgentBatchArgs(JSON.stringify({ task: "单任务", tier: "capable" }));
    expect(single).toEqual({ tasks: [{ task: "单任务", tier: "capable" }] });
  });

  it("未知 tier 值被忽略（走自动路由）", () => {
    const parsed = parseSubAgentBatchArgs(JSON.stringify({ task: "t", tier: "quick" }));
    expect(parsed).toEqual({ tasks: [{ task: "t" }] });
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

describe("parseSubAgentTier", () => {
  it("接受 fast / capable（含前后空白）", () => {
    expect(parseSubAgentTier("fast")).toBe("fast");
    expect(parseSubAgentTier("capable")).toBe("capable");
    expect(parseSubAgentTier("  FAST ")).toBe("fast");
    expect(parseSubAgentTier("Capable")).toBe("capable");
  });

  it("拒绝未知值 / 缺失 / 非字符串", () => {
    expect(parseSubAgentTier("quick")).toBeUndefined();
    expect(parseSubAgentTier("")).toBeUndefined();
    expect(parseSubAgentTier(undefined)).toBeUndefined();
    expect(parseSubAgentTier(null)).toBeUndefined();
    expect(parseSubAgentTier(123)).toBeUndefined();
  });
});

describe("resolveSubAgentModel（强弱路由）", () => {
  it("通用只读调研默认走 fast 档：fastModel 优先", () => {
    expect(resolveSubAgentModel({ model: "main", capableModel: "cap", fastModel: "fast" }, { task: "t" })).toBe("fast");
  });

  it("通用调研 fast 档未配置时回落 capableModel", () => {
    expect(resolveSubAgentModel({ model: "main", capableModel: "cap" }, { task: "t" })).toBe("cap");
  });

  it("通用调研两档均未配置时回落主运行模型", () => {
    expect(resolveSubAgentModel({ model: "main" }, { task: "t" })).toBe("main");
  });

  it("专家委派默认走 capable 档：capableModel 优先", () => {
    expect(resolveSubAgentModel({ model: "main", capableModel: "cap", fastModel: "fast" }, { task: "t", expertId: "e" })).toBe("cap");
  });

  it("专家委派 capable 档未配置时回落主运行模型（不走 fast）", () => {
    expect(resolveSubAgentModel({ model: "main", fastModel: "fast" }, { task: "t", expertId: "e" })).toBe("main");
  });

  it("显式 tier=fast 可让专家也走 fast 档", () => {
    expect(resolveSubAgentModel({ model: "main", capableModel: "cap", fastModel: "fast" }, { task: "t", expertId: "e", tier: "fast" })).toBe("fast");
  });

  it("显式 tier=capable 可让通用调研走 capable 档", () => {
    expect(resolveSubAgentModel({ model: "main", capableModel: "cap", fastModel: "fast" }, { task: "t", tier: "capable" })).toBe("cap");
  });

  it("tier 覆盖时即使未配置对应档也回落到兜底模型", () => {
    expect(resolveSubAgentModel({ model: "main" }, { task: "t", tier: "capable" })).toBe("main");
    expect(resolveSubAgentModel({ model: "main" }, { task: "t", tier: "fast" })).toBe("main");
  });
});

describe("runSubAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const expertManifest: PluginManifest = {
    id: "writer-expert",
    name: "写作专家",
    description: "擅长产出文稿",
    version: "1.0.0",
    kind: "expert",
    templatePrompt: "你是写作专家，擅长输出 Markdown 文稿。",
    defaultToolIds: ["read_file", "export_md"],
    defaultSkillIds: ["weekly-report"],
  };

  /** 专家委派默认受「项目绑定」约束：给一个绑定了 writer-expert 的项目 = 生产默认口径。 */
  function makeExpertContext(expert: PluginManifest | null, overrides?: Partial<SubAgentRunContext>): SubAgentRunContext {
    return makeContext({
      project: { id: "project-1", boundExpertIds: ["writer-expert"] } as unknown as Project,
      resolveExpert: (id) => (expert && id === expert.id ? expert : null),
      ...overrides,
    });
  }

  it("专家模式：注入专家提示词、按 defaultToolIds 给工具（含写类）、按 defaultSkillIds 过滤技能", async () => {
    mockedExecuteChatTurn.mockResolvedValue({ content: "专家报告", toolRounds: 1, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, estimated: false } as never);
    const { outputText } = await runSubAgent({
      args: JSON.stringify({ task: "写一篇周报", expertId: "writer-expert" }),
      context: makeExpertContext(expertManifest),
    });

    expect(outputText).toContain("专家报告");
    const call = mockedExecuteChatTurn.mock.calls[0][0];
    expect(call.systemPrompt).toContain("你是写作专家");
    expect(call.systemPrompt).toContain("子 Agent 运行规则");
    // 工具按专家声明给：read_file + 写类 export_md，write_file（未声明）与 MCP 被排除
    expect(call.tools?.map((t) => t.name)).toEqual(["read_file", "export_md"]);
    expect(call.enabledSkillIds).toEqual(["weekly-report"]);
    expect(call.enableKnowledgeContext).toBe(false);
  });

  it("专家 id 无法解析时返回错误文本", async () => {
    const { outputText } = await runSubAgent({
      args: JSON.stringify({ task: "任务", expertId: "ghost-expert" }),
      context: makeExpertContext(expertManifest),
    });
    expect(outputText).toContain("不存在");
    expect(mockedExecuteChatTurn).not.toHaveBeenCalled();
  });

  // 专家是「本项目可指派的工作角色」：未绑定即不可被模型委派（技能/MCP 不适用此口径）。
  it("未绑定到当前项目的专家被拒绝委派，且明确说明原因", async () => {
    const { outputText } = await runSubAgent({
      args: JSON.stringify({ task: "写周报", expertId: "writer-expert" }),
      context: makeExpertContext(expertManifest, {
        project: { id: "project-2", boundExpertIds: ["dev-expert"] } as unknown as Project,
      }),
    });
    expect(outputText).toContain("未绑定到当前项目");
    expect(mockedExecuteChatTurn).not.toHaveBeenCalled();
  });

  it("无项目（临时会话）默认不放行；打开「允许指派任意专家」后放行", async () => {
    const rejected = await runSubAgent({
      args: JSON.stringify({ task: "写周报", expertId: "writer-expert" }),
      context: makeExpertContext(expertManifest, { project: null }),
    });
    expect(rejected.outputText).toContain("未绑定到当前项目");
    expect(mockedExecuteChatTurn).not.toHaveBeenCalled();

    mockedExecuteChatTurn.mockResolvedValue({
      content: "专家报告",
      toolRounds: 1,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      estimated: false,
    } as never);
    const allowed = await runSubAgent({
      args: JSON.stringify({ task: "写周报", expertId: "writer-expert" }),
      context: makeExpertContext(expertManifest, { project: null, allowAnyExpertDelegation: true }),
    });
    expect(allowed.outputText).toContain("专家报告");
  });

  it("专家未声明工具时以纯文本专家运行（不报错）", async () => {
    mockedExecuteChatTurn.mockResolvedValue({ content: "纯文本产出", toolRounds: 0, usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 }, estimated: false } as never);
    const noToolExpert = { ...expertManifest, defaultToolIds: [], defaultSkillIds: [] };
    const { outputText } = await runSubAgent({
      args: JSON.stringify({ task: "写段文案", expertId: "writer-expert" }),
      context: makeExpertContext(noToolExpert),
    });
    expect(outputText).toContain("纯文本产出");
    expect(mockedExecuteChatTurn.mock.calls[0][0].tools).toEqual([]);
    expect(mockedExecuteChatTurn.mock.calls[0][0].enabledSkillIds).toEqual([]);
  });

  it("以独立上下文调用引擎：白名单工具集、无知识检索/记忆抽取、任务作为 user 消息", async () => {
    mockedExecuteChatTurn.mockResolvedValue({ content: "子任务报告正文", toolRounds: 2, usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, estimated: false } as never);
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

  it("强弱路由：通用调研走 fast 档、专家委派走 capable 档（未配置则回落主模型）", async () => {
    mockedExecuteChatTurn.mockResolvedValue({ content: "报告", toolRounds: 1, usage: { promptTokens: 6, completionTokens: 3, totalTokens: 9 }, estimated: false } as never);

    // 通用调研：上下文带 fastModel → 引擎应使用 fast-model
    const fastContext = makeContext({ model: "main-model", capableModel: "cap-model", fastModel: "fast-model" });
    await runSubAgent({ args: JSON.stringify({ task: "快查资料" }), context: fastContext });
    expect(mockedExecuteChatTurn.mock.calls[0][0].model).toBe("fast-model");

    // 专家委派：上下文带 capableModel → 引擎应使用 cap-model（不走 fast）
    await runSubAgent({ args: JSON.stringify({ task: "写周报", expertId: "writer-expert" }), context: makeExpertContext(expertManifest, { model: "main-model", capableModel: "cap-model", fastModel: "fast-model" }) });
    expect(mockedExecuteChatTurn.mock.calls[1][0].model).toBe("cap-model");

    // 两档均未配置：回落主模型
    const fallthrough = makeContext({ model: "only-model" });
    await runSubAgent({ args: JSON.stringify({ task: "兜底任务" }), context: fallthrough });
    expect(mockedExecuteChatTurn.mock.calls[2][0].model).toBe("only-model");
  });

  it("推送开始/完成动作步骤到父运行时间线", async () => {
    mockedExecuteChatTurn.mockResolvedValue({ content: "报告", toolRounds: 1, usage: { promptTokens: 6, completionTokens: 3, totalTokens: 9 }, estimated: false } as never);
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
      return { content: result as string, toolRounds: 2, usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 }, estimated: false } as never;
    });

    const { outputText } = await runSubAgent({ args: "外层任务", context });
    expect(outputText).toContain("嵌套调用被拒绝");
    expect(isSubAgentActive()).toBe(false);
  });

  it("引擎无内容返回时给出兜底提示", async () => {
    mockedExecuteChatTurn.mockResolvedValue({ content: "  ", toolRounds: 1, usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 }, estimated: false } as never);
    const { outputText } = await runSubAgent({ args: "任务", context: makeContext() });
    expect(outputText).toContain("未返回有效报告");
  });

  it("成功时回传子 Agent 用量与工具轮数（并入主会话统计）", async () => {
    mockedExecuteChatTurn.mockResolvedValue({
      content: "调研报告",
      toolRounds: 3,
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      estimated: false,
    } as never);
    const result = await runSubAgent({ args: JSON.stringify({ task: "调研" }), context: makeContext() });
    expect(result.usage).toEqual({ promptTokens: 100, completionTokens: 50, totalTokens: 150, estimated: false });
    expect(result.toolRounds).toBe(3);
  });

  it("引擎报告估算用量时透传 estimated 标记", async () => {
    mockedExecuteChatTurn.mockResolvedValue({
      content: "估算报告",
      toolRounds: 1,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      estimated: true,
    } as never);
    const result = await runSubAgent({ args: JSON.stringify({ task: "调研" }), context: makeContext() });
    expect(result.usage?.estimated).toBe(true);
  });

  it("失败/兜底路径不携带用量", async () => {
    mockedExecuteChatTurn.mockRejectedValue(new Error("模型不可用"));
    const failed = await runSubAgent({ args: "任务", context: makeContext() });
    expect(failed.usage).toBeUndefined();
    expect(failed.toolRounds).toBeUndefined();

    mockedExecuteChatTurn.mockResolvedValue({ content: "  ", toolRounds: 1, usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 }, estimated: false } as never);
    const empty = await runSubAgent({ args: "任务", context: makeContext() });
    expect(empty.usage).toBeUndefined();
  });

  it("批量并行派发：每个子任务独立调引擎，报告分节 + 用量聚合", async () => {
    mockedExecuteChatTurn.mockImplementation(async (options) => {
      const prompt = options.messages[0].content;
      if (String(prompt).includes("调研 A")) {
        return { content: "A 报告", toolRounds: 2, usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, estimated: false } as never;
      }
      return { content: "B 报告", toolRounds: 3, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, estimated: true } as never;
    });

    const result = await runSubAgent({
      args: JSON.stringify({ tasks: [{ task: "调研 A" }, { task: "调研 B" }] }),
      context: makeContext(),
    });

    expect(mockedExecuteChatTurn).toHaveBeenCalledTimes(2);
    expect(result.outputText).toContain("## 子任务 1：调研 A");
    expect(result.outputText).toContain("A 报告");
    expect(result.outputText).toContain("## 子任务 2：调研 B");
    expect(result.outputText).toContain("B 报告");
    // 用量聚合：token 求和 + estimated 任一为真即为真
    expect(result.usage).toEqual({ promptTokens: 110, completionTokens: 55, totalTokens: 165, estimated: true });
    expect(result.toolRounds).toBe(5);
    expect(isSubAgentActive()).toBe(false);
  });

  it("批量中单个子任务失败不影响其余（失败节报错误文本、不贡献用量）", async () => {
    mockedExecuteChatTurn.mockImplementation(async (options) => {
      const prompt = String(options.messages[0].content);
      if (prompt.includes("会失败的任务")) {
        throw new Error("模型不可用");
      }
      return { content: "成功报告", toolRounds: 1, usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 }, estimated: false } as never;
    });

    const result = await runSubAgent({
      args: JSON.stringify({ tasks: ["会失败的任务", "正常任务"] }),
      context: makeContext(),
    });

    expect(result.outputText).toContain("子 Agent 执行失败");
    expect(result.outputText).toContain("成功报告");
    expect(result.usage).toEqual({ promptTokens: 20, completionTokens: 10, totalTokens: 30, estimated: false });
    expect(result.toolRounds).toBe(1);
  });

  it("批量超过上限时拒绝并引导拆分", async () => {
    const result = await runSubAgent({
      args: JSON.stringify({ tasks: Array.from({ length: MAX_SUB_AGENT_BATCH + 1 }, (_, i) => ({ task: `任务 ${i}` })) }),
      context: makeContext(),
    });
    expect(result.outputText).toContain("拆分");
    expect(mockedExecuteChatTurn).not.toHaveBeenCalled();
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
