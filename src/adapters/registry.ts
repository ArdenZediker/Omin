// Omni - Model Registry & Dispatcher
// Central hub for managing all AI model adapters

import type { ModelAdapter, ChatRequest, ChatResponse, StreamChunk, ProviderConfig, ModelConfig, CustomModelConfig } from "./types";
import { OpenAIAdapter } from "./openai";
import { ClaudeAdapter } from "./claude";
import { GeminiAdapter } from "./gemini";
import { OllamaAdapter } from "./ollama";
import { DeepSeekAdapter } from "./deepseek";
import { BUILTIN_MODELS } from "./types";

type AdapterConstructor = new (config: ProviderConfig) => ModelAdapter;

const ADAPTER_MAP: Record<string, AdapterConstructor> = {
  openai: OpenAIAdapter,
  claude: ClaudeAdapter,
  gemini: GeminiAdapter,
  ollama: OllamaAdapter,
  deepseek: DeepSeekAdapter,
  openrouter: OpenAIAdapter,
  moonshot: OpenAIAdapter,
  siliconflow: OpenAIAdapter,
  dashscope: OpenAIAdapter,
  zhipu: OpenAIAdapter,
};

class ModelRegistry {
  private adapters: Map<string, ModelAdapter> = new Map();
  private configs: Map<string, ProviderConfig> = new Map();
  private customModels: Map<string, CustomModelConfig[]> = new Map(); // provider -> custom models
  private currentModel: string = "gpt-4o";

  // Register a provider with its config
  registerProvider(provider: string, config: ProviderConfig): void {
    const AdapterClass = ADAPTER_MAP[provider] || OpenAIAdapter;
    this.configs.set(provider, config);
    this.adapters.set(provider, new AdapterClass(config));
    // Store custom models if provided
    if (config.customModels && config.customModels.length > 0) {
      this.customModels.set(provider, config.customModels);
    } else {
      this.customModels.delete(provider);
    }
  }

  // Remove a provider
  unregisterProvider(provider: string): void {
    this.adapters.delete(provider);
    this.configs.delete(provider);
    this.customModels.delete(provider);
  }

  // Add a custom model to a provider
  addCustomModel(provider: string, model: CustomModelConfig): void {
    const models = this.customModels.get(provider) || [];
    // Avoid duplicate IDs
    if (!models.find((m) => m.id === model.id)) {
      models.push(model);
      this.customModels.set(provider, models);
      // Also update the stored config
      const config = this.configs.get(provider);
      if (config) {
        config.customModels = models;
      }
    }
  }

  // Remove a custom model from a provider
  removeCustomModel(provider: string, modelId: string): void {
    const models = this.customModels.get(provider) || [];
    const filtered = models.filter((m) => m.id !== modelId);
    this.customModels.set(provider, filtered);
    // Also update the stored config
    const config = this.configs.get(provider);
    if (config) {
      config.customModels = filtered;
    }
  }

  // Get custom models for a provider
  getCustomModels(provider: string): CustomModelConfig[] {
    return this.customModels.get(provider) || [];
  }

  // Get adapter for a specific model
  getAdapterForModel(modelId: string): ModelAdapter | null {
    const modelConfig = this.getModelConfig(modelId);
    if (!modelConfig) return null;
    return this.adapters.get(modelConfig.provider) || null;
  }

  // Get all available models (custom model list first; built-ins are fallback only)
  getAvailableModels(): ModelConfig[] {
    const registered = Array.from(this.adapters.keys());
    const custom: ModelConfig[] = [];

    for (const provider of registered) {
      const models = this.customModels.get(provider) || [];
      for (const m of models) {
        custom.push({
          id: m.id,
          name: m.name,
          provider,
          maxTokens: m.maxTokens || 128000,
          supportsVision: m.supportsVision ?? false,
          supportsStreaming: m.supportsStreaming ?? true,
          requestModelId: m.requestModelId,
        });
      }
    }

    if (custom.length > 0) {
      return custom;
    }

    return BUILTIN_MODELS.filter((m) => registered.includes(m.provider));
  }

