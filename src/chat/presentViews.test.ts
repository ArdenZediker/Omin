// presentViews 纯函数测试：从 ChatStep 已持久化字段推导展示卡视图。
// 全部输入模拟 localTools 真实 outputText 组装格式（含历史消息兼容场景）。
import { describe, expect, it } from "vitest";
import {
  inferPresentView,
  parseDiffLines,
  stripClippedNote,
  MAX_READ_PREVIEW_CHARS,
} from "./presentViews";

describe("stripClippedNote", () => {
  it("无标记时原样返回", () => {
    expect(stripClippedNote("普通输出\n第二行")).toEqual({ text: "普通输出\n第二行", clipped: false });
  });

  it("剥离末尾 [clipped-note] 块并标记截断", () => {
    const { text, clipped } = stripClippedNote("正文输出\n[clipped-note] 已读 600/5000 字符，offsetChars=2200 续读");
    expect(text).toBe("正文输出");
    expect(clipped).toBe(true);
  });
});

describe("inferPresentView · terminal（/bash）", () => {
  it("成功命令：exit 0 + 输出正文", () => {
    const view = inferPresentView("bash", JSON.stringify({ command: "git status" }), "On branch main\nnothing to commit");
    expect(view).toMatchObject({
      kind: "terminal",
      command: "git status",
      exitCode: null,
      timedOut: false,
      shellReset: false,
      clipped: false,
      output: "On branch main\nnothing to commit",
    });
  });

  it("非零退出码：解析（退出码 N）前缀", () => {
    const view = inferPresentView("bash", JSON.stringify({ command: "ls nope" }), "（退出码 2）\nls: cannot access 'nope': No such file");
    expect(view).toMatchObject({ kind: "terminal", exitCode: 2, output: "ls: cannot access 'nope': No such file" });
  });

  it("持久会话超时：timedOut=true 且不误报退出码", () => {
    const view = inferPresentView(
      "bash",
      JSON.stringify({ command: "sleep 999" }),
      "（命令超时，持久会话仍存活；长命令可在末尾加 \" &\" 转后台，稍后用 echo $! / jobs 查询）\n部分输出...",
    );
    expect(view).toMatchObject({ kind: "terminal", timedOut: true, exitCode: null, output: "部分输出..." });
  });

  it("自动重置 + 退出码 + 截断注记三层前缀全解析", () => {
    const view = inferPresentView(
      "bash",
      JSON.stringify({ command: "make all" }),
      "（持久 shell 已自动重置：旧会话已失效，本次在全新会话中执行，cwd/环境变量回到初始状态）\n（退出码 2）\nerror: boom\n[clipped-note] 输出超限，用 head/tail/grep 提取",
    );
    expect(view).toMatchObject({
      kind: "terminal",
      shellReset: true,
      exitCode: 2,
      clipped: true,
      output: "error: boom",
    });
  });

  it("成功无输出占位文案归一为空串", () => {
    const view = inferPresentView("bash", JSON.stringify({ command: "cd ." }), "（命令执行成功，无输出）");
    expect(view).toMatchObject({ kind: "terminal", output: "" });
  });

  it("带 shellReset 标记的成功命令输出前缀被剥离", () => {
    const view = inferPresentView("bash", JSON.stringify({ command: "pwd" }), "（持久 shell 已自动重置：旧会话已失效，本次在全新会话中执行，cwd/环境变量回到初始状态）\n/d/repo");
    expect(view).toMatchObject({ kind: "terminal", shellReset: true, output: "/d/repo" });
  });
});

