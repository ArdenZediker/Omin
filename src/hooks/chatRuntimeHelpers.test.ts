import { describe, expect, it, afterEach } from "vitest";
import { buildChatTools, buildExpertAgentHint, createStructuredOutputFilter, extractToolCallArgs, resolveEnabledToolNames } from "./chatRuntimeHelpers";
import { BUILTIN_TOOL_IDS } from "../config/manifests/tools";
import type { Project } from "../chat/types";
import { BASIC_SETTINGS_STORAGE_KEY } from "../app/constants";
import { pluginRegistry } from "../plugins/registry";
import type { PluginManifest } from "../plugins/types";

describe("extractToolCallArgs", () => {
  it("纯字符串原样返回", () => {
    expect(extractToolCallArgs('"关键词"')).toBe("关键词");
    expect(extractToolCallArgs("非 JSON 文本")).toBe("非 JSON 文本");
  });

  it("单字段直接返回该字段的值（query / path / sessionId 等单参数工具）", () => {
    expect(extractToolCallArgs(JSON.stringify({ query: "性能优化" }))).toBe("性能优化");
    expect(extractToolCallArgs(JSON.stringify({ path: "src/main.rs" }))).toBe("src/main.rs");
    expect(extractToolCallArgs(JSON.stringify({ sessionId: "chat-1" }))).toBe("chat-1");
  });

  it("单字段为 command（bash）时原样返回完整命令，绝不拼成 command=...", () => {
    const command = 'cd "/c/Users/PengY/Documents/Codex" && find . -type f | head -200';
    // 回归：曾兜底拼成 `command=cd "/c/..." && find ...`——shell 把 `command=cd` 读成
    // 变量赋值，转而把引号内的路径当命令执行 → 退出码 126「Is a directory」。
    expect(extractToolCallArgs(JSON.stringify({ command }))).toBe(command);
    expect(extractToolCallArgs(JSON.stringify({ command: "ls -la /tmp" }))).toBe("ls -la /tmp");
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

  it("未知单字符串字段也直接返回值（不再拼 key=value）", () => {
    // 回归：拼成 `foo=bar` 会让 shell/CLI 把 key 当变量赋值，吞掉真正的首个词。
    expect(extractToolCallArgs(JSON.stringify({ foo: "bar" }))).toBe("bar");
    expect(extractToolCallArgs(JSON.stringify({ url: "https://example.com" }))).toBe(
      "https://example.com",
    );
  });

  it("单字段值为非字符串时保留原始 JSON（交由 execute 侧解析）", () => {
    const raw = JSON.stringify({ limit: 20 });
    expect(extractToolCallArgs(raw)).toBe(raw);
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
  afterEach(() => {
    localStorage.removeItem(BASIC_SETTINGS_STORAGE_KEY);
  });

  // 口径：专家是「本项目可指派的工作角色」，与技能/MCP 的「安装 + 开启即可用」刻意不同 ——
  // 默认只有项目绑定过的专家才进模型的可委派名册。
  it("没绑定专家时名册为空，并说明专家是项目级的", () => {
    expect(buildExpertAgentHint(null)).toContain("none available");
    expect(buildExpertAgentHint(null)).toContain("project-scoped");
    expect(buildExpertAgentHint(null)).not.toContain("AVAILABLE EXPERTS");

    const unbound = { boundExpertIds: [] } as unknown as Project;
    expect(buildExpertAgentHint(unbound)).not.toContain("AVAILABLE EXPERTS");
  });

  it("项目绑定专家时只暴露绑定集；绑定的专家不存在则回退到无专家提示", () => {
    const bound = { boundExpertIds: ["dev-expert"] } as unknown as Project;
    const hint = buildExpertAgentHint(bound);
    expect(hint).toContain("AVAILABLE EXPERTS");
    expect(hint).toContain("dev-expert");
    expect(hint).not.toContain("writer-expert");

    const boundMissing = { boundExpertIds: ["ghost-expert"] } as unknown as Project;
    expect(buildExpertAgentHint(boundMissing)).toContain("none available");
  });

  it("打开「允许模型指派任意专家」后，未绑定项目也能看到全部已启用专家", () => {
    localStorage.setItem(BASIC_SETTINGS_STORAGE_KEY, JSON.stringify({ allowAnyExpertDelegation: true }));
    const hint = buildExpertAgentHint(null);
    expect(hint).toContain("AVAILABLE EXPERTS");
    expect(hint).toContain("dev-expert");
    expect(hint).toContain("writer-expert");
  });

  it("已停用的专家不进名册（listExperts 按 enabled 过滤）", () => {
    const manifest = {
      id: "tmp-expert",
      name: "临时专家",
      description: "",
      version: "0.0.1",
      kind: "expert",
      templatePrompt: "你是临时专家。",
    } as PluginManifest;
    pluginRegistry.install(manifest, { type: "local", path: "tmp" });
    try {
      expect(pluginRegistry.listExperts().some((m) => m.id === "tmp-expert")).toBe(true);
      pluginRegistry.setEnabled("tmp-expert", false);
      expect(pluginRegistry.listExperts().some((m) => m.id === "tmp-expert")).toBe(false);
    } finally {
      pluginRegistry.uninstall("tmp-expert");
    }
  });

  it("agent 工具描述自动追加专家名册（未绑定项目时为兜底文案）", () => {
    const agentTool = buildChatTools(null).find((t) => t.name === "agent");
    expect(agentTool).toBeDefined();
    expect(agentTool!.description).toContain("none available");
  });
});
