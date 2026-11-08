import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../agent-core";
import type { Message } from "../adapters/types";
import {
  projectAgentHostTurns,
  reconcileAgentHostTurns,
} from "./agentHostProjection";

function event<T extends AgentEvent>(
  value: Omit<T, "seq" | "sessionId" | "at">,
  seq: number,
): AgentEvent {
  return {
    ...value,
    seq,
    sessionId: "host-1",
    at: seq,
  } as AgentEvent;
}

function completedEvents(): AgentEvent[] {
  return [
    event({ type: "turn/started", payload: { turn: 1 } }, 2),
    event({
      type: "request/header",
      payload: {
        turn: 1,
        config: { provider: "mock", model: "mock-model" },
        tools: ["read_file"],
      },
    }, 3),
    event({
      type: "tool/call",
      payload: {
        turn: 1,
        step: 1,
        call: { id: "call-1", name: "read_file", arguments: "{\"path\":\"a\"}" },
      },
    }, 4),
    event({
      type: "tool/result",
      payload: {
        turn: 1,
        step: 1,
        callId: "call-1",
        name: "read_file",
        isError: false,
        message: {
          id: "tool-1",
          role: "tool",
          createdAt: 4,
          content: [{ type: "text", text: "file body" }],
        },
      },
    }, 5),
    event({
      type: "assistant/message",
      payload: {
        turn: 1,
        step: 2,
        message: {
          id: "assistant-1",
          role: "assistant",
          createdAt: 6,
          content: [
            { type: "reasoning", text: "checked" },
            { type: "text", text: "finished" },
          ],
        },
        usage: {
          promptTokens: 10,
          completionTokens: 2,
          totalTokens: 12,
        },
      },
    }, 6),
    event({
      type: "turn/completed",
      payload: { turn: 1, reason: { kind: "completed" } },
    }, 7),
  ];
}

describe("Agent Host transcript projection", () => {
  it("projects final text, reasoning, tools and usage", () => {
    const [turn] = projectAgentHostTurns(completedEvents(), "host-1");

    expect(turn.agentHost).toEqual({
      sessionId: "host-1",
      turn: 1,
      completedSeq: 7,
    });
    expect(turn.message).toMatchObject({
      role: "project",
      content: "finished",
      reasoning: "checked",
      toolCallResults: [{
        id: "call-1",
        name: "read_file",
        result: "file body",
      }],
      turnUsage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        model: "mock-model",
        toolRounds: 1,
      },
    });
  });

  it("adopts an existing unmarked response before appending", () => {
    const turns = projectAgentHostTurns(completedEvents(), "host-1");
    const existing: Message[] = [
      { role: "user", content: "read a" },
      {
        role: "project",
        content: "finished",
        toolCallResults: [{
          id: "call-1",
          name: "read_file",
          arguments: "{\"path\":\"a\"}",
          result: "file body",
        }],
      },
    ];

    const result = reconcileAgentHostTurns(existing, turns, "host-1");

    expect(result.recoveredTurns).toBe(1);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1].agentHost).toEqual(turns[0].agentHost);
  });

  it("is idempotent after recovery metadata is persisted", () => {
    const turns = projectAgentHostTurns(completedEvents(), "host-1");
    const first = reconcileAgentHostTurns([{ role: "user", content: "read a" }], turns, "host-1");
    const second = reconcileAgentHostTurns(first.messages, turns, "host-1");

    expect(first.messages).toHaveLength(2);
    expect(second.messages).toEqual(first.messages);
    expect(second.recoveredTurns).toBe(0);
  });

  it("turns an interrupted orphan event stream into a visible message", () => {
    const turns = projectAgentHostTurns([
      event({ type: "turn/started", payload: { turn: 3 } }, 20),
    ], "host-1");

    expect(turns).toHaveLength(1);
    expect(turns[0].message).toMatchObject({
      role: "project",
      content: "上一轮回复在应用退出前中断，未生成可恢复内容。",
      agentHost: {
        sessionId: "host-1",
        turn: 3,
        completedSeq: 20,
      },
    });
  });
});
