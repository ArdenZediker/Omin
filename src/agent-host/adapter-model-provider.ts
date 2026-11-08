import type {
  AgentMessage,
  AgentTokenUsage,
  AgentToolCall,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
} from "../agent-core";
import {
  reasoningBlocks,
  textBlocks,
  toolCallBlocks,
} from "../agent-core";
import { ClaudeAdapter } from "../adapters/claude";
import { DeepSeekAdapter } from "../adapters/deepseek";
import { GeminiAdapter } from "../adapters/gemini";
import { OllamaAdapter } from "../adapters/ollama";
import { OpenAIAdapter } from "../adapters/openai";
import {
  ReasoningEffort,
  type ChatRequest,
  type Message,
  type ModelAdapter,
  type ModelProtocol,
  type ProviderConfig,
  type StreamChunk,
} from "../adapters/types";
import type {
  AgentProviderRegistry,
  AgentProviderSettings,
  AgentProviderStatus,
} from "./provider-settings";

export type ProviderAdapterFactory = (
  provider: string,
  protocol: ModelProtocol,
  config: ProviderConfig,
) => ModelAdapter;

function defaultAdapterFactory(
  provider: string,
  protocol: ModelProtocol,
  config: ProviderConfig,
): ModelAdapter {
  if (provider === "deepseek" && protocol === "openai") {
    return new DeepSeekAdapter(config);
  }
  switch (protocol) {
    case "openai":
      return new OpenAIAdapter(config);
    case "claude":
      return new ClaudeAdapter(config);
    case "gemini":
      return new GeminiAdapter(config);
    case "ollama":
      return new OllamaAdapter(config);
  }
}

const DEFAULT_PROTOCOL: ModelProtocol = "openai";

function resolveProtocol(settings: AgentProviderSettings): ModelProtocol {
  if (settings.protocol) return settings.protocol;
  if (settings.provider === "claude" || settings.provider === "gemini" || settings.provider === "ollama") {
    return settings.provider;
  }
  return DEFAULT_PROTOCOL;
}

function toChatMessage(message: AgentMessage): Message {
  const content = textBlocks(message);
  const images = message.content
    .filter((block): block is Extract<typeof block, { type: "image" }> => block.type === "image")
    .map((block) => block.image);
  if (message.role === "assistant") {
    const calls = toolCallBlocks(message);
    return {
      role: "assistant",
      content,
      reasoning: reasoningBlocks(message) || undefined,
      ...(images.length > 0 ? { images } : {}),
      ...(calls.length > 0
        ? {
            toolCalls: calls.map((call) => ({
              id: call.id,
              name: call.name,
              arguments: call.arguments,
            })),
          }
        : {}),
    };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      content,
      ...(typeof message.source?.callId === "string"
        ? { toolCallId: message.source.callId }
        : {}),
      ...(typeof message.source?.name === "string"
        ? { toolCallName: message.source.name }
        : {}),
    };
  }
  return {
    role: "user",
    content,
    ...(images.length > 0 ? { images } : {}),
  };
}

function toChatRequest(request: ModelRequest): ChatRequest {
  const messages: Message[] = [
    ...(request.system ? [{ role: "system" as const, content: request.system }] : []),
    ...request.messages.map(toChatMessage),
  ];
  const reasoningEffort = (() => {
    switch (request.config.reasoningEffort) {
      case "low":
        return ReasoningEffort.Low;
      case "medium":
        return ReasoningEffort.Medium;
      case "high":
        return ReasoningEffort.High;
      case "xhigh":
        return ReasoningEffort.XHigh;
      case "max":
        return ReasoningEffort.Max;
      default:
        return undefined;
    }
  })();
  return {
    messages,
    model: request.config.model,
    signal: request.signal,
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
    options: {
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(request.config.maxTokens === undefined
        ? {}
        : { maxTokens: request.config.maxTokens }),
      ...(request.config.temperature === undefined
        ? {}
        : { temperature: request.config.temperature }),
    },
  };
}

