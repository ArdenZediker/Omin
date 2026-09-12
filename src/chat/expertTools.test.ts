import { describe, expect, it } from "vitest";
import { mcpConnectorIdOfToolName, selectExpertTools } from "./expertTools";
import type { ChatToolParam } from "../adapters/types";

function tool(name: string): ChatToolParam {
  return { name, description: name, parameters: { type: "object", properties: {} } };
}

const ALL_TOOLS: ChatToolParam[] = [
  tool("read_file"),
  tool("export_md"),
  tool("write_file"),
  tool("mcp__github__search_repos"),
  tool("mcp__github__create_issue"),
  tool("mcp__notion__search"),
];

describe("mcpConnectorIdOfToolName", () => {
  it("解析 `mcp__{连接器}__{工具}`，与 executeMcpToolCall 的切分规则一致", () => {
    expect(mcpConnectorIdOfToolName("mcp__github__search_repos")).toBe("github");
    expect(mcpConnectorIdOfToolName("mcp__notion__search")).toBe("notion");
  });

  it("非 MCP 工具与缺少分隔符的名字返回 null", () => {
    expect(mcpConnectorIdOfToolName("read_file")).toBeNull();
    expect(mcpConnectorIdOfToolName("mcp__onlyprefix")).toBeNull();
    expect(mcpConnectorIdOfToolName("mcp____tool")).toBeNull();
  });

  it("连接器 id 自身含 __ 时只取第一段（与调用侧同一约定）", () => {
    expect(mcpConnectorIdOfToolName("mcp__my__server__tool")).toBe("my");
  });
});

describe("selectExpertTools", () => {
  it("只声明本地工具：精确匹配，不夹带 MCP", () => {
    const selected = selectExpertTools(ALL_TOOLS, { defaultToolIds: ["read_file", "export_md"] });
    expect(selected.map((t) => t.name)).toEqual(["read_file", "export_md"]);
  });

  it("只绑定 MCP 连接器：给出该连接器的全部 mcp__* 工具", () => {
    const selected = selectExpertTools(ALL_TOOLS, { defaultMcpConnectorIds: ["github"] });
    expect(selected.map((t) => t.name)).toEqual([
      "mcp__github__search_repos",
      "mcp__github__create_issue",
    ]);
  });

  it("本地工具 + MCP 连接器可叠加，且保持入参顺序", () => {
    const selected = selectExpertTools(ALL_TOOLS, {
      defaultToolIds: ["read_file"],
      defaultMcpConnectorIds: ["notion"],
    });
    expect(selected.map((t) => t.name)).toEqual(["read_file", "mcp__notion__search"]);
  });

  it("未绑定的连接器不被夹带；空白 id 被忽略", () => {
    const selected = selectExpertTools(ALL_TOOLS, { defaultMcpConnectorIds: ["", "  "] });
    expect(selected).toEqual([]);
  });

  it("两类声明皆空 ⇒ 纯文本专家（空工具集）", () => {
    expect(selectExpertTools(ALL_TOOLS, {})).toEqual([]);
    expect(selectExpertTools(ALL_TOOLS, { defaultToolIds: [], defaultMcpConnectorIds: [] })).toEqual([]);
  });
});
