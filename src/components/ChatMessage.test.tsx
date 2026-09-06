import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ChatMessage, { buildUserMessageSegments } from "./ChatMessage";
import type { Message } from "../adapters/types";

describe("buildUserMessageSegments（按光标位置排布附件）", () => {
  const att = (path: string, offset?: number) => ({ path, name: path, size: null, offset });

  it("无附件时只返回整段正文", () => {
    expect(buildUserMessageSegments("abc", [])).toEqual([{ kind: "text", text: "abc" }]);
  });

  it("光标在文字前（offset=0）：附件排在正文之前", () => {
    const segments = buildUserMessageSegments("abc", [att("a.png", 0)]);
    expect(segments[0]).toMatchObject({ kind: "attachment" });
    expect(segments[1]).toEqual({ kind: "text", text: "abc" });
  });

  it("光标在文字后（offset=末尾）：附件排在正文之后", () => {
    const segments = buildUserMessageSegments("abc", [att("a.png", 3)]);
    expect(segments[0]).toEqual({ kind: "text", text: "abc" });
    expect(segments[1]).toMatchObject({ kind: "attachment" });
  });

  it("光标在文字中间：正文被切成两段，附件插在中间", () => {
    const segments = buildUserMessageSegments("abcd", [att("a.png", 2)]);
    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual({ kind: "text", text: "ab" });
    expect(segments[1]).toMatchObject({ kind: "attachment" });
    expect(segments[2]).toEqual({ kind: "text", text: "cd" });
  });

  it("多个附件按 offset 升序排列，同 offset 保持原始顺序", () => {
    const segments = buildUserMessageSegments("abcdef", [att("b.png", 4), att("a.png", 2), att("c.png", 2)]);
    expect(
      segments.map((s) =>
        s.kind === "attachment" ? s.attachment.name : s.kind === "image" ? (s.image.name ?? "") : s.text,
      ),
    ).toEqual(["ab", "a.png", "c.png", "cd", "b.png", "ef"]);
  });

  it("offset 缺省（旧数据）视为 0，且超出正文长度时被夹紧到末尾", () => {
    expect(buildUserMessageSegments("abc", [att("legacy.png")])[0]).toMatchObject({ kind: "attachment" });
    const clamped = buildUserMessageSegments("abc", [att("far.png", 999)]);
    expect(clamped[0]).toEqual({ kind: "text", text: "abc" });
    expect(clamped[1]).toMatchObject({ kind: "attachment" });
  });

  it("图片按光标 offset 交错，光标在文字后时图片排在正文之后", () => {
    const segments = buildUserMessageSegments("abc", [], [{ src: "data:img1", offset: 3 }]);
    expect(segments[0]).toEqual({ kind: "text", text: "abc" });
    expect(segments[1]).toMatchObject({ kind: "image", image: { src: "data:img1" } });
  });

  it("图片与附件按各自 offset 合并排序，offset 相同则附件先于图片（稳定）", () => {
    const segments = buildUserMessageSegments(
      "abcdef",
      [att("a.png", 2)],
      [{ src: "data:img1", offset: 2 }, { src: "data:img2", offset: 4 }],
    );
    expect(
      segments.map((s) =>
        s.kind === "attachment" ? `att:${s.attachment.name}` : s.kind === "image" ? `img:${s.image.src}` : `txt:${s.text}`,
      ),
    ).toEqual(["txt:ab", "att:a.png", "img:data:img1", "txt:cd", "img:data:img2", "txt:ef"]);
  });
});

describe("ChatMessage", () => {
  it("工具结果消息不单独渲染（已合并到 assistant 的思考块）", () => {
    const { container } = render(
      <ChatMessage
        message={{ role: "tool", content: "工具输出", toolCallId: "tc-1", toolCallName: "list_files" }}
        index={1}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("assistant 消息的思考块展示推理字数与工具调用步骤", () => {
    const message: Message = {
      role: "project",
      content: "已找到相关文件，下面给出说明。",
      reasoning: "用户想查文件，我先列目录看看有什么。",
      toolCallResults: [
        {
          id: "tc-1",
          name: "list_files",
          arguments: JSON.stringify({ path: "D:/proj" }),
          result: "找到 12 个项目：\n1. [目录] D:/proj/src",
        },
        {
          id: "tc-2",
          name: "read_file",
          arguments: JSON.stringify({ path: "src/index.tsx" }),
          result: "文件：src/index.tsx\n\nimport React ...",
        },
        {
          id: "tc-3",
          name: "search_files",
          arguments: JSON.stringify({ keyword: "Hook" }),
          result: "",
          isError: true,
        },
      ],
    };

    const { container } = render(<ChatMessage message={message} index={2} />);

    // 折叠态：默认收起，只显示标题与箭头
    expect(screen.getByText("深度思考")).toBeTruthy();

    // 展开后展示推理文本与三个工具步骤
    fireEvent.click(container.querySelector(".message-reasoning__toggle")!);

    expect(screen.getByText("用户想查文件，我先列目录看看有什么。")).toBeTruthy();
    expect(screen.getByText("List Files")).toBeTruthy();
    expect(screen.getByText("Read File")).toBeTruthy();
    expect(screen.getByText("Search Files")).toBeTruthy();
    expect(screen.getByText("D:/proj")).toBeTruthy();
    expect(screen.getByText("src/index.tsx")).toBeTruthy();
    expect(screen.getByText("找到 12 个项目：")).toBeTruthy();
    expect(screen.getByText("文件：src/index.tsx")).toBeTruthy();

    // 错误步骤有独立错误样式标记
    const errorStep = document.querySelector(".exec-action--error");
    expect(errorStep).not.toBeNull();
  });

  it("assistant 消息无思考内容时也始终显示思考块（空状态有 '未触发深度推理' 提示）", () => {
    render(
      <ChatMessage
        message={{ role: "project", content: "普通回答。" }}
        index={3}
      />,
    );
    // 始终展示 UI 元素，确保用户能看到「深度思考」入口
    expect(screen.getByText("深度思考")).toBeTruthy();
    // 折叠态标题行不显示摘要，空状态提示在展开后才出现
    fireEvent.click(screen.getByRole("button", { name: /深度思考/ }));
    expect(screen.getByText(/本次回答未使用推理模型或工具调用/)).toBeTruthy();
  });

  it("按 steps 顺序交错渲染（reasoning → tool_call → reasoning），实现 WorkBuddy 式深度思考视图", () => {
    const message: Message = {
      role: "project",
      content: "已完成查询。",
      steps: [
        { type: "reasoning", text: "用户想知道项目里有什么类型的组件，我先列文件看看。" },
        {
          type: "tool_call",
          name: "list_files",
          arguments: JSON.stringify({ path: "src/components" }),
          result: "找到 8 个组件：\n1. [文件] ChatMessage.tsx",
        },
        { type: "reasoning", text: "看到了，现在读一下 ChatMessage 来分析结构。" },
        {
          type: "tool_call",
          name: "read_file",
          arguments: JSON.stringify({ path: "src/components/ChatMessage.tsx" }),
          result: "import React ...",
          isError: false,
        },
      ],
    };

    const { container } = render(<ChatMessage message={message} index={4} />);

    // 点击外层「深度思考」开关展开时间线
    fireEvent.click(container.querySelector(".message-reasoning__toggle")!);

    const flow = container.querySelector(".exec-timeline");
    expect(flow).not.toBeNull();

    const segments = flow!.children;
    // 4 段：reasoning / tool_call / reasoning / tool_call
    expect(segments.length).toBe(4);

    // 顺序与类型断言：第一段是 reasoning 段，第二段是动作行，第三段是 reasoning 段，第四段是动作行
    expect(segments[0].classList.contains("exec-seg")).toBe(true);
    expect(segments[0].textContent).toContain("用户想知道项目里有什么类型的组件");
    expect(segments[1].classList.contains("exec-action")).toBe(true);
    expect(segments[1].textContent).toContain("List Files");
    expect(segments[1].textContent).toContain("src/components");
    expect(segments[2].classList.contains("exec-seg")).toBe(true);
    expect(segments[2].textContent).toContain("看到了，现在读一下");
    expect(segments[3].classList.contains("exec-action")).toBe(true);
    expect(segments[3].textContent).toContain("Read File");
    expect(segments[3].textContent).toContain("ChatMessage.tsx");
  });

  it("artifact step 渲染为可点击的产物迷你卡片，点击发出「在产物面板打开」事件", () => {
    const message: Message = {
      role: "project",
      content: "已导出文档。",
      steps: [
        {
          type: "tool_call",
          name: "export_docx",
          arguments: JSON.stringify({ path: "D:/out/周报.docx", topic: "周报" }),
          result: "已导出 D:/out/周报.docx",
        },
        { type: "artifact", artifactId: "art-1", title: "周报.docx" },
      ],
    };

    const { container } = render(<ChatMessage message={message} index={5} />);
    fireEvent.click(container.querySelector(".message-reasoning__toggle")!);

    const row = container.querySelector(".exec-artifact");
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain("周报.docx");
    expect(row!.textContent).toContain("在产物面板打开");

    let openedArtifactId: string | null = null;
    const handler = (event: Event) => {
      openedArtifactId = (event as CustomEvent).detail.artifactId;
    };
    window.addEventListener("omni:open-artifact", handler);
    try {
      fireEvent.click(row!);
    } finally {
      window.removeEventListener("omni:open-artifact", handler);
    }
    expect(openedArtifactId).toBe("art-1");
  });

  it("running 过渡态步骤（流式中）渲染为 spinner 动作行，且不显示文件卡片与结果", () => {
    const message: Message = {
      role: "project",
      content: "",
      steps: [
        {
          type: "tool_call",
          name: "export_docx",
          arguments: JSON.stringify({ path: "D:/out/周报.docx", topic: "周报" }),
          result: "",
          status: "running",
        },
      ],
    };

    const { container } = render(<ChatMessage message={message} index={6} isStreaming />);

    // 展开思考块（挂载即流式时不会自动展开，仅响应 false→true 变化），running 步骤以 spinner 呈现
    fireEvent.click(container.querySelector(".message-reasoning__toggle")!);
    const row = container.querySelector(".exec-action--running");
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain("正在导出");
    expect(row!.textContent).toContain("Export Word");
    // running 态不显示「已导出」文件卡片与结果预览
    expect(container.querySelector(".exec-action__file")).toBeNull();
    expect(container.querySelector(".exec-action__result")).toBeNull();
  });

  it("中断消息（遗留 running / 定案 interrupted）收起摘要改「已中断」，展开后动作行弱化呈现", () => {
    const message: Message = {
      role: "project",
      content: "中途被你停止了。",
      steps: [
        { type: "reasoning", text: "先导出文档，再生成图表。" },
        {
          type: "tool_call",
          name: "export_docx",
          arguments: JSON.stringify({ path: "D:/out/周报.docx", topic: "周报" }),
          result: "",
          status: "interrupted",
        },
      ],
    };

    const { container } = render(<ChatMessage message={message} index={6} />);

    // 未展开：收起摘要前缀为「已中断」，不再谎称「已完成」
    expect(screen.getByText(/已中断/)).toBeTruthy();
    expect(screen.queryByText(/已完成/)).toBeNull();

    fireEvent.click(container.querySelector(".message-reasoning__toggle")!);

    const row = container.querySelector(".exec-action--interrupted");
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain("已中断");
    expect(row!.textContent).toContain("Export Word");
    // 中断态不显示文件卡片与结果
    expect(container.querySelector(".exec-action__file")).toBeNull();
    expect(container.querySelector(".exec-action__result")).toBeNull();
    expect(container.querySelector(".exec-action--running")).toBeNull();
  });

  it("race 兜底：running 步骤带回成功 result（非流式）摘要显示「已完成」而非「已中断」", () => {
    // 模拟：appendLastProjectStep 因参数序列化差异未匹配、或 onToolStep 比 finishTaskResult 慢一拍，
    // 导致 message.steps 里残留一条 status="running" 的工具步骤，但 result 已带回成功信息。
    // 这种情况下 ThinkingBlock 的收起摘要不应标「已中断」（毕竟是成功生成）。
    const message: Message = {
      role: "project",
      content: "已生成并保存完成。",
      steps: [
        { type: "reasoning", text: "导出 SpringBoot 介绍。" },
        {
          type: "tool_call",
          name: "export_md",
          arguments: JSON.stringify({ path: "D:/SpringBoot介绍.md" }),
          result: "Markdown 已生成：D:/SpringBoot介绍.md（3.2 KB）",
          status: "running",
        },
      ],
    };

    render(<ChatMessage message={message} index={9} />);

    // 应显示「已完成」而不是「已中断」——该 running 步骤的 result 是成功结果
    expect(screen.queryByText(/已中断/)).toBeNull();
    expect(screen.getByText(/已完成/)).toBeTruthy();
  });

  it("race 兜底：带成功 result 的 running file-producing 步骤让「查看所有变更」按钮仍可见", () => {
    // 模拟：onToolStep 比 finishTaskResult 慢一拍、或 appendLastProjectStep 因 arguments 微差未匹配，
    // message.steps 里遗留一条 status="running" 但 result 已带回成功内容 + 是 file-producing tool 的步骤。
    // ThinkingBlock 摘要会按 isResolvedAsSuccess 显示「已完成」，
    // 同样的兜底也要落到 changeEntries 上——避免 footer 区的「查看所有变更」按钮消失。
    const message: Message = {
      role: "project",
      content: "已生成并保存完成。",
      steps: [
        { type: "reasoning", text: "把调研报告导出到 Documents/Omni。" },
        {
          type: "tool_call",
          name: "export_md",
          arguments: JSON.stringify({ path: "C:/Users/PengY/Documents/Omni/调研报告 v1.md" }),
          result: "Markdown 已生成：C:/Users/PengY/Documents/Omni/调研报告 v1.md（4.2 KB）",
          status: "running",
        },
      ],
    };

    const { container } = render(<ChatMessage message={message} index={10} />);

    // 摘要应显示「已完成」（与 stepSettlement.isResolvedAsSuccess 一致）
    expect(screen.getByText(/已完成/)).toBeTruthy();
    // 「查看所有变更 (1)」应可见——不能让 race 兜底只覆盖摘要、不覆盖 footer
    expect(screen.getByText("查看所有变更 (1)")).toBeTruthy();
    expect(container.querySelector(".message-aggregate__link")).not.toBeNull();
  });

  it("race 兜底：带失败 result 的 running 步骤不进 changeEntries（不会谎报变更）", () => {
    // 失败 result 不算成功；不通过 isResolvedAsSuccess 兜底——避免把错误步骤包装成完成。
    const message: Message = {
      role: "project",
      content: "导出失败。",
      steps: [
        {
          type: "tool_call",
          name: "export_md",
          arguments: JSON.stringify({ path: "D:/out/周报.md" }),
          result: "写入失败：磁盘空间不足",
          isError: true,
          status: "running",
        },
      ],
    };

    render(<ChatMessage message={message} index={11} />);

    // 错误步骤不进 changeEntries，所以 footer 不该有「查看所有变更」按钮
    expect(screen.queryByText(/查看所有变更/)).toBeNull();
  });

  it("action 步骤（引擎级动作如知识检索）渲染为动作行，不再误判为空态", () => {
    const message: Message = {
      role: "project",
      content: "基于知识库回答。",
      steps: [
        { type: "action", label: "检索", title: "Knowledge Search", icon: "Search", detail: "「测试」命中 3 条知识片段" },
      ],
    };

    const { container } = render(<ChatMessage message={message} index={7} />);

    // 有动作步骤时不应显示空态提示
    expect(screen.queryByText(/本次回答未使用推理模型或工具调用/)).toBeNull();

    fireEvent.click(container.querySelector(".message-reasoning__toggle")!);
    const row = container.querySelector(".exec-action");
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain("检索");
    expect(row!.textContent).toContain("Knowledge Search");
    expect(row!.textContent).toContain("命中 3 条知识片段");
  });
});