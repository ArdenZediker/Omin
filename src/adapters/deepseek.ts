// Omni - DeepSeek 适配器
import type { ModelAdapter, ModelConfig, ChatRequest, ChatResponse, StreamChunk, ProviderConfig } from "./types";
import { toOpenAITools, toOpenAIMessage, parseOpenAIToolCalls, OpenAIStreamToolAccumulator } from "./wireTools";
import { postJsonWithRetry, postJsonStream } from "./http";

const DEEPSEEK_MODELS: ModelConfig[] = [
  { id: "deepseek-chat", name: "DeepSeek V3", provider: "deepseek", maxTokens: 65536, maxOutput: 8192, supportsVision: false, supportsStreaming: true, toolCalling: true },
  { id: "deepseek-reasoner", name: "DeepSeek R1", provider: "deepseek", maxTokens: 65536, maxOutput: 8192, supportsVision: false, supportsStreaming: true, thinking: true },
];

export class DeepSeekAdapter implements ModelAdapter {
  readonly provider = "deepseek";
  readonly models = DEEPSEEK_MODELS;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  private getBaseUrl(): string {
    return this.config.baseUrl || "https://api.deepseek.com/v1";
  }

  private getHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
      ...this.config.customHeaders,
    };
  }

  /** deepseek-reasoner 不支持 tools 参数，传入时静默忽略。 */
  private supportsTools(request: ChatRequest): boolean {
    return Boolean(request.tools?.length) && !String(request.model).includes("reasoner");
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await postJsonWithRetry(
      `${this.getBaseUrl()}/chat/completions`,
      {
        model: request.model,
        messages: request.messages.map((m) => toOpenAIMessage(m)),
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens,
        stream: false,
        ...(this.supportsTools(request) ? { tools: toOpenAITools(request.tools) } : {}),
      },
      this.getHeaders(),
      request.signal
    );

    const data = await response.json();
    return {
      content: data.choices[0].message.content ?? "",
      model: data.model,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
      toolCalls: this.supportsTools(request) ? parseOpenAIToolCalls(data) : undefined,
    };
  }

  async chatStream(request: ChatRequest, onChunk: (chunk: StreamChunk) => void): Promise<ChatResponse> {
    const response = await postJsonStream(
      `${this.getBaseUrl()}/chat/completions`,
      {
        model: request.model,
        messages: request.messages.map((m) => toOpenAIMessage(m)),
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens,
        stream: true,
        ...(this.supportsTools(request) ? { tools: toOpenAITools(request.tools) } : {}),
      },
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
            // 多 provider 兼容：DeepSeek-R1 / 阿里 Qwen3-thinking / OpenAI Responses 中转等
            // R1 的思考链独立字段，透传而非丢弃；兼容 reasoning / thinking_content / thought 等命名
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
            if (delta.content) {
              fullContent += delta.content;
              onChunk({ content: delta.content, done: false, model });
            }
            if (delta.tool_calls) {
              toolAccumulator.add(delta.tool_calls);
            }
          }
        } catch {
          // 跳过
        }
      }
      if (done) break;
    }

    return { content: fullContent, model, toolCalls: this.supportsTools(request) ? toolAccumulator.getToolCalls() : undefined };
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
