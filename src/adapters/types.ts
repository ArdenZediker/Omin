import type { KnowledgeContextResult } from "../chat/knowledgeTypes";
import type { Artifact } from "../chat/artifacts";

// Omni - 多模型适配层
// 为所有 AI 模型提供统一接口

/**
 * 用户在输入框附带的本地文件（非图片类）。
 *
 * 图片走的是另一条通道：`Message.images`（base64 DataURL）直接内联进请求体交给
 * vision 模型。任意文件不能这么做——几十 MB 的 docx 塞进请求体既不现实也没必要，
 * 所以这里只记绝对路径，由模型按需调用 /read_file 读取。
 */
/**
 * 用户随消息附带的内联图片（base64 DataURL）。
 *
 * 与 ChatAttachment（非图片文件，只记绝对路径）不同，图片直接内联进请求体交给
 * vision 模型。任意文件不能这么做——几十 MB 的 docx 塞进请求体既不现实也没必要。
 *
 * offset 语义与 ChatAttachment.offset 完全一致：上传/粘贴瞬间按光标位置记录，
 * 渲染时把图片插到正文对应位置。缺省（undefined）视为 0，即排在正文最前面（兼容旧数据）。
 */
export interface ChatImage {
  /** base64 DataURL */
  src: string;
  /** 展示用文件名（可选，缺省时 UI 合成 image_N.png） */
  name?: string;
  /** 插入位置：该图片在消息正文（content）中的字符偏移量 */
  offset?: number;
}

export interface ChatAttachment {
  /** 本地绝对路径 */
  path: string;
  /** 展示用文件名 */
  name: string;
  /** 字节数；未知为 null */
  size: number | null;
  /**
   * 插入位置：该附件在消息正文（content）中的字符偏移量。
   *
   * 由输入框在上传/粘贴的瞬间按光标位置记录；渲染时按 offset 把正文切片，
   * 把附件 chip 插到对应位置（光标在文字前→chip 在前，光标在文字后→chip 在后）。
   * 缺省（undefined）视为 0，即排在正文最前面——兼容旧数据。
   */
  offset?: number;
}

/**
 * 从 base64 Data URL 中解析真实的 MIME 类型（如 `data:image/jpeg;base64,...` → `image/jpeg`）。
 * 图片附件在转 base64 前会被缩放/重压缩（可能变成 JPEG），适配器发送 vision 内容时必须用真实类型，
 * 不能写死 image/png，否则模型会按错误格式解码。非 data URL（裸 base64）回退 image/png。
 */
export function mimeTypeFromDataUrl(dataUrl: string): string {
  const match = /^data:([^;]+);base64,/.exec(dataUrl);
  return match ? match[1] : "image/png";
}

export interface Message {
  role: "system" | "user" | "project" | "assistant" | "tool";
  content: string;
  images?: ChatImage[]; // base64 编码图片（带插入位置 offset）
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
  /** 用户随消息附带的本地文件（仅 user 消息有）；内容不内联，只记路径 */
  attachments?: ChatAttachment[];
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
  /**
   * 工具调用步骤。status="running" 为执行中的过渡态（engine 仅实时推送、不进持久化 steps，
   * 完成后由运行时原地升级为带结果的最终步骤）；status="interrupted" 为中断定案态（运行被
   * 用户停止/超时/出错时，运行时把遗留的 running 步骤标记为已中断并随消息持久化）；
   * 缺省 status 即正常完成的最终态。
   */
  | {
      type: "tool_call";
      name: string;
      arguments: string;
      result: string;
      isError?: boolean;
      status?: "running" | "interrupted";
    }
  /** WorkBuddy 式异构时间线条目：由渲染层直接映射为「动作行」（人类可读标签 + 图标 + 迷你文件卡片）。engine 当前不产出，仅作为向前兼容的扩展点。 */
  | {
      type: "action";
      /** 中文动作动词，如「导出」「写入」 */
      label: string;
      /** 英文工具/动作标题，如「Export Word」 */
      title: string;
      /** 参数/详情摘要（可选） */
      detail?: string;
      /** lucide 图标名（可选，缺省回退 Terminal） */
      icon?: string;
      /** 若动作产出文件，附路径与状态标签（如「已导出」） */
      file?: { path: string; badge: string };
    }
  /** WorkBuddy 式异构时间线条目：动作产出的可交付物引用（打开右侧产物面板）。 */
  | { type: "artifact"; artifactId: string; title: string };

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
  /** 非流式响应里的完整推理文本（如 R1 / GPT-5.6 / Qwen3-thinking 等），与 StreamChunk.reasoning 字段语义对应 */
  reasoning?: string;
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
