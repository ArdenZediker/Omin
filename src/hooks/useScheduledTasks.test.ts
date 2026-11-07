import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledTaskRecord } from "../chat/types";
import { useScheduledTasks, type UseScheduledTasksArgs } from "./useScheduledTasks";
import { createScheduleStateStore, type ScheduleKvStorage } from "./scheduledTaskState";
import { StrictMode, createElement } from "react";

const native = vi.hoisted(() => ({ label: "main" }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: native.label }) }));

const now = new Date(2026, 9, 25, 12, 0).getTime();
const task: ScheduledTaskRecord = {
  id: "reminder", title: "提醒", prompt: "查看日报", cron: "0 9 * * *",
  target: "desktop", enabled: true, createdAt: now - 60_000, updatedAt: now,
};

describe("useScheduledTasks cron regression", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); localStorage.clear(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("does not immediately deliver a new task whose cron has not occurred", async () => {
    const setDraft = vi.fn(async () => undefined);
    renderHook(() => useScheduledTasks({
      scheduledTasks: [task], setScheduledTasks: vi.fn(), isOwner: true,
      desktopActions: { setDraft, openChat: vi.fn(async () => undefined), notify: vi.fn() },
    }));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(setDraft).not.toHaveBeenCalled();
  });
});

function fixture(overrides: Partial<UseScheduledTasksArgs> = {}) {
  const data = new Map<string, string>();
  const storage: ScheduleKvStorage = {
    read: vi.fn(async (key) => data.get(key) ?? null),
    write: vi.fn(async (key, value) => { data.set(key, value); }),
  };
  const actions = {
    setDraft: vi.fn(async (_draft: string) => undefined),
    openChat: vi.fn(async () => undefined),
    notify: vi.fn(async () => undefined),
    sendSystemNotification: vi.fn(async (_title: string, _body: string) => undefined),
    openSessionReminder: vi.fn(async (_sessionId: string, _draft: string) => undefined),
  };
  const args: UseScheduledTasksArgs = {
    scheduledTasks: [{ ...task, createdAt: now - 86_400_000, cron: "0 12 * * *" }],
    setScheduledTasks: vi.fn(), desktopActions: actions, isOwner: true,
    stateStore: createScheduleStateStore(storage), onIssue: vi.fn(), ...overrides,
  };
  return { args, storage, data, actions };
}
async function flush() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }

