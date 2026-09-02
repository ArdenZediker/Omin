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

  it("assistant 消息无思考内容时不显示思考块", () => {
    render(
      <ChatMessage
        message={{ role: "project", content: "普通回答。" }}
        index={3}
      />,
    );
    expect(screen.queryByText("思考过程")).toBeNull();
  });
});