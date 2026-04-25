// Omni - Ollama Adapter (Local Models)
import type { ModelAdapter, ModelConfig, ChatRequest, ChatResponse, StreamChunk, ProviderConfig } from "./types";

const OLLAMA_MODELS: ModelConfig[] = [
  { id: "llama3", name: "Llama 3 (Local)", provider: "ollama", maxTokens: 8192, supportsVision: false, supportsStreaming: true },
  { id: "llava", name: "LLaVA (Local)", provider: "ollama", maxTokens: 4096, supportsVision: true, supportsStreaming: true },
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

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await fetch(`${this.getBaseUrl()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.config.customHeaders },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map((msg) => {
          if (msg.images && msg.images.length > 0) {
            return {
              role: msg.role,
              content: msg.content,
              images: msg.images.map((img) => (img.startsWith("data:") ? img.split(",")[1] : img)),
            };
          }
          return { role: msg.role, content: msg.content };
        }),
        stream: false,
        options: {
          temperature: request.temperature ?? 0.7,
          num_predict: request.maxTokens,
        },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Ollama API error: ${response.status} - ${err}`);
    }

    const data = await response.json();
    return {
      content: data.message?.content || "",
      model: data.model || request.model,
    };
  }

  async chatStream(request: ChatRequest, onChunk: (chunk: StreamChunk) => void): Promise<ChatResponse> {
    const response = await fetch(`${this.getBaseUrl()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.config.customHeaders },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map((msg) => {
          if (msg.images && msg.images.length > 0) {
            return {
              role: msg.role,
              content: msg.content,
              images: msg.images.map((img) => (img.startsWith("data:") ? img.split(",")[1] : img)),
            };
          }
          return { role: msg.role, content: msg.content };
        }),
        stream: true,
        options: {
          temperature: request.temperature ?? 0.7,
          num_predict: request.maxTokens,
        },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Ollama API error: ${response.status} - ${err}`);
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
      const lines = chunk.split("\n").filter((l) => l.trim());

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.message?.content) {
            fullContent += parsed.message.content;
            model = parsed.model || model;
            onChunk({ content: parsed.message.content, done: false, model });
          }
          if (parsed.done) {
            onChunk({ content: "", done: true, model });
          }
        } catch {
          // Skip
        }
      }
    }

    return { content: fullContent, model };
  }

  async validate(): Promise<boolean> {
    try {
      const response = await fetch(`${this.getBaseUrl()}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }
}
