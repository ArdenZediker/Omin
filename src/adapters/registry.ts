// Omni - 模型注册与调度器
// 负责集中管理所有 AI 模型适配器

import type { ModelAdapter, ChatRequest, ChatResponse, StreamChunk, ProviderConfig, ModelConfig, CustomModelConfig } from "./types";
import { OpenAIAdapter } from "./openai";
import { ClaudeAdapter } from "./claude";
import { GeminiAdapter } from "./gemini";
import { OllamaAdapter } from "./ollama";
import { DeepSeekAdapter } from "./deepseek";
import { BUILTIN_MODELS } from "./types";
import { loadAppKvEntries, saveAppKvEntry } from "../app/sqliteStorage";

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
  private customModels: Map<string, CustomModelConfig[]> = new Map(); // 提供方 -> 自定义模型
  private currentModel: string = "gpt-4o";

  // 注册提供方及其配置
  registerProvider(provider: string, config: ProviderConfig): void {
    const AdapterClass = ADAPTER_MAP[provider] || OpenAIAdapter;
    this.configs.set(provider, config);
    this.adapters.set(provider, new AdapterClass(config));
    // 如果提供了自定义模型，则保存起来
    if (config.customModels && config.customModels.length > 0) {
      this.customModels.set(provider, config.customModels);
    } else {
      this.customModels.delete(provider);
    }
  }

  // 移除提供方
  unregisterProvider(provider: string): void {
    this.adapters.delete(provider);
    this.configs.delete(provider);
    this.customModels.delete(provider);
  }

  // 为提供方添加自定义模型
  addCustomModel(provider: string, model: CustomModelConfig): void {
    const models = this.customModels.get(provider) || [];
    // 避免重复 ID
    if (!models.find((m) => m.id === model.id)) {
      models.push(model);
      this.customModels.set(provider, models);
      // 同步更新已保存的配置
      const config = this.configs.get(provider);
      if (config) {
        config.customModels = models;
      }
    }
  }

  // 从提供方移除自定义模型
  removeCustomModel(provider: string, modelId: string): void {
    const models = this.customModels.get(provider) || [];
    const filtered = models.filter((m) => m.id !== modelId);
    this.customModels.set(provider, filtered);
    // 同步更新已保存的配置
    const config = this.configs.get(provider);
    if (config) {
      config.customModels = filtered;
    }
  }

  // 获取某个提供方的自定义模型
  getCustomModels(provider: string): CustomModelConfig[] {
    return this.customModels.get(provider) || [];
  }

  // 获取指定模型对应的适配器
  getAdapterForModel(modelId: string): ModelAdapter | null {
    const modelConfig = this.getModelConfig(modelId);
    if (!modelConfig) return null;
    return this.adapters.get(modelConfig.provider) || null;
  }

  getAdapterForProvider(provider: string): ModelAdapter | null {
    return this.adapters.get(provider) || null;
  }

  // 获取全部可用模型（自定义模型优先，内置模型仅作兜底）
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

  // 获取模型配置
  getModelConfig(modelId: string): ModelConfig | undefined {
    // 先检查内置模型
    const builtin = BUILTIN_MODELS.find((m) => m.id === modelId);
    if (builtin) return builtin;
    // 再检查自定义模型
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

  // 设置当前模型
  setCurrentModel(modelId: string): void {
    this.currentModel = modelId;
  }

  // 获取当前模型
  getCurrentModel(): string {
    return this.currentModel;
  }

  // 使用当前模型或指定模型发送聊天消息
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const model = request.model || this.currentModel;
    const modelConfig = this.getModelConfig(model);
    const adapter = this.getAdapterForModel(model);
    if (!adapter || !modelConfig) {
      throw new Error(`No adapter registered for model: ${model}. Please configure the provider first.`);
    }
    return adapter.chat({ ...request, model: modelConfig.requestModelId || model });
  }

  // 流式发送聊天消息
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

  // 验证提供方凭据
  async validateProvider(provider: string): Promise<boolean> {
    const adapter = this.adapters.get(provider);
    if (!adapter) return false;
    return adapter.validate();
  }

  // 获取所有已注册提供方
  getRegisteredProviders(): string[] {
    return Array.from(this.adapters.keys());
  }

  // 检查某个提供方是否已注册
  isProviderRegistered(provider: string): boolean {
    return this.adapters.has(provider);
  }

  // 获取提供方配置（不包含 API Key，避免泄露）
  getProviderConfig(provider: string): { name?: string; baseUrl?: string; hasApiKey: boolean } | null {
    const config = this.configs.get(provider);
    if (!config) return null;
    return { name: config.name, baseUrl: config.baseUrl, hasApiKey: !!config.apiKey };
  }
}

// 单例实例
export const modelRegistry = new ModelRegistry();

// 持久化配置到统一存储层，并支持恢复
const STORAGE_KEY = "omni_provider_configs";
export const CURRENT_MODEL_STORAGE_KEY = "omni_current_model";

export async function saveProviderConfigs(): Promise<void> {
  const data: Record<string, { apiKey: string; baseUrl?: string; name?: string; customModels?: CustomModelConfig[] }> = {};
  modelRegistry.getRegisteredProviders().forEach((provider) => {
    // 保存时需要原始配置，直接访问私有映射
    const rawConfig = (modelRegistry as unknown as { configs: Map<string, ProviderConfig> }).configs.get(provider);
    if (rawConfig) {
      data[provider] = { apiKey: rawConfig.apiKey, baseUrl: rawConfig.baseUrl, name: rawConfig.name, customModels: rawConfig.customModels };
    }
  });
  await saveAppKvEntry(STORAGE_KEY, JSON.stringify(data));
  await saveAppKvEntry(CURRENT_MODEL_STORAGE_KEY, modelRegistry.getCurrentModel());
}

export async function loadProviderConfigs(): Promise<void> {
  try {
    const entries = await loadAppKvEntries([STORAGE_KEY, CURRENT_MODEL_STORAGE_KEY]);
    const raw = entries[STORAGE_KEY];
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

    const savedCurrentModel = entries[CURRENT_MODEL_STORAGE_KEY] ?? null;
    const availableModels = modelRegistry.getAvailableModels();
    if (savedCurrentModel && availableModels.some((model) => model.id === savedCurrentModel)) {
      modelRegistry.setCurrentModel(savedCurrentModel);
    } else if (availableModels.length > 0) {
      modelRegistry.setCurrentModel(availableModels[0].id);
    }
  } catch {
    // 忽略解析错误
  }
}
