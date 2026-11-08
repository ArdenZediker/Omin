import { describe, expect, it } from "vitest";
import { InMemorySessionEventStore } from "./event-store";
import { projectMessages } from "./message-projection";
import type { ModelProvider, ModelRequest, ModelStreamEvent } from "./model";
import { AgentRuntime } from "./runtime";
import { AgentToolRegistry, type AgentToolDefinition } from "./tools";
import { reasoningBlocks, textBlocks } from "./types";

function scriptedModel(scripts: ModelStreamEvent[][]): ModelProvider {
  const queue = [...scripts];
  return {
    async *stream() {
      const script = queue.shift();
      if (!script) throw new Error("No scripted model response");
      for (const event of script) yield event;
    },
  };
}

function fixedIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const MODEL = { provider: "test", model: "test-model" };

describe("AgentRuntime", () => {
  it("persists one turn and derives model-visible messages", async () => {
    const store = new InMemorySessionEventStore();
    const runtime = new AgentRuntime({
      store,
      model: scriptedModel([[
        { type: "reasoning-delta", text: "thinking" },
        { type: "text-delta", text: "hello" },
        { type: "usage", usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 } },
        { type: "finish", reason: { kind: "stop" } },
      ]]),
      tools: new AgentToolRegistry(),
      now: () => 1000,
      idFactory: fixedIds("id"),
    });
    const sessionId = await runtime.createSession({ cwd: "/workspace" });

    const result = await runtime.prompt(sessionId, "hi", { model: MODEL });
    await runtime.whenIdle(sessionId);

    expect(result).toMatchObject({
      content: "hello",
      reasoning: "thinking",
      reason: { kind: "completed" },
      usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 },
    });
    const events = await store.read(sessionId);
    expect(events.map((event) => event.type)).toEqual([
      "session/created",
      "agent/inbox/spliced",
      "agent/status",
      "turn/started",
      "agent/inbox/spliced",
      "request/header",
      "step/started",
      "user/message",
      "assistant/chunk",
      "assistant/chunk",
      "assistant/message",
      "step/completed",
      "turn/completed",
      "agent/status",
    ]);
    const messages = projectMessages(events);
    expect(messages).toHaveLength(2);
    expect(textBlocks(messages[0])).toBe("hi");
    expect(reasoningBlocks(messages[1])).toBe("thinking");
    expect(textBlocks(messages[1])).toBe("hello");
  });

  it("executes a tool and feeds its durable result into the next model step", async () => {
    const store = new InMemorySessionEventStore();
    const tools = new AgentToolRegistry();
    const tool: AgentToolDefinition = {
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object" },
      async execute({ call }) {
        return { content: `contents:${call.arguments}` };
      },
    };
    tools.register(tool);
    const runtime = new AgentRuntime({
      store,
      model: scriptedModel([
        [
          { type: "finish", reason: {
            kind: "tool-calls",
            calls: [{ id: "call-1", name: "read_file", arguments: "a.txt" }],
          } },
        ],
        [
          { type: "text-delta", text: "file is ready" },
          { type: "finish", reason: { kind: "stop" } },
        ],
      ]),
      tools,
      now: () => 2000,
      idFactory: fixedIds("id"),
    });
    const sessionId = await runtime.createSession({ cwd: "/workspace" });

    const result = await runtime.prompt(sessionId, "read it", { model: MODEL });

    expect(result.content).toBe("file is ready");
    const events = await store.read(sessionId);
    expect(events.filter((event) => event.type === "tool/call")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool/result")).toHaveLength(1);
    expect(events.filter((event) => event.type === "step/started")).toHaveLength(2);
    const messages = projectMessages(events);
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(textBlocks(messages[2])).toBe("contents:a.txt");
    expect(textBlocks(messages[3])).toBe("file is ready");
  });

  it("uses a configured per-session tool catalog", async () => {
    const store = new InMemorySessionEventStore();
    const requests: ModelRequest[] = [];
    const runtime = new AgentRuntime({
      store,
      model: {
        async *stream(request) {
          requests.push(request);
          if (requests.length === 1) {
            yield {
              type: "finish",
              reason: {
                kind: "tool-calls",
                calls: [{
                  id: "call-session",
                  name: "session_only",
                  arguments: "{}",
                }],
              },
            };
            return;
          }
          yield { type: "text-delta", text: "session tool complete" };
          yield { type: "finish", reason: { kind: "stop" } };
        },
      },
      tools: new AgentToolRegistry(),
      idFactory: fixedIds("session-tools"),
    });
    const sessionId = await runtime.createSession({ cwd: "/workspace" });
    const sessionTools = new AgentToolRegistry();
    sessionTools.register({
      name: "session_only",
      description: "session scoped",
      parameters: { type: "object" },
      async execute() {
        return { content: "session result" };
      },
    });
    await runtime.configureTools(sessionId, sessionTools);

    const result = await runtime.prompt(sessionId, "use session tool", { model: MODEL });

    expect(result.content).toBe("session tool complete");
    expect(requests[0].tools?.map((tool) => tool.name)).toEqual(["session_only"]);
    const events = await store.read(sessionId);
    expect(events.find((event) => event.type === "request/header"))
      .toMatchObject({ payload: { tools: ["session_only"] } });
    expect(events.find((event) => event.type === "tool/result"))
      .toMatchObject({ payload: { message: { content: [{ type: "text", text: "session result" }] } } });
  });

  it("queues a follow-up while the current turn is running", async () => {
    const store = new InMemorySessionEventStore();
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const requests: ModelRequest[] = [];
    const model: ModelProvider = {
      async *stream(request) {
        requests.push(request);
        if (requests.length === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
          yield { type: "text-delta", text: "first" };
          yield { type: "finish", reason: { kind: "stop" } };
          return;
        }
        yield { type: "text-delta", text: "second" };
        yield { type: "finish", reason: { kind: "stop" } };
      },
    };
    const runtime = new AgentRuntime({
      store,
      model,
      tools: new AgentToolRegistry(),
      idFactory: fixedIds("id"),
    });
    const sessionId = await runtime.createSession({ cwd: "/workspace" });

    const first = runtime.prompt(sessionId, "one", { model: MODEL });
    await firstStarted.promise;
    const second = runtime.prompt(sessionId, "two", { model: MODEL });
    releaseFirst.resolve();

    await expect(first).resolves.toMatchObject({ content: "first", turn: 1 });
    await expect(second).resolves.toMatchObject({ content: "second", turn: 2 });
    expect(requests).toHaveLength(2);
    expect(projectMessages(await store.read(sessionId))
      .filter((message) => message.role === "user")
      .map(textBlocks)).toEqual(["one", "two"]);
  });

  it("delivers steer input at the next step boundary in the same turn", async () => {
    const store = new InMemorySessionEventStore();
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const requests: ModelRequest[] = [];
    const model: ModelProvider = {
      async *stream(request) {
        requests.push(request);
        if (requests.length === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
          yield { type: "text-delta", text: "base" };
          yield { type: "finish", reason: { kind: "stop" } };
          return;
        }
        yield { type: "text-delta", text: "steered" };
        yield { type: "finish", reason: { kind: "stop" } };
      },
    };
    const runtime = new AgentRuntime({
      store,
      model,
      tools: new AgentToolRegistry(),
      idFactory: fixedIds("id"),
    });
    const sessionId = await runtime.createSession({ cwd: "/workspace" });

    const result = runtime.prompt(sessionId, "start", { model: MODEL });
    await firstStarted.promise;
    await runtime.steer(sessionId, "adjust direction", { model: MODEL });
    releaseFirst.resolve();

    await expect(result).resolves.toMatchObject({ content: "steered", turn: 1 });
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.filter((message) => message.role === "user").map(textBlocks))
      .toEqual(["start", "adjust direction"]);
    const stepEvents = (await store.read(sessionId))
      .filter((event) => event.type === "step/started");
    expect(stepEvents.map((event) => event.payload.step)).toEqual([1, 2]);
  });

  it("keeps inject pending while idle and claims it when a later wake starts", async () => {
    const store = new InMemorySessionEventStore();
    const runtime = new AgentRuntime({
      store,
      model: scriptedModel([[
        { type: "text-delta", text: "done" },
        { type: "finish", reason: { kind: "stop" } },
      ]]),
      tools: new AgentToolRegistry(),
      idFactory: fixedIds("id"),
    });
    const sessionId = await runtime.createSession({ cwd: "/workspace" });

    await runtime.inject(sessionId, "background context", { model: MODEL });
    expect(await runtime.isRunning(sessionId)).toBe(false);
    expect((await store.read(sessionId)).some((event) => event.type === "turn/started")).toBe(false);

    const result = await runtime.prompt(sessionId, "wake", { model: MODEL });
    expect(result.content).toBe("done");
    expect(projectMessages(await store.read(sessionId))
      .filter((message) => message.role === "user")
      .map(textBlocks)).toEqual(["background context", "wake"]);
  });

  it("runs parallel-safe tools together and treats exclusive tools as barriers", async () => {
    const store = new InMemorySessionEventStore();
    const safeOneStarted = deferred();
    const safeTwoStarted = deferred();
    const releaseSafeOne = deferred();
    const exclusiveStarted = deferred();
    const tools = new AgentToolRegistry();
    tools.register({
      name: "safe_one",
      description: "first safe tool",
      parameters: { type: "object" },
      isConcurrencySafe: () => true,
      async execute() {
        safeOneStarted.resolve();
        await releaseSafeOne.promise;
        return { content: "safe one" };
      },
    });
    tools.register({
      name: "safe_two",
      description: "second safe tool",
      parameters: { type: "object" },
      isConcurrencySafe: () => true,
      async execute() {
        safeTwoStarted.resolve();
        return { content: "safe two" };
      },
    });
    tools.register({
      name: "exclusive",
      description: "write tool",
      parameters: { type: "object" },
      async execute() {
        exclusiveStarted.resolve();
        return { content: "exclusive ran" };
      },
    });
    let modelCall = 0;
    const runtime = new AgentRuntime({
      store,
      model: {
        async *stream() {
          modelCall += 1;
          if (modelCall === 1) {
            yield {
              type: "finish",
              reason: {
                kind: "tool-calls",
                calls: [
                  { id: "safe-1", name: "safe_one", arguments: "{}" },
                  { id: "safe-2", name: "safe_two", arguments: "{}" },
                  { id: "write-1", name: "exclusive", arguments: "{}" },
                ],
              },
            };
            return;
          }
          yield { type: "text-delta", text: "tools complete" };
          yield { type: "finish", reason: { kind: "stop" } };
        },
      },
      tools,
      idFactory: fixedIds("id"),
    });
    const sessionId = await runtime.createSession({ cwd: "/workspace" });

    const result = runtime.prompt(sessionId, "run tools", { model: MODEL });
    await Promise.all([safeOneStarted.promise, safeTwoStarted.promise]);
    let exclusiveWasStarted = false;
    void exclusiveStarted.promise.then(() => {
      exclusiveWasStarted = true;
    });
    await Promise.resolve();
    expect(exclusiveWasStarted).toBe(false);

    releaseSafeOne.resolve();
    await exclusiveStarted.promise;
    await expect(result).resolves.toMatchObject({ content: "tools complete" });
    expect((await store.read(sessionId))
      .filter((event) => event.type === "tool/result")
      .map((event) => event.payload.name)).toEqual([
        "safe_one",
        "safe_two",
        "exclusive",
      ]);
  });

  it("cancels the active step and clears queued follow-ups", async () => {
    const store = new InMemorySessionEventStore();
    const started = deferred();
    const model: ModelProvider = {
      async *stream(request) {
        started.resolve();
        await new Promise<void>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
        yield { type: "finish", reason: { kind: "stop" } };
      },
    };
    const runtime = new AgentRuntime({
      store,
      model,
      tools: new AgentToolRegistry(),
      idFactory: fixedIds("id"),
    });
    const sessionId = await runtime.createSession({ cwd: "/workspace" });
    const active = runtime.prompt(sessionId, "long task", { model: MODEL });
    await started.promise;
    const queued = runtime.prompt(sessionId, "later", { model: MODEL });

    await runtime.cancel(sessionId, { reason: "stop requested" });

    await expect(active).resolves.toMatchObject({
      reason: { kind: "aborted", message: "stop requested" },
    });
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    await runtime.whenIdle(sessionId);
    expect((await store.read(sessionId)).filter((event) => event.type === "turn/started"))
      .toHaveLength(1);
  });

  it("streams durable events to subscribers and resumes session state from the store", async () => {
    const store = new InMemorySessionEventStore();
    const firstRuntime = new AgentRuntime({
      store,
      model: scriptedModel([[
        { type: "text-delta", text: "first" },
        { type: "finish", reason: { kind: "stop" } },
      ]]),
      tools: new AgentToolRegistry(),
      idFactory: fixedIds("id"),
    });
    const sessionId = await firstRuntime.createSession({ cwd: "/workspace" });
    const eventTypes: string[] = [];
    const unsubscribe = firstRuntime.subscribe(sessionId, (event) => {
      eventTypes.push(event.type);
    });
    await firstRuntime.prompt(sessionId, "one", { model: MODEL });
    unsubscribe();

    const resumedRuntime = new AgentRuntime({
      store,
      model: scriptedModel([[
        { type: "text-delta", text: "second" },
        { type: "finish", reason: { kind: "stop" } },
      ]]),
      tools: new AgentToolRegistry(),
      idFactory: fixedIds("resume"),
    });
    const result = await resumedRuntime.prompt(sessionId, "two", { model: MODEL });

    expect(result.turn).toBe(2);
    expect(eventTypes).toContain("assistant/chunk");
    expect(projectMessages(await store.read(sessionId))
      .filter((message) => message.role === "user")
      .map(textBlocks)).toEqual(["one", "two"]);
  });
});
