import {
  addAgentUsage,
  emptyAgentUsage,
  reasoningBlocks,
  textBlocks,
  type AgentEvent,
  type AgentMessage,
} from "../agent-core";
import type {
  AgentHostTurnMetadata,
  ChatStep,
  ChatToolCallResult,
  Message,
} from "../adapters/types";

export interface RecoveredAgentHostTurn {
  agentHost: AgentHostTurnMetadata;
  message: Message;
}

interface PendingTurn {
  turn: number;
  model: string;
  finalAssistant?: AgentMessage;
  reasoning: string;
  calls: Map<string, { name: string; arguments: string }>;
  toolResults: ChatToolCallResult[];
  steps: ChatStep[];
  usage: ReturnType<typeof emptyAgentUsage>;
  sawUsage: boolean;
  completedSeq: number;
  reason?: Extract<AgentEvent, { type: "turn/completed" }>["payload"]["reason"];
}

function hasVisibleMessage(message: Message): boolean {
  return Boolean(
    message.content.trim()
      || message.reasoning?.trim()
      || message.steps?.length,
  );
}

function stripTrailingPlaceholder(messages: Message[]): Message[] {
  const last = messages[messages.length - 1];
  if (last?.role === "project" && !hasVisibleMessage(last)) {
    return messages.slice(0, -1);
  }
  return messages;
}

function createRecoveredMessage(
  turn: PendingTurn,
  orphaned: boolean,
  agentHost: AgentHostTurnMetadata,
): Message {
  const content = turn.finalAssistant ? textBlocks(turn.finalAssistant) : "";
  const reasoning = (
    turn.finalAssistant ? reasoningBlocks(turn.finalAssistant) : ""
  ) || turn.reasoning;
  const toolRounds = new Set(turn.toolResults.map((item) => item.round ?? 0)).size;
  const hasUsage = turn.sawUsage && turn.usage.totalTokens > 0;
  const interrupted = orphaned || turn.reason?.kind === "aborted";
  const failed = turn.reason?.kind === "failed";
  const fallback = interrupted
    ? "上一轮回复在应用退出前中断，未生成可恢复内容。"
    : failed
      ? `上一轮回复失败：${
          turn.reason?.kind === "failed" ? turn.reason.message : "未知错误"
        }`
      : "";

  return {
    role: "project",
    content: content || (!turn.steps.length && !reasoning ? fallback : ""),
    ...(reasoning ? { reasoning } : {}),
    ...(turn.toolResults.length ? { toolCallResults: turn.toolResults } : {}),
    ...(turn.steps.length ? { steps: turn.steps } : {}),
    ...((hasUsage || turn.toolResults.length > 0)
      ? {
          turnUsage: {
            inputTokens: turn.usage.promptTokens,
            outputTokens: turn.usage.completionTokens,
            totalTokens: turn.usage.totalTokens,
            model: turn.model,
            toolRounds,
            ...(turn.usage.cachedPromptTokens > 0
              ? { cachedPromptTokens: turn.usage.cachedPromptTokens }
              : {}),
            estimated: !turn.sawUsage,
          },
        }
      : {}),
    agentHost,
  };
}

/**
 * Reconstructs user-visible turns from durable Host events.
 *
 * `session/created.history` is intentionally ignored: those messages already
 * exist in Omni and are only an import baseline for the Host.
 */
