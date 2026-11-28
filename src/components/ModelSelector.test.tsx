import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  models: [] as Array<{
    id: string;
    name: string;
    provider: string;
    maxTokens: number;
    supportsVision: boolean;
    supportsStreaming: boolean;
  }>,
  statuses: {} as Record<string, boolean>,
}));

vi.mock("../adapters/registry", () => ({
  modelRegistry: {
    getAvailableModels: () => fixtures.models,
    getModelConfig: (modelId: string) => fixtures.models.find((model) => model.id === modelId),
  },
}));

vi.mock("../app/sqliteStorage", () => ({
  readSqliteBackedJson: (_key: string, fallback: Record<string, boolean>) => ({ ...fallback, ...fixtures.statuses }),
}));

import ModelSelector from "./ModelSelector";

describe("ModelSelector", () => {
  beforeEach(() => {
    fixtures.models = [
      {
        id: "claude-sonnet",
        name: "Claude Sonnet",
        provider: "claude",
        maxTokens: 200000,
        supportsVision: true,
        supportsStreaming: true,
      },
      {
        id: "custom-openai",
        name: "Custom OpenAI Model",
        provider: "openai",
        maxTokens: 128000,
        supportsVision: false,
        supportsStreaming: true,
      },
    ];
    fixtures.statuses = {};
  });

  it("uses a solid provider marker when connection status is unknown", () => {
    render(<ModelSelector currentModel="claude-sonnet" onModelChange={vi.fn()} />);

    expect(screen.getByRole("img", { name: "模型状态：Claude 模型" })).toHaveClass("model-selector__status-dot--claude");
    expect(document.querySelector(".model-selector__status-dot")?.className).not.toContain("gradient");
  });

  it("uses semantic connected and disconnected states", () => {
    fixtures.statuses = { "claude-sonnet": true, "custom-openai": false };
    render(<ModelSelector currentModel="claude-sonnet" onModelChange={vi.fn()} />);

    expect(screen.getAllByRole("img", { name: "模型状态：已连接" })[0]).toHaveClass("model-selector__status-dot--connected");

    fireEvent.click(screen.getByRole("button", { name: /Claude Sonnet/ }));
    expect(screen.getByRole("img", { name: "模型状态：连接失败" })).toHaveClass("model-selector__status-dot--disconnected");
  });

  it("selects a model and closes the list", () => {
    const onModelChange = vi.fn();
    render(<ModelSelector currentModel="claude-sonnet" onModelChange={onModelChange} />);

    fireEvent.click(screen.getByRole("button", { name: /Claude Sonnet/ }));
    fireEvent.click(screen.getByRole("button", { name: /Custom OpenAI Model/ }));

    expect(onModelChange).toHaveBeenCalledWith("custom-openai");
    expect(document.querySelector(".model-selector__dropdown")).not.toBeInTheDocument();
  });
});
