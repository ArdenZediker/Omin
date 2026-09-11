// Omni - Ollama 适配器（本地模型）
import type { ModelAdapter, ModelConfig, ChatRequest, ChatResponse, StreamChunk, ProviderConfig, ChatToolCall } from "./types";
import { toWireRole } from "./types";
import { toOllamaTools, toOllamaMessage, parseOllamaToolCalls } from "./wireTools";
import { postJsonWithRetry, postJsonStream, iterateStream } from "./http";
import { resolveRequestOptions, ollamaToolChoice } from "./chatOptions";
import { sendWithParamCompat, type UnsupportedParam } from "./paramCompat";

const OLLAMA_MODELS: ModelConfig[] = [
  { id: "llama3", name: "Llama 3 (Local)", provider: "ollama", maxTokens: 8192, maxOutput: 4096, supportsVision: false, supportsStreaming: true, toolCalling: true },
  { id: "llava", name: "LLaVA (Local)", provider: "ollama", maxTokens: 4096, maxOutput: 2048, supportsVision: true, supportsStreaming: true },
  { id: "qwen2.5", name: "Qwen2.5 (Local)", provider: "ollama", maxTokens: 32768, maxOutput: 8192, supportsVision: false, supportsStreaming: true, toolCalling: true },
];

export class OllamaAdapter implements ModelAdapter {
  readonly provider = "ollama";
  readonly models = OLLAMA_MODELS;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  private getBaseUrl(): string {
    return this.config.baseUrl || "http://localhost:11434";
  }

  private getHeaders(): Record<string, string> {
    return { "Content-Type": "application/json", ...this.config.customHeaders };
  }

  private buildMessages(request: ChatRequest) {
    return request.messages.map((msg) => {
      if (msg.images && msg.images.length > 0) {
        return {
          role: toWireRole(msg.role),
          content: msg.content,
          images: msg.images.map((img) => (img.src.startsWith("data:") ? img.src.split(",")[1] : img.src)),
        };
      }
      return toOllamaMessage(msg);
    });
  }

  private buildBody(request: ChatRequest, stream: boolean, skip: Set<UnsupportedParam>): Record<string, unknown> {
    const opts = resolveRequestOptions(request);
    const options: Record<string, unknown> = {};
    // 调用方没意见时不下发，而不是凭空塞一个 0.7。
    if (opts.temperature !== undefined && !skip.has("temperature")) options.temperature = opts.temperature;
    if (opts.maxTokens && !skip.has("maxTokens")) options.num_predict = opts.maxTokens;
    // 中性工具选择 → Ollama tool_choice（仅支持 auto/required/none，Specific 回落 required）。
    // 注：Ollama 原生 /api/chat 并无 tool_choice 字段，此处沿用既有放置位置；Auto（无意见）时不下发。
    const tc = skip.has("toolChoice") ? undefined : ollamaToolChoice(opts.toolChoice);
    if (tc) options.tool_choice = tc;
    return {
      model: request.model,
      messages: this.buildMessages(request),
      stream,
      options,
      ...(request.tools && request.tools.length > 0 ? { tools: toOllamaTools(request.tools) } : {}),
    };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const url = `${this.getBaseUrl()}/api/chat`;
    const headers = this.getHeaders();
    const data = await sendWithParamCompat({
      modelId: request.model,
      declared: resolveRequestOptions(request).unsupportedParams,
      buildBody: (skip) => this.buildBody(request, false, skip),
      send: async (body) => {
        const response = await postJsonWithRetry(url, body, headers, request.signal, { retryable: false });
        return (await response.json()) as any;
      },
    });

    return {
      content: data.message?.content || "",
      model: data.model || request.model,
      toolCalls: parseOllamaToolCalls(data),
    };
  }

  async chatStream(request: ChatRequest, onChunk: (chunk: StreamChunk) => void): Promise<ChatResponse> {
    const url = `${this.getBaseUrl()}/api/chat`;
    const headers = this.getHeaders();
    // 降级重试只发生在响应头阶段（4xx 立即抛出，尚未有任何增量交给 onChunk），不会重复输出。
    const response = await sendWithParamCompat({
      modelId: request.model,
      declared: resolveRequestOptions(request).unsupportedParams,
      buildBody: (skip) => this.buildBody(request, true, skip),
      send: (body) => postJsonStream(url, body, headers, request.signal),
    });

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let fullContent = "";
    let model = request.model;
    let pendingToolCalls: ChatToolCall[] | undefined;

    for await (const value of iterateStream(reader, { signal: request.signal })) {
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n").filter((l) => l.trim());

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.message?.content) {
            fullContent += parsed.message.content;
            model = parsed.model || model;
            onChunk({ content: parsed.message.content, done: false, model });
          }
          // Ollama 原生流式的 tool_calls 以完整形式出现在 message 上
          if (parsed.message?.tool_calls?.length) {
            pendingToolCalls = parseOllamaToolCalls(parsed);
          }
          if (parsed.done) {
            onChunk({ content: "", done: true, model });
          }
        } catch {
          // 跳过
        }
      }
    }

    return { content: fullContent, model, toolCalls: pendingToolCalls };
  }

  async validate(): Promise<boolean> {
    try {
      const response = await fetch(`${this.getBaseUrl()}/api/tags`, { signal: AbortSignal.timeout(10_000) });
      return response.ok;
    } catch {
      return false;
    }
  }
}
