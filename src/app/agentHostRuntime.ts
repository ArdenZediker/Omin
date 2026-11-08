import type {
  AgentContentBlock,
  AgentEvent,
  AgentMessage,
  AgentUsage,
} from "../agent-core";
import {
  addAgentUsage,
  emptyAgentUsage,
  reasoningBlocks,
  textBlocks,
} from "../agent-core";
import type {
  Message,
  TokenUsage,
} from "../adapters/types";
import { getModelPricing } from "../adapters/modelCatalog";
import { estimatePromptTokens, estimateTokens } from "../chat/tokenEstimator";
import type {
  ChatExecutionResult,
  ChatStep,
  ChatToolCallResult,
} from "../chat/types";
import { readSqliteBackedJson, saveSqliteBackedValue } from "./sqliteStorage";
import {
  cancelAgentSession,
  createAgentModelConfig,
  createAgentSession,
  ensureAgentHost,
  promptAgentSession,
  readAgentEvents,
  subscribeAgentHostEvents,
} from "./agentHostClient";

export const AGENT_HOST_SESSION_MAP_KEY = "omni_agent_host_sessions_v1";

type SessionMap = Record<string, string>;

export interface AgentHostTurnOptions {
  omniSessionId: string | null;
  cwd: string;
  title?: string;
  history: Message[];
  prompt: string;
  modelId: string;
  system?: string;
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void;
  onReasoning?: (reasoning: string) => void;
  onToolStep?: (step: ChatStep) => void;
}

function readSessionMap(): SessionMap {
  return readSqliteBackedJson<SessionMap>(AGENT_HOST_SESSION_MAP_KEY, {});
}

function writeSessionMap(map: SessionMap): void {
  saveSqliteBackedValue(AGENT_HOST_SESSION_MAP_KEY, JSON.stringify(map));
}

function messageBlocks(message: Message): AgentContentBlock[] {
  const blocks: AgentContentBlock[] = [];
  if (message.reasoning?.trim()) {
    blocks.push({ type: "reasoning", text: message.reasoning });
  }
  if (message.content.trim()) {
    blocks.push({ type: "text", text: message.content });
  }
  for (const call of message.toolCalls ?? []) {
    blocks.push({
      type: "tool-call",
      call: {
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      },
    });
  }
  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "" });
  }
  return blocks;
}

/**
 * Converts Omni's persisted chat transcript to the Host's neutral message
 * shape. Images remain in the Omni transcript but are intentionally excluded
 * from this text bridge; callers should keep vision turns on the legacy engine
 * until the Host protocol has an image content block.
 */
export function toAgentHostHistory(messages: Message[]): AgentMessage[] {
  const history: AgentMessage[] = [];
  messages.forEach((message, index) => {
    if (message.role === "system") return;
    history.push({
      id: `omni-history-${index}-${message.role}`,
      role: message.role === "project" ? "assistant" : message.role,
      content: messageBlocks(message),
      createdAt: Date.now(),
      ...(message.role === "tool"
        ? {
            source: {
              ...(message.toolCallId ? { callId: message.toolCallId } : {}),
              ...(message.toolCallName ? { name: message.toolCallName } : {}),
            },
          }
        : {}),
    });
  });
  return history;
}

async function hostSessionExists(sessionId: string): Promise<boolean> {
  try {
    await readAgentEvents(sessionId, undefined, 1);
    return true;
  } catch {
    return false;
  }
}

async function getOrCreateHostSession(options: {
  omniSessionId: string | null;
  cwd: string;
  title?: string;
  history: Message[];
}): Promise<string> {
  const map = readSessionMap();
  if (options.omniSessionId) {
    const existing = map[options.omniSessionId];
    if (existing && await hostSessionExists(existing)) {
      return existing;
    }
    if (existing) delete map[options.omniSessionId];
  }

  const hostSessionId = await createAgentSession(
    options.cwd,
    options.title,
    toAgentHostHistory(options.history),
  );
  if (options.omniSessionId) {
    map[options.omniSessionId] = hostSessionId;
    writeSessionMap(map);
  }
  return hostSessionId;
}

function tokenUsageFromAgentUsage(usage: AgentUsage): TokenUsage {
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    ...(usage.cachedPromptTokens > 0 ? { cachedPromptTokens: usage.cachedPromptTokens } : {}),
  };
}

function estimateCostUsd(modelId: string, usage: TokenUsage): number {
  const pricing = getModelPricing(modelId);
  if (!pricing) return 0;
  return (
    (usage.promptTokens * (pricing.input ?? 0))
    + (usage.completionTokens * (pricing.output ?? 0))
  ) / 1_000_000;
}

function eventMessageText(event: Extract<AgentEvent, { type: "tool/result" }>): string {
  return textBlocks(event.payload.message);
}

/**
 * Executes one Host turn and projects its durable events back into the existing
 * Omni chat result contract. The Host remains the owner of turn state and tool
 * scheduling; this function is only an event adapter for the React UI.
 */
