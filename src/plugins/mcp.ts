/**
 * Omni MCP 连接器运行层（前端）。
 *
 * 与 WorkBuddy 的连接器模型对齐：连接器 = MCP 服务器（stdio 子进程或 HTTP 远程）。
 * 已启用且配置了启动命令（config.command）或远程地址（config.url）的连接器插件，应用启动时自动
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

/** MCP 启动配置：stdio 子进程 或 Streamable HTTP 远程。 */
export type McpLaunchConfig =
  | { type: "stdio"; command: string; args: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

/**
 * 解析 MCP 启动配置 JSON。支持两种形态：
 *  - 直接对象：{ "command": "npx", "args": [...], "env": {...} }
 *                 或 { "url": "...", "headers": {...} }
 *  - Claude Desktop 风格包装：{ "mcpServers": { "<name>": { ... } } }
 * 优先识别 url → Streamable HTTP；否则识别 command → stdio。
 */
export type ParsedMcpConfig =
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { type: "http"; url: string; headers: Record<string, string> };

export function parseMcpJson(input: string): ParsedMcpConfig | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch (error) {
    return { error: `JSON 解析失败：${(error as Error).message}` };
  }
  let cfg: Record<string, unknown> = raw as Record<string, unknown>;
  if (
    cfg &&
    typeof cfg === "object" &&
    cfg.mcpServers &&
    typeof cfg.mcpServers === "object"
  ) {
    const servers = cfg.mcpServers as Record<string, unknown>;
    const keys = Object.keys(servers);
    if (keys.length === 0) return { error: "mcpServers 为空，请至少配置一个服务器" };
    cfg = servers[keys[0]] as Record<string, unknown>;
  }
  if (!cfg || typeof cfg !== "object") {
    return { error: "配置必须是一个 JSON 对象" };
  }

  const url = typeof cfg.url === "string" ? cfg.url.trim() : "";
  if (url) {
    const headers: Record<string, string> = {};
    if (cfg.headers && typeof cfg.headers === "object") {
      for (const [key, value] of Object.entries(
        cfg.headers as Record<string, unknown>,
      )) {
        if (value != null) headers[key] = String(value);
      }
    }
    return { type: "http", url, headers };
  }

  const command = typeof cfg.command === "string" ? cfg.command.trim() : "";
  if (!command) return { error: "缺少 command 或 url 字段（必须提供其一）" };
  const args = Array.isArray(cfg.args)
    ? cfg.args.map((item) => String(item))
    : cfg.args == null
      ? []
      : [String(cfg.args)];
  const env: Record<string, string> = {};
  if (cfg.env && typeof cfg.env === "object") {
    for (const [key, value] of Object.entries(
      cfg.env as Record<string, unknown>,
    )) {
      if (value != null) env[key] = String(value);
    }
  }
  return { type: "stdio", command, args, env };
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
  config: McpLaunchConfig,
): Promise<McpServerInfo> {
  if (config.type === "stdio") {
    return invoke<McpServerInfo>("start_mcp_server", {
      id,
      command: config.command,
      args: config.args,
      env: config.env ?? null,
      url: null,
      headers: null,
    });
  }
  return invoke<McpServerInfo>("start_mcp_server", {
    id,
    command: null,
    args: null,
    env: null,
    url: config.url,
    headers: config.headers ?? null,
  });
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

/** 信任确认弹窗要展示的启动信息（env/header 只给 key，值脱敏防 token 泄露）。 */
export function getMcpTrustInfo(manifest: PluginManifest): {
  type: "stdio" | "http" | null;
  command: string;
  args: string[];
  envKeys: string[];
  url: string;
  headerKeys: string[];
} {
  const launch = getMcpLaunchConfig(manifest);
  return {
    type: launch?.type ?? null,
    command: launch?.type === "stdio" ? launch.command : "",
    args: launch?.type === "stdio" ? launch.args : [],
    envKeys: launch?.type === "stdio" ? Object.keys(launch.env ?? {}) : [],
    url: launch?.type === "http" ? launch.url : "",
    headerKeys: launch?.type === "http" ? Object.keys(launch.headers ?? {}) : [],
  };
}

/** 从连接器插件的 config 中读取 MCP 启动配置。 */
function getMcpLaunchConfig(manifest: PluginManifest): McpLaunchConfig | null {
  const config = pluginRegistry.getConnectorConfig(manifest.id) ?? {};
  const url = String(config.url ?? "").trim();
  if (url) {
    const headers =
      config.headers && typeof config.headers === "object"
        ? (config.headers as Record<string, string>)
        : undefined;
    return { type: "http", url, headers };
  }
  const command = String(config.command ?? "").trim();
  if (!command) return null;
  const args = Array.isArray(config.args) ? config.args.map(String) : [];
  const env =
    config.env && typeof config.env === "object"
      ? (config.env as Record<string, string>)
      : undefined;
  return { type: "stdio", command, args, env };
}

/**
 * 启动（或复用）一个连接器对应的 MCP 服务器，并记录其暴露的工具。
 * 连接器插件需 enabled 且已配置 command 或 url。
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
    const info = await startMcpServer(manifest.id, launch);
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
      // 进程可能已退出或远程连接已关闭
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

// ---------------------------------------------------------------------------
// 工具声明预算
//
// MCP 服务器能暴露任意数量的工具、任意大的 JSON Schema，而这些声明会被原样拼进
// **每一条**请求的 tools 字段：既不过 buildChatTools 的 SAFE/OFFERED 白名单，也不受
// 项目 allowedToolIds 约束，更没有体积上限。一个暴露两百个工具、或单个 schema 上百
// KB 的服务器就足以吃掉整窗预算，甚至让上游直接拒收请求。
//
// 这里对齐 Codex 的披露预算：单个工具 8KB、单连接器累计 64KB，超出的**隐藏**而不是
// 截断——被截断的 JSON Schema 是坏数据，模型会照着残缺结构瞎传参，比看不到更糟。
// ---------------------------------------------------------------------------

export interface McpToolSchemaBudget {
  /** 单个工具声明序列化后的字符上限。 */
  perToolMaxChars: number;
  /** 单个连接器下所有工具声明的累计字符上限。 */
  perConnectorMaxChars: number;
}

