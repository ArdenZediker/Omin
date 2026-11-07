import { describe, expect, it, vi } from "vitest";
import { createScheduleStateStore, SCHEDULE_STATE_PREFIX, type ScheduleKvStorage } from "./scheduledTaskState";

function fixture() {
  const data = new Map<string, string>();
  const storage: ScheduleKvStorage = {
    read: vi.fn(async (key) => data.get(key) ?? null),
    write: vi.fn(async (key, value) => { data.set(key, value); }),
  };
  return { data, storage, store: createScheduleStateStore(storage) };
}
const slot = { scheduledAt: 1_000, slotKey: "2026-10-25T09:00" };

describe("durable schedule claim", () => {
  it("serializes simultaneous stores in one context so exactly one wins", async () => {
    const { storage, store } = fixture();
    const second = createScheduleStateStore(storage);
    const results = await Promise.all([store.claim("one", slot, 2_000), second.claim("one", slot, 2_000)]);
    expect(results.map((result) => result.claimed)).toEqual([true, false]);
    expect(storage.write).toHaveBeenCalledTimes(1);
  });

  it("claim write rejection is retryable, with no in-memory false success", async () => {
    const { storage, store } = fixture();
    vi.mocked(storage.write).mockRejectedValueOnce(new Error("disk full"));
    await expect(store.claim("one", slot, 2_000)).rejects.toThrow("disk full");
    expect((await store.claim("one", slot, 2_000)).claimed).toBe(true);
  });

  it("crash after claim survives store reconstruction and consumes the slot", async () => {
    const { storage, store } = fixture();
    await store.claim("one", slot, 2_000);
    const restarted = createScheduleStateStore(storage);
    expect((await restarted.claim("one", slot, 2_000)).claimed).toBe(false);
    expect((await restarted.load("one"))?.status).toBe("claimed");
  });

  it("completion write failure cannot erase a durable claim", async () => {
    const { storage, store } = fixture();
    const result = await store.claim("one", slot, 2_000);
    vi.mocked(storage.write).mockRejectedValueOnce(new Error("disk full"));
    await expect(store.settle(result.record!, "delivered")).rejects.toThrow("disk full");
    expect((await createScheduleStateStore(storage).claim("one", slot, 3_000)).claimed).toBe(false);
  });

  it("wall-clock rollback and repeated DST minute cannot redeliver", async () => {
    const { store } = fixture();
    await store.claim("one", slot, 2_000);
    expect((await store.claim("one", { scheduledAt: 3_601_000, slotKey: slot.slotKey }, 4_000)).claimed).toBe(false);
    expect((await store.claim("one", { scheduledAt: 4_000, slotKey: "2026-10-25T08:59" }, 5_000)).claimed).toBe(false);
    expect((await store.claim("one", { scheduledAt: 5_000, slotKey: "2026-10-25T09:01" }, 6_000)).claimed).toBe(true);
  });

  it("manual retry requires the current claim token and ignores stale completions", async () => {
    const { store } = fixture();
    const first = (await store.claim("one", slot, 2_000)).record!;
    await store.settle(first, "unknown", "interrupted");
    const second = await store.claim("one", slot, 3_000, first.claimId);
    expect(second.claimed).toBe(true);
    expect((await store.claim("one", slot, 3_000, first.claimId)).claimed).toBe(false);
    await store.settle(first, "delivered");
    expect((await store.load("one"))?.claimId).toBe(second.record?.claimId);
    expect((await store.load("one"))?.status).toBe("claimed");
  });

  it("a successful reminder cannot be manually retried by mistake", async () => {
    const { store } = fixture();
    const first = (await store.claim("one", slot, 2_000)).record!;
    await store.settle(first, "delivered");
    expect((await store.claim("one", slot, 3_000, first.claimId)).claimed).toBe(false);
  });

  it.each(["broken", "null", "{}", '{"version":2}'])("fails closed for corrupt records: %s", async (raw) => {
    const { data, store, storage } = fixture();
    data.set(SCHEDULE_STATE_PREFIX + "one", raw);
    await expect(store.claim("one", slot, 2_000)).rejects.toThrow();
    expect(storage.write).not.toHaveBeenCalled();
  });
});