export function projectAgentHostTurns(
  events: readonly AgentEvent[],
  sessionId: string,
): RecoveredAgentHostTurn[] {
  const turns = new Map<number, PendingTurn>();
  const started = new Set<number>();

  const ensureTurn = (turnNumber: number): PendingTurn => {
    const existing = turns.get(turnNumber);
    if (existing) return existing;
    const created: PendingTurn = {
      turn: turnNumber,
      model: "agent-host",
      reasoning: "",
      calls: new Map(),
      toolResults: [],
      steps: [],
      usage: emptyAgentUsage(),
      sawUsage: false,
      completedSeq: 0,
    };
    turns.set(turnNumber, created);
    return created;
  };

  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    switch (event.type) {
      case "turn/started": {
        started.add(event.payload.turn);
        const turn = ensureTurn(event.payload.turn);
        turn.completedSeq = Math.max(turn.completedSeq, event.seq);
        break;
      }
      case "request/header": {
        const turn = ensureTurn(event.payload.turn);
        turn.model = event.payload.config.model;
        turn.completedSeq = Math.max(turn.completedSeq, event.seq);
        break;
      }
      case "assistant/message": {
        const turn = ensureTurn(event.payload.turn);
        turn.finalAssistant = event.payload.message;
        turn.reasoning += reasoningBlocks(event.payload.message);
        addAgentUsage(turn.usage, event.payload.usage);
        if (event.payload.usage) turn.sawUsage = true;
        turn.completedSeq = Math.max(turn.completedSeq, event.seq);
        break;
      }
      case "tool/call": {
        const turn = ensureTurn(event.payload.turn);
        turn.calls.set(event.payload.call.id, {
          name: event.payload.call.name,
          arguments: event.payload.call.arguments,
        });
        turn.completedSeq = Math.max(turn.completedSeq, event.seq);
        break;
      }
      case "tool/result": {
        const turn = ensureTurn(event.payload.turn);
        const call = turn.calls.get(event.payload.callId);
        const result = textBlocks(event.payload.message);
        turn.toolResults.push({
          id: event.payload.callId,
          name: event.payload.name,
          arguments: call?.arguments ?? "",
          result,
          isError: event.payload.isError,
          round: event.payload.step,
        });
        turn.steps.push({
          type: "tool_call",
          name: event.payload.name,
          arguments: call?.arguments ?? "",
          result,
          ...(event.payload.isError ? { isError: true } : {}),
        });
        turn.completedSeq = Math.max(turn.completedSeq, event.seq);
        break;
      }
      case "turn/completed": {
        const turn = ensureTurn(event.payload.turn);
        turn.reason = event.payload.reason;
        turn.completedSeq = event.seq;
        break;
      }
      default:
        break;
    }
  }

  return [...turns.values()]
    .filter((turn) => started.has(turn.turn))
    .sort((left, right) => left.turn - right.turn)
    .map((turn) => {
      const agentHost = {
        sessionId,
        turn: turn.turn,
        completedSeq: turn.completedSeq,
      };
      return {
        agentHost,
        message: createRecoveredMessage(
          turn,
          turn.reason === undefined,
          agentHost,
        ),
      };
    });
}

function hasProjectedTurn(
  message: Message,
  sessionId: string,
  turn: number,
): boolean {
  return (
    message.agentHost?.sessionId === sessionId
    && message.agentHost.turn === turn
  );
}

function tryMatchExistingTurn(
  messages: Message[],
  projected: RecoveredAgentHostTurn,
): number | undefined {
  const expected = projected.message;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate.role !== "project" || candidate.agentHost) continue;
    if (candidate.content !== expected.content) continue;
    const candidateTools = candidate.toolCallResults?.map((item) => item.id).join(",") ?? "";
    const expectedTools = expected.toolCallResults?.map((item) => item.id).join(",") ?? "";
    if (candidateTools !== expectedTools) continue;
    return index;
  }
  return undefined;
}

/**
 * Merges projected Host turns into an existing Omni transcript.
 *
 * Existing unmarked replies are adopted before appending, so upgrading from
 * the first Host implementation does not duplicate the previous response.
 */
export function reconcileAgentHostTurns(
  messages: readonly Message[],
  turns: readonly RecoveredAgentHostTurn[],
  sessionId: string,
): { messages: Message[]; recoveredTurns: number } {
  let next = stripTrailingPlaceholder(messages.map((message) => ({ ...message })));
  let recoveredTurns = 0;

  for (const turn of turns) {
    const existing = next.findIndex((message) =>
      hasProjectedTurn(message, sessionId, turn.agentHost.turn)
    );
    if (existing >= 0) continue;

    const matched = tryMatchExistingTurn(next, turn);
    if (matched !== undefined) {
      next[matched] = {
        ...next[matched],
        agentHost: turn.agentHost,
      };
      recoveredTurns += 1;
      continue;
    }

    next = [...next, turn.message];
    recoveredTurns += 1;
  }

  return { messages: next, recoveredTurns };
}
