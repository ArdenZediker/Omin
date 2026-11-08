import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ChatInput from "./ChatInput";
import type { KnowledgeCollection } from "../chat/knowledgeTypes";

const knowledgeCollections: KnowledgeCollection[] = [
  {
    id: "collection-product",
    name: "产品知识库",
    description: "产品说明与使用规范",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: "collection-contract",
    name: "合同知识库",
    description: "合同模板与审阅规则",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
];

function renderChatInput(onSend = vi.fn(), experts: Parameters<typeof ChatInput>[0]["experts"] = []) {
  render(
    <ChatInput
      knowledgeCollections={knowledgeCollections}
      experts={experts}
      onSend={onSend}
      isLoading={false}
      onStop={vi.fn()}
    />
  );
  return onSend;
}

describe("ChatInput", () => {
  it("点击编辑区右侧空白时仍然聚焦输入框", () => {
    renderChatInput();
    const textarea = screen.getByPlaceholderText("输入聊天内容...");
    const editor = textarea.closest(".chat-composer__editor-wrap");

    expect(editor).not.toBeNull();
    expect(textarea).not.toHaveFocus();
    fireEvent.pointerDown(editor!);
    expect(textarea).toHaveFocus();
  });

  it("生成过程中仍可继续编辑草稿，但不会误发或覆盖正在生成的回答", () => {
    const onSend = vi.fn();
    render(
      <ChatInput
        onSend={onSend}
        isLoading
        onStop={vi.fn()}
      />
    );
    const textarea = screen.getByPlaceholderText("输入聊天内容...");

    expect(textarea).toBeEnabled();
    fireEvent.change(textarea, { target: { value: "补充一点背景" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(textarea).toHaveValue("补充一点背景");
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTitle("停止生成")).toBeInTheDocument();
  });

  it("selects a knowledge collection with @ and sends the collection id without the mention text", () => {
    const onSend = renderChatInput();
    const textarea = screen.getByPlaceholderText("输入聊天内容...");

    fireEvent.change(textarea, {
      target: {
        value: "帮我查一下 @产品",
        selectionStart: 10,
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /@ 产品知识库/ }));
    expect(screen.getByTitle("取消本次知识库选择").parentElement).toHaveClass("chat-composer__status");
    const status = screen.getByTitle("取消本次知识库选择").parentElement!;
    const editor = screen.getByPlaceholderText("输入聊天内容...").parentElement!;
    expect(status.parentElement).toBe(editor);
    expect(editor.querySelector("textarea")).toBe(screen.getByPlaceholderText("输入聊天内容..."));
    fireEvent.change(textarea, {
      target: {
        value: "帮我查一下 定价策略",
        selectionStart: 10,
      },
    });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith("帮我查一下 定价策略", undefined, {
      hiddenContext: undefined,
      knowledgeCollectionId: "collection-product",
      knowledgeCollectionName: "产品知识库",
      expertId: null,
      expertName: null,
      selectedMode: null,
      attachments: undefined,
    });
  });

  it("allows choosing the knowledge collection directly from the composer toolbar", () => {
    renderChatInput();

    fireEvent.click(screen.getByRole("button", { name: "选择知识库" }));
    fireEvent.click(screen.getByRole("button", { name: /产品知识库/ }));

    expect(screen.getByTitle("取消本次知识库选择")).toHaveTextContent("@ 产品知识库");
  });

  it("selects an expert with @ and sends the expert id for role switch", () => {
    const onSend = renderChatInput(vi.fn(), [
      {
        id: "writer-expert",
        name: "写作专家",
        description: "擅长产出文稿",
        version: "1.0.0",
        kind: "expert",
        templatePrompt: "你是写作专家",
      },
    ]);
    const textarea = screen.getByPlaceholderText("输入聊天内容...");

    fireEvent.change(textarea, {
      target: {
        value: "帮我 @写",
        selectionStart: 6,
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /@ 写作专家/ }));
    fireEvent.change(textarea, {
      target: {
        value: "帮我润色这段话",
        selectionStart: 7,
      },
    });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith("帮我润色这段话", undefined, {
      hiddenContext: undefined,
      knowledgeCollectionId: null,
      knowledgeCollectionName: null,
      expertId: "writer-expert",
      expertName: "写作专家",
      selectedMode: null,
      attachments: undefined,
    });
  });
});
