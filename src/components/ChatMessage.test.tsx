import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ChatMessage from "./ChatMessage";
import type { Message } from "../adapters/types";

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

    render(<ChatMessage message={message} index={2} />);

    // 折叠态：默认收起，只显示摘要
    expect(screen.getByText("思考过程")).toBeTruthy();
    expect(screen.getByText(/字思考.*个工具/)).toBeTruthy();

    // 展开后展示推理文本与三个工具步骤
    fireEvent.click(screen.getByRole("button", { name: /思考过程/ }));

    expect(screen.getByText("用户想查文件，我先列目录看看有什么。")).toBeTruthy();
    expect(screen.getByText("列出文件")).toBeTruthy();
    expect(screen.getByText("读取文件")).toBeTruthy();
    expect(screen.getByText("搜索文件")).toBeTruthy();
    expect(screen.getByText("D:/proj")).toBeTruthy();
    expect(screen.getByText("src/index.tsx")).toBeTruthy();
    expect(screen.getByText("找到 12 个项目：")).toBeTruthy();
    expect(screen.getByText("文件：src/index.tsx")).toBeTruthy();

    // 错误步骤有独立错误样式标记
    const errorStep = document.querySelector(".message-reasoning__step--error");
    expect(errorStep).not.toBeNull();
  });

  it("assistant 消息无思考内容时也始终显示思考块（空状态有 '未触发深度推理' 提示）", () => {
    render(
      <ChatMessage
        message={{ role: "project", content: "普通回答。" }}
        index={3}
      />,
    );
    // 始终展示 UI 元素，确保用户能看到「思考过程」入口
    expect(screen.getByText("思考过程")).toBeTruthy();
    expect(screen.getByText("未触发深度推理")).toBeTruthy();
    // 默认折叠：body 不在 DOM 中（展开后才出现）
    expect(screen.queryByText("本次回答未使用推理模型或工具调用")).toBeNull();
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

    // 摘要包含 reasoning 字数（两段求和）与工具数
    fireEvent.click(screen.getByRole("button", { name: /思考过程/ }));

    const flow = container.querySelector(".message-reasoning__flow");
    expect(flow).not.toBeNull();

    const segments = flow!.children;
    // 4 段：reasoning / tool_call / reasoning / tool_call
    expect(segments.length).toBe(4);

    // 顺序与类型断言：第一段是 reasoning pre，第二段是 tool step，第三段是 reasoning pre，第四段是 tool step
    expect(segments[0].classList.contains("message-reasoning__text--segment")).toBe(true);
    expect(segments[0].textContent).toContain("用户想知道项目里有什么类型的组件");
    expect(segments[1].classList.contains("message-reasoning__step")).toBe(true);
    expect(segments[1].textContent).toContain("列出文件");
    expect(segments[1].textContent).toContain("src/components");
    expect(segments[2].classList.contains("message-reasoning__text--segment")).toBe(true);
    expect(segments[2].textContent).toContain("看到了，现在读一下");
    expect(segments[3].classList.contains("message-reasoning__step")).toBe(true);
    expect(segments[3].textContent).toContain("读取文件");
    expect(segments[3].textContent).toContain("ChatMessage.tsx");
  });
});