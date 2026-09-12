import { beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectMcpConnector } from "./mcp";
import type { PluginManifest } from "./types";

/** mcp.ts 的 connectedServers 是模块级状态，测试之间必须清干净，否则互相污染。 */
const CONNECTOR_IDS = [
  "untrusted-1",
  "trusted-1",
  "revoked-1",
  "forged-1",
  "merge-1",
];

/**
 * 连接器信任门（Trust Gate）单测。
 *
 * 锁定的是一条安全红线：MCP 服务器是本机上的任意子进程，它暴露的工具不经过
 * buildChatTools 的 SAFE/OFFERED 白名单——因此「未获信任的连接器」必须在三个
 * 层面都被拦住：不拉起进程、不注入工具、拒绝执行工具调用。
 */

const state = {
  enabled: new Set<string>(),
  configs: new Map<string, Record<string, unknown>>(),
};

vi.mock("./registry", () => ({
  pluginRegistry: {
    isEnabled: (id: string) => state.enabled.has(id),
    getConnectorConfig: (id: string) => state.configs.get(id) ?? null,
    setConnectorConfig: (id: string, config: Record<string, unknown>) => {
      state.configs.set(id, { ...(state.configs.get(id) ?? {}), ...config });
    },
    listEnabledConnectors: () => [],
  },
}));

/** 记录被真正拉起的子进程，用于断言「未信任时根本没启动」。 */
const startedServers: string[] = [];
const stoppedServers: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "start_mcp_server") {
      startedServers.push(String(args.id));
      return {
        id: String(args.id),
        server_info: {},
        capabilities: {},
        tools: [
          {
            name: "read_file",
            description: "读取任意文件",
            input_schema: { type: "object", properties: {} },
          },
        ],
        stderr_tail: [],
      };
    }
    if (cmd === "stop_mcp_server") {
      stoppedServers.push(String(args.id));
      return [];
    }
    return null;
  }),
}));

const makeManifest = (id: string): PluginManifest =>
  ({
    id,
    kind: "connector",
    name: `测试连接器 ${id}`,
  }) as PluginManifest;

/** 配置一个已启用、已配启动命令、但尚未获信任的 MCP 连接器。 */
const setupConnector = (id: string) => {
  state.enabled.add(id);
  state.configs.set(id, { command: "npx", args: ["-y", "@test/server"] });
  return makeManifest(id);
};

describe("MCP 连接器信任门", () => {
  beforeEach(async () => {
    state.enabled.clear();
    state.configs.clear();
    startedServers.length = 0;
    stoppedServers.length = 0;
    for (const id of CONNECTOR_IDS) {
      await disconnectMcpConnector(id);
    }
  });

  it("未获信任的连接器不会被拉起，也不向模型暴露任何工具", async () => {
    const { ensureMcpConnector, listActiveMcpTools } = await import("./mcp");
    const manifest = setupConnector("untrusted-1");

    const info = await ensureMcpConnector(manifest);

    expect(info).toBeNull();
    expect(startedServers).not.toContain("untrusted-1");
    expect(listActiveMcpTools()).toHaveLength(0);
  });

  it("确认信任后可以拉起，并把工具注入 function calling（mcp__ 前缀）", async () => {
    const { ensureMcpConnector, listActiveMcpTools, setConnectorTrusted } =
      await import("./mcp");
    const manifest = setupConnector("trusted-1");

    setConnectorTrusted(manifest, true);
    const info = await ensureMcpConnector(manifest);

    expect(info).not.toBeNull();
    expect(startedServers).toContain("trusted-1");
    const tools = listActiveMcpTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("mcp__trusted-1__read_file");
  });

  it("信任被撤销后，残留的连接态也不再向模型暴露工具（纵深防御）", async () => {
    const { ensureMcpConnector, listActiveMcpTools, setConnectorTrusted } =
      await import("./mcp");
    const manifest = setupConnector("revoked-1");

    setConnectorTrusted(manifest, true);
    await ensureMcpConnector(manifest);
    expect(listActiveMcpTools()).toHaveLength(1);

    setConnectorTrusted(manifest, false);
    expect(listActiveMcpTools()).toHaveLength(0);
  });

  it("模型自行编造 mcp__ 工具名时，未信任的连接器拒绝执行", async () => {
    const { executeMcpToolCall, ensureMcpConnector, setConnectorTrusted } =
      await import("./mcp");
    const manifest = setupConnector("forged-1");

    // 先建立连接态（模拟服务器还活着，但信任已被撤销/从未授予）
    setConnectorTrusted(manifest, true);
    await ensureMcpConnector(manifest);
    setConnectorTrusted(manifest, false);

    const output = await executeMcpToolCall(
      "mcp__forged-1__read_file",
      JSON.stringify({ path: "C:/secret.txt" }),
    );

    expect(output).toContain("尚未获得信任");
    expect(output).toContain("已拒绝调用");
  });

  it("写入信任状态不会覆盖已有的 command/args/env 配置", async () => {
    const { setConnectorTrusted } = await import("./mcp");
    const manifest = setupConnector("merge-1");
    state.configs.set("merge-1", {
      command: "npx",
      args: ["-y", "@test/server"],
      env: { TOKEN: "abc" },
    });

    setConnectorTrusted(manifest, true);

    const config = state.configs.get("merge-1");
    expect(config?.trusted).toBe(true);
    expect(config?.command).toBe("npx");
    expect(config?.args).toEqual(["-y", "@test/server"]);
    expect(config?.env).toEqual({ TOKEN: "abc" });
  });
});

