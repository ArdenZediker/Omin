import type { KnowledgeContextResult } from "../chat/knowledgeTypes";

// Omni - 多模型适配层
// 为所有 AI 模型提供统一接口

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[]; // base64 编码图片
  knowledgeContext?: KnowledgeContextResult | null;
}

export interface ModelConfig {
  id: string;
  name: string;
  provider: string;
  maxTokens: number;
  supportsVision: boolean;
  supportsStreaming: boolean;
  requestModelId?: string;
}

export interface ChatRequest {
  messages: Message[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface ChatResponse {
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface EmbeddingResponse {
  embedding: number[];
  model: string;
}

export interface StreamChunk {
  content: string;
  done: boolean;
  model: string;
}

// 适配器抽象接口
export interface ModelAdapter {
  readonly provider: string;
  readonly models: ModelConfig[];
  chat(request: ChatRequest): Promise<ChatResponse>;
  chatStream(
    request: ChatRequest,
    onChunk: (chunk: StreamChunk) => void
  ): Promise<ChatResponse>;
  embed?(input: string): Promise<EmbeddingResponse>;
  validate(): Promise<boolean>;
}

// 提供方配置
export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
  name?: string;
  customHeaders?: Record<string, string>;
  customModels?: CustomModelConfig[];
}

// 自定义模型配置（用于中转 / 代理类提供方）
export interface CustomModelConfig {
  id: string;
  name: string;
  maxTokens?: number;
  supportsVision?: boolean;
  supportsStreaming?: boolean;
  requestModelId?: string;
}

// 所有内置模型
export const BUILTIN_MODELS: ModelConfig[] = [
  // OpenAI 模型
  { id: "gpt-4o", name: "GPT-4o", provider: "openai", maxTokens: 128000, supportsVision: true, supportsStreaming: true },
  { id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "openai", maxTokens: 128000, supportsVision: true, supportsStreaming: true },
  { id: "o1", name: "o1", provider: "openai", maxTokens: 200000, supportsVision: true, supportsStreaming: false },
  { id: "o3-mini", name: "o3 Mini", provider: "openai", maxTokens: 200000, supportsVision: false, supportsStreaming: true },
  // Claude 模型
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "claude", maxTokens: 200000, supportsVision: true, supportsStreaming: true },
  { id: "claude-opus-4-20250514", name: "Claude Opus 4", provider: "claude", maxTokens: 200000, supportsVision: true, supportsStreaming: true },
  // Gemini 模型
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "gemini", maxTokens: 1048576, supportsVision: true, supportsStreaming: true },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "gemini", maxTokens: 1048576, supportsVision: true, supportsStreaming: true },
  // Ollama（本地模型）
  { id: "llama3", name: "Llama 3 (Local)", provider: "ollama", maxTokens: 8192, supportsVision: false, supportsStreaming: true },
  { id: "llava", name: "LLaVA (Local)", provider: "ollama", maxTokens: 4096, supportsVision: true, supportsStreaming: true },
  // DeepSeek 模型
  { id: "deepseek-chat", name: "DeepSeek V3", provider: "deepseek", maxTokens: 65536, supportsVision: false, supportsStreaming: true },
  { id: "deepseek-reasoner", name: "DeepSeek R1", provider: "deepseek", maxTokens: 65536, supportsVision: false, supportsStreaming: true },
  // OpenRouter（兼容 OpenAI）
  { id: "openai/gpt-4o", name: "GPT-4o", provider: "openrouter", maxTokens: 128000, supportsVision: true, supportsStreaming: true },
  { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet", provider: "openrouter", maxTokens: 200000, supportsVision: true, supportsStreaming: true },
  { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "openrouter", maxTokens: 1048576, supportsVision: true, supportsStreaming: true },
  // Moonshot / Kimi（兼容 OpenAI）
  { id: "moonshot-v1-8k", name: "Moonshot v1 8K", provider: "moonshot", maxTokens: 8192, supportsVision: false, supportsStreaming: true },
  { id: "moonshot-v1-32k", name: "Moonshot v1 32K", provider: "moonshot", maxTokens: 32768, supportsVision: false, supportsStreaming: true },
  { id: "moonshot-v1-128k", name: "Moonshot v1 128K", provider: "moonshot", maxTokens: 128000, supportsVision: false, supportsStreaming: true },
  // SiliconFlow（兼容 OpenAI）
  { id: "deepseek-ai/DeepSeek-V3", name: "DeepSeek V3", provider: "siliconflow", maxTokens: 65536, supportsVision: false, supportsStreaming: true },
  { id: "deepseek-ai/DeepSeek-R1", name: "DeepSeek R1", provider: "siliconflow", maxTokens: 65536, supportsVision: false, supportsStreaming: true },
  { id: "Qwen/Qwen2.5-72B-Instruct", name: "Qwen2.5 72B", provider: "siliconflow", maxTokens: 32768, supportsVision: false, supportsStreaming: true },
  // 阿里百炼 / DashScope 兼容模式
  { id: "qwen-plus", name: "Qwen Plus", provider: "dashscope", maxTokens: 131072, supportsVision: false, supportsStreaming: true },
  { id: "qwen-max", name: "Qwen Max", provider: "dashscope", maxTokens: 32768, supportsVision: false, supportsStreaming: true },
  { id: "qwen-vl-plus", name: "Qwen VL Plus", provider: "dashscope", maxTokens: 32768, supportsVision: true, supportsStreaming: true },
  // 智谱 GLM（兼容 OpenAI）
  { id: "glm-4-plus", name: "GLM-4 Plus", provider: "zhipu", maxTokens: 128000, supportsVision: false, supportsStreaming: true },
  { id: "glm-4-flash", name: "GLM-4 Flash", provider: "zhipu", maxTokens: 128000, supportsVision: false, supportsStreaming: true },
  { id: "glm-4v-plus", name: "GLM-4V Plus", provider: "zhipu", maxTokens: 8192, supportsVision: true, supportsStreaming: true },
];
