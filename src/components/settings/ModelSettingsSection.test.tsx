import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReasoningEffort } from "../../adapters/chatOptions";
import type { CustomModelConfig, DiscoveredModel, ModelProtocol } from "../../adapters/types";
import ModelSettingsSection from "./ModelSettingsSection";

const baseModel: CustomModelConfig & { endpointId: string; endpointName: string } = {
  id: "model-a",
  name: "模型 A",
  requestModelId: "model-a-id",
  supportsVision: true,
  supportsStreaming: true,
  toolCalling: true,
  thinking: false,
  endpointId: "endpoint-a",
  endpointName: "接口 A",
};

const baseProps = {
  endpoints: [{ id: "endpoint-a", name: "接口 A", baseUrl: "https://example.com", protocol: "openai" as ModelProtocol }],
  endpointModels: [baseModel],
  availableModels: [
    {
      id: "model-a",
      name: "模型 A",
      provider: "openai",
      requestModelId: "model-a-id",
      supportsVision: true,
      supportsStreaming: true,
    },
  ],
  currentModel: "model-a",
  discoveredModels: [] as DiscoveredModel[],
  discoveringModels: false,
  modelPrefs: {
    enableVisionInput: true,
    enableStreaming: true,
    temperature: 0.7,
    maxOutputTokens: 1024,
    costSaverCompaction: false,
  },
  testingConnection: false,
  testResult: null,
  isModelFormOpen: false,
  editingModel: null,
  modelEndpointId: "endpoint-a",
  modelProtocol: "openai" as ModelProtocol,
  endpointName: "接口 A",
  baseUrl: "",
  apiKey: "",
  modelId: "model-a",
  modelDiscoveryError: "",
  modelName: "模型 A",
  modelVision: true,
  modelStreaming: true,
  modelContextWindow: 128000,
  modelMaxOutput: 4096,
  modelToolCalling: true,
  modelThinking: false,
  modelDefaultReasoningEffort: ReasoningEffort.Medium,
  modelUnsupportedParams: [],
  onOpenNewModelForm: vi.fn(),
  onOpenEditModelForm: vi.fn(),
  onCloseModelForm: vi.fn(),
  onChooseEndpoint: vi.fn(),
  onDiscoverModels: vi.fn(),
  onSetModelEndpointId: vi.fn(),
  onSetModelProtocol: vi.fn(),
  onSetEndpointName: vi.fn(),
  onSetBaseUrl: vi.fn(),
  onSetApiKey: vi.fn(),
  onSetModelId: vi.fn(),
  onSetModelName: vi.fn(),
  onSetModelVision: vi.fn(),
  onSetModelStreaming: vi.fn(),
  onSetModelContextWindow: vi.fn(),
  onSetModelMaxOutput: vi.fn(),
  onSetModelToolCalling: vi.fn(),
  onSetModelThinking: vi.fn(),
  onSetModelDefaultReasoningEffort: vi.fn(),
  onToggleModelUnsupportedParam: vi.fn(),
  onSetModelPrefs: vi.fn(),
  onResetModelPrefs: vi.fn(),
  onTestConnection: vi.fn(),
  onSaveModel: vi.fn(),
  onRemoveModel: vi.fn(),
  onSelectDiscoveredModel: vi.fn(),
  onModelChange: vi.fn(),
};

describe("聊天模型设置", () => {
  it("模型列表使用语义卡片并标记当前主模型", () => {
    render(<ModelSettingsSection {...baseProps} />);

    const card = screen.getByRole("button", { name: /模型 A/ }).closest(".omni-model-card");
    expect(card).toHaveClass("omni-knowledge-model-card");
    expect(card).toHaveAttribute("data-active", "true");
    expect(screen.getAllByText("当前主模型")[1]).toHaveClass("omni-knowledge-chip--selected");
    expect(screen.getByText("新增模型")).toHaveClass("omni-model-add-button");
  });

  it("模型编辑弹窗使用主题语义类并接入焦点管理", () => {
    render(<ModelSettingsSection {...baseProps} isModelFormOpen editingModel={baseModel} />);

    const dialog = screen.getByRole("dialog", { name: "编辑模型" });
    expect(dialog).toHaveClass("omni-model-dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("保存模型")).toHaveClass("omni-knowledge-button--primary");
    expect(screen.getByText("删除模型")).toHaveClass("omni-knowledge-button--danger");
  });
});
