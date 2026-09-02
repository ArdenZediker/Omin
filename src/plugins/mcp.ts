/**
 * Omni MCP 连接器运行层（前端）。
 *
 * 与 WorkBuddy 的连接器模型对齐：连接器 = MCP 服务器（stdio 子进程）。
 * 已启用且配置了启动命令（config.command）的连接器插件，应用启动时自动
 * 拉起对应 MCP 服务器，其 tools/list 暴露的工具以 `mcp__{serverId}__{tool}`
 * 命名注入对话的 function calling 工具列表；模型发起调用时经 Rust
 * call_mcp_tool 执行并回填结果。
 */

import { invoke } from "@tauri-apps/api/core";
import { pluginRegistry } from "./registry";
import type { ChatToolParam } from "../adapters/types";
import type { PluginManifest } from "./types";

export interface McpToolInfo {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface McpServerInfo {
  id: string;
  server_info: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  tools: McpToolInfo[];
  stderr_tail: string[];
}

export interface McpToolResult {
  ok: boolean;
  text: string;
  error?: string | null;
}

interface ConnectedMcpServer {
  serverId: string;
  connectorId: string;
  connectorName: string;
  info: McpServerInfo;
  connectedAt: number;
}

/** 已连接的 MCP 服务器（前端内存态；应用重启后由 syncMcpConnectors 恢复）。 */
const connectedServers = new Map<string, ConnectedMcpServer>();

/** 连接器插件 → 是否正在尝试连接（防重入）。 */
const connecting = new Set<string>();

// ---------------------------------------------------------------------------
// Rust 命令封装
// ---------------------------------------------------------------------------

export async function startMcpServer(
  id: string,
  command: string,
  args: string[],
  env?: Record<string, string>,
): Promise<McpServerInfo> {
  return invoke<McpServerInfo>("start_mcp_server", { id, command, args, env: env ?? null });
}

export async function stopMcpServer(id: string): Promise<string[]> {
  return invoke<string[]>("stop_mcp_server", { id });
}

export async function listMcpTools(id: string): Promise<McpToolInfo[]> {
  return invoke<McpToolInfo[]>("list_mcp_tools", { id });
}

export async function callMcpTool(
  id: string,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<McpToolResult> {
  return invoke<McpToolResult>("call_mcp_tool", { id, name, arguments: arguments_ });
}

export async function readMcpStderr(id: string): Promise<string[]> {
  return invoke<string[]>("read_mcp_stderr", { id });
}

// ---------------------------------------------------------------------------
// 连接器 ↔ MCP 生命周期
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 信任门（Trust Gate）
//
// 对齐 WorkBuddy 的连接器信任模型：MCP 连接器配置完成后**不自动激活**，必须由
// 用户显式确认信任（点「信任并连接」）才会拉起子进程、并把它的工具注入对话的
// function calling。
//
// 原因（这是 Omni 权限模型最大的一个缺口）：MCP 服务器是本机上的任意子进程，
// 它 tools/list 暴露的工具不经过 buildChatTools 的 SAFE/OFFERED 白名单，也不看
// 项目 allowedToolIds——一旦拉起，等于把该服务器的全部能力（可能是文件读写、
// 命令执行、数据库访问）直接交给模型，Omni 自身的三层权限模型对它完全失效。
// ---------------------------------------------------------------------------

/** 读取连接器的信任状态（存在连接器 config.trusted）。 */
export function isConnectorTrusted(manifest: PluginManifest): boolean {
  return isTrustedById(manifest.id);
}

function isTrustedById(id: string): boolean {
  const config = pluginRegistry.getConnectorConfig(id) ?? {};
  return config.trusted === true;
}

/** 写入信任状态。setConnectorConfig 是合并语义，不影响 command/args/env。 */
export function setConnectorTrusted(manifest: PluginManifest, trusted: boolean): void {
  pluginRegistry.setConnectorConfig(manifest.id, { trusted });
}

/** 信任确认弹窗要展示的启动信息（env 只给 key，值脱敏防 token 泄露）。 */
export function getMcpTrustInfo(manifest: PluginManifest): {
  command: string;
  args: string[];
  envKeys: string[];
} {
  const launch = getMcpLaunchConfig(manifest);
  return {
    command: launch?.command ?? "",
    args: launch?.args ?? [],
    envKeys: Object.keys(launch?.env ?? {}),
  };
}

/** 从连接器插件的 config 中读取 MCP 启动配置。 */
function getMcpLaunchConfig(manifest: PluginManifest): { command: string; args: string[]; env?: Record<string, string> } | null {
  const config = pluginRegistry.getConnectorConfig(manifest.id) ?? {};
  const command = String(config.command ?? "").trim();
  if (!command) return null;
  const args = Array.isArray(config.args) ? config.args.map(String) : [];
  const env = config.env && typeof config.env === "object" ? (config.env as Record<string, string>) : undefined;
  return { command, args, env };
}

/**
 * 启动（或复用）一个连接器对应的 MCP 服务器，并记录其暴露的工具。
 * 连接器插件需 enabled 且已配置 command。
 */
export async function ensureMcpConnector(
  manifest: PluginManifest,
  options?: { requireTrust?: boolean },
): Promise<McpServerInfo | null> {
  if (!pluginRegistry.isEnabled(manifest.id)) return null;
  // 信任门：未获用户信任的连接器不拉起，其工具自然也不会注入对话。
  const requireTrust = options?.requireTrust ?? true;
  if (requireTrust && !isConnectorTrusted(manifest)) return null;
  const launch = getMcpLaunchConfig(manifest);
  if (!launch) return null;

  if (connecting.has(manifest.id)) {
    return connectedServers.get(manifest.id)?.info ?? null;
  }
  connecting.add(manifest.id);
  try {
    const existing = connectedServers.get(manifest.id);
    if (existing) return existing.info;
    const info = await startMcpServer(manifest.id, launch.command, launch.args, launch.env);
    connectedServers.set(manifest.id, {
      serverId: manifest.id,
      connectorId: manifest.id,
      connectorName: manifest.name,
      info,
      connectedAt: Date.now(),
    });
    return info;
  } finally {
    connecting.delete(manifest.id);
  }
}

/** 断开一个连接器对应的 MCP 服务器。 */
export async function disconnectMcpConnector(connectorId: string): Promise<void> {
  const existing = connectedServers.get(connectorId);
  if (existing) {
    try {
      await stopMcpServer(connectorId);
    } catch {
      // 进程可能已退出
    }
    connectedServers.delete(connectorId);
  }
}

/**
 * 应用启动时调用：把已启用、已配置、且**已获用户信任**的连接器拉起。
 * 未获信任的会被 ensureMcpConnector 的信任门挡下——配置完成不等于激活，
 * 这是刻意为之的安全设计。静默失败，不阻塞启动。
 */
export async function syncMcpConnectors(): Promise<void> {
  const manifests = pluginRegistry.listEnabledConnectors();
  for (const manifest of manifests) {
    try {
      await ensureMcpConnector(manifest);
    } catch {
      // 单个连接器失败不影响其它连接器
    }
  }
}

// ---------------------------------------------------------------------------
// 对话注入
// ---------------------------------------------------------------------------

/** 已连接 MCP 服务器暴露的工具 → function calling 工具声明（mcp__ 前缀）。 */
export function listActiveMcpTools(): ChatToolParam[] {
  const tools: ChatToolParam[] = [];
  for (const server of connectedServers.values()) {
    // 纵深防御：即便连接态残留（如信任被撤销后进程未退出），未信任的
    // 连接器也不向模型暴露任何工具。
    if (!isTrustedById(server.connectorId)) continue;
    for (const tool of server.info.tools ?? []) {
      tools.push({
        name: `mcp__${server.serverId}__${tool.name}`,
        description: `${server.connectorName} · ${tool.description || tool.name}`,
        parameters: tool.input_schema ?? { type: "object", properties: {} },
      });
    }
  }
  return tools;
}

/** 当前已连接状态（供 UI 展示）。 */
export function listConnectedMcpServers(): Array<{
  connectorId: string;
  connectorName: string;
  toolCount: number;
  serverInfo: Record<string, unknown>;
}> {
  return Array.from(connectedServers.values()).map((server) => ({
    connectorId: server.connectorId,
    connectorName: server.connectorName,
    toolCount: server.info.tools?.length ?? 0,
    serverInfo: server.info.server_info,
  }));
}

/**
 * 执行一次模型发起的 MCP 工具调用。
 * name 形如 `mcp__{serverId}__{toolName}`；arguments 为 JSON 字符串。
 */
export async function executeMcpToolCall(
  name: string,
  argumentsJson: string,
): Promise<string> {
  const parts = name.split("__");
  if (parts.length < 3 || parts[0] !== "mcp") {
    return `未知的 MCP 工具：${name}`;
  }
  const serverId = parts[1];
  const toolName = parts.slice(2).join("__");
  const server = connectedServers.get(serverId);
  if (!server) {
    return `MCP 服务器未连接：${serverId}。请在扩展中心「连接器」中重新连接后再试。`;
  }
  // 独立校验信任状态（不能只依赖 listActiveMcpTools 的过滤）：
  // 模型可以自行编造 `mcp__{serverId}__{tool}` 名字发起调用，若服务器恰好
  // 处于连接态而此处不校验，未受信任的连接器就会被间接驱动。
  if (!isTrustedById(serverId)) {
    return `连接器「${server.connectorName}」尚未获得信任，已拒绝调用其工具 ${toolName}。请在扩展中心「连接器」中确认信任后再试。`;
  }
  let parsed: Record<string, unknown> = {};
  if (argumentsJson && argumentsJson !== "{}") {
    try {
      parsed = JSON.parse(argumentsJson);
    } catch {
      parsed = { raw: argumentsJson };
    }
  }
  try {
    const result = await callMcpTool(serverId, toolName, parsed);
    if (!result.ok) {
      return `MCP 工具执行失败：${result.error ?? (result.text || "未知错误")}`;
    }
    return result.text || "工具执行完成（无输出）";
  } catch (error) {
    return `MCP 工具调用出错：${error instanceof Error ? error.message : String(error)}`;
  }
}