  // Get model config
  getModelConfig(modelId: string): ModelConfig | undefined {
    // Check built-in first
    const builtin = BUILTIN_MODELS.find((m) => m.id === modelId);
    if (builtin) return builtin;
    // Check custom models
    for (const [provider, models] of this.customModels.entries()) {
      const found = models.find((m) => m.id === modelId);
      if (found) {
        return {
          id: found.id,
          name: found.name,
          provider,
          maxTokens: found.maxTokens || 128000,
          supportsVision: found.supportsVision ?? false,
          supportsStreaming: found.supportsStreaming ?? true,
          requestModelId: found.requestModelId,
        };
      }
    }
    return undefined;
  }

  // Set current model
  setCurrentModel(modelId: string): void {
    this.currentModel = modelId;
  }

  // Get current model
  getCurrentModel(): string {
    return this.currentModel;
  }

  // Send a chat message using the current or specified model
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const model = request.model || this.currentModel;
    const modelConfig = this.getModelConfig(model);
    const adapter = this.getAdapterForModel(model);
    if (!adapter || !modelConfig) {
      throw new Error(`No adapter registered for model: ${model}. Please configure the provider first.`);
    }
    return adapter.chat({ ...request, model: modelConfig.requestModelId || model });
  }

  // Stream a chat message
  async chatStream(
    request: ChatRequest,
    onChunk: (chunk: StreamChunk) => void
  ): Promise<ChatResponse> {
    const model = request.model || this.currentModel;
    const modelConfig = this.getModelConfig(model);
    const adapter = this.getAdapterForModel(model);
    if (!adapter || !modelConfig) {
      throw new Error(`No adapter registered for model: ${model}. Please configure the provider first.`);
    }
    return adapter.chatStream({ ...request, model: modelConfig.requestModelId || model }, onChunk);
  }

  // Validate a provider's credentials
  async validateProvider(provider: string): Promise<boolean> {
    const adapter = this.adapters.get(provider);
    if (!adapter) return false;
    return adapter.validate();
  }

  // Get all registered providers
  getRegisteredProviders(): string[] {
    return Array.from(this.adapters.keys());
  }

  // Check if a provider is registered
  isProviderRegistered(provider: string): boolean {
    return this.adapters.has(provider);
  }

  // Get provider config (without API key for security)
  getProviderConfig(provider: string): { name?: string; baseUrl?: string; hasApiKey: boolean } | null {
    const config = this.configs.get(provider);
    if (!config) return null;
    return { name: config.name, baseUrl: config.baseUrl, hasApiKey: !!config.apiKey };
  }
}

// Singleton instance
export const modelRegistry = new ModelRegistry();

// Persist/restore config to localStorage
const STORAGE_KEY = "omni_provider_configs";
const CURRENT_MODEL_STORAGE_KEY = "omni_current_model";

export function saveProviderConfigs(): void {
  const data: Record<string, { apiKey: string; baseUrl?: string; name?: string; customModels?: CustomModelConfig[] }> = {};
  modelRegistry.getRegisteredProviders().forEach((provider) => {
    // We need the raw config for saving - access through private map
    const rawConfig = (modelRegistry as unknown as { configs: Map<string, ProviderConfig> }).configs.get(provider);
    if (rawConfig) {
      data[provider] = { apiKey: rawConfig.apiKey, baseUrl: rawConfig.baseUrl, name: rawConfig.name, customModels: rawConfig.customModels };
    }
  });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  localStorage.setItem(CURRENT_MODEL_STORAGE_KEY, modelRegistry.getCurrentModel());
}

export function loadProviderConfigs(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw) as Record<string, { apiKey: string; baseUrl?: string; name?: string; customModels?: CustomModelConfig[] }>;
      for (const [provider, config] of Object.entries(data)) {
        if (config.apiKey) {
          modelRegistry.registerProvider(provider, {
            apiKey: config.apiKey,
            baseUrl: config.baseUrl,
            name: config.name,
            customModels: config.customModels,
          });
        }
      }
    }

    const savedCurrentModel = localStorage.getItem(CURRENT_MODEL_STORAGE_KEY);
    const availableModels = modelRegistry.getAvailableModels();
    if (savedCurrentModel && availableModels.some((model) => model.id === savedCurrentModel)) {
      modelRegistry.setCurrentModel(savedCurrentModel);
    } else if (availableModels.length > 0) {
      modelRegistry.setCurrentModel(availableModels[0].id);
    }
  } catch {
    // Ignore parse errors
  }
}
