import { describe, expect, it } from "vitest";
import { buildChatTools, buildExpertAgentHint, createStructuredOutputFilter, extractToolCallArgs, resolveEnabledToolNames } from "./chatRuntimeHelpers";
import { BUILTIN_TOOL_IDS } from "../config/manifests/tools";
import type { Project } from "../chat/types";

describe("extractToolCallArgs", () => {
  it("纯字符串原样返回", () => {
    expect(extractToolCallArgs('"关键词"')).toBe("关键词");
    expect(extractToolCallArgs("非 JSON 文本")).toBe("非 JSON 文本");
  });

  it("单字段命中 directKeys 时返回该字符串（老工具单参数形态）", () => {
    expect(extractToolCallArgs(JSON.stringify({ query: "性能优化" }))).toBe("性能优化");
    expect(extractToolCallArgs(JSON.stringify({ path: "src/main.rs" }))).toBe("src/main.rs");
    expect(extractToolCallArgs(JSON.stringify({ sessionId: "chat-1" }))).toBe("chat-1");
  });

  it("{manifest:{...}} 返回 manifest 的 JSON（install_expert）", () => {
    const manifest = { id: "dev-expert", kind: "expert", templatePrompt: "x" };
    const raw = JSON.stringify({ manifest });
    const out = extractToolCallArgs(raw);
    expect(JSON.parse(out)).toEqual(manifest);
  });

  it("多参数对象保留原始 JSON（web_fetch / git_* / install_skill）", () => {
    const raw = JSON.stringify({ url: "https://example.com", max_chars: 3000 });
    expect(extractToolCallArgs(raw)).toBe(raw);
    const raw2 = JSON.stringify({ operation: "log", limit: 20 });
    expect(extractToolCallArgs(raw2)).toBe(raw2);
    const raw3 = JSON.stringify({ id: "weekly-report", content: "# 正文", name: "周报" });
    expect(extractToolCallArgs(raw3)).toBe(raw3);
  });

  it("含对象/数组字段（spec/paths/manifest 内嵌）保留原始 JSON（export_*）", () => {
    const raw = JSON.stringify({
      path: "C:/out/report.docx",
      spec: { title: "报告", children: [{ type: "h1", text: "一" }] },
      overwrite: true,
    });
    expect(extractToolCallArgs(raw)).toBe(raw);
    const raw2 = JSON.stringify({ message: "fix", paths: ["a.rs", "b.rs"] });
    expect(extractToolCallArgs(raw2)).toBe(raw2);
  });

  it("未知单字符串字段兜底拼 key=value", () => {
    expect(extractToolCallArgs(JSON.stringify({ foo: "bar" }))).toBe("foo=bar");
  });

  it("空对象与空串返回空", () => {
    expect(extractToolCallArgs("{}")).toBe("");
    expect(extractToolCallArgs("")).toBe("");
  });
});

describe("createStructuredOutputFilter", () => {
  it("普通文本原样累积显示", () => {
    const filter = createStructuredOutputFilter();
    expect(filter.append("Hello ")).toBe("Hello ");
    expect(filter.append("world")).toBe("Hello world");
    expect(filter.getVisibleText()).toBe("Hello world");
  });

  it("检测到 <omni_memory> 起始后停止追加，保留标签前文本", () => {
    const filter = createStructuredOutputFilter();
    filter.append("已完成修改。");
    expect(filter.append("\n<omni_memory>[]</omni_memory>")).toBe("已完成修改。");
    expect(filter.getVisibleText()).toBe("已完成修改。");
  });

  it("标签跨 chunk 到达也能正确截断", () => {
    const filter = createStructuredOutputFilter();
    filter.append("正文");
    filter.append("<omni_");
    filter.append('summary>{"title":"x"}</omni_summary>');
    expect(filter.getVisibleText()).toBe("正文");
  });

  it("进入结构化块后追加的后续 chunk 不再污染可见文本", () => {
    const filter = createStructuredOutputFilter();
    filter.append("前文");
    filter.append(" <omni_memory>[]</omni_memory>");
    filter.append(" 不应出现 ");
    expect(filter.getVisibleText()).toBe("前文");
  });
});

describe("内置工具对所有模型/会话公用", () => {
  it("buildChatTools(null) 暴露全部内置工具，不受项目限制", () => {
    const tools = buildChatTools(null);
    const ids = new Set(tools.map((t) => t.name));
    expect(ids.size).toBe(BUILTIN_TOOL_IDS.length);
    for (const id of BUILTIN_TOOL_IDS) expect(ids.has(id)).toBe(true);
  });

  it("绑定项目时仍暴露全部内置工具，并叠加项目额外启用的工具", () => {
    const project = { allowedToolIds: ["export_docx"] } as unknown as Project;
    const ids = new Set(buildChatTools(project).map((t) => t.name));
    for (const id of BUILTIN_TOOL_IDS) expect(ids.has(id)).toBe(true);
    expect(ids.has("export_docx")).toBe(true);
  });

  it("resolveEnabledToolNames 在无项目会话也列出内置工具（英文标题）", () => {
    const { toolNames } = resolveEnabledToolNames(null);
    expect(toolNames).toContain("Search Sessions");
    expect(toolNames).toContain("Read File");
    expect(toolNames).toContain("Web Search");
  });
});

describe("buildExpertAgentHint（agent 工具的动态专家名册）", () => {
  it("无项目绑定时列出全部可用专家（含内置）", () => {
    const hint = buildExpertAgentHint(null);
    expect(hint).toContain("AVAILABLE EXPERTS");
    expect(hint).toContain("dev-expert");
  });

  it("agent 工具描述自动追加专家名册", () => {
    const agentTool = buildChatTools(null).find((t) => t.name === "agent");
    expect(agentTool).toBeDefined();
    expect(agentTool!.description).toContain("AVAILABLE EXPERTS");
  });

  it("项目绑定专家时只暴露绑定集；绑定的专家不存在则回退到无专家提示", () => {
    const bound = { boundExpertIds: ["dev-expert"] } as unknown as Project;
    const hint = buildExpertAgentHint(bound);
    expect(hint).toContain("dev-expert");
    expect(hint).not.toContain("writer-expert");

    const boundMissing = { boundExpertIds: ["ghost-expert"] } as unknown as Project;
    expect(buildExpertAgentHint(boundMissing)).toContain("none available");
  });
});
