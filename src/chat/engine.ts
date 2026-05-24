import { modelRegistry } from "../adapters/registry";
import type { Message } from "../adapters/types";
import { getUsagePreferences } from "./storage";
import type { ChatExecutionResult } from "./types";
import { buildKnowledgeContextBlock } from "./knowledgeContext";

const DEFAULT_SYSTEM_PROMPT =
  "You are Omni, a helpful, knowledgeable AI assistant. Be concise and clear. Use markdown when useful.";

const MODEL_PRICING_USD_PER_1K: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 0.005, output: 0.015 },
  "gpt-4o-mini": { input: 0.00015, output: 0.0006 },
  "o1": { input: 0.015, output: 0.06 },
  "o3-mini": { input: 0.0011, output: 0.0044 },
  "claude-sonnet-4-20250514": { input: 0.003, output: 0.015 },
  "claude-opus-4-20250514": { input: 0.015, output: 0.075 },
  "gemini-2.5-pro": { input: 0.00125, output: 0.01 },
  "gemini-2.5-flash": { input: 0.0003, output: 0.0025 },
  "deepseek-chat": { input: 0.00027, output: 0.0011 },
  "deepseek-reasoner": { input: 0.00055, output: 0.00219 },
};

function estimateTokens(text: string) {
  const normalized = text.trim();
  if (!normalized) return 0;
  return Math.max(1, Math.ceil(normalized.length / 4));
}

function estimatePromptTokens(messages: Message[]) {
  return messages.reduce((total, message) => {
    const imageTokens = (message.images?.length ?? 0) * 256;
    return total + estimateTokens(message.content) + imageTokens;
  }, 0);
}

function estimateCost(model: string, promptTokens: number, completionTokens: number) {
  const pricing = MODEL_PRICING_USD_PER_1K[model];
  if (!pricing) return 0;
  return (promptTokens / 1000) * pricing.input + (completionTokens / 1000) * pricing.output;
}

export async function executeChatTurn(options: {
  model: string;
  messages: Message[];
  signal?: AbortSignal;
  systemPrompt?: string;
  onChunk?: (chunk: string) => void;
  knowledgeQuery?: string | null;
  enableKnowledgeContext?: boolean;
}): Promise<ChatExecutionResult> {
  const {
    model,
    messages,
    signal,
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    onChunk,
    knowledgeQuery,
    enableKnowledgeContext = true,
  } = options;

  if (signal?.aborted) {
    throw new DOMException("Request aborted", "AbortError");
  }

  const registeredProviders = modelRegistry.getRegisteredProviders();
  if (registeredProviders.length === 0) {
    throw new Error("请先配置至少一个提供方");
  }

  const adapter = modelRegistry.getAdapterForModel(model);
  if (!adapter) {
    throw new Error(`模型 "${model}" 对应的提供方尚未配置`);
  }

  const modelConfig = modelRegistry.getModelConfig(model);
  const preferences = getUsagePreferences();
  const hasImages = messages.some((message) => (message.images?.length ?? 0) > 0);
  if (hasImages && (!modelConfig?.supportsVision || !preferences.enableVisionInput)) {
    throw new Error("当前模型或偏好设置不允许图片输入");
  }

  const knowledgeContext =
    enableKnowledgeContext && !signal?.aborted
      ? await buildKnowledgeContextBlock({
          model,
          messages,
          knowledgeQuery,
          signal,
        })
      : null;

  const systemMessage: Message = { role: "system", content: systemPrompt };
  const knowledgeMessages: Message[] = knowledgeContext
    ? [{ role: "system", content: knowledgeContext.block }]
    : [];
  const requestMessages: Message[] = [systemMessage, ...knowledgeMessages, ...messages];
  const shouldStream = Boolean(modelConfig?.supportsStreaming && preferences.enableStreaming && onChunk);

  if (shouldStream) {
    let streamedContent = "";
    const response = await modelRegistry.chatStream(
      {
        messages: requestMessages,
        model,
        temperature: preferences.temperature,
        maxTokens: preferences.maxOutputTokens,
        stream: true,
      },
      (chunk) => {
        if (signal?.aborted) {
          return;
        }
        if (chunk.done) return;
        streamedContent += chunk.content;
        onChunk?.(chunk.content);
      }
    );

    if (signal?.aborted) {
      throw new DOMException("Request aborted", "AbortError");
    }

    const promptTokens = estimatePromptTokens(requestMessages);
    const completionTokens = estimateTokens(streamedContent || response.content);
    return {
      content: streamedContent || response.content,
      model: response.model,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      estimated: true,
      costUsd: estimateCost(model, promptTokens, completionTokens),
      knowledgeContext: knowledgeContext ?? null,
    };
  }

  const response = await modelRegistry.chat({
    messages: requestMessages,
    model,
    temperature: preferences.temperature,
    maxTokens: preferences.maxOutputTokens,
    stream: false,
  });

  if (signal?.aborted) {
    throw new DOMException("Request aborted", "AbortError");
  }

  const promptTokens = response.usage?.promptTokens ?? estimatePromptTokens(requestMessages);
  const completionTokens = response.usage?.completionTokens ?? estimateTokens(response.content);
  return {
    content: response.content,
    model: response.model,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: response.usage?.totalTokens ?? promptTokens + completionTokens,
    },
    estimated: !response.usage,
    costUsd: estimateCost(model, promptTokens, completionTokens),
    knowledgeContext: knowledgeContext ?? null,
  };
}
