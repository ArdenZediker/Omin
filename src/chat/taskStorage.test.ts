import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskExecutionResult } from "./taskTypes";

const storage = vi.hoisted(() => {
  const entries = new Map<string, string>();
  return {
    entries,
    loadAppKvEntries: vi.fn(async (keys: string[]) => Object.fromEntries(keys.filter((key) => entries.has(key)).map((key) => [key, entries.get(key)]))),
    saveAppKvEntry: vi.fn(async (key: string, value: string) => { entries.set(key, value); }),
    readSqliteBackedValue: vi.fn((key: string) => entries.get(key) ?? null),
    saveSqliteBackedValue: vi.fn((key: string, value: string) => { entries.set(key, value); }),
  };
});

vi.mock("../app/sqliteStorage", () => storage);

import { createTaskHistoryStore, getLatestTaskForSession, taskHistoryStorageKey } from "./taskStorage";

function task(taskId: string, status: TaskExecutionResult["status"]): TaskExecutionResult {
  return {
    taskId, intent: "chat", status, trace: [],
    plan: { taskId, intent: "chat", goal: taskId, model: "test", sourceMessages: [], steps: [], createdAt: 1 },
  };
}

describe("task history lifecycle", () => {
  beforeEach(() => {
    storage.entries.clear();
    vi.clearAllMocks();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("does not persist an empty snapshot while loading", async () => {
    const history = createTaskHistoryStore("main");
    await history.load();
    expect(storage.saveSqliteBackedValue).not.toHaveBeenCalled();
    expect(history.getHistory()).toEqual([]);
  });

  it("recovers running tasks without losing partial messages or tool output", async () => {
    const existing = { ...task("old", "running"),
      conversationMessages: [{ role: "project" as const, content: "partial" }],
      toolResult: { ok: true, outputText: "already ran" } };
    storage.entries.set(taskHistoryStorageKey("main"), JSON.stringify([existing]));
    const history = createTaskHistoryStore("main");
    await history.load();
    expect(history.getHistory()[0]).toMatchObject({
      status: "aborted", conversationMessages: existing.conversationMessages,
      toolResult: existing.toolResult,
    });
    expect(JSON.parse(storage.entries.get(taskHistoryStorageKey("main"))!)[0].status).toBe("aborted");
  });

  it("queues new task behind asynchronous hydration and keeps window histories separate", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    storage.entries.set(taskHistoryStorageKey("main"), JSON.stringify([task("old", "completed")]));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    storage.loadAppKvEntries.mockImplementationOnce(async (keys) => {
      await gate;
      return Object.fromEntries(keys.filter((key) => storage.entries.has(key)).map((key) => [key, storage.entries.get(key)]));
    });
    const main = createTaskHistoryStore("main");
    const pending = main.record(task("new", "running"));
    expect(storage.saveAppKvEntry).not.toHaveBeenCalled();
    release();
    await pending;
    expect(main.getHistory().map(({ taskId }) => taskId)).toEqual(["new", "old"]);
    const compact = createTaskHistoryStore("compact");
    await compact.record(task("compact-only", "completed"));
    expect(compact.getHistory().map(({ taskId }) => taskId)).toEqual(["compact-only"]);
    expect(JSON.parse(storage.entries.get(taskHistoryStorageKey("main"))!).map(({ taskId }: TaskExecutionResult) => taskId)).toEqual(["new", "old"]);
  });

  it("selects only the newest run of the requested session", () => {
    const older = { ...task("older", "aborted"), sessionId: "session-a" };
    const newer = { ...task("newer", "completed"), sessionId: "session-a" };
    const other = { ...task("other", "failed"), sessionId: "session-b" };
    expect(getLatestTaskForSession([other, newer, older], "session-a")).toEqual(newer);
    expect(getLatestTaskForSession([other, newer, older], "session-b")).toEqual(other);
    expect(getLatestTaskForSession([other, newer, older], "missing")).toBeNull();
    expect(getLatestTaskForSession([other, newer, older], null)).toBeNull();
  });
});
