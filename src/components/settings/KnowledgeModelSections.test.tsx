import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../chat/knowledgeEmbedding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../chat/knowledgeEmbedding")>();
  return {
    ...actual,
    getKnowledgeEmbeddingProviderOptions: () => [{ id: "openai", label: "OpenAI" }],
  };
});

vi.mock("../../chat/knowledgeMultimodal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../chat/knowledgeMultimodal")>();
  return {
    ...actual,
    getKnowledgeMultimodalProviderOptions: () => [{ id: "openai", label: "OpenAI" }],
    KNOWLEDGE_MULTIMODAL_PROVIDER_BASE_URLS: { openai: "https://api.openai.com/v1" },
    KNOWLEDGE_MULTIMODAL_CAPABILITY_OPTIONS: [
      { id: "image", label: "图片" },
      { id: "audio", label: "音频" },
    ],
  };
});

import KnowledgeEmbeddingSection from "./KnowledgeEmbeddingSection";
import KnowledgeMultimodalSection from "./KnowledgeMultimodalSection";
import { getDefaultKnowledgeEmbeddingConfig } from "../../chat/knowledgeEmbedding";
import { getDefaultKnowledgeMultimodalConfig } from "../../chat/knowledgeMultimodal";

describe("知识库模型设置", () => {
  it("向量模型状态徽标、列表与弹窗使用主题语义类", async () => {
    const config = getDefaultKnowledgeEmbeddingConfig();
    render(<KnowledgeEmbeddingSection config={config} onChangeConfig={vi.fn()} />);

    expect(screen.getByText("已关闭")).toHaveClass("omni-knowledge-status-badge");
    expect(screen.getByText("添加模型")).toHaveClass("omni-knowledge-button--secondary");

    fireEvent.click(screen.getByText("添加模型"));
    const dialog = screen.getByRole("dialog", { name: "新增模型" });
    expect(dialog).toHaveClass("omni-knowledge-model-dialog");
    expect(screen.getByRole("button", { name: "向量模型供应商" })).toBeInTheDocument();
  });

  it("多模态模型卡片用 data-active 表达默认态并保留缺少 Key 警告", () => {
    const config = getDefaultKnowledgeMultimodalConfig();
    config.models = [{
      id: "openai:image:model:1",
      name: "图像模型",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "model",
      apiKey: "",
      capability: "image",
    }];
    config.activeImageModelId = config.models[0].id;

    render(<KnowledgeMultimodalSection config={config} onChangeConfig={vi.fn()} />);
    const card = screen.getByText("图像模型").closest(".omni-knowledge-model-card");
    expect(card).toHaveAttribute("data-active", "true");
    expect(card).toHaveClass("omni-knowledge-model-card");
    expect(screen.getByText("图片默认")).toHaveClass("omni-knowledge-chip--selected");
    expect(screen.getByText("缺少 Key")).toHaveClass("omni-knowledge-chip--warning");
  });
});
