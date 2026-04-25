// Omni - Multi-Model Adapter Layer
// Unified interface for all AI model providers

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[]; // base64 encoded images
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

export interface StreamChunk {
  content: string;
  done: boolean;
  model: string;
}

// Abstract adapter interface
export interface ModelAdapter {
  readonly provider: string;
  readonly models: ModelConfig[];
  chat(request: ChatRequest): Promise<ChatResponse>;
  chatStream(
    request: ChatRequest,
    onChunk: (chunk: StreamChunk) => void
  ): Promise<ChatResponse>;
  validate(): Promise<boolean>;
}

// Provider configuration
export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
  name?: string;
  customHeaders?: Record<string, string>;
  customModels?: CustomModelConfig[];
}

// Custom model configuration (for relay/proxy providers)
export interface CustomModelConfig {
  id: string;
  name: string;
  maxTokens?: number;
  supportsVision?: boolean;
  supportsStreaming?: boolean;
  requestModelId?: string;
}

// All built-in models
export const BUILTIN_MODELS: ModelConfig[] = [
  // OpenAI
  { id: "gpt-4o", name: "GPT-4o", provider: "openai", maxTokens: 128000, supportsVision: true, supportsStreaming: true },
  { id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "openai", maxTokens: 128000, supportsVision: true, supportsStreaming: true },
  { id: "o1", name: "o1", provider: "openai", maxTokens: 200000, supportsVision: true, supportsStreaming: false },
  { id: "o3-mini", name: "o3 Mini", provider: "openai", maxTokens: 200000, supportsVision: false, supportsStreaming: true },
  // Claude
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "claude", maxTokens: 200000, supportsVision: true, supportsStreaming: true },
  { id: "claude-opus-4-20250514", name: "Claude Opus 4", provider: "claude", maxTokens: 200000, supportsVision: true, supportsStreaming: true },
  // Gemini
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "gemini", maxTokens: 1048576, supportsVision: true, supportsStreaming: true },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "gemini", maxTokens: 1048576, supportsVision: true, supportsStreaming: true },
  // Ollama (local)
  { id: "llama3", name: "Llama 3 (Local)", provider: "ollama", maxTokens: 8192, supportsVision: false, supportsStreaming: true },
  { id: "llava", name: "LLaVA (Local)", provider: "ollama", maxTokens: 4096, supportsVision: true, supportsStreaming: true },
  // DeepSeek
  { id: "deepseek-chat", name: "DeepSeek V3", provider: "deepseek", maxTokens: 65536, supportsVision: false, supportsStreaming: true },
  { id: "deepseek-reasoner", name: "DeepSeek R1", provider: "deepseek", maxTokens: 65536, supportsVision: false, supportsStreaming: true },
  // OpenRouter (OpenAI-compatible)
  { id: "openai/gpt-4o", name: "GPT-4o", provider: "openrouter", maxTokens: 128000, supportsVision: true, supportsStreaming: true },
  { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet", provider: "openrouter", maxTokens: 200000, supportsVision: true, supportsStreaming: true },
  { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "openrouter", maxTokens: 1048576, supportsVision: true, supportsStreaming: true },
  // Moonshot / Kimi (OpenAI-compatible)
  { id: "moonshot-v1-8k", name: "Moonshot v1 8K", provider: "moonshot", maxTokens: 8192, supportsVision: false, supportsStreaming: true },
  { id: "moonshot-v1-32k", name: "Moonshot v1 32K", provider: "moonshot", maxTokens: 32768, supportsVision: false, supportsStreaming: true },
  { id: "moonshot-v1-128k", name: "Moonshot v1 128K", provider: "moonshot", maxTokens: 128000, supportsVision: false, supportsStreaming: true },
  // SiliconFlow (OpenAI-compatible)
  { id: "deepseek-ai/DeepSeek-V3", name: "DeepSeek V3", provider: "siliconflow", maxTokens: 65536, supportsVision: false, supportsStreaming: true },
  { id: "deepseek-ai/DeepSeek-R1", name: "DeepSeek R1", provider: "siliconflow", maxTokens: 65536, supportsVision: false, supportsStreaming: true },
  { id: "Qwen/Qwen2.5-72B-Instruct", name: "Qwen2.5 72B", provider: "siliconflow", maxTokens: 32768, supportsVision: false, supportsStreaming: true },
  // Alibaba Bailian / DashScope compatible mode
  { id: "qwen-plus", name: "Qwen Plus", provider: "dashscope", maxTokens: 131072, supportsVision: false, supportsStreaming: true },
  { id: "qwen-max", name: "Qwen Max", provider: "dashscope", maxTokens: 32768, supportsVision: false, supportsStreaming: true },
  { id: "qwen-vl-plus", name: "Qwen VL Plus", provider: "dashscope", maxTokens: 32768, supportsVision: true, supportsStreaming: true },
  // Zhipu GLM (OpenAI-compatible)
  { id: "glm-4-plus", name: "GLM-4 Plus", provider: "zhipu", maxTokens: 128000, supportsVision: false, supportsStreaming: true },
  { id: "glm-4-flash", name: "GLM-4 Flash", provider: "zhipu", maxTokens: 128000, supportsVision: false, supportsStreaming: true },
  { id: "glm-4v-plus", name: "GLM-4V Plus", provider: "zhipu", maxTokens: 8192, supportsVision: true, supportsStreaming: true },
];