describe("scheduled reminder lifecycle", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); localStorage.clear(); native.label = "main"; });
  afterEach(() => { cleanup(); vi.useRealTimers(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });

  it("persists claim before delivery and lastRunAt is the scheduled instant", async () => {
    vi.setSystemTime(now + 25_000);
    const { args, actions } = fixture();
    actions.setDraft.mockImplementation(async () => {
      expect((await args.stateStore!.load(task.id))?.status).toBe("claimed");
    });
    const { result } = renderHook(() => useScheduledTasks(args));
    await flush();
    expect(actions.setDraft).toHaveBeenCalledExactlyOnceWith(task.prompt);
    expect(result.current.deliveries[task.id]).toMatchObject({ status: "delivered", scheduledAt: now });
    const calls = vi.mocked(args.setScheduledTasks).mock.calls;
    const update = calls[calls.length - 1]?.[0];
    expect(typeof update === "function" && update(args.scheduledTasks)[0].lastRunAt).toBe(now);
    expect(actions.openChat).not.toHaveBeenCalled();
  });

  it("only one owner delivers, repeated effects/remounts do not repeat", async () => {
    const { args, actions } = fixture();
    const first = renderHook(() => useScheduledTasks(args), { wrapper: ({ children }) => createElement(StrictMode, null, children) });
    renderHook(() => useScheduledTasks(args));
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    first.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(actions.setDraft).toHaveBeenCalledTimes(1);
  });

  it("restores an unknown crash claim without automatic replay", async () => {
    const { args, actions } = fixture();
    await args.stateStore!.claim(task.id, { scheduledAt: now, slotKey: "2026-10-25T12:00" }, now);
    const { result } = renderHook(() => useScheduledTasks(args));
    await flush();
    expect(actions.setDraft).not.toHaveBeenCalled();
    expect(result.current.issues[task.id].code).toBe("unknown");
  });

  it("failed claims do not deliver and retry on the next tick", async () => {
    const { args, storage, actions } = fixture();
    vi.mocked(storage.write).mockRejectedValueOnce(new Error("disk full"));
    const { result } = renderHook(() => useScheduledTasks(args));
    await flush();
    expect(actions.setDraft).not.toHaveBeenCalled();
    expect(result.current.issues[task.id].code).toBe("storage");
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(actions.setDraft).toHaveBeenCalledTimes(1);
    expect(result.current.issues[task.id]).toBeUndefined();
  });

  it("delivery errors remain visible, do not auto-retry, but allow explicit retry", async () => {
    const { args, actions } = fixture();
    actions.setDraft.mockRejectedValueOnce(new Error("window unavailable"));
    const { result } = renderHook(() => useScheduledTasks(args));
    await flush();
    expect(result.current.issues[task.id].code).toBe("unknown");
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(actions.setDraft).toHaveBeenCalledTimes(1);
    await act(async () => { await Promise.all([result.current.retryReminder(task.id), result.current.retryReminder(task.id)]); });
    expect(actions.setDraft).toHaveBeenCalledTimes(2);
    expect(result.current.deliveries[task.id].status).toBe("delivered");
  });

  it("successful delivery plus failed completion save is not redelivered after remount", async () => {
    const { args, storage, actions } = fixture();
    actions.setDraft.mockImplementation(async () => { vi.mocked(storage.write).mockRejectedValueOnce(new Error("disk full")); });
    const first = renderHook(() => useScheduledTasks(args));
    await flush();
    expect(first.result.current.issues[task.id].code).toBe("unknown");
    first.unmount();
    renderHook(() => useScheduledTasks(args));
    await flush();
    expect(actions.setDraft).toHaveBeenCalledTimes(1);
  });

  it("reports invalid cron while still processing other enabled tasks", async () => {
    const { args, actions } = fixture();
    args.scheduledTasks = [{ ...task, cron: "invalid" }, { ...args.scheduledTasks[0], id: "valid" }, { ...task, id: "off", enabled: false }];
    const { result } = renderHook(() => useScheduledTasks(args));
    await flush();
    expect(result.current.issues[task.id].code).toBe("invalid");
    expect(actions.setDraft).toHaveBeenCalledTimes(1);
  });

  it("a wake after several days delivers only the newest minute", async () => {
    const { args, actions } = fixture();
    args.scheduledTasks[0].cron = "* * * * *";
    renderHook(() => useScheduledTasks(args));
    await flush();
    vi.setSystemTime(now + 3 * 86_400_000 + 5_000);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await flush();
    expect(actions.setDraft).toHaveBeenCalledTimes(2);
    expect((await args.stateStore!.load(task.id))?.scheduledAt).toBe(now + 3 * 86_400_000);
  });

  it("passes sessionId to a dedicated session action and never uses current-session fallback", async () => {
    const { args, actions } = fixture();
    args.scheduledTasks[0] = { ...args.scheduledTasks[0], target: "session", sessionId: "original-session" };
    renderHook(() => useScheduledTasks(args));
    await flush();
    expect(actions.openSessionReminder).toHaveBeenCalledExactlyOnceWith("original-session", task.prompt);
    expect(actions.setDraft).not.toHaveBeenCalled();
    expect(actions.openChat).not.toHaveBeenCalled();
  });

  it("a deleted session rejection stays visible without writing into another session", async () => {
    const { args, actions } = fixture();
    args.scheduledTasks[0] = { ...args.scheduledTasks[0], target: "session", sessionId: "deleted" };
    actions.openSessionReminder.mockRejectedValue(new Error("会话已删除"));
    const { result } = renderHook(() => useScheduledTasks(args));
    await flush();
    expect(result.current.issues[task.id].message).toContain("会话已删除");
    expect(actions.setDraft).not.toHaveBeenCalled();
  });

  it("does not treat a console-only notify adapter as successful delivery", async () => {
    const { args, actions } = fixture();
    args.scheduledTasks[0].target = "notification";
    args.desktopActions = { setDraft: actions.setDraft, notify: actions.notify };
    const { result } = renderHook(() => useScheduledTasks(args));
    await flush();
    expect(result.current.issues[task.id].code).toBe("unavailable");
    expect(actions.notify).not.toHaveBeenCalled();
    expect(await args.stateStore!.load(task.id)).toBeNull();
  });

  it("notification target invokes only the real notification interface", async () => {
    const { args, actions } = fixture();
    args.scheduledTasks[0].target = "notification";
    renderHook(() => useScheduledTasks(args));
    await flush();
    expect(actions.sendSystemNotification).toHaveBeenCalledExactlyOnceWith(task.title, task.prompt);
    expect(actions.setDraft).not.toHaveBeenCalled();
  });

  it("missing sessionId does not claim or deliver", async () => {
    const { args, actions } = fixture();
    args.scheduledTasks[0].target = "session";
    const { result } = renderHook(() => useScheduledTasks(args));
    await flush();
    expect(result.current.issues[task.id].code).toBe("unavailable");
    expect(await args.stateStore!.load(task.id)).toBeNull();
    expect(actions.openSessionReminder).not.toHaveBeenCalled();
  });

  it("native compact windows cannot acquire ownership even with an explicit flag", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    native.label = "compact";
    const { args, actions, storage } = fixture();
    renderHook(() => useScheduledTasks(args));
    await flush();
    expect(actions.setDraft).not.toHaveBeenCalled();
    expect(storage.read).not.toHaveBeenCalled();
  });

  it("waits for hydration readiness", async () => {
    const { args, actions } = fixture({ ready: false });
    const rendered = renderHook((props) => useScheduledTasks(props), { initialProps: args });
    await flush();
    expect(actions.setDraft).not.toHaveBeenCalled();
    rendered.rerender({ ...args, ready: true });
    await flush();
    expect(actions.setDraft).toHaveBeenCalledTimes(1);
  });
});
