// Omni - Gemini 适配器
import type { ModelAdapter, ModelConfig, ChatRequest, ChatResponse, StreamChunk, ProviderConfig } from "./types";
import { mimeTypeFromDataUrl } from "./types";
import { toGeminiTools, toGeminiContent, parseGeminiToolCalls, parseGeminiStreamToolCalls } from "./wireTools";
import { postJsonWithRetry, postJsonStream, iterateStream } from "./http";

const GEMINI_MODELS: ModelConfig[] = [
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "gemini", maxTokens: 1048576, maxOutput: 65536, supportsVision: true, supportsStreaming: true, toolCalling: true, thinking: true },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "gemini", maxTokens: 1048576, maxOutput: 65536, supportsVision: true, supportsStreaming: true, toolCalling: true, thinking: true },
  { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash-Lite", provider: "gemini", maxTokens: 1048576, maxOutput: 65536, supportsVision: false, supportsStreaming: true, toolCalling: true },
];

export class GeminiAdapter implements ModelAdapter {
  readonly provider = "gemini";
  readonly models = GEMINI_MODELS;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  private getBaseUrl(): string {
    return this.config.baseUrl || "https://generativelanguage.googleapis.com";
  }

  private getKeyUrl(): string {
    return `?key=${this.config.apiKey}`;
  }

  private buildContents(request: ChatRequest) {
    return request.messages
      .map((msg) => {
        // 工具调用/工具结果走公共转换；普通文本/图片消息在此处理
        if (msg.role !== "system" && msg.role !== "tool" && !(msg.role === "assistant" && msg.toolCalls?.length)) {
          const parts: Array<Record<string, unknown>> = [];
          if (msg.images && msg.images.length > 0) {
            for (const img of msg.images) {
              const base64 = img.src.startsWith("data:") ? img.src.split(",")[1] : img.src;
              parts.push({ inline_data: { mime_type: mimeTypeFromDataUrl(img.src), data: base64 } });
            }
          }
          parts.push({ text: msg.content });
          return {
            role: msg.role === "project" ? "model" : "user",
            parts,
          };
        }
        return toGeminiContent(msg);
      })
      .filter((c): c is { role: "user" | "model"; parts: Array<Record<string, unknown>> } => c !== null);
  }

  private buildBody(request: ChatRequest): Record<string, unknown> {
    const systemInstruction = request.messages.find((m) => m.role === "system");
    const body: Record<string, unknown> = {
      contents: this.buildContents(request),
      generationConfig: {
        temperature: request.temperature ?? 0.7,
        maxOutputTokens: request.maxTokens,
      },
    };
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction.content }] };
    }
    if (request.tools && request.tools.length > 0) {
      body.tools = toGeminiTools(request.tools);
    }
    return body;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await postJsonWithRetry(
      `${this.getBaseUrl()}/v1beta/models/${request.model}:generateContent${this.getKeyUrl()}`,
      this.buildBody(request),
      { "Content-Type": "application/json", ...this.config.customHeaders },
      request.signal
    );

    const data = await response.json();
    type GeminiPart = { text?: string; thought?: string; functionCall?: unknown };
    const parts: GeminiPart[] = data.candidates?.[0]?.content?.parts || [];
    // Aggregate thought blocks (Gemini thinking mode reasoning, mirrors stream branch)
    const thoughtText = parts
      .filter((p) => typeof p.thought === "string")
      .map((p) => p.thought as string)
      .join("\n");
    const text = parts
      .filter((p) => typeof p.text === "string")
      .map((p) => p.text as string)
      .join("") || "";

    return {
      content: text,
      reasoning: thoughtText || undefined,
      model: data.model,
      usage: data.usageMetadata
        ? {
            promptTokens: data.usageMetadata.promptTokenCount,
            completionTokens: data.usageMetadata.candidatesTokenCount,
            totalTokens: data.usageMetadata.totalTokenCount,
          }
        : undefined,
      toolCalls: parseGeminiToolCalls(data),
    };
  }

  async chatStream(request: ChatRequest, onChunk: (chunk: StreamChunk) => void): Promise<ChatResponse> {
    const response = await postJsonStream(
      `${this.getBaseUrl()}/v1beta/models/${request.model}:streamGenerateContent?alt=sse&key=${this.config.apiKey}`,
      this.buildBody(request),
      { "Content-Type": "application/json", ...this.config.customHeaders },
      request.signal
    );

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let fullContent = "";
    let buffer = "";
    let toolCalls;

    const handleLine = (rawLine: string) => {
      const line = rawLine.trim();
      if (!line.startsWith("data: ")) {
        return;
      }
      try {
        const parsed = JSON.parse(line.slice(6));
        const parts = parsed.candidates?.[0]?.content?.parts;
        if (Array.isArray(parts)) {
          for (const part of parts) {
            if (part.text) {
              fullContent += part.text;
              onChunk({ content: part.text, done: false, model: request.model });
            }
            if (part.thought) {
              onChunk({ content: "", done: false, model: request.model, reasoning: part.thought });
            }
          }
          // Gemini SSE 每个 chunk 的 parts 是全量快照，functionCall 直接取
          const calls = parseGeminiStreamToolCalls(parts);
          if (calls) toolCalls = calls;
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

    onChunk({ content: "", done: true, model: request.model });
    return { content: fullContent, model: request.model, toolCalls };
  }

  async validate(): Promise<boolean> {
    try {
      const response = await fetch(`${this.getBaseUrl()}/v1beta/models${this.getKeyUrl()}`, { signal: AbortSignal.timeout(10_000) });
      return response.ok;
    } catch {
      return false;
    }
  }
}
