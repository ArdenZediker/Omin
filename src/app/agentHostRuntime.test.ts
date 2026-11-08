import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../agent-core";

const mocks = vi.hoisted(() => ({
  agentSessionStatus: vi.fn(),
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
  steerAgentSession: vi.fn(),
  subscribeAgentHostClientToolCalls: vi.fn(),
  subscribeAgentHostEvents: vi.fn(),
  waitAgentSessionIdle: vi.fn(),
}));

vi.mock("./sqliteStorage", () => ({
  readSqliteBackedJson: mocks.readSqliteBackedJson,
  saveSqliteBackedValue: mocks.saveSqliteBackedValue,
}));

vi.mock("./agentHostClient", () => ({
  agentSessionStatus: mocks.agentSessionStatus,
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
  steerAgentSession: mocks.steerAgentSession,
  subscribeAgentHostClientToolCalls: mocks.subscribeAgentHostClientToolCalls,
  subscribeAgentHostEvents: mocks.subscribeAgentHostEvents,
  waitAgentSessionIdle: mocks.waitAgentSessionIdle,
}));

import {
  deleteAgentHostSession,
  recoverAgentHostSession,
  runAgentHostTurn,
  steerAgentHostTurn,
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
    mocks.waitAgentSessionIdle.mockResolvedValue(undefined);
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

  it("waits for idle and keeps a late steered turn in the same result", async () => {
    let eventListener: ((message: unknown) => void) | undefined;
    let resolveIdle!: () => void;
    mocks.subscribeAgentHostEvents.mockImplementation(async (listener) => {
      eventListener = listener;
      return () => undefined;
    });
    mocks.promptAgentSession.mockResolvedValue("prompt-1");
    mocks.waitAgentSessionIdle.mockImplementation(() =>
      new Promise<void>((resolve) => {
        resolveIdle = resolve;
      })
    );

    const resultPromise = runAgentHostTurn({
      omniSessionId: "omni-session",
      cwd: "D:/workspace",
      history: [],
      prompt: "plan",
      modelId: "mock-model",
    });

    await vi.waitFor(() => {
      expect(mocks.promptAgentSession).toHaveBeenCalledWith(
        "host-new",
        "plan",
        { provider: "mock", model: "mock-model" },
        undefined,
        undefined,
      );
    });

    const emit = (event: AgentEvent) => {
      eventListener?.({ kind: "event", event });
    };
    emit({
      seq: 1,
      sessionId: "host-new",
      at: 1,
      type: "turn/started",
      payload: { turn: 1 },
    });
    emit({
      seq: 2,
      sessionId: "host-new",
      at: 2,
      type: "assistant/message",
      payload: {
        turn: 1,
        step: 1,
        message: {
          id: "assistant-1",
          role: "assistant",
          createdAt: 2,
          content: [{ type: "text", text: "first" }],
        },
      },
    });
    emit({
      seq: 3,
      sessionId: "host-new",
      at: 3,
      type: "turn/completed",
      payload: { turn: 1, reason: { kind: "completed" } },
    });
    await vi.waitFor(() => {
      expect(mocks.waitAgentSessionIdle).toHaveBeenCalledWith("host-new");
    });
    emit({
      seq: 4,
      sessionId: "host-new",
      at: 4,
      type: "user/message",
      payload: {
        turn: 2,
        step: 1,
        message: {
          id: "steer-1",
          role: "user",
          createdAt: 4,
          content: [{ type: "text", text: "补充" }],
        },
      },
    });
    emit({
      seq: 5,
      sessionId: "host-new",
      at: 5,
      type: "assistant/message",
      payload: {
        turn: 2,
        step: 1,
        message: {
          id: "assistant-2",
          role: "assistant",
          createdAt: 5,
          content: [{ type: "text", text: "second" }],
        },
      },
    });
    emit({
      seq: 6,
      sessionId: "host-new",
      at: 6,
      type: "turn/completed",
      payload: { turn: 2, reason: { kind: "completed" } },
    });
    resolveIdle();

    await expect(resultPromise).resolves.toMatchObject({
      content: "first\n\nsecond",
      agentHost: {
        sessionId: "host-new",
        turn: 2,
        completedSeq: 6,
      },
    });
  });
});

describe("steerAgentHostTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureAgentHost.mockResolvedValue({ running: true });
    mocks.agentSessionStatus.mockResolvedValue({ running: true });
    mocks.createAgentModelConfig.mockReturnValue({
      provider: "mock",
      model: "mock-model",
    });
    mocks.steerAgentSession.mockResolvedValue("steer-1");
    mocks.readSqliteBackedJson.mockReturnValue({
      "omni-1": { hostSessionId: "host-1" },
    });
  });

  it("adds text and images to the active Host turn", async () => {
    await expect(steerAgentHostTurn({
      omniSessionId: "omni-1",
      content: "补充上下文",
      images: [{ src: "data:image/png;base64,AAAA", name: "shot.png" }],
      modelId: "mock-model",
    })).resolves.toBe("steer-1");

    expect(mocks.agentSessionStatus).toHaveBeenCalledWith("host-1");
    expect(mocks.steerAgentSession).toHaveBeenCalledWith(
      "host-1",
      "补充上下文",
      { provider: "mock", model: "mock-model" },
      undefined,
      [{ src: "data:image/png;base64,AAAA", name: "shot.png" }],
    );
  });

  it("does not create a second turn when the answer already finished", async () => {
    mocks.agentSessionStatus.mockResolvedValue({ running: false });

    await expect(steerAgentHostTurn({
      omniSessionId: "omni-1",
      content: "晚到的消息",
      modelId: "mock-model",
      startupTimeoutMs: 0,
    })).rejects.toThrow("当前回答已经结束");

    expect(mocks.steerAgentSession).not.toHaveBeenCalled();
  });

  it("waits through the startup race until the Host session is running", async () => {
    mocks.readSqliteBackedJson
      .mockReturnValueOnce({})
      .mockReturnValue({ "omni-1": { hostSessionId: "host-1" } });
    mocks.agentSessionStatus
      .mockResolvedValueOnce({ running: false })
      .mockResolvedValueOnce({ running: true });

    await expect(steerAgentHostTurn({
      omniSessionId: "omni-1",
      content: "启动后补充",
      modelId: "mock-model",
      startupTimeoutMs: 1_000,
    })).resolves.toBe("steer-1");

    expect(mocks.agentSessionStatus).toHaveBeenCalledTimes(2);
    expect(mocks.steerAgentSession).toHaveBeenCalledOnce();
  });
});
