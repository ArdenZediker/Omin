import { loadAppKvEntries, saveAppKvEntry } from "../app/sqliteStorage";
import type { ScheduleOccurrence } from "./scheduledTaskCron";

export type ScheduleDeliveryStatus = "claimed" | "delivered" | "failed" | "unknown";
export type ScheduleDeliveryRecord = ScheduleOccurrence & {
  version: 1;
  taskId: string;
  claimId: string;
  claimedAt: number;
  status: ScheduleDeliveryStatus;
  message?: string;
};
export type ScheduleKvStorage = {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
};
export const SCHEDULE_STATE_PREFIX = "omni_schedule_delivery_v1:";
const queues = new Map<string, Promise<unknown>>();

/** All stores in this JS context serialize by task. NOT a cross-process CAS:
 * scheduling must have one main-webview owner. Multiple application processes
 * sharing a database need a backend atomic claim or single-instance guard. */
function serialize<T>(key: string, action: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(action);
  queues.set(key, next);
  void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => undefined);
  return next;
}

function decode(raw: string | null, taskId: string): ScheduleDeliveryRecord | null {
  if (raw === null) return null;
  const value = JSON.parse(raw) as Partial<ScheduleDeliveryRecord> | null;
  if (!value || value.version !== 1 || value.taskId !== taskId || typeof value.claimId !== "string"
    || !value.claimId || typeof value.slotKey !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value.slotKey)
    || typeof value.scheduledAt !== "number" || !Number.isFinite(value.scheduledAt)
    || typeof value.claimedAt !== "number" || !Number.isFinite(value.claimedAt)
    || !["claimed", "delivered", "failed", "unknown"].includes(value.status ?? "")
    || (value.message !== undefined && typeof value.message !== "string")) {
    throw new Error("提醒投递记录损坏，已停止自动投递以避免重复提醒");
  }
  return value as ScheduleDeliveryRecord;
}

export function createScheduleStateStore(storage: ScheduleKvStorage) {
  const keyOf = (taskId: string) => SCHEDULE_STATE_PREFIX + encodeURIComponent(taskId);
  const read = async (taskId: string) => decode(await storage.read(keyOf(taskId)), taskId);
  return {
    load(taskId: string) { return serialize(keyOf(taskId), () => read(taskId)); },
    claim(taskId: string, occurrence: ScheduleOccurrence, now: number, retryClaimId?: string) {
      return serialize(keyOf(taskId), async () => {
        const previous = await read(taskId);
        if (retryClaimId !== undefined) {
          // Explicit user retry uses the displayed failed/unknown claim ID.
          if (!previous || previous.claimId !== retryClaimId || previous.status === "delivered") {
            return { claimed: false, record: previous };
          }
          occurrence = { scheduledAt: previous.scheduledAt, slotKey: previous.slotKey };
        } else if (previous && occurrence.slotKey <= previous.slotKey) {
          // A monotonic wall-clock high water suppresses clock/time-zone rollback.
          return { claimed: false, record: previous };
        }
        const record: ScheduleDeliveryRecord = {
          version: 1, taskId, ...occurrence, claimId: crypto.randomUUID(), claimedAt: now, status: "claimed",
        };
        await storage.write(keyOf(taskId), JSON.stringify(record));
        return { claimed: true, record };
      });
    },
    settle(record: ScheduleDeliveryRecord, status: Exclude<ScheduleDeliveryStatus, "claimed">, message?: string) {
      return serialize(keyOf(record.taskId), async () => {
        const current = await read(record.taskId);
        if (!current || current.claimId !== record.claimId) return current;
        const next = { ...current, status, message };
        await storage.write(keyOf(record.taskId), JSON.stringify(next));
        return next;
      });
    },
  };
}

export type ScheduleStateStore = ReturnType<typeof createScheduleStateStore>;
export const scheduleStateStore = createScheduleStateStore({
  async read(key) {
    if (typeof window === "undefined") throw new Error("提醒存储不可用");
    if ("__TAURI_INTERNALS__" in window) return (await loadAppKvEntries([key]))[key] ?? null;
    return localStorage.getItem(key);
  },
  async write(key, value) {
    if (typeof window === "undefined") throw new Error("提醒存储不可用");
    if ("__TAURI_INTERNALS__" in window) await saveAppKvEntry(key, value);
    else localStorage.setItem(key, value);
  },
});
