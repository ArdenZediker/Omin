// Omni - DeepSeek 适配器
import type { ModelAdapter, ModelConfig, ChatRequest, ChatResponse, StreamChunk, ProviderConfig } from "./types";
import { toOpenAITools, toOpenAIMessage, parseOpenAIToolCalls, OpenAIStreamToolAccumulator } from "./wireTools";
import { resolveReasoningReturnPolicy } from "./reasoningPolicy";
import { postJsonWithRetry, postJsonStream, iterateStream } from "./http";
import { resolveRequestOptions, reasoningEffortToOpenAI, openAIToolChoice, ToolChoice } from "./chatOptions";
import { sendWithParamCompat, type UnsupportedParam } from "./paramCompat";

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

  private buildBody(request: ChatRequest, stream: boolean, skip: Set<UnsupportedParam>): Record<string, unknown> {
    const opts = resolveRequestOptions(request);
    // 历史 reasoning 回传策略：默认不回传；仅命中 include 关键字的模型才回传 reasoning_content。
    const policy = resolveReasoningReturnPolicy(this.provider, request.model);
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((m) => toOpenAIMessage(m, policy)),
      stream,
    };
    // 调用方没意见时不下发，而不是凭空塞一个 0.7——有些模型（如 kimi-k3）直接拒绝 temperature。
    if (opts.temperature !== undefined && !skip.has("temperature")) body.temperature = opts.temperature;
    if (opts.maxTokens && !skip.has("maxTokens")) body.max_tokens = opts.maxTokens;
    // 中性推理力度 → reasoning_effort（DeepSeek-R1 等支持；非 thinking 模型引擎不带，零影响）
    const effort = skip.has("reasoningEffort") ? undefined : reasoningEffortToOpenAI(opts.reasoningEffort);
    if (effort) body.reasoning_effort = effort;
    if (this.supportsTools(request)) {
      body.tools = toOpenAITools(request.tools);
      // ToolChoice.Auto 语义是「无意见」→ 不下发该字段
      if (opts.toolChoice !== ToolChoice.Auto && !skip.has("toolChoice")) {
        body.tool_choice = openAIToolChoice(opts.toolChoice, opts.toolChoiceName);
      }
    }
    return body;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const url = `${this.getBaseUrl()}/chat/completions`;
    const data = await sendWithParamCompat({
      modelId: request.model,
      declared: resolveRequestOptions(request).unsupportedParams,
      buildBody: (skip) => this.buildBody(request, false, skip),
      send: async (body) => {
        const response = await postJsonWithRetry(url, body, this.getHeaders(), request.signal, { timeoutMs: request.timeoutMs });
        return (await response.json()) as any;
      },
    });
    // 多 provider 兼容：非流式响应同样支持 reasoning_content / reasoning / reasoning_text / thinking_content / thought
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
      toolCalls: this.supportsTools(request) ? parseOpenAIToolCalls(data) : undefined,
    };
  }

  async chatStream(request: ChatRequest, onChunk: (chunk: StreamChunk) => void): Promise<ChatResponse> {
    const url = `${this.getBaseUrl()}/chat/completions`;
    const headers = this.getHeaders();
    // 降级重试只发生在响应头阶段（4xx 立即抛出，尚未有任何增量交给 onChunk），不会重复输出。
    const response = await sendWithParamCompat({
      modelId: request.model,
      declared: resolveRequestOptions(request).unsupportedParams,
      buildBody: (skip) => this.buildBody(request, true, skip),
      send: (body) => postJsonStream(url, body, headers, request.signal, request.timeoutMs),
    });

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