describe("inferPresentView · read（/read_file）", () => {
  const readResult = [
    "文件：src/app.ts",
    "",
    "1 import x",
    "2 const y = 1",
    "",
    "[file-meta total=5000 offset=1600 returned=600 lines=41-47 truncated=true]",
    "[clipped-note] 已读 600/5000 字符（第 41-47 行），下一步 offsetChars=2200 续读",
  ].join("\n");

  it("解析路径/行区间/进度/截断与正文", () => {
    const view = inferPresentView("read_file", JSON.stringify({ path: "src/app.ts" }), readResult);
    expect(view).toMatchObject({
      kind: "read",
      path: "src/app.ts",
      lineFrom: 41,
      lineTo: 47,
      returned: 600,
      total: 5000,
      truncated: true,
      clipped: true,
    });
    expect(view?.kind === "read" && view.content).toBe("1 import x\n2 const y = 1");
  });

  it("无 file-meta 的旧格式回落 null（走普通文本预览）", () => {
    expect(inferPresentView("read_file", "{}", "文件内容…")).toBeNull();
  });
});

describe("inferPresentView · web", () => {
  it("web_search：解析编号列表为结果项", () => {
    const result = [
      "「portable-pty」搜索结果（2 条）：",
      "1. wezterm/portable-pty — GitHub",
      "   https://github.com/wezterm/wezterm",
      "   Cross-platform PTY library",
      "2. docs.rs portable-pty 0.9.0",
      "   https://docs.rs/portable-pty/0.9.0",
      "   Allocate a pseudo terminal",
    ].join("\n");
    const view = inferPresentView("web_search", JSON.stringify({ query: "portable-pty" }), result);
    expect(view).toEqual({
      kind: "web",
      mode: "search",
      source: "portable-pty",
      clipped: false,
      items: [
        { title: "wezterm/portable-pty — GitHub", url: "https://github.com/wezterm/wezterm", snippet: "Cross-platform PTY library" },
        { title: "docs.rs portable-pty 0.9.0", url: "https://docs.rs/portable-pty/0.9.0", snippet: "Allocate a pseudo terminal" },
      ],
    });
  });

  it("web_fetch：解析标题/地址为单项卡片", () => {
    const view = inferPresentView("web_fetch", JSON.stringify({ url: "https://example.com" }), "标题：Example Domain\n地址：https://example.com\n\n正文……");
    expect(view).toEqual({
      kind: "web",
      mode: "fetch",
      source: "https://example.com",
      clipped: false,
      items: [{ title: "Example Domain", url: "https://example.com", snippet: "" }],
    });
  });
});

describe("inferPresentView · diff（fileDiff）", () => {
  it("带 fileDiff 的写文件步骤推导 diff 视图", () => {
    const view = inferPresentView(
      "edit_file",
      JSON.stringify({ path: "src/app.ts" }),
      "已修改 src/app.ts",
      { filename: "app.ts", insertions: 5, deletions: 2, diffContent: "@@ -1,2 +1,5 @@\n-old\n+new" },
    );
    expect(view).toEqual({
      kind: "diff",
      filename: "app.ts",
      insertions: 5,
      deletions: 2,
      diffContent: "@@ -1,2 +1,5 @@\n-old\n+new",
    });
  });

  it("无 diffContent 的 fileDiff 不推导", () => {
    expect(
      inferPresentView("edit_file", "{}", "ok", { filename: "a.ts", insertions: 0, deletions: 0, diffContent: "" }),
    ).toBeNull();
  });
});

describe("parseDiffLines", () => {
  it("按行分类 add/del/hunk/ctx，+++ / --- 头不算增删", () => {
    const { lines, omitted } = parseDiffLines("--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-old\n+new\n ctx");
    expect(omitted).toBe(0);
    expect(lines.map((l) => l.type)).toEqual(["ctx", "ctx", "hunk", "del", "add", "ctx"]);
  });

  it("超过 400 行截断并返回省略数", () => {
    const big = Array.from({ length: 450 }, (_, i) => `+line${i}`).join("\n");
    const { omitted } = parseDiffLines(big);
    expect(omitted).toBe(50);
  });
});

describe("MAX_READ_PREVIEW_CHARS", () => {
  it("预览上限为正数（组件据此截断超长内容）", () => {
    expect(MAX_READ_PREVIEW_CHARS).toBeGreaterThan(0);
  });
});
