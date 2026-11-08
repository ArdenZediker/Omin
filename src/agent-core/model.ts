import type {
  AgentMessage,
  AgentModelConfig,
  AgentTokenUsage,
  AgentToolCall,
  AgentToolSchema,
} from "./types";

export type ModelFinishReason =
  | { kind: "stop" }
  | { kind: "tool-calls"; calls: AgentToolCall[] }
  | { kind: "max-tokens" };

export type ModelStreamEvent =
  | { type: "reasoning-delta"; text: string }
  | { type: "text-delta"; text: string }
  | { type: "usage"; usage: AgentTokenUsage }
  | { type: "finish"; reason: ModelFinishReason };

export interface ModelRequest {
  sessionId: string;
  turn: number;
  step: number;
  messages: AgentMessage[];
  system?: string;
  tools: AgentToolSchema[];
  config: AgentModelConfig;
  signal: AbortSignal;
}

export interface ModelProvider {
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}
