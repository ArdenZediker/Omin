import { describe, expect, it } from "vitest";
import { getToolActionMeta, isFileProducingTool, getFileBadgeLabel, extractToolFilePath } from "./toolActionMap";

describe("toolActionMap", () => {
  it("已知内置工具返回中文动词与英文标题", () => {
    const meta = getToolActionMeta("export_docx");
    expect(meta.verb).toBe("导出");
    expect(meta.title).toBe("Export Word");
    expect(meta.producesFile).toBe(true);
  });

  it("MCP 连接器工具解析出工具名展示，隐藏 serverId", () => {
    const meta = getToolActionMeta("mcp__srv_abc123__search_notes");
    expect(meta.verb).toBe("调用");
    expect(meta.title).toBe("MCP · search_notes");
    expect(meta.title).not.toContain("srv_abc123");
    expect(meta.producesFile).toBe(false);
  });

  it("MCP 产出类工具按工具名（而非前缀）推断文件产出并可提取路径", () => {
    expect(isFileProducingTool("mcp__srv__write_report")).toBe(true);
    expect(isFileProducingTool("mcp__srv__read_notes")).toBe(false);
    const path = extractToolFilePath(JSON.stringify({ path: "D:/out/r.md" }), "mcp__srv__write_report");
    expect(path).toBe("D:/out/r.md");
    expect(getFileBadgeLabel("mcp__srv__write_report")).toBe("已生成");
  });

  it("完全未知的工具回退为「调用 + 原名」", () => {
    const meta = getToolActionMeta("some_custom_tool");
    expect(meta.verb).toBe("调用");
    expect(meta.title).toBe("some_custom_tool");
    expect(meta.producesFile).toBe(false);
  });
});
