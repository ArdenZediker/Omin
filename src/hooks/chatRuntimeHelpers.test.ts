import { describe, expect, it } from "vitest";
import { extractToolCallArgs } from "./chatRuntimeHelpers";

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
