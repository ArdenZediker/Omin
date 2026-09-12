import type { ChatToolParam } from "../adapters/types";
import type { PluginManifest } from "../plugins/types";

/**
 * 专家能力边界：把「专家声明」翻译成实际可用的工具集。
 *
 * 专家有两类声明：
 * - `defaultToolIds`：内置 / 项目工具的 id（精确匹配工具名）；
 * - `defaultMcpConnectorIds`：MCP **连接器** id（匹配该连接器暴露的 `mcp__{id}__*` 工具）。
 *
 * 为什么 MCP 必须单列一项：`buildChatTools()` 只产出内置 + 项目工具，**永远不含 `mcp__*`**，
 * 因此 `defaultToolIds` 勾不到任何 MCP 工具——这正是「专家在场时 MCP 被整体摘掉」的根因。
 * 连接器 id 与 MCP serverId 同值（`mcp.ts::ensureMcpConnector` 里 `serverId = connectorId = manifest.id`）。
 */

const MCP_TOOL_PREFIX = "mcp__";

/**
 * 从 MCP 工具名解析所属连接器 id；非 MCP 工具返回 null。
 *
 * 解析规则与 `mcp.ts::executeMcpToolCall` 严格一致：按 `__` 切分后取第 2 段，
 * 工具名是第 3 段起再拼回。二者必须同源，否则「绑定得到」却「调用不到」。
 * （副作用：连接器 id 自身含 `__` 时只能取到第一段——与调用侧同样的行为，属已知约定。）
 */
export function mcpConnectorIdOfToolName(toolName: string): string | null {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = toolName.slice(MCP_TOOL_PREFIX.length);
  const separator = rest.indexOf("__");
  return separator > 0 ? rest.slice(0, separator) : null;
}

/**
 * 专家的实际工具集 = `defaultToolIds` 命中的工具 ∪ 绑定连接器暴露的 `mcp__*` 工具。
 * 两类都为空 ⇒ 返回空数组（纯文本专家）。
 */
export function selectExpertTools(
  allTools: ChatToolParam[],
  expert: Pick<PluginManifest, "defaultToolIds" | "defaultMcpConnectorIds">,
): ChatToolParam[] {
  const declaredTools = new Set(expert.defaultToolIds ?? []);
  const declaredConnectors = new Set((expert.defaultMcpConnectorIds ?? []).filter(Boolean));
  return allTools.filter((tool) => {
    if (declaredTools.has(tool.name)) return true;
    if (declaredConnectors.size === 0) return false;
    const connectorId = mcpConnectorIdOfToolName(tool.name);
    return connectorId !== null && declaredConnectors.has(connectorId);
  });
}
