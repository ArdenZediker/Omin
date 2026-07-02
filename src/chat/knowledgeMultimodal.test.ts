import { describe, expect, it } from "vitest";
import { normalizeKnowledgeMultimodalConfig, type KnowledgeMultimodalModelConfig } from "./knowledgeMultimodal";

const imageModel: KnowledgeMultimodalModelConfig = {
  id: "openai:image:gpt-4.1-mini:1",
  name: "GPT 4.1 Mini Image",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4.1-mini",
  apiKey: "test-key",
  capability: "image",
};

const audioModel: KnowledgeMultimodalModelConfig = {
  id: "openai:audio:gpt-4o-mini-transcribe:1",
  name: "GPT 4o Mini Transcribe",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini-transcribe",
  apiKey: "test-key",
  capability: "audio",
};

describe("knowledgeMultimodal", () => {
  it("默认模型为空时保持未选择状态", () => {
    const config = normalizeKnowledgeMultimodalConfig({
      models: [imageModel, audioModel],
      activeImageModelId: "",
      activeAudioModelId: "",
    });

    expect(config.activeImageModelId).toBe("");
    expect(config.activeAudioModelId).toBe("");
  });

  it("默认模型无效或能力不匹配时不回退到第一条模型", () => {
    const config = normalizeKnowledgeMultimodalConfig({
      models: [imageModel, audioModel],
      activeImageModelId: audioModel.id,
      activeAudioModelId: "missing-model",
    });

    expect(config.activeImageModelId).toBe("");
    expect(config.activeAudioModelId).toBe("");
  });

  it("默认模型有效且能力匹配时保留选择", () => {
    const config = normalizeKnowledgeMultimodalConfig({
      models: [imageModel, audioModel],
      activeImageModelId: imageModel.id,
      activeAudioModelId: audioModel.id,
    });

    expect(config.activeImageModelId).toBe(imageModel.id);
    expect(config.activeAudioModelId).toBe(audioModel.id);
  });
});
