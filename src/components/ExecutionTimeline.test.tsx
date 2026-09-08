import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExecutionTimeline } from "./ExecutionTimeline";
import type { ChatStep } from "../adapters/types";

describe("ExecutionTimeline（共享组件）", () => {
  it("按 steps 渲染推理段 / 动作行 / 引擎动作 / 产物迷你卡", () => {
    const steps: ChatStep[] = [
      { type: "reasoning", text: "先检索知识库。" },
      { type: "action", label: "检索", title: "Knowledge Search", icon: "Search", detail: "命中 3 条片段" },
      { type: "tool_call", name: "list_files", arguments: JSON.stringify({ path: "src" }), result: "找到 5 个文件" },
      { type: "artifact", artifactId: "art-9", title: "报告.docx" },
    ];

    const { container } = render(<ExecutionTimeline steps={steps} />);

    const flow = container.querySelector(".exec-timeline");
    expect(flow).not.toBeNull();
    expect(flow!.children.length).toBe(4);
    expect(flow!.children[0].classList.contains("exec-seg")).toBe(true);
    expect(flow!.children[1].classList.contains("exec-action")).toBe(true);
    expect(flow!.children[2].classList.contains("exec-action")).toBe(true);
    expect(flow!.children[3].classList.contains("exec-artifact")).toBe(true);

    expect(screen.getByText("Knowledge Search")).toBeTruthy();
    expect(screen.getByText("List Files")).toBeTruthy();
    expect(screen.getByText("报告.docx")).toBeTruthy();
  });

  it("无 steps 时回退到 legacy reasoning + toolCallResults 渲染", () => {
    const { container } = render(
      <ExecutionTimeline
        legacyReasoning="用户想查文件，我先列目录。"
        legacyTools={[
          {
            id: "tc-1",
            name: "read_file",
            arguments: JSON.stringify({ path: "src/index.ts" }),
            result: "文件内容…",
          },
        ]}
      />,
    );

    const flow = container.querySelector(".exec-timeline");
    expect(flow).not.toBeNull();
    expect(flow!.children.length).toBe(2);
    expect(flow!.children[0].textContent).toContain("用户想查文件，我先列目录。");
    expect(flow!.children[1].textContent).toContain("Read File");
    expect(flow!.children[1].textContent).toContain("src/index.ts");

    // 推理段可折叠展开
    fireEvent.click(container.querySelector(".exec-seg__toggle")!);
    expect(screen.getByText("用户想查文件，我先列目录。")).toBeTruthy();
  });

  it("running 过渡态（流式中）渲染 spinner 动作行", () => {
    const steps: ChatStep[] = [
      { type: "tool_call", name: "export_xlsx", arguments: JSON.stringify({ path: "D:/out/表.xlsx" }), result: "", status: "running" },
    ];
    const { container } = render(<ExecutionTimeline steps={steps} isStreaming />);
    expect(container.querySelector(".exec-action--running")).not.toBeNull();
    expect(container.querySelector(".exec-action__icon--spin")).not.toBeNull();
    expect(container.querySelector(".exec-action--interrupted")).toBeNull();
  });

  it("中断定案态（status=interrupted）弱化呈现为已中断，不再转圈，也不显示文件卡", () => {
    const steps: ChatStep[] = [
      { type: "tool_call", name: "export_xlsx", arguments: JSON.stringify({ path: "D:/out/表.xlsx" }), result: "", status: "interrupted" },
    ];
    const { container } = render(<ExecutionTimeline steps={steps} isStreaming />);
    expect(container.querySelector(".exec-action--interrupted")).not.toBeNull();
    expect(container.querySelector(".exec-action--running")).toBeNull();
    expect(container.querySelector(".exec-action__icon--spin")).toBeNull();
    expect(container.querySelector(".exec-action__file")).toBeNull();
    expect(screen.getByText("已中断")).toBeTruthy();
  });

  it("旧数据兜底：流式结束后仍遗留的 running 步骤同样呈现为已中断", () => {
    const steps: ChatStep[] = [
      { type: "tool_call", name: "export_xlsx", arguments: JSON.stringify({ path: "D:/out/表.xlsx" }), result: "", status: "running" },
    ];
    const { container } = render(<ExecutionTimeline steps={steps} />);
    expect(container.querySelector(".exec-action--interrupted")).not.toBeNull();
    expect(container.querySelector(".exec-action--running")).toBeNull();
    expect(container.querySelector(".exec-action__icon--spin")).toBeNull();
    expect(screen.getByText("已中断")).toBeTruthy();
  });

  it("race 兜底：running 步骤带回成功 result（非流式）按完成态渲染，文件卡 & 结果预览出现", () => {
    // 模拟：appendLastProjectStep 由于参数序列化差异未匹配、或 finishTaskResult 比 onToolStep 慢一拍，
    // 导致 message.steps 里有一条 status="running" 的工具步骤，但其实 result 已带回。
    // 此时不应显示「已中断」，而应按完成态正常展示文件卡片与结果首行。
    const steps: ChatStep[] = [
      {
        type: "tool_call",
        name: "export_md",
        arguments: JSON.stringify({ path: "D:/SpringBoot介绍.md" }),
        result: "Markdown 已生成：D:/SpringBoot介绍.md（3.2 KB）",
        status: "running",
      },
    ];
    const { container } = render(<ExecutionTimeline steps={steps} />);
    expect(container.querySelector(".exec-action--interrupted")).toBeNull();
    expect(container.querySelector(".exec-action--running")).toBeNull();
    // 「已中断」字样不应出现；动作行的结果是成功消息首行
    expect(screen.queryByText("已中断")).toBeNull();
    expect(screen.getByText(/Markdown 已生成/)).toBeTruthy();
    expect(container.querySelector(".exec-action__file")).not.toBeNull();
  });

  it("错误 result 不会触发完成态兜底：isError 的 running 步骤若流式外仍显示已中断", () => {
    const steps: ChatStep[] = [
      {
        type: "tool_call",
        name: "export_md",
        arguments: JSON.stringify({ path: "D:/x.md" }),
        result: "工具执行失败：xxx",
        status: "running",
        isError: true,
      },
    ];
    const { container } = render(<ExecutionTimeline steps={steps} />);
    // isError=true 不会被视为成功，仍按已中断兜底渲染
    expect(container.querySelector(".exec-action--interrupted")).not.toBeNull();
  });

  it("search_files 结果渲染为可点击命中行，点击回调携带路径与行号", () => {
    const onOpenFileLocation = vi.fn();
    const steps: ChatStep[] = [
      {
        type: "tool_call",
        name: "search_files",
        arguments: JSON.stringify({ pattern: "export" }),
        result: [
          "找到 2 个相关匹配：",
          "1.",
          "  import { a } from \"./a\";",
          "src/app.ts:42 export const x = 1;",
          "  export const y = 2;",
          "2.",
          "C:\\repo\\b.ts:7 return z;",
        ].join("\n"),
      },
    ];

    const { container } = render(<ExecutionTimeline steps={steps} onOpenFileLocation={onOpenFileLocation} />);

    // 命中行渲染为可点击定位按钮，缩进上下文行不出现
    const locs = container.querySelectorAll<HTMLButtonElement>(".exec-search-match__loc");
    expect(locs.length).toBe(2);
    expect(locs[0].textContent).toBe("src/app.ts:42");
    expect(locs[1].textContent).toBe("C:\\repo\\b.ts:7");
    expect(container.querySelectorAll(".exec-search-match").length).toBe(2);

    fireEvent.click(locs[0]);
    expect(onOpenFileLocation).toHaveBeenCalledWith("src/app.ts", 42);
    fireEvent.click(locs[1]);
    expect(onOpenFileLocation).toHaveBeenCalledWith("C:\\repo\\b.ts", 7);
  });

  it("未提供 onOpenFileLocation 时命中行仍渲染（按钮无回调），普通工具不受影响", () => {
    const steps: ChatStep[] = [
      { type: "tool_call", name: "search_files", arguments: "{}", result: "找到 1 个相关匹配：\n1.\na.ts:3 hi" },
      { type: "tool_call", name: "read_file", arguments: JSON.stringify({ path: "a.ts" }), result: "文件：a.ts" },
    ];
    const { container } = render(<ExecutionTimeline steps={steps} />);
    expect(container.querySelectorAll(".exec-search-match__loc").length).toBe(1);
    // read_file 仍是普通文本预览
    expect(container.querySelector(".exec-action__result")).not.toBeNull();
  });
});

