import { describe, expect, it } from "vitest";
import type { ModelConfig } from "../adapters/types";
import { resolveCurrentModelId, resolveExecutionModelId } from "./modelSelection";

const models: ModelConfig[] = [
  {
    id: "deepseek-chat",
    name: "DeepSeek V3",
    provider: "deepseek",
    maxTokens: 65536,
    supportsVision: false,
    supportsStreaming: true,
  },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    provider: "openai",
    maxTokens: 128000,
    supportsVision: true,
    supportsStreaming: true,
  },
];

describe("modelSelection", () => {
  it("没有已配置模型时不返回假默认模型", () => {
    expect(resolveCurrentModelId({ savedModelId: "gpt-4o", registryModelId: "gpt-4o", availableModels: [] })).toBe("");
  });

  it("优先使用仍然可用的保存模型，否则回退第一个可用模型", () => {
    expect(resolveCurrentModelId({ savedModelId: "gpt-4o-mini", registryModelId: "deepseek-chat", availableModels: models })).toBe("gpt-4o-mini");
    expect(resolveCurrentModelId({ savedModelId: "missing", registryModelId: "also-missing", availableModels: models })).toBe("deepseek-chat");
  });

  it("执行模型优先使用助手模型，然后才使用当前模型", () => {
    expect(resolveExecutionModelId({ assistantModelId: "gpt-4o-mini", currentModelId: "deepseek-chat", availableModels: models })).toBe("gpt-4o-mini");
    expect(resolveExecutionModelId({ assistantModelId: "missing", currentModelId: "deepseek-chat", availableModels: models })).toBe("deepseek-chat");
  });
});
