import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../agent-core";

const mocks = vi.hoisted(() => ({
  readSqliteBackedJson: vi.fn(),
  saveSqliteBackedValue: vi.fn(),
  startAgentHost: vi.fn(),
  readAgentEvents: vi.fn(),
}));

vi.mock("./sqliteStorage", () => ({
  readSqliteBackedJson: mocks.readSqliteBackedJson,
  saveSqliteBackedValue: mocks.saveSqliteBackedValue,
}));

vi.mock("./agentHostClient", () => ({
  cancelAgentSession: vi.fn(),
  createAgentModelConfig: vi.fn(),
  createAgentSession: vi.fn(),
  ensureAgentHost: vi.fn(),
  promptAgentSession: vi.fn(),
  readAgentEvents: mocks.readAgentEvents,
  startAgentHost: mocks.startAgentHost,
  subscribeAgentHostEvents: vi.fn(),
}));

import { recoverAgentHostSession } from "./agentHostRuntime";

function completedTurnEvents(): AgentEvent[] {
  return [
    {
      seq: 1,
      sessionId: "host-1",
      at: 1,
      type: "turn/started",
      payload: { turn: 1 },
    },
    {
      seq: 2,
      sessionId: "host-1",
      at: 2,
      type: "assistant/message",
      payload: {
        turn: 1,
        step: 1,
        message: {
          id: "assistant-1",
          role: "assistant",
          createdAt: 2,
          content: [{ type: "text", text: "recovered response" }],
        },
      },
    },
    {
      seq: 3,
      sessionId: "host-1",
      at: 3,
      type: "turn/completed",
      payload: { turn: 1, reason: { kind: "completed" } },
    },
  ] as AgentEvent[];
}

describe("recoverAgentHostSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startAgentHost.mockResolvedValue({ running: true });
  });

  it("migrates the v1 string map and recovers missing turns", async () => {
    mocks.readSqliteBackedJson.mockReturnValue({
      "omni-1": "host-1",
    });
    mocks.readAgentEvents
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(completedTurnEvents());

    const messages = await recoverAgentHostSession({
      omniSessionId: "omni-1",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(mocks.startAgentHost).toHaveBeenCalledOnce();
    expect(mocks.readAgentEvents).toHaveBeenNthCalledWith(1, "host-1", undefined, 1);
    expect(mocks.readAgentEvents).toHaveBeenNthCalledWith(2, "host-1");
    expect(messages).toEqual([
      { role: "user", content: "hello" },
      expect.objectContaining({
        role: "project",
        content: "recovered response",
        agentHost: {
          sessionId: "host-1",
          turn: 1,
          completedSeq: 3,
        },
      }),
    ]);
  });

  it("does not start the Host for an unmapped Omni session", async () => {
    mocks.readSqliteBackedJson.mockReturnValue({});

    await expect(recoverAgentHostSession({
      omniSessionId: "omni-1",
      messages: [],
    })).resolves.toBeNull();

    expect(mocks.startAgentHost).not.toHaveBeenCalled();
    expect(mocks.readAgentEvents).not.toHaveBeenCalled();
  });
});