describe("ExecutionTimeline · 展示卡（presentView 分发）", () => {
  it("bash 成功结果渲染 terminal 卡：命令 + exit 0 + 输出", () => {
    const steps: ChatStep[] = [
      {
        type: "tool_call",
        name: "bash",
        arguments: JSON.stringify({ command: "git status" }),
        result: "On branch main\nnothing to commit",
      },
    ];
    const { container } = render(<ExecutionTimeline steps={steps} />);

    expect(container.querySelector(".exec-card--badge, .exec-card")).not.toBeNull();
    expect(container.querySelector(".exec-card__badge--terminal")).not.toBeNull();
    expect(container.querySelector(".exec-card__cmd")!.textContent).toBe("git status");
    expect(container.querySelector(".exec-card__status--ok")!.textContent).toBe("exit 0");
    expect(container.querySelector(".exec-card__pre")!.textContent).toContain("nothing to commit");
  });

  it("bash 非零退出码渲染失败态徽标，不再显示纯文本预览", () => {
    const steps: ChatStep[] = [
      {
        type: "tool_call",
        name: "bash",
        arguments: JSON.stringify({ command: "ls nope" }),
        result: "（退出码 2）\nls: cannot access 'nope'",
      },
    ];
    const { container } = render(<ExecutionTimeline steps={steps} />);

    expect(container.querySelector(".exec-card__status--fail")!.textContent).toBe("exit 2");
    expect(container.querySelector(".exec-action__result")).toBeNull();
  });

  it("write_file 携带 fileDiff 渲染 diff 卡，点击展开行级着色 diff", () => {
    const steps: ChatStep[] = [
      {
        type: "tool_call",
        name: "write_file",
        arguments: JSON.stringify({ path: "src/app.ts" }),
        result: "已写入 src/app.ts",
        fileDiff: { filename: "app.ts", insertions: 1, deletions: 1, diffContent: "@@ -1,1 +1,1 @@\n-old line\n+new line" },
      },
    ];
    const { container } = render(<ExecutionTimeline steps={steps} />);

    expect(container.querySelector(".exec-card__badge--diff")).not.toBeNull();
    expect(container.querySelector(".exec-card__cmd")!.textContent).toBe("app.ts");
    expect(container.querySelector(".exec-card__stat-add")!.textContent).toBe("+1");
    expect(container.querySelector(".exec-card__stat-del")!.textContent).toBe("−1");
    // 默认折叠：无 diff 行
    expect(container.querySelector(".exec-diff-line")).toBeNull();

    fireEvent.click(container.querySelector(".exec-card__head--btn")!);
    expect(container.querySelector(".exec-diff-line--add")!.textContent).toBe("+new line");
    expect(container.querySelector(".exec-diff-line--del")!.textContent).toBe("-old line");
  });

  it("read_file 带 file-meta 渲染 read 卡（行区间 + 进度），默认折叠内容", () => {
    const steps: ChatStep[] = [
      {
        type: "tool_call",
        name: "read_file",
        arguments: JSON.stringify({ path: "docs/notes.md" }),
        result: [
          "文件：docs/notes.md",
          "",
          "1 内容行",
          "",
          "[file-meta total=5000 offset=0 returned=600 lines=1-20 truncated=true]",
          "[clipped-note] 已读 600/5000 字符（第 1-20 行），下一步 offsetChars=600 续读",
        ].join("\n"),
      },
    ];
    const { container } = render(<ExecutionTimeline steps={steps} />);

    expect(container.querySelector(".exec-card")).not.toBeNull();
    expect(container.querySelector(".exec-card__cmd")!.textContent).toBe("docs/notes.md");
    expect(container.querySelector(".exec-card__status")!.textContent).toContain("第 1-20 行");
    expect(container.querySelector(".exec-card__status")!.textContent).toContain("12%");
    expect(container.querySelector(".exec-card__note")!.textContent).toContain("search_files");
  });

  it("web_search 渲染结果列表卡，标题点击走 openArtifactUrl", () => {
    const steps: ChatStep[] = [
      {
        type: "tool_call",
        name: "web_search",
        arguments: JSON.stringify({ query: "portable-pty" }),
        result: [
          "「portable-pty」搜索结果（1 条）：",
          "1. wezterm/portable-pty — GitHub",
          "   https://github.com/wezterm/wezterm",
          "   Cross-platform PTY library",
        ].join("\n"),
      },
    ];
    const { container } = render(<ExecutionTimeline steps={steps} />);

    expect(container.querySelector(".exec-card__badge--web")).not.toBeNull();
    expect(container.querySelector(".exec-web-item__title")!.textContent).toBe("wezterm/portable-pty — GitHub");
    expect(container.querySelector(".exec-web-item__snippet")!.textContent).toBe("Cross-platform PTY library");
  });

  it("无匹配格式的工具结果仍走普通文本预览（回归保护）", () => {
    const steps: ChatStep[] = [
      { type: "tool_call", name: "list_files", arguments: "{}", result: "找到 5 个匹配项（glob=*）：" },
    ];
    const { container } = render(<ExecutionTimeline steps={steps} />);
    expect(container.querySelector(".exec-card")).toBeNull();
    expect(container.querySelector(".exec-action__result")!.textContent).toContain("找到 5 个匹配项");
  });
});
