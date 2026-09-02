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
