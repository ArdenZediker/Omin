import type { ModelConfig } from "./types";

/**
 * Omni 内置模型目录（model catalog）。
 *
 * 对照三方做法：
 * - Codex：config.toml 内置 provider 模板（base_url + env_key），model 预设带上下文窗口
 * - DeepSeek 生态客户端（Chatbox / Cherry Studio）：厂商注册表内置模型列表 + 价格
 * - WorkBuddy：推荐连接器一键授权，模型元数据（窗口/价格/能力）服务端下发
 *
 * Omni 采用「内置目录 + 用户填 key」：模型/窗口/价格/能力全内置，
 * 用户只需填 API key（baseUrl 留空用默认端点）。价格单位：USD / 1M tokens。
 */

export interface ModelPricing {
  /** 输入价格 USD/1M tokens；undefined 表示未知 */
  input?: number;
  output?: number;
}

export interface ProviderDefaults {
  label: string;
  /** 默认端点；用户不填 baseUrl 时使用 */
  baseUrl: string;
  /** 兼容协议：openai 兼容 / claude / gemini / ollama */
  protocol: "openai" | "claude" | "gemini" | "ollama";
  /** 是否本地模型（无需 key） */
  local?: boolean;
}

export const PROVIDER_DEFAULTS: Record<string, ProviderDefaults> = {
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", protocol: "openai" },
  claude: { label: "Anthropic Claude", baseUrl: "https://api.anthropic.com", protocol: "claude" },
  gemini: { label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com", protocol: "gemini" },
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", protocol: "openai" },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", protocol: "openai" },
  moonshot: { label: "Moonshot Kimi", baseUrl: "https://api.moonshot.cn/v1", protocol: "openai" },
  siliconflow: { label: "SiliconFlow", baseUrl: "https://api.siliconflow.cn/v1", protocol: "openai" },
  dashscope: { label: "阿里云百炼", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", protocol: "openai" },
  zhipu: { label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", protocol: "openai" },
  ollama: { label: "Ollama (本地)", baseUrl: "http://localhost:11434/v1", protocol: "ollama", local: true },
};

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // OpenAI
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "o1": { input: 15, output: 60 },
  "o3-mini": { input: 1.1, output: 4.4 },
  "o4-mini": { input: 1.1, output: 4.4 },
  // GPT-5.6 系列（2026-07 发布，Sol/Terra/Luna 三档）
  "gpt-5.6-sol": { input: 4, output: 16 },
  "gpt-5.6-terra": { input: 2, output: 12 },
  "gpt-5.6-luna": { input: 0.6, output: 3 },
  // Claude
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-opus-4-20250514": { input: 15, output: 75 },
  "claude-sonnet-4-20250805": { input: 3, output: 15 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4 },
  // Gemini（1M 窗口内按标准价，超 200k 档有加成，这里取标准档）
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  // DeepSeek
  "deepseek-chat": { input: 0.27, output: 1.1 },
  "deepseek-reasoner": { input: 0.55, output: 2.19 },
  // Moonshot
  "moonshot-v1-8k": { input: 12, output: 12 },
  "moonshot-v1-32k": { input: 24, output: 24 },
  "moonshot-v1-128k": { input: 60, output: 60 },
  // DashScope（人民币按 0.14 折 USD 估算，仅供参考）
  "qwen-plus": { input: 0.11, output: 0.28 },
  "qwen-max": { input: 0.34, output: 1.34 },
  "qwen-vl-plus": { input: 0.21, output: 0.84 },
  "qwen-turbo": { input: 0.03, output: 0.09 },
};

/**
 * 内置模型列表（含能力与窗口元数据）。
 * maxTokens 语义 = 上下文窗口大小；maxOutput = 单次输出上限（缺省按窗口一半保守估计）。
 */
export const BUILTIN_MODELS: ModelConfig[] = [
  // OpenAI
  { id: "gpt-4o", name: "GPT-4o", provider: "openai", maxTokens: 128000, maxOutput: 16384, supportsVision: true, supportsStreaming: true, toolCalling: true },
  { id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "openai", maxTokens: 128000, maxOutput: 16384, supportsVision: true, supportsStreaming: true, toolCalling: true },
  { id: "o1", name: "o1", provider: "openai", maxTokens: 200000, maxOutput: 100000, supportsVision: true, supportsStreaming: false, toolCalling: true, thinking: true },
  { id: "o3-mini", name: "o3 Mini", provider: "openai", maxTokens: 200000, maxOutput: 100000, supportsVision: false, supportsStreaming: true, toolCalling: true, thinking: true },
  { id: "o4-mini", name: "o4 Mini", provider: "openai", maxTokens: 200000, maxOutput: 100000, supportsVision: true, supportsStreaming: true, toolCalling: true, thinking: true },
  // GPT-5.6 系列（2026-07 发布，支持 reasoning effort 多档控制）
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai", maxTokens: 1050000, maxOutput: 128000, supportsVision: true, supportsStreaming: true, toolCalling: true, thinking: true },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai", maxTokens: 1050000, maxOutput: 128000, supportsVision: true, supportsStreaming: true, toolCalling: true, thinking: true },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai", maxTokens: 1050000, maxOutput: 128000, supportsVision: true, supportsStreaming: true, toolCalling: true, thinking: true },
  // Claude
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "claude", maxTokens: 200000, maxOutput: 64000, supportsVision: true, supportsStreaming: true, toolCalling: true },
  { id: "claude-sonnet-4-20250805", name: "Claude Sonnet 4.5", provider: "claude", maxTokens: 200000, maxOutput: 64000, supportsVision: true, supportsStreaming: true, toolCalling: true },
  { id: "claude-opus-4-20250514", name: "Claude Opus 4", provider: "claude", maxTokens: 200000, maxOutput: 64000, supportsVision: true, supportsStreaming: true, toolCalling: true },
  { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku", provider: "claude", maxTokens: 200000, maxOutput: 8192, supportsVision: true, supportsStreaming: true, toolCalling: true },
  // Gemini
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "gemini", maxTokens: 1048576, maxOutput: 65536, supportsVision: true, supportsStreaming: true, toolCalling: true, thinking: true },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "gemini", maxTokens: 1048576, maxOutput: 65536, supportsVision: true, supportsStreaming: true, toolCalling: true, thinking: true },
  { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash-Lite", provider: "gemini", maxTokens: 1048576, maxOutput: 65536, supportsVision: false, supportsStreaming: true, toolCalling: true },
  // Ollama（本地）
  { id: "llama3", name: "Llama 3 (Local)", provider: "ollama", maxTokens: 8192, maxOutput: 4096, supportsVision: false, supportsStreaming: true, toolCalling: true },
  { id: "llava", name: "LLaVA (Local)", provider: "ollama", maxTokens: 4096, maxOutput: 2048, supportsVision: true, supportsStreaming: true },
  { id: "qwen2.5", name: "Qwen2.5 (Local)", provider: "ollama", maxTokens: 32768, maxOutput: 8192, supportsVision: false, supportsStreaming: true, toolCalling: true },
  // DeepSeek
  { id: "deepseek-chat", name: "DeepSeek V3", provider: "deepseek", maxTokens: 65536, maxOutput: 8192, supportsVision: false, supportsStreaming: true, toolCalling: true },
  { id: "deepseek-reasoner", name: "DeepSeek R1", provider: "deepseek", maxTokens: 65536, maxOutput: 8192, supportsVision: false, supportsStreaming: true, thinking: true },
  // OpenRouter（兼容 OpenAI）
  { id: "openai/gpt-4o", name: "GPT-4o", provider: "openrouter", maxTokens: 128000, maxOutput: 16384, supportsVision: true, supportsStreaming: true, toolCalling: true },
  { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet", provider: "openrouter", maxTokens: 200000, maxOutput: 64000, supportsVision: true, supportsStreaming: true, toolCalling: true },
  { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "openrouter", maxTokens: 1048576, maxOutput: 65536, supportsVision: true, supportsStreaming: true, toolCalling: true },
  { id: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openrouter", maxTokens: 1050000, maxOutput: 128000, supportsVision: true, supportsStreaming: true, toolCalling: true, thinking: true },
  { id: "openai/gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openrouter", maxTokens: 1050000, maxOutput: 128000, supportsVision: true, supportsStreaming: true, toolCalling: true, thinking: true },
  { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openrouter", maxTokens: 1050000, maxOutput: 128000, supportsVision: true, supportsStreaming: true, toolCalling: true, thinking: true },
  // Moonshot / Kimi（兼容 OpenAI）
  { id: "moonshot-v1-8k", name: "Moonshot v1 8K", provider: "moonshot", maxTokens: 8192, maxOutput: 4096, supportsVision: false, supportsStreaming: true, toolCalling: true },
  { id: "moonshot-v1-32k", name: "Moonshot v1 32K", provider: "moonshot", maxTokens: 32768, maxOutput: 8192, supportsVision: false, supportsStreaming: true, toolCalling: true },
  { id: "moonshot-v1-128k", name: "Moonshot v1 128K", provider: "moonshot", maxTokens: 128000, maxOutput: 16384, supportsVision: false, supportsStreaming: true, toolCalling: true },
  // SiliconFlow（兼容 OpenAI）
  { id: "deepseek-ai/DeepSeek-V3", name: "DeepSeek V3", provider: "siliconflow", maxTokens: 65536, maxOutput: 8192, supportsVision: false, supportsStreaming: true, toolCalling: true },
  { id: "deepseek-ai/DeepSeek-R1", name: "DeepSeek R1", provider: "siliconflow", maxTokens: 65536, maxOutput: 8192, supportsVision: false, supportsStreaming: true, thinking: true },
  { id: "Qwen/Qwen2.5-72B-Instruct", name: "Qwen2.5 72B", provider: "siliconflow", maxTokens: 32768, maxOutput: 8192, supportsVision: false, supportsStreaming: true, toolCalling: true },
  // 阿里百炼 / DashScope 兼容模式
  { id: "qwen-plus", name: "Qwen Plus", provider: "dashscope", maxTokens: 131072, maxOutput: 8192, supportsVision: false, supportsStreaming: true, toolCalling: true },
  { id: "qwen-max", name: "Qwen Max", provider: "dashscope", maxTokens: 32768, maxOutput: 8192, supportsVision: false, supportsStreaming: true, toolCalling: true },
  { id: "qwen-vl-plus", name: "Qwen VL Plus", provider: "dashscope", maxTokens: 32768, maxOutput: 8192, supportsVision: true, supportsStreaming: true, toolCalling: true },
  { id: "qwen-turbo", name: "Qwen Turbo", provider: "dashscope", maxTokens: 131072, maxOutput: 8192, supportsVision: false, supportsStreaming: true, toolCalling: true },
  // 智谱 GLM（兼容 OpenAI）
  { id: "glm-4-plus", name: "GLM-4 Plus", provider: "zhipu", maxTokens: 128000, maxOutput: 8192, supportsVision: false, supportsStreaming: true, toolCalling: true },
  { id: "glm-4-flash", name: "GLM-4 Flash", provider: "zhipu", maxTokens: 128000, maxOutput: 8192, supportsVision: false, supportsStreaming: true, toolCalling: true },
  { id: "glm-4v-plus", name: "GLM-4V Plus", provider: "zhipu", maxTokens: 8192, maxOutput: 4096, supportsVision: true, supportsStreaming: true, toolCalling: true },
];

/** 按模型 id 查价格；未收录返回 undefined（成本显示「未知」）。 */
export function getModelPricing(modelId: string): ModelPricing | undefined {
  return MODEL_PRICING[modelId];
}

/** 按模型 id 查内置元数据（含 catalog 中可能出现的扩展字段）。 */
export function findBuiltinModel(modelId: string): ModelConfig | undefined {
  return BUILTIN_MODELS.find((m) => m.id === modelId);
}
