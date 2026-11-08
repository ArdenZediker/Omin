import { describe, expect, it } from "vitest";
import {
  EventLogCorruptionError,
  JsonlSessionEventStore,
  type EventLogPort,
} from "./jsonl-event-store";
import { AgentRuntime } from "./runtime";
import { AgentToolRegistry } from "./tools";

const SESSION_ID = "session-1";
const MODEL = { provider: "test", model: "test-model" };

function createdEvent(title: string) {
  return {
    type: "session/created" as const,
    payload: { cwd: "/workspace", title },
    at: 1,
  };
}

function textModel(text: string) {
  return {
    async *stream() {
      yield { type: "text-delta" as const, text };
      yield { type: "finish" as const, reason: { kind: "stop" as const } };
    },
  };
}

class StringEventLogPort implements EventLogPort {
  readonly values = new Map<string, string>();
  replaceCount = 0;

  async read(sessionId: string): Promise<string | null> {
    return this.values.get(sessionId) ?? null;
  }

  async append(sessionId: string, content: string): Promise<void> {
    await Promise.resolve();
    this.values.set(sessionId, `${this.values.get(sessionId) ?? ""}${content}`);
  }

  async replace(sessionId: string, content: string): Promise<void> {
    this.replaceCount += 1;
    this.values.set(sessionId, content);
  }
}

describe("JsonlSessionEventStore", () => {
  it("serializes concurrent appends into one strict sequence", async () => {
    const port = new StringEventLogPort();
    const store = new JsonlSessionEventStore(port);

    const events = await Promise.all(
      Array.from({ length: 24 }, (_, index) => (
        store.append(SESSION_ID, createdEvent(`title-${index}`))
      )),
    );

    expect(events.map((event) => event.seq)).toEqual(
      Array.from({ length: 24 }, (_, index) => index + 1),
    );
    expect((await store.read(SESSION_ID)).map((event) => event.seq)).toEqual(
      events.map((event) => event.seq),
    );
    expect(port.values.get(SESSION_ID)?.trimEnd().split("\n")).toHaveLength(24);
  });

  it("rehydrates a durable log with a new store instance", async () => {
    const port = new StringEventLogPort();
    const first = new JsonlSessionEventStore(port);
    await first.append(SESSION_ID, createdEvent("one"));
    await first.append(SESSION_ID, createdEvent("two"));

    const resumed = new JsonlSessionEventStore(port);
    const events = await resumed.read(SESSION_ID);
    expect(events.map((event) => event.seq)).toEqual([1, 2]);

    const appended = await resumed.append(SESSION_ID, createdEvent("three"));
    expect(appended.seq).toBe(3);
  });

  it("resumes an AgentRuntime from a new durable store instance", async () => {
    const port = new StringEventLogPort();
    const firstRuntime = new AgentRuntime({
      store: new JsonlSessionEventStore(port),
      model: textModel("first"),
      tools: new AgentToolRegistry(),
      idFactory: () => SESSION_ID,
    });
    const sessionId = await firstRuntime.createSession({ cwd: "/workspace" });
    await firstRuntime.prompt(sessionId, "one", { model: MODEL });

    const resumedStore = new JsonlSessionEventStore(port);
    const resumedRuntime = new AgentRuntime({
      store: resumedStore,
      model: textModel("second"),
      tools: new AgentToolRegistry(),
    });
    const result = await resumedRuntime.prompt(sessionId, "two", { model: MODEL });

    expect(result).toMatchObject({ turn: 2, content: "second" });
    expect((await resumedStore.read(sessionId))
      .filter((event) => event.type === "turn/started")
      .map((event) => event.payload.turn)).toEqual([1, 2]);
  });

  it("ignores and repairs an incomplete final line after a crash", async () => {
    const port = new StringEventLogPort();
    const first = new JsonlSessionEventStore(port);
    const event = await first.append(SESSION_ID, createdEvent("one"));
    const validLine = port.values.get(SESSION_ID);
    port.values.set(SESSION_ID, `${validLine}{"seq":2`);

    const resumed = new JsonlSessionEventStore(port);
    expect(await resumed.read(SESSION_ID)).toEqual([event]);

    const appended = await resumed.append(SESSION_ID, createdEvent("two"));
    expect(appended.seq).toBe(2);
    expect(port.replaceCount).toBe(1);
    expect(port.values.get(SESSION_ID)).toBe(
      `${validLine}${JSON.stringify(appended)}\n`,
    );
  });

  it("rejects corruption in a completed line", async () => {
    const port = new StringEventLogPort();
    const store = new JsonlSessionEventStore(port);
    const first = await store.append(SESSION_ID, createdEvent("one"));
    port.values.set(
      SESSION_ID,
      `${JSON.stringify(first)}\n{"seq":2,"sessionId":"session-1"}\n`,
    );

    await expect(new JsonlSessionEventStore(port).read(SESSION_ID))
      .rejects.toBeInstanceOf(EventLogCorruptionError);
  });

  it("rejects sequence gaps and cross-session records", async () => {
    const port = new StringEventLogPort();
    const store = new JsonlSessionEventStore(port);
    const first = await store.append(SESSION_ID, createdEvent("one"));
    port.values.set(
      SESSION_ID,
      `${JSON.stringify(first)}\n${JSON.stringify({ ...first, seq: 3 })}\n`,
    );
    await expect(new JsonlSessionEventStore(port).read(SESSION_ID))
      .rejects.toThrow("expected seq 2, received 3");

    port.values.set(
      SESSION_ID,
      `${JSON.stringify({ ...first, sessionId: "other" })}\n`,
    );
    await expect(new JsonlSessionEventStore(port).read(SESSION_ID))
      .rejects.toThrow("event belongs to a different session");
  });

  it("supports afterSeq and limit without changing stored history", async () => {
    const port = new StringEventLogPort();
    const store = new JsonlSessionEventStore(port);
    for (const title of ["one", "two", "three"]) {
      await store.append(SESSION_ID, createdEvent(title));
    }

    expect((await store.read(SESSION_ID, { afterSeq: 1, limit: 1 }))
      .map((event) => event.seq)).toEqual([2]);
    expect(await store.read(SESSION_ID)).toHaveLength(3);
  });
});
