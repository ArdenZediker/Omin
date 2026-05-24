// Omni - Claude 适配器
import type { ModelAdapter, ModelConfig, ChatRequest, ChatResponse, StreamChunk, ProviderConfig } from "./types";

const CLAUDE_MODELS: ModelConfig[] = [
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "claude", maxTokens: 200000, supportsVision: true, supportsStreaming: true },
  { id: "claude-opus-4-20250514", name: "Claude Opus 4", provider: "claude", maxTokens: 200000, supportsVision: true, supportsStreaming: true },
];

export class ClaudeAdapter implements ModelAdapter {
  readonly provider = "claude";
  readonly models = CLAUDE_MODELS;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  private getBaseUrl(): string {
    return this.config.baseUrl || "https://api.anthropic.com";
  }

  private buildMessages(request: ChatRequest) {
    // Claude 需要单独的系统消息
    const systemMsg = request.messages.find((m) => m.role === "system");
    const chatMsgs = request.messages.filter((m) => m.role !== "system");

    const messages = chatMsgs.map((msg) => {
      if (msg.images && msg.images.length > 0) {
        return {
          role: msg.role,
          content: [
            ...msg.images.map((img) => ({
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: "image/png",
                data: img.startsWith("data:") ? img.split(",")[1] : img,
              },
            })),
            { type: "text" as const, text: msg.content },
          ],
        };
      }
      return { role: msg.role, content: msg.content };
    });

    return { system: systemMsg?.content || "", messages };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const { system, messages } = this.buildMessages(request);

    const response = await fetch(`${this.getBaseUrl()}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
        ...this.config.customHeaders,
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens || 4096,
        system,
        messages,
        stream: false,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Claude API error: ${response.status} - ${err}`);
    }

    const data = await response.json();
    const textBlock = data.content.find((b: { type: string }) => b.type === "text");

    return {
      content: textBlock?.text || "",
      model: data.model,
      usage: data.usage
        ? {
            promptTokens: data.usage.input_tokens,
            completionTokens: data.usage.output_tokens,
            totalTokens: data.usage.input_tokens + data.usage.output_tokens,
          }
        : undefined,
    };
  }

  async chatStream(request: ChatRequest, onChunk: (chunk: StreamChunk) => void): Promise<ChatResponse> {
    const { system, messages } = this.buildMessages(request);

    const response = await fetch(`${this.getBaseUrl()}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
        ...this.config.customHeaders,
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens || 4096,
        system,
        messages,
        stream: true,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Claude API error: ${response.status} - ${err}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let fullContent = "";
    let model = request.model;
    let buffer = "";

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
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === "content_block_delta" && parsed.delta?.text) {
            fullContent += parsed.delta.text;
            onChunk({ content: parsed.delta.text, done: false, model });
          } else if (parsed.type === "message_start" && parsed.message?.model) {
            model = parsed.message.model;
          } else if (parsed.type === "message_stop") {
            onChunk({ content: "", done: true, model });
          }
        } catch {
          // 跳过
        }
      }
      if (done) break;
    }

    return { content: fullContent, model };
  }

  async validate(): Promise<boolean> {
    try {
      const response = await fetch(`${this.getBaseUrl()}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
