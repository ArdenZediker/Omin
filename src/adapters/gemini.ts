// Omni - Gemini 适配器
import type { ModelAdapter, ModelConfig, ChatRequest, ChatResponse, StreamChunk, ProviderConfig } from "./types";

const GEMINI_MODELS: ModelConfig[] = [
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "gemini", maxTokens: 1048576, supportsVision: true, supportsStreaming: true },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "gemini", maxTokens: 1048576, supportsVision: true, supportsStreaming: true },
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

  private buildContents(request: ChatRequest) {
    return request.messages
      .filter((m) => m.role !== "system")
      .map((msg) => {
        const parts: Array<Record<string, unknown>> = [];
        if (msg.images && msg.images.length > 0) {
          for (const img of msg.images) {
            const base64 = img.startsWith("data:") ? img.split(",")[1] : img;
            parts.push({ inline_data: { mime_type: "image/png", data: base64 } });
          }
        }
        parts.push({ text: msg.content });
        return {
          role: msg.role === "assistant" ? "model" : "user",
          parts,
        };
      });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
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

    const response = await fetch(
      `${this.getBaseUrl()}/v1beta/models/${request.model}:generateContent?key=${this.config.apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.config.customHeaders },
        body: JSON.stringify(body),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${err}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

    return {
      content: text,
      model: request.model,
      usage: data.usageMetadata
        ? {
            promptTokens: data.usageMetadata.promptTokenCount,
            completionTokens: data.usageMetadata.candidatesTokenCount,
            totalTokens: data.usageMetadata.totalTokenCount,
          }
        : undefined,
    };
  }

  async chatStream(request: ChatRequest, onChunk: (chunk: StreamChunk) => void): Promise<ChatResponse> {
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

    const response = await fetch(
      `${this.getBaseUrl()}/v1beta/models/${request.model}:streamGenerateContent?alt=sse&key=${this.config.apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.config.customHeaders },
        body: JSON.stringify(body),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${err}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let fullContent = "";
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
        try {
          const parsed = JSON.parse(line.slice(6));
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            fullContent += text;
            onChunk({ content: text, done: false, model: request.model });
          }
        } catch {
          // 跳过
        }
      }
      if (done) break;
    }

    onChunk({ content: "", done: true, model: request.model });
    return { content: fullContent, model: request.model };
  }

  async validate(): Promise<boolean> {
    try {
      const response = await fetch(
        `${this.getBaseUrl()}/v1beta/models?key=${this.config.apiKey}`
      );
      return response.ok;
    } catch {
      return false;
    }
  }
}