/**
 * MCP 工具声明预算。
 *
 * 锁定的是一条预算红线：MCP 服务器可以暴露任意多、任意大的工具声明，而这些声明
 * 会拼进每一条请求 —— 不设上限就等于把上下文窗口交给第三方服务器处置。
 */
describe("MCP 工具声明预算（selectMcpToolsWithinBudget）", () => {
  const BUDGET = { perToolMaxChars: 512, perConnectorMaxChars: 1024 };

  const makeTool = (name: string, schemaChars = 0) => ({
    name,
    description: name,
    input_schema: {
      type: "object",
      properties: { blob: { type: "string", description: "x".repeat(schemaChars) } },
    },
  });

  it("预算内全部保留，前缀与描述按连接器拼装", async () => {
    const { selectMcpToolsWithinBudget } = await import("./mcp");

    const selection = selectMcpToolsWithinBudget(
      [{ serverId: "srv", connectorName: "测试连接器", tools: [makeTool("a"), makeTool("b")] }],
      BUDGET,
    );

    expect(selection.hidden).toHaveLength(0);
    expect(selection.tools.map((t) => t.name)).toEqual(["mcp__srv__a", "mcp__srv__b"]);
    expect(selection.tools[0].description).toBe("测试连接器 · a");
  });

  it("单个工具超预算：隐藏该工具并记录原因，其余照常保留", async () => {
    const { selectMcpToolsWithinBudget } = await import("./mcp");

    const selection = selectMcpToolsWithinBudget(
      [{ serverId: "srv", connectorName: "测试连接器", tools: [makeTool("small"), makeTool("huge", 2000), makeTool("small2")] }],
      BUDGET,
    );

    expect(selection.tools.map((t) => t.name)).toEqual(["mcp__srv__small", "mcp__srv__small2"]);
    expect(selection.hidden).toHaveLength(1);
    expect(selection.hidden[0]).toMatchObject({ toolName: "huge", reason: "tool-too-large" });
    expect(selection.hidden[0].chars).toBeGreaterThan(BUDGET.perToolMaxChars);
  });

  it("单连接器累计超预算：后续工具被隐藏，累加不越过上限", async () => {
    const { selectMcpToolsWithinBudget } = await import("./mcp");

    // 每个工具约 300+ 字符，4 个即超过 1024 的累计预算。
    const tools = [makeTool("t1", 250), makeTool("t2", 250), makeTool("t3", 250), makeTool("t4", 250)];
    const selection = selectMcpToolsWithinBudget([{ serverId: "srv", connectorName: "测试连接器", tools }], BUDGET);

    expect(selection.tools.length).toBeLessThan(tools.length);
    expect(selection.hidden.some((item) => item.reason === "connector-budget-exceeded")).toBe(true);
    const total = selection.tools.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0);
    expect(total).toBeLessThanOrEqual(BUDGET.perConnectorMaxChars);
  });

  it("预算按连接器独立计算，一个连接器超限不影响另一个", async () => {
    const { selectMcpToolsWithinBudget } = await import("./mcp");

    const selection = selectMcpToolsWithinBudget(
      [
        { serverId: "srv-a", connectorName: "A", tools: [makeTool("t1", 250), makeTool("t2", 250), makeTool("t3", 250), makeTool("t4", 250)] },
        { serverId: "srv-b", connectorName: "B", tools: [makeTool("only")] },
      ],
      BUDGET,
    );

    expect(selection.tools.some((tool) => tool.name === "mcp__srv-b__only")).toBe(true);
    expect(selection.hidden.every((item) => item.connectorName === "A")).toBe(true);
  });

  it("默认预算为单工具 8KB / 单连接器 64KB", async () => {
    const { MCP_TOOL_SCHEMA_BUDGET } = await import("./mcp");
    expect(MCP_TOOL_SCHEMA_BUDGET.perToolMaxChars).toBe(8 * 1024);
    expect(MCP_TOOL_SCHEMA_BUDGET.perConnectorMaxChars).toBe(64 * 1024);
  });

  it("缺省 input_schema 时回落到空对象结构，不丢工具", async () => {
    const { selectMcpToolsWithinBudget } = await import("./mcp");

    const selection = selectMcpToolsWithinBudget(
      [{ serverId: "srv", connectorName: "测试连接器", tools: [{ name: "bare", description: "", input_schema: undefined as never }] }],
      BUDGET,
    );

    expect(selection.tools).toHaveLength(1);
    expect(selection.tools[0].parameters).toEqual({ type: "object", properties: {} });
  });
});
