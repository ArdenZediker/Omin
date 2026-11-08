import type {
  AgentMessage,
  AgentModelConfig,
  AgentPrompt,
  AgentSessionId,
  AgentTokenUsage,
  AgentToolCall,
} from "./types";

export type AgentTurnEndReason =
  | { kind: "completed" }
  | { kind: "max-tokens" }
  | { kind: "aborted"; message?: string }
  | { kind: "failed"; code: string; message: string };

export type AgentStepEndReason =
  | { kind: "completed" }
  | { kind: "tools"; count: number }
  | { kind: "max-tokens" }
  | { kind: "aborted"; message?: string };

export type AgentStreamChunk =
  | { type: "reasoning-delta"; text: string }
  | { type: "text-delta"; text: string };

interface AgentEventBase<TType extends string, TPayload> {
  seq: number;
  sessionId: AgentSessionId;
  type: TType;
  at: number;
  payload: TPayload;
}

export type AgentEvent =
  | AgentEventBase<"session/created", {
      cwd: string;
      title?: string;
      /** Existing conversation imported from the Omni store when the Host session was created. */
      history?: AgentMessage[];
    }>
  | AgentEventBase<"agent/status", {
      status: "idle" | "running";
    }>
  | AgentEventBase<"agent/inbox/spliced", {
      target: "next-turn" | "next-step";
      start: number;
      removedCount?: number;
      inserted: AgentPrompt[];
      outcome?: "claimed" | "cancelled";
    }>
  | AgentEventBase<"request/header", {
      turn: number;
      config: AgentModelConfig;
      system?: string;
      tools: string[];
    }>
  | AgentEventBase<"turn/started", {
      turn: number;
    }>
  | AgentEventBase<"step/started", {
      turn: number;
      step: number;
    }>
  | AgentEventBase<"user/message", {
      turn: number;
      step: number;
      message: AgentMessage;
    }>
  | AgentEventBase<"assistant/chunk", {
      turn: number;
      step: number;
      chunk: AgentStreamChunk;
    }>
  | AgentEventBase<"assistant/message", {
      turn: number;
      step: number;
      message: AgentMessage;
      usage?: AgentTokenUsage;
      interrupted?: boolean;
    }>
  | AgentEventBase<"tool/call", {
      turn: number;
      step: number;
      call: AgentToolCall;
    }>
  | AgentEventBase<"tool/result", {
      turn: number;
      step: number;
      message: AgentMessage;
      callId: string;
      name: string;
      isError: boolean;
    }>
  | AgentEventBase<"step/completed", {
      turn: number;
      step: number;
      reason: AgentStepEndReason;
    }>
  | AgentEventBase<"turn/completed", {
      turn: number;
      reason: AgentTurnEndReason;
    }>;

export type AgentEventType = AgentEvent["type"];

export type AgentEventOf<TType extends AgentEventType> = Extract<AgentEvent, { type: TType }>;

export type AgentEventDraft<TType extends AgentEventType> = Omit<
  AgentEventOf<TType>,
  "seq" | "sessionId" | "at"
> & {
  at?: number;
};