function toUsage(usage: {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens?: number;
} | undefined): AgentTokenUsage | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    ...(usage.cachedPromptTokens === undefined
      ? {}
      : { cachedPromptTokens: usage.cachedPromptTokens }),
  };
}

type QueueItem =
  | { kind: "event"; event: ModelStreamEvent }
  | { kind: "end" };

/**
 * Adapts Omni's wire-level model adapters to the Agent Core model contract.
 *
 * Provider credentials stay in Host memory. Only the provider name and model
 * configuration are persisted in the session event log.
 */
export class AdapterModelProvider implements ModelProvider, AgentProviderRegistry {
  private readonly adapters = new Map<string, {
    adapter: ModelAdapter;
    protocol: ModelProtocol;
    baseUrl?: string;
    hasApiKey: boolean;
  }>();

  constructor(
    private readonly adapterFactory: ProviderAdapterFactory = defaultAdapterFactory,
  ) {}

  configureProvider(settings: AgentProviderSettings): AgentProviderStatus {
    const provider = settings.provider.trim();
    if (!provider) throw new Error("provider name must not be empty");
    const protocol = resolveProtocol(settings);
    const config: ProviderConfig = {
      apiKey: settings.apiKey,
      ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
      ...(settings.customHeaders
        ? { customHeaders: settings.customHeaders }
        : {}),
      protocol,
    };
    const adapter = this.adapterFactory(provider, protocol, config);
    this.adapters.set(provider, {
      adapter,
      protocol,
      ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
      hasApiKey: settings.apiKey.length > 0,
    });
    return this.status(provider);
  }

  removeProvider(provider: string): boolean {
    return this.adapters.delete(provider);
  }

  listProviders(): AgentProviderStatus[] {
    return [...this.adapters.keys()]
      .sort((left, right) => left.localeCompare(right))
      .map((provider) => this.status(provider));
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const registration = this.adapters.get(request.config.provider);
    if (!registration) {
      throw new Error(
        `model provider "${request.config.provider}" is not configured`,
      );
    }

    const queue: QueueItem[] = [];
    let wake: (() => void) | undefined;
    let failure: unknown;
    const notify = () => {
      const resolve = wake;
      wake = undefined;
      resolve?.();
    };
    const emit = (event: ModelStreamEvent) => {
      queue.push({ kind: "event", event });
      notify();
    };

    const completion = registration.adapter.chatStream(
      toChatRequest(request),
      (chunk: StreamChunk) => {
        if (chunk.reasoning) {
          emit({ type: "reasoning-delta", text: chunk.reasoning });
        }
        if (chunk.content) {
          emit({ type: "text-delta", text: chunk.content });
        }
      },
    ).then((response) => {
      const usage = toUsage(response.usage);
      if (usage) emit({ type: "usage", usage });
      const calls: AgentToolCall[] = (response.toolCalls ?? []).map((call) => ({
        id: call.id || crypto.randomUUID(),
        name: call.name,
        arguments: call.arguments,
      }));
      emit({
        type: "finish",
        reason: calls.length > 0
          ? { kind: "tool-calls", calls }
          : { kind: "stop" },
      });
    }).catch((error: unknown) => {
      failure = error;
    }).finally(() => {
      queue.push({ kind: "end" });
      notify();
    });

    try {
      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        const item = queue.shift();
        if (!item) continue;
        if (item.kind === "end") break;
        yield item.event;
      }
      await completion;
      if (failure) throw failure;
    } finally {
      if (request.signal.aborted) {
        void completion.catch(() => undefined);
      }
    }
  }

  private status(provider: string): AgentProviderStatus {
    const registration = this.adapters.get(provider);
    if (!registration) throw new Error(`provider "${provider}" is not configured`);
    return {
      provider,
      protocol: registration.protocol,
      ...(registration.baseUrl ? { baseUrl: registration.baseUrl } : {}),
      hasApiKey: registration.hasApiKey,
    };
  }
}
