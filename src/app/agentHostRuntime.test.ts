import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../agent-core";

const mocks = vi.hoisted(() => ({
  cancelAgentSession: vi.fn(),
  configureAgentSessionTools: vi.fn(),
  createAgentModelConfig: vi.fn(),
  createAgentSession: vi.fn(),
  deleteAgentSession: vi.fn(),
  ensureAgentHost: vi.fn(),
  failAgentHostClientToolCall: vi.fn(),
  promptAgentSession: vi.fn(),
  readSqliteBackedJson: vi.fn(),
  readAgentEvents: vi.fn(),
  respondAgentHostClientToolCall: vi.fn(),
  saveSqliteBackedValue: vi.fn(),
  startAgentHost: vi.fn(),
  subscribeAgentHostClientToolCalls: vi.fn(),
  subscribeAgentHostEvents: vi.fn(),
}));

vi.mock("./sqliteStorage", () => ({
  readSqliteBackedJson: mocks.readSqliteBackedJson,
  saveSqliteBackedValue: mocks.saveSqliteBackedValue,
}));

vi.mock("./agentHostClient", () => ({
  cancelAgentSession: mocks.cancelAgentSession,
  configureAgentSessionTools: mocks.configureAgentSessionTools,
  createAgentModelConfig: mocks.createAgentModelConfig,
  createAgentSession: mocks.createAgentSession,
  deleteAgentSession: mocks.deleteAgentSession,
  ensureAgentHost: mocks.ensureAgentHost,
  failAgentHostClientToolCall: mocks.failAgentHostClientToolCall,
  promptAgentSession: mocks.promptAgentSession,
  readAgentEvents: mocks.readAgentEvents,
  respondAgentHostClientToolCall: mocks.respondAgentHostClientToolCall,
  startAgentHost: mocks.startAgentHost,
  subscribeAgentHostClientToolCalls: mocks.subscribeAgentHostClientToolCalls,
  subscribeAgentHostEvents: mocks.subscribeAgentHostEvents,
}));

import {
  deleteAgentHostSession,
  recoverAgentHostSession,
  runAgentHostTurn,
} from "./agentHostRuntime";

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

describe("deleteAgentHostSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startAgentHost.mockResolvedValue({ running: true });
    mocks.deleteAgentSession.mockResolvedValue(true);
  });

  it("clears the Omni mapping and deletes the durable Host session", async () => {
    mocks.readSqliteBackedJson.mockReturnValue({
      "omni-1": { hostSessionId: "host-1" },
      "omni-2": { hostSessionId: "host-2" },
    });

    await deleteAgentHostSession("omni-1");

    expect(mocks.startAgentHost).toHaveBeenCalledOnce();
    expect(mocks.deleteAgentSession).toHaveBeenCalledWith("host-1");
    expect(mocks.saveSqliteBackedValue).toHaveBeenCalledWith(
      "omni_agent_host_sessions_v1",
      JSON.stringify({ "omni-2": { hostSessionId: "host-2" } }),
    );
  });

  it("does not start the Host for an unmapped session", async () => {
    mocks.readSqliteBackedJson.mockReturnValue({});

    await deleteAgentHostSession("omni-1");

    expect(mocks.startAgentHost).not.toHaveBeenCalled();
    expect(mocks.deleteAgentSession).not.toHaveBeenCalled();
    expect(mocks.saveSqliteBackedValue).not.toHaveBeenCalled();
  });
});

describe("runAgentHostTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readSqliteBackedJson.mockReturnValue({});
    mocks.ensureAgentHost.mockResolvedValue({ running: true });
    mocks.createAgentSession.mockResolvedValue("host-new");
    mocks.createAgentModelConfig.mockReturnValue({
      provider: "mock",
      model: "mock-model",
    });
  });

  it("uses the full session tool catalog and delegates client tools", async () => {
    let eventListener: ((message: unknown) => void) | undefined;
    let clientToolListener: ((call: unknown) => void) | undefined;
    mocks.subscribeAgentHostEvents.mockImplementation(async (listener) => {
      eventListener = listener;
      return () => undefined;
    });
    mocks.subscribeAgentHostClientToolCalls.mockImplementation(async (listener) => {
      clientToolListener = listener;
      return () => undefined;
    });
    mocks.promptAgentSession.mockImplementation(async () => {
      queueMicrotask(() => clientToolListener?.({
        kind: "native-tool-call",
        id: "client-call-1",
        tool: "todo_write",
        arguments: "{\"todos\":[]}",
        sessionId: "host-new",
        turn: 1,
        step: 1,
      }));
      return "prompt-1";
    });
    mocks.respondAgentHostClientToolCall.mockImplementation(async () => {
      const events = [
        {
          seq: 1,
          sessionId: "host-new",
          at: 1,
          type: "tool/call",
          payload: {
            turn: 1,
            step: 1,
            call: {
              id: "client-call-1",
              name: "todo_write",
              arguments: "{\"todos\":[]}",
            },
          },
        },
        {
          seq: 2,
          sessionId: "host-new",
          at: 2,
          type: "tool/result",
          payload: {
            turn: 1,
            step: 1,
            callId: "client-call-1",
            name: "todo_write",
            isError: false,
            message: {
              id: "tool-result-1",
              role: "tool",
              createdAt: 2,
              content: [{ type: "text", text: "todos updated" }],
            },
          },
        },
        {
          seq: 3,
          sessionId: "host-new",
          at: 3,
          type: "assistant/message",
          payload: {
            turn: 1,
            step: 2,
            message: {
              id: "assistant-1",
              role: "assistant",
              createdAt: 3,
              content: [{ type: "text", text: "done" }],
            },
          },
        },
        {
          seq: 4,
          sessionId: "host-new",
          at: 4,
          type: "turn/completed",
          payload: { turn: 1, reason: { kind: "completed" } },
        },
      ] as AgentEvent[];
      for (const event of events) {
        eventListener?.({ kind: "event", event });
      }
    });
    const clientCall = vi.fn(async () => ({
      outputText: "todos updated",
      path: "D:/workspace/TODO.md",
      artifact: { artifactId: "artifact-1", title: "TODO" },
    }));

    const result = await runAgentHostTurn({
      omniSessionId: "omni-session",
      cwd: "D:/workspace",
      history: [],
      prompt: "plan",
      modelId: "mock-model",
      tools: [{
        name: "todo_write",
        description: "Write todos",
        parameters: { type: "object" },
      }],
      executeClientToolCall: clientCall,
    });

    expect(mocks.configureAgentSessionTools).toHaveBeenCalledWith(
      "host-new",
      [expect.objectContaining({ name: "todo_write" })],
    );
    expect(clientCall).toHaveBeenCalledWith({
      id: "client-call-1",
      name: "todo_write",
      arguments: "{\"todos\":[]}",
    });
    expect(mocks.respondAgentHostClientToolCall).toHaveBeenCalledWith(
      "client-call-1",
      { content: "todos updated" },
    );
    expect(result).toMatchObject({
      content: "done",
      toolCallResults: [{
        id: "client-call-1",
        path: "D:/workspace/TODO.md",
      }],
      steps: [
        expect.objectContaining({ type: "tool_call", name: "todo_write" }),
        {
          type: "artifact",
          artifactId: "artifact-1",
          title: "TODO",
        },
      ],
      agentHost: {
        sessionId: "host-new",
        turn: 1,
        completedSeq: 4,
      },
    });
  });
});
