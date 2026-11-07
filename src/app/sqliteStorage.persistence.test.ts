import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { flushStorageWrites, getStorageWriteFailures, retryFailedStorageWrites, saveAppKvEntry, saveSqliteBackedValue, removeSqliteBackedValue } from "./sqliteStorage";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const mockInvoke = vi.mocked(invoke);
describe("SQLite 保存失败与顺序", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    mockInvoke.mockReset().mockResolvedValue(undefined);
    localStorage.clear();
  });
  afterEach(async () => {
    mockInvoke.mockResolvedValue(undefined);
    await retryFailedStorageWrites();
    await flushStorageWrites();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });
  it("保留本地值并公开错误，重试成功清除错误", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("磁盘已满"));
    saveSqliteBackedValue("settings", "latest");
    await flushStorageWrites();
    expect(localStorage.getItem("settings")).toBe("latest");
    expect(getStorageWriteFailures()).toEqual([expect.objectContaining({ key: "settings", message: "磁盘已满" })]);
    await retryFailedStorageWrites();
    expect(mockInvoke).toHaveBeenLastCalledWith("save_app_kv", { key: "settings", value: "latest" });
    expect(getStorageWriteFailures()).toEqual([]);
  });
  it("同 key 新写入等待旧写入结束，成功后不重放失败旧值", async () => {
    let rejectOld!: (error: Error) => void;
    mockInvoke.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    const first = saveAppKvEntry("order", "old").catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    const second = saveAppKvEntry("order", "new");
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    rejectOld(new Error("旧保存失败"));
    await Promise.all([first, second]);
    await retryFailedStorageWrites();
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockInvoke).toHaveBeenLastCalledWith("save_app_kv", { key: "order", value: "new" });
    expect(getStorageWriteFailures()).toEqual([]);
  });
  it("删除失败重试执行删除而不是恢复旧值", async () => {
    mockInvoke.mockRejectedValueOnce("locked");
    removeSqliteBackedValue("deleted");
    await flushStorageWrites();
    expect(getStorageWriteFailures()[0]?.key).toBe("deleted");
    await retryFailedStorageWrites();
    expect(mockInvoke).toHaveBeenLastCalledWith("remove_app_kv", { key: "deleted" });
  });
});
