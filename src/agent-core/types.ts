export type AgentSessionId = string;

export type AgentContentBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; call: AgentToolCall };

export type AgentMessageRole = "user" | "assistant" | "tool";

export interface AgentMessage {
  id: string;
  role: AgentMessageRole;
  content: AgentContentBlock[];
  createdAt: number;
  source?: Record<string, unknown>;
}

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AgentToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AgentTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens?: number;
  reasoningTokens?: number;
}

export interface AgentModelConfig {
  provider: string;
  model: string;
  reasoningEffort?: "off" | "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
  temperature?: number;
}

/**
 * User input accepted by the agent inbox.
 *
 * Queue entries stay serializable so the same payload can be persisted,
 * replayed, and transported over Host RPC without leaking in-process promise
 * functions into the event log.
 */
export interface AgentPrompt {
  id: string;
  content: string;
  config: AgentModelConfig;
  system?: string;
}

export interface AgentUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens: number;
  reasoningTokens: number;
  exact: boolean;
}

export function emptyAgentUsage(): AgentUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedPromptTokens: 0,
    reasoningTokens: 0,
    exact: true,
  };
}

export function addAgentUsage(target: AgentUsage, usage: AgentTokenUsage | undefined): void {
  if (!usage) {
    target.exact = false;
    return;
  }
  target.promptTokens += usage.promptTokens;
  target.completionTokens += usage.completionTokens;
  target.totalTokens += usage.totalTokens;
  target.cachedPromptTokens += usage.cachedPromptTokens ?? 0;
  target.reasoningTokens += usage.reasoningTokens ?? 0;
}

export function textBlocks(message: AgentMessage): string {
  return message.content
    .filter((block): block is Extract<AgentContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export function reasoningBlocks(message: AgentMessage): string {
  return message.content
    .filter((block): block is Extract<AgentContentBlock, { type: "reasoning" }> => block.type === "reasoning")
    .map((block) => block.text)
    .join("");
}

export function toolCallBlocks(message: AgentMessage): AgentToolCall[] {
  return message.content
    .filter((block): block is Extract<AgentContentBlock, { type: "tool-call" }> => block.type === "tool-call")
    .map((block) => block.call);
}
