// Omni - Ollama 适配器（本地模型）
import type { ModelAdapter, ModelConfig, ChatRequest, ChatResponse, StreamChunk, ProviderConfig, ChatToolCall } from "./types";
import { toWireRole } from "./types";
import { toOllamaTools, toOllamaMessage, parseOllamaToolCalls } from "./wireTools";
import { postJsonWithRetry, postJsonStream, iterateStream } from "./http";

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

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await postJsonWithRetry(
      `${this.getBaseUrl()}/api/chat`,
      {
        model: request.model,
        messages: this.buildMessages(request),
        stream: false,
        options: {
          temperature: request.temperature ?? 0.7,
          num_predict: request.maxTokens,
        },
        ...(request.tools && request.tools.length > 0 ? { tools: toOllamaTools(request.tools) } : {}),
      },
      this.getHeaders(),
      request.signal,
      { retryable: false }
    );

    const data = await response.json();
    return {
      content: data.message?.content || "",
      model: data.model || request.model,
      toolCalls: parseOllamaToolCalls(data),
    };
  }

  async chatStream(request: ChatRequest, onChunk: (chunk: StreamChunk) => void): Promise<ChatResponse> {
    const response = await postJsonStream(
      `${this.getBaseUrl()}/api/chat`,
      {
        model: request.model,
        messages: this.buildMessages(request),
        stream: true,
        options: {
          temperature: request.temperature ?? 0.7,
          num_predict: request.maxTokens,
        },
        ...(request.tools && request.tools.length > 0 ? { tools: toOllamaTools(request.tools) } : {}),
      },
      this.getHeaders(),
      request.signal
    );

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
