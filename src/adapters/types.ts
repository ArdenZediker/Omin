import type { KnowledgeContextResult } from "../chat/knowledgeTypes";
import type { Artifact } from "../chat/artifacts";

// Omni - 多模型适配层
// 为所有 AI 模型提供统一接口

export interface Message {
  role: "system" | "user" | "project" | "assistant" | "tool";
  content: string;
  images?: string[]; // base64 编码图片
  knowledgeContext?: KnowledgeContextResult | null;
  /** role === "tool" 时：对应当前轮次 assistant.toolCalls 里某次调用的 id */
  toolCallId?: string;
  /** role === "tool" 时：对应工具名（Gemini functionResponse 必须回传 name） */
  toolCallName?: string;
  /** role === "assistant" 时：模型发起的工具调用（function calling 循环用） */
  toolCalls?: ChatToolCall[];
  /** role === "assistant" 时：本轮所有工具调用的执行记录（参数 + 结果），UI 在思考块里按时间顺序渲染 */
  toolCallResults?: ChatToolCallResult[];
  /** role === "assistant" 时：按轮交错的思考+工具步骤流（用于 WorkBuddy 式深度思考渲染）；存在时优先于 toolCallResults */
  steps?: ChatStep[];
  /** 推理模型思考链全文（如 R1 reasoning_content / Gemini thought），用于 UI 折叠展示 */
  reasoning?: string;
  /** 该消息关联的产物（AI 生成的文件/网页/技能等），UI 渲染产物卡片 */
  artifacts?: Artifact[];
}

/**
 * 把应用内部消息角色映射为 OpenAI 兼容接口的线上(wire)角色。
 * "project" 是 Omni 内部角色（项目/桌宠的发言，语义等同 assistant），
 * OpenAI 系接口只接受 system/assistant/user/tool/function，透传会被 400 拒绝
 * （"project is not one of ['system', 'assistant', 'user', 'tool', 'function']"）。
 */
export function toWireRole(role: Message["role"]): "system" | "user" | "assistant" | "tool" {
  if (role === "project") return "assistant";
  return role;
}

/** 模型发起的一次工具调用。arguments 是 JSON 字符串。 */
export interface ChatToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** 一次工具调用的完整执行记录（用于 UI 在「思考过程」块里展示工具步骤和结果）。 */
export interface ChatToolCallResult {
  /** 对应 ChatToolCall.id */
  id: string;
  name: string;
  /** 原始参数 JSON 字符串 */
  arguments: string;
  /** 执行返回文本（输出文本或错误信息） */
  result: string;
  /** 是否异常（默认 false；engine 检测到执行失败置 true） */
  isError?: boolean;
  /** 所属工具循环轮次（0 起始）；用于 UI 显示「第 N 步」 */
  round?: number;
}

/**
 * 思考/工具事件的按时间顺序步骤流（WorkBuddy 式「推理…调用工具…推理…」交错视图）。
 * engine 在工具循环中按轮累积：每轮先把该轮思考链增量压入，再把该轮工具调用压入。
 */
export type ChatStep =
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; name: string; arguments: string; result: string; isError?: boolean };

/** 声明式工具定义（OpenAI function calling 风格的跨适配器统一形态）。 */
export interface ChatToolParam {
  name: string;
  description?: string;
  /** JSON Schema（OpenAI 兼容接口直接透传；Claude/Gemini 内部转换） */
  parameters?: Record<string, unknown>;
}

export interface ModelConfig {
  id: string;
  name: string;
  provider: string;
  /** 上下文窗口大小（token） */
  maxTokens: number;
  /** 单次输出上限（token）；缺省时按窗口的一半估算 */
  maxOutput?: number;
  supportsVision: boolean;
  supportsStreaming: boolean;
  /** 支持 function calling / 工具调用 */
  toolCalling?: boolean;
  /** 推理模型（思考链，如 o 系列 / R1 / Gemini 2.5） */
  thinking?: boolean;
  requestModelId?: string;
}

export interface ChatRequest {
  messages: Message[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  /** function calling 工具声明；提供后模型可主动发起工具调用 */
  tools?: ChatToolParam[];
  /** 取消信号：透传到底层 fetch（立即中断在途请求） */
  signal?: AbortSignal;
}

export interface ChatResponse {
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** 模型请求调用的工具（非流式 function calling 时返回） */
  toolCalls?: ChatToolCall[];
}

export interface EmbeddingResponse {
  embedding: number[];
  model: string;
}

export interface StreamChunk {
  content: string;
  done: boolean;
  model: string;
  /** 推理模型的思考链增量（如 DeepSeek R1 的 reasoning_content） */
  reasoning?: string;
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
  embed?(input: string, model?: string): Promise<EmbeddingResponse>;
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
  maxOutput?: number;
  supportsVision?: boolean;
  supportsStreaming?: boolean;
  toolCalling?: boolean;
  thinking?: boolean;
  requestModelId?: string;
}

// 内置模型目录（含窗口/能力/价格元数据），见 modelCatalog.ts
export { BUILTIN_MODELS } from "./modelCatalog";
