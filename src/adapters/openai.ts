// Omni - OpenAI 适配器
import type { ModelAdapter, ModelConfig, ChatRequest, ChatResponse, StreamChunk, ProviderConfig, EmbeddingResponse } from "./types";
import { toWireRole } from "./types";
import { resolveRequestOptions, reasoningEffortToOpenAI, openAIToolChoice } from "./chatOptions";
import { toOpenAITools, toOpenAIMessage, parseOpenAIToolCalls, OpenAIStreamToolAccumulator } from "./wireTools";
import { postJsonWithRetry, postJsonStream, iterateStream } from "./http";

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
              image_url: { url: img.src.startsWith("data:") ? img.src : `data:image/png;base64,${img.src}` },
            })),
          ],
        };
      }
      return toOpenAIMessage(msg);
    });
  }

  private buildBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const opts = resolveRequestOptions(request);
    const body: Record<string, unknown> = {
      model: request.model,
      messages: this.buildMessages(request),
      stream,
    };
    if (isOSeries(request.model)) {
      // o 系列：只认 max_completion_tokens，无 temperature（但支持 reasoning_effort）
      body.max_completion_tokens = opts.maxTokens ?? 32768;
    } else {
      if (opts.temperature !== undefined) body.temperature = opts.temperature;
      if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    }
    // 中性推理力度 → OpenAI 系 reasoning_effort 字符串（仅 thinking 模型会带，由引擎决定）
    const effort = reasoningEffortToOpenAI(opts.reasoningEffort);
    if (effort) body.reasoning_effort = effort;
    if (request.tools && request.tools.length > 0) {
      body.tools = toOpenAITools(request.tools);
      body.tool_choice = openAIToolChoice(opts.toolChoice, opts.toolChoiceName);
    }
    return body;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const url = `${this.getBaseUrl()}/chat/completions`;
    const body = this.buildBody(request, false);
    const response = await postJsonWithRetry(url, body, this.getHeaders(), request.signal);

    const data = await response.json();
    if (data.error) {
      const message =
        typeof data.error?.message === "string"
          ? data.error.message
          : JSON.stringify(data.error).slice(0, 300);
      throw new Error(`模型返回错误：${message}`);
    }
    // 多 provider 兼容：非流式响应里 reasoning 字段命名同样不统一。通用扫描所有
    // 命中 reason|think|thought|chain|reflect|analysis 的字符串字段，自动捕获。
    const msg = data.choices?.[0]?.message ?? {};
    let reasoningText: string | undefined;
    for (const key of Object.keys(msg)) {
      if (/reason|think|thought|chain|reflect|analysis/i.test(key) && typeof msg[key] === "string" && (msg[key] as string).trim()) {
        reasoningText = msg[key] as string;
        break;
      }
    }
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
    const url = `${this.getBaseUrl()}/chat/completions`;
    const body = this.buildBody(request, true);
    const headers = this.getHeaders();
    const response = await postJsonStream(url, body, headers, request.signal);

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let fullContent = "";
    let model = request.model;
    let buffer = "";
    const toolAccumulator = new OpenAIStreamToolAccumulator();

    const handleLine = (rawLine: string) => {
      const line = rawLine.trim();
      if (!line.startsWith("data: ")) {
        return;
      }
      const data = line.slice(6);
      if (data === "[DONE]") {
        onChunk({ content: "", done: true, model });
        return;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(data);
      } catch {
        // 跳过格式异常的块
        return;
      }
      // 流内错误（如模型/参数错误、限流）：OpenAI 以 data: {"error":{...}} 形式推送。
      // 必须在 try 之外显式抛出，否则会被「跳过格式异常的块」吞掉，导致 UI 只看到空回复、无报错。
      if (parsed?.error) {
        const message =
          typeof parsed.error?.message === "string"
            ? parsed.error.message
            : JSON.stringify(parsed.error).slice(0, 300);
        throw new Error(`模型返回错误：${message}`);
      }
      const delta = parsed?.choices?.[0]?.delta;
        if (delta) {
          model = parsed.model || model;
          if (delta.content) {
            fullContent += delta.content;
            onChunk({ content: delta.content, done: false, model });
          }
          // 多 provider 兼容：reasoning 字段命名高度不统一（OpenAI gpt-5 用 reasoning；
          // DeepSeek-R1 / Qwen3-thinking 用 reasoning_content；其它中转可能用
          // thinking / chain_of_thought / thought / reasoning_details 等任意名字）。
          // 扫描 delta 中所有命中 reason|think|thought|chain|reflect|analysis 的
          // 字符串字段，自动捕获任意命名，避免「思考名不是常用名」时漏抓。
          let reasoningText = "";
          for (const key of Object.keys(delta)) {
            if (/reason|think|thought|chain|reflect|analysis/i.test(key) && typeof delta[key] === "string" && delta[key]) {
              reasoningText = delta[key];
              break;
            }
          }
          if (reasoningText) {
            onChunk({ content: "", done: false, model, reasoning: reasoningText });
          }
          if (delta.tool_calls) {
            toolAccumulator.add(delta.tool_calls);
          }
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