export const MCP_TOOL_SCHEMA_BUDGET: McpToolSchemaBudget = {
  perToolMaxChars: 8 * 1024,
  perConnectorMaxChars: 64 * 1024,
};

export interface McpHiddenTool {
  serverId: string;
  connectorName: string;
  toolName: string;
  reason: "tool-too-large" | "connector-budget-exceeded";
  /** 该工具声明的实际字符数，便于排查「为什么它没出现」。 */
  chars: number;
}

export interface McpToolSelection {
  tools: ChatToolParam[];
  hidden: McpHiddenTool[];
}

/**
 * 纯函数：把候选 MCP 工具按预算裁成可注入的声明列表。
 * 保持输入顺序，一旦某工具超出预算就隐藏并记录原因，便于向用户解释。
 */
export function selectMcpToolsWithinBudget(
  servers: Array<{ serverId: string; connectorName: string; tools?: McpToolInfo[] }>,
  budget: McpToolSchemaBudget = MCP_TOOL_SCHEMA_BUDGET,
): McpToolSelection {
  const tools: ChatToolParam[] = [];
  const hidden: McpHiddenTool[] = [];
  for (const server of servers) {
    let used = 0;
    for (const tool of server.tools ?? []) {
      const param: ChatToolParam = {
        name: `mcp__${server.serverId}__${tool.name}`,
        description: `${server.connectorName} · ${tool.description || tool.name}`,
        parameters: tool.input_schema ?? { type: "object", properties: {} },
      };
      const chars = JSON.stringify(param).length;
      if (chars > budget.perToolMaxChars) {
        hidden.push({ serverId: server.serverId, connectorName: server.connectorName, toolName: tool.name, reason: "tool-too-large", chars });
        continue;
      }
      if (used + chars > budget.perConnectorMaxChars) {
        hidden.push({ serverId: server.serverId, connectorName: server.connectorName, toolName: tool.name, reason: "connector-budget-exceeded", chars });
        continue;
      }
      used += chars;
      tools.push(param);
    }
  }
  return { tools, hidden };
}

/** 上一次注入时因超预算被隐藏的工具（进程内记忆，供 UI 说明用）。 */
let lastMcpToolOverflow: McpHiddenTool[] = [];

/** 已连接 MCP 服务器暴露的工具 → function calling 工具声明（mcp__ 前缀，受预算裁剪）。 */
export function listActiveMcpTools(): ChatToolParam[] {
  // 纵深防御：即便连接态残留（如信任被撤销后进程未退出），未信任的
  // 连接器也不向模型暴露任何工具。
  const trusted = Array.from(connectedServers.values()).filter((server) => isTrustedById(server.connectorId));
  const selection = selectMcpToolsWithinBudget(
    trusted.map((server) => ({
      serverId: server.serverId,
      connectorName: server.connectorName,
      tools: server.info.tools,
    })),
  );
  lastMcpToolOverflow = selection.hidden;
  return selection.tools;
}

/**
 * 上次注入时被隐藏的工具说明；没有隐藏则返回 null。
 *
 * 没有这个提示，「连接器连上了、协议也通了，但工具列表里看不到它」就无从解释——
 * 用户只会以为连接器坏了。
 */
export function getMcpToolOverflowNotice(): string | null {
  if (lastMcpToolOverflow.length === 0) return null;
  const names = lastMcpToolOverflow.map((item) => `${item.connectorName}/${item.toolName}`).join("、");
  return `已隐藏 ${lastMcpToolOverflow.length} 个超出声明预算的 MCP 工具（${names}）：单个工具上限 ${MCP_TOOL_SCHEMA_BUDGET.perToolMaxChars} 字符、单连接器累计上限 ${MCP_TOOL_SCHEMA_BUDGET.perConnectorMaxChars} 字符。`;
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
