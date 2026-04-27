// Omni - OpenAI 适配器
import type { ModelAdapter, ModelConfig, ChatRequest, ChatResponse, StreamChunk, ProviderConfig } from "./types";

const OPENAI_MODELS: ModelConfig[] = [
  { id: "gpt-4o", name: "GPT-4o", provider: "openai", maxTokens: 128000, supportsVision: true, supportsStreaming: true },
  { id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "openai", maxTokens: 128000, supportsVision: true, supportsStreaming: true },
  { id: "o1", name: "o1", provider: "openai", maxTokens: 200000, supportsVision: true, supportsStreaming: false },
  { id: "o3-mini", name: "o3 Mini", provider: "openai", maxTokens: 200000, supportsVision: false, supportsStreaming: true },
];

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

  private buildMessages(request: ChatRequest) {
    return request.messages.map((msg) => {
      if (msg.images && msg.images.length > 0) {
        return {
          role: msg.role,
          content: [
            { type: "text", text: msg.content },
            ...msg.images.map((img) => ({
              type: "image_url" as const,
              image_url: { url: img.startsWith("data:") ? img : `data:image/png;base64,${img}` },
            })),
          ],
        };
      }
      return { role: msg.role, content: msg.content };
    });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await fetch(`${this.getBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
        ...this.config.customHeaders,
      },
      body: JSON.stringify({
        model: request.model,
        messages: this.buildMessages(request),
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens,
        stream: false,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${err}`);
    }

    const data = await response.json();
    return {
      content: data.choices[0].message.content,
      model: data.model,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
    };
  }

  async chatStream(request: ChatRequest, onChunk: (chunk: StreamChunk) => void): Promise<ChatResponse> {
    const response = await fetch(`${this.getBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
        ...this.config.customHeaders,
      },
      body: JSON.stringify({
        model: request.model,
        messages: this.buildMessages(request),
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens,
        stream: true,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${err}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let fullContent = "";
    let model = request.model;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n").filter((l) => l.startsWith("data: "));

      for (const line of lines) {
        const data = line.slice(6);
        if (data === "[DONE]") {
          onChunk({ content: "", done: true, model });
          break;
        }
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullContent += delta;
            model = parsed.model || model;
            onChunk({ content: delta, done: false, model });
          }
        } catch {
          // 跳过格式异常的块
        }
      }
    }

    return { content: fullContent, model };
  }

  async validate(): Promise<boolean> {
    try {
      const response = await fetch(`${this.getBaseUrl()}/models`, {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
