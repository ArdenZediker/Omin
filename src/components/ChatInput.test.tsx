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

function renderChatInput(onSend = vi.fn()) {
  render(
    <ChatInput
      knowledgeCollections={knowledgeCollections}
      onSend={onSend}
      isLoading={false}
      onStop={vi.fn()}
    />
  );
  return onSend;
}

describe("ChatInput", () => {
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
    });
  });
});