export async function runAgentHostTurn(options: AgentHostTurnOptions): Promise<ChatExecutionResult> {
  if (options.signal?.aborted) {
    throw new DOMException("Request aborted", "AbortError");
  }

  await ensureAgentHost();
  const hostSessionId = await getOrCreateHostSession({
    omniSessionId: options.omniSessionId,
    cwd: options.cwd,
    title: options.title,
    history: options.history,
  });

  const startedAt = performance.now();
  const usage = emptyAgentUsage();
  usage.exact = false;
  let reasoning = "";
  let finalAssistant: AgentMessage | undefined;
  let closed = false;
  const toolSteps: ChatStep[] = [];
  const toolResults: ChatToolCallResult[] = [];
  const pendingCalls = new Map<string, { name: string; arguments: string }>();
  let resolveTurn!: (result: ChatExecutionResult) => void;
  let rejectTurn!: (error: unknown) => void;
  let unlisten: (() => void) | undefined;
  const resultPromise = new Promise<ChatExecutionResult>((resolve, reject) => {
    resolveTurn = resolve;
    rejectTurn = reject;
  });

  const cleanup = () => {
    if (closed) return;
    closed = true;
    unlisten?.();
    options.signal?.removeEventListener("abort", onAbort);
  };
  const settleRejected = (error: unknown) => {
    cleanup();
    rejectTurn(error);
  };
  const onAbort = () => {
    void cancelAgentSession(hostSessionId, "cancelled by UI");
    settleRejected(new DOMException("Request aborted", "AbortError"));
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    unlisten = await subscribeAgentHostEvents((notification) => {
      if (closed || notification.kind !== "event") return;
      const event = notification.event;
      if (event.sessionId !== hostSessionId) return;

      switch (event.type) {
        case "assistant/chunk":
          if (event.payload.chunk.type === "text-delta") {
            options.onChunk?.(event.payload.chunk.text);
          } else {
            reasoning += event.payload.chunk.text;
            options.onReasoning?.(event.payload.chunk.text);
          }
          break;
        case "assistant/message":
          finalAssistant = event.payload.message;
          if (event.payload.usage) addAgentUsage(usage, event.payload.usage);
          break;
        case "tool/call":
          pendingCalls.set(event.payload.call.id, {
            name: event.payload.call.name,
            arguments: event.payload.call.arguments,
          });
          break;
        case "tool/result": {
          const call = pendingCalls.get(event.payload.callId);
          const text = eventMessageText(event);
          toolResults.push({
            id: event.payload.callId,
            name: event.payload.name,
            arguments: call?.arguments ?? "",
            result: text,
            isError: event.payload.isError,
            round: event.payload.step,
          });
          const step: ChatStep = {
            type: "tool_call",
            name: event.payload.name,
            arguments: call?.arguments ?? "",
            result: text,
            isError: event.payload.isError,
          };
          toolSteps.push(step);
          options.onToolStep?.(step);
          break;
        }
        case "turn/completed":
          if (event.payload.reason.kind === "aborted") {
            settleRejected(new DOMException("Request aborted", "AbortError"));
            return;
          }
          if (event.payload.reason.kind === "failed") {
            settleRejected(new Error(event.payload.reason.message));
            return;
          }
          cleanup();
          {
            const content = finalAssistant ? textBlocks(finalAssistant) : "";
            const assistantReasoning = finalAssistant ? reasoningBlocks(finalAssistant) : "";
            if (!reasoning && assistantReasoning) reasoning = assistantReasoning;
            if (usage.totalTokens === 0) {
              usage.promptTokens = estimatePromptTokens(options.history);
              usage.completionTokens = estimateTokens(content);
              usage.totalTokens = usage.promptTokens + usage.completionTokens;
              usage.exact = false;
            }
            const tokenUsage = tokenUsageFromAgentUsage(usage);
            const toolRounds = new Set(toolResults.map((item) => item.round)).size;
            const elapsed = performance.now() - startedAt;
            resolveTurn({
              content,
              model: options.modelId,
              usage: tokenUsage,
              estimated: !usage.exact,
              costUsd: estimateCostUsd(options.modelId, tokenUsage),
              ...(reasoning ? { reasoning } : {}),
              ...(toolRounds > 0 ? { toolRounds } : {}),
              ...(toolResults.length ? { toolCallResults: toolResults } : {}),
              ...(toolSteps.length ? { steps: toolSteps } : {}),
              generationDurationMs: elapsed,
              modelDurationMs: elapsed,
            });
          }
          break;
        default:
          break;
      }
    });
  } catch (error: unknown) {
    settleRejected(error instanceof Error ? error : new Error(String(error)));
    return resultPromise;
  }

  if (closed) {
    unlisten();
    return resultPromise;
  }
  try {
    await promptAgentSession(
      hostSessionId,
      options.prompt,
      createAgentModelConfig(options.modelId),
      options.system,
    );
  } catch (error: unknown) {
    settleRejected(error instanceof Error ? error : new Error(String(error)));
  }
  return resultPromise;
}
