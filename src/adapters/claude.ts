// Omni - Claude 适配器
import type { ModelAdapter, ModelConfig, ChatRequest, ChatResponse, StreamChunk, ProviderConfig } from "./types";
import { toWireRole } from "./types";
import { toClaudeTools, toClaudeMessage, parseClaudeToolCalls, ClaudeStreamToolAccumulator } from "./wireTools";
import { postJsonWithRetry, postJsonStream, iterateStream } from "./http";

const CLAUDE_MODELS: ModelConfig[] = [
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "claude", maxTokens: 200000, maxOutput: 64000, supportsVision: true, supportsStreaming: true, toolCalling: true },
  { id: "claude-sonnet-4-20250805", name: "Claude Sonnet 4.5", provider: "claude", maxTokens: 200000, maxOutput: 64000, supportsVision: true, supportsStreaming: true, toolCalling: true },
  { id: "claude-opus-4-20250514", name: "Claude Opus 4", provider: "claude", maxTokens: 200000, maxOutput: 64000, supportsVision: true, supportsStreaming: true, toolCalling: true },
  { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku", provider: "claude", maxTokens: 200000, maxOutput: 8192, supportsVision: true, supportsStreaming: true, toolCalling: true },
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

  private getHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.config.apiKey,
      "anthropic-version": "2023-06-01",
      ...this.config.customHeaders,
    };
  }

  private buildMessages(request: ChatRequest) {
    // Claude 需要单独的系统消息；system 加 cache_control 开启 prompt 缓存（长 system 每轮省成本）
    const systemMsg = request.messages.find((m) => m.role === "system");
    const chatMsgs = request.messages.filter((m) => m.role !== "system");

    const messages = chatMsgs
      .map((msg) => {
        if (msg.images && msg.images.length > 0) {
          return {
            role: toWireRole(msg.role),
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
        return toClaudeMessage(msg);
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);

    const system = systemMsg?.content
      ? [{ type: "text" as const, text: systemMsg.content, cache_control: { type: "ephemeral" } }]
      : [];

    return { system, messages };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const { system, messages } = this.buildMessages(request);

    const response = await postJsonWithRetry(
      `${this.getBaseUrl()}/v1/messages`,
      {
        model: request.model,
        max_tokens: request.maxTokens || 4096,
        system,
        messages,
        stream: false,
        ...(request.tools && request.tools.length > 0 ? { tools: toClaudeTools(request.tools) } : {}),
      },
      this.getHeaders(),
      request.signal
    );

    const data = await response.json();
    // 聚合思考块：Anthropic extended thinking 模式下 content 数组里会有 type:"thinking" 块
    const thinkingText = Array.isArray(data.content)
      ? data.content
          .filter((b: { type: string }) => b.type === "thinking" || b.type === "redacted_thinking")
          .map((b: { thinking?: string; text?: string }) => b.thinking || b.text || "")
          .filter(Boolean)
          .join("\n")
      : "";
    const textBlock = data.content.find((b: { type: string }) => b.type === "text");

    return {
      content: textBlock?.text || "",
      reasoning: thinkingText || undefined,
      model: data.model,
      usage: data.usage
        ? {
            promptTokens: data.usage.input_tokens,
            completionTokens: data.usage.output_tokens,
            totalTokens: data.usage.input_tokens + data.usage.output_tokens,
          }
        : undefined,
      toolCalls: parseClaudeToolCalls(data),
    };
  }

  async chatStream(request: ChatRequest, onChunk: (chunk: StreamChunk) => void): Promise<ChatResponse> {
    const { system, messages } = this.buildMessages(request);

    const response = await postJsonStream(
      `${this.getBaseUrl()}/v1/messages`,
      {
        model: request.model,
        max_tokens: request.maxTokens || 4096,
        system,
        messages,
        stream: true,
        ...(request.tools && request.tools.length > 0 ? { tools: toClaudeTools(request.tools) } : {}),
      },
      this.getHeaders(),
      request.signal
    );

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let fullContent = "";
    let fullReasoning = "";
    let model = request.model;
    let buffer = "";
    const toolAccumulator = new ClaudeStreamToolAccumulator();

    const handleLine = (rawLine: string) => {
      const line = rawLine.trim();
      if (!line.startsWith("data: ")) {
        return;
      }
      const data = line.slice(6);
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === "content_block_delta") {
          // Anthropic extended thinking：type:"thinking_delta" 携带 reasoning 增量
          if (parsed.delta?.type === "thinking_delta" && parsed.delta?.thinking) {
            fullReasoning += parsed.delta.thinking;
            onChunk({ content: "", done: false, model, reasoning: parsed.delta.thinking });
          } else if (parsed.delta?.text) {
            fullContent += parsed.delta.text;
            onChunk({ content: parsed.delta.text, done: false, model });
          }
        } else if (parsed.type === "message_start" && parsed.message?.model) {
          model = parsed.message.model;
        } else if (parsed.type === "message_stop") {
          onChunk({ content: "", done: true, model });
        } else if (parsed.type === "content_block_start" || parsed.type === "content_block_delta" || parsed.type === "content_block_stop") {
          toolAccumulator.add(parsed);
        }
      } catch {
        // 跳过
      }
    };

    for await (const value of iterateStream(reader, { signal: request.signal })) {
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const rawLine of lines) handleLine(rawLine);
    }

    // 流结束：冲刷解码器残留与最后一行不完整数据
    buffer += decoder.decode();
    const tailLines = buffer.split("\n");
    buffer = tailLines.pop() ?? "";
    for (const rawLine of tailLines) handleLine(rawLine);

    return { content: fullContent, model, toolCalls: toolAccumulator.getToolCalls(), reasoning: fullReasoning || undefined };
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
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
