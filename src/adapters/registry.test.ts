import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "./claude";
import { DeepSeekAdapter } from "./deepseek";
import { OllamaAdapter } from "./ollama";
import { OpenAIAdapter } from "./openai";
import { ModelRegistry } from "./registry";
import { ReasoningEffort } from "./chatOptions";

describe("ModelRegistry", () => {
  it("routes a custom provider by its declared protocol instead of its name", () => {
    const registry = new ModelRegistry();
    registry.registerProvider("my-anthropic-gateway", {
      apiKey: "",
      baseUrl: "https://gateway.example.com",
      protocol: "claude",
    });

    expect(registry.getAdapterForProvider("my-anthropic-gateway")).toBeInstanceOf(ClaudeAdapter);
    expect(registry.getProviderConfig("my-anthropic-gateway")?.protocol).toBe("claude");
  });

  it("allows keyless local providers and keeps native Ollama routing", () => {
    const registry = new ModelRegistry();
    registry.registerProvider("local-ollama", {
      apiKey: "",
      name: "Local Ollama",
      protocol: "ollama",
    });

    expect(registry.getAdapterForProvider("local-ollama")).toBeInstanceOf(OllamaAdapter);
    expect(registry.getProviderConfig("local-ollama")?.hasApiKey).toBe(false);
  });

  it("migrates the old Ollama /v1 default to the native API root", () => {
    const registry = new ModelRegistry();
    registry.registerProvider("local-ollama", {
      apiKey: "",
      baseUrl: "http://localhost:11434/v1",
      protocol: "ollama",
    });

    expect(registry.getProviderConfig("local-ollama")?.baseUrl).toBe("http://localhost:11434");
  });

  it("defaults an unknown custom provider to the OpenAI-compatible adapter", () => {
    const registry = new ModelRegistry();
    registry.registerProvider("my-gateway", { apiKey: "", name: "My Gateway" });

    expect(registry.getAdapterForProvider("my-gateway")).toBeInstanceOf(OpenAIAdapter);
    expect(registry.getProviderConfig("my-gateway")?.protocol).toBe("openai");
  });

  it("keeps DeepSeek-specific wire behavior for the DeepSeek namespace", () => {
    const registry = new ModelRegistry();
    registry.registerProvider("deepseek", { apiKey: "test", protocol: "openai" });

    expect(registry.getAdapterForProvider("deepseek")).toBeInstanceOf(DeepSeekAdapter);
  });

  it("still honors an explicit protocol on an overridden provider namespace", () => {
    const registry = new ModelRegistry();
    registry.registerProvider("deepseek", { apiKey: "", protocol: "claude" });

    expect(registry.getAdapterForProvider("deepseek")).toBeInstanceOf(ClaudeAdapter);
  });

  it("preserves custom-model capabilities when exposing the catalog", () => {
    const registry = new ModelRegistry();
    registry.registerProvider("gateway", {
      apiKey: "",
      protocol: "openai",
      customModels: [{
        id: "gateway:reasoner",
        requestModelId: "reasoner-v1",
        name: "Gateway Reasoner",
        maxTokens: 131072,
        maxContextWindow: 200000,
        maxOutput: 32768,
        supportsVision: true,
        supportsStreaming: false,
        toolCalling: true,
        thinking: true,
        defaultReasoningEffort: ReasoningEffort.High,
        unsupportedParams: ["temperature"],
      }],
    });

    const model = registry.getAvailableModels()[0];
    expect(model).toMatchObject({
      id: "gateway:reasoner",
      provider: "gateway",
      maxTokens: 131072,
      maxContextWindow: 200000,
      maxOutput: 32768,
      supportsVision: true,
      supportsStreaming: false,
      toolCalling: true,
      thinking: true,
      defaultReasoningEffort: ReasoningEffort.High,
      unsupportedParams: ["temperature"],
      requestModelId: "reasoner-v1",
    });
  });

  it("keeps built-in models for other registered providers beside custom models", () => {
    const registry = new ModelRegistry();
    registry.registerProvider("openai", { apiKey: "sk-test" });
    registry.registerProvider("gateway", {
      apiKey: "",
      customModels: [{ id: "gateway:one", name: "Gateway One" }],
    });

    const models = registry.getAvailableModels();
    expect(models.some((model) => model.id === "gateway:one")).toBe(true);
    expect(models.some((model) => model.provider === "openai" && model.id === "gpt-4o")).toBe(true);
  });
});
