// Omni - OpenAI 适配器
import type { ModelAdapter, ModelConfig, ChatRequest, ChatResponse, StreamChunk, ProviderConfig, EmbeddingResponse } from "./types";
import { toWireRole } from "./types";
import { toOpenAITools, toOpenAIMessage, parseOpenAIToolCalls, OpenAIStreamToolAccumulator } from "./wireTools";
import { postJsonWithRetry, postJsonStream } from "./http";

const OPENAI_MODELS: ModelConfig[] = [
  { id: "gpt-4o", name: "GPT-4o", provider: "openai", maxTokens: 128000, maxOutput: 16384, supportsVision: true, supportsStreaming: true, toolCalling: true },
  { id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "openai", maxTokens: 128000, maxOutput: 16384, supportsVision: true, supportsStreaming: true, toolCalling: true },
  { id: "o1", name: "o1", provider: "openai", maxTokens: 200000, maxOutput: 100000, supportsVision: true, supportsStreaming: false, toolCalling: true, thinking: true },
  { id: "o3-mini", name: "o3 Mini", provider: "openai", maxTokens: 200000, maxOutput: 100000, supportsVision: false, supportsStreaming: true, toolCalling: true, thinking: true },
];

/** o 系列只接受 max_completion_tokens 且不支持 temperature。 */
function isOSeries(model: string): boolean {
  return /^o[1-4](-|$)/.test(model);
}

export class OpenAIAdapter implements ModelAdapter {
  readonly provider = "openai";
  readonly models = OPENAI_MODELS;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  private getBaseUrl(): string {
    return this.config.baseUrl || "https://api.openai.com/v1";
  }

  private getHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
      ...this.config.customHeaders,
    };
  }

  private buildMessages(request: ChatRequest) {
    return request.messages.map((msg) => {
      if (msg.images && msg.images.length > 0) {
        return {
          role: toWireRole(msg.role),
          content: [
            { type: "text", text: msg.content },
            ...msg.images.map((img) => ({
              type: "image_url" as const,
              image_url: { url: img.startsWith("data:") ? img : `data:image/png;base64,${img}` },
            })),
          ],
        };
      }
      return toOpenAIMessage(msg);
    });
  }

  private buildBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: this.buildMessages(request),
      stream,
    };
    if (isOSeries(request.model)) {
      // o 系列：只认 max_completion_tokens，无 temperature
      body.max_completion_tokens = request.maxTokens ?? 32768;
    } else {
      if (request.temperature !== undefined) body.temperature = request.temperature;
      if (request.maxTokens) body.max_tokens = request.maxTokens;
    }
    if (request.tools && request.tools.length > 0) {
      body.tools = toOpenAITools(request.tools);
      body.tool_choice = "auto";
    }
    return body;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await postJsonWithRetry(
      `${this.getBaseUrl()}/chat/completions`,
      this.buildBody(request, false),
      this.getHeaders(),
      request.signal
    );

    const data = await response.json();
    // 多 provider 兼容：非流式响应里 reasoning 字段命名同样不统一（覆盖 GPT-5.6 / Qwen3-thinking / DeepSeek-R1 / Gemini 中转等）
    const msg = data.choices?.[0]?.message ?? {};
    const reasoningText =
      (typeof msg.reasoning_content === "string" && msg.reasoning_content) ||
      (typeof msg.reasoning === "string" && msg.reasoning) ||
      (typeof msg.reasoning_text === "string" && msg.reasoning_text) ||
      (typeof msg.thinking_content === "string" && msg.thinking_content) ||
      (typeof msg.thought === "string" && msg.thought) ||
      undefined;
    return {
      content: msg.content ?? "",
      reasoning: reasoningText,
      model: data.model,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
      toolCalls: parseOpenAIToolCalls(data),
    };
  }

  async chatStream(request: ChatRequest, onChunk: (chunk: StreamChunk) => void): Promise<ChatResponse> {
    const response = await postJsonStream(
      `${this.getBaseUrl()}/chat/completions`,
      this.buildBody(request, true),
      this.getHeaders(),
      request.signal
    );

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let fullContent = "";
    let model = request.model;
    let buffer = "";
    const toolAccumulator = new OpenAIStreamToolAccumulator();

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
      } else {
        buffer += decoder.decode(value, { stream: true });
      }

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data: ")) {
          continue;
        }
        const data = line.slice(6);
        if (data === "[DONE]") {
          onChunk({ content: "", done: true, model });
          continue;
        }
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (delta) {
            model = parsed.model || model;
            if (delta.content) {
              fullContent += delta.content;
              onChunk({ content: delta.content, done: false, model });
            }
            // 多 provider 兼容：DeepSeek-R1 / 阿里 Qwen3-thinking / OpenAI Responses 中转等
            // 不同服务方对 reasoning 字段命名不统一，依次回退到常见命名
            const reasoningText =
              (typeof delta.reasoning_content === "string" && delta.reasoning_content) ||
              (typeof delta.reasoning === "string" && delta.reasoning) ||
              (typeof delta.reasoning_text === "string" && delta.reasoning_text) ||
              (typeof delta.thinking_content === "string" && delta.thinking_content) ||
              (typeof delta.thought === "string" && delta.thought) ||
              "";
            if (reasoningText) {
              onChunk({ content: "", done: false, model, reasoning: reasoningText });
            }
            if (delta.tool_calls) {
              toolAccumulator.add(delta.tool_calls);
            }
          }
        } catch {
          // 跳过格式异常的块
        }
      }
      if (done) break;
    }

    return { content: fullContent, model, toolCalls: toolAccumulator.getToolCalls() };
  }

  async embed(input: string, model = "text-embedding-3-small"): Promise<EmbeddingResponse> {
    const embeddingModel = model.trim() || "text-embedding-3-small";
    const response = await postJsonWithRetry(
      `${this.getBaseUrl()}/embeddings`,
      { model: embeddingModel, input },
      this.getHeaders(),
      undefined
    );

    const data = await response.json();
    return {
      embedding: data.data?.[0]?.embedding ?? [],
      model: data.model ?? embeddingModel,
    };
  }

  async validate(): Promise<boolean> {
    try {
      const response = await fetch(`${this.getBaseUrl()}/models`, {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
