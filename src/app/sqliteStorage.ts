import { invoke } from "@tauri-apps/api/core";

export type StorageWriteFailure = { key: string; message: string; failedAt: number };
type PendingStorageWrite = { generation: number; execute: () => Promise<unknown> };
const writeTails = new Map<string, Promise<void>>();
const pendingWrites = new Map<string, PendingStorageWrite>();
const failures = new Map<string, StorageWriteFailure>();
const failureListeners = new Set<() => void>();
let failureSnapshot: StorageWriteFailure[] = [];
let nextGeneration = 0;

function publishFailures() {
  failureSnapshot = [...failures.values()].sort((a, b) => b.failedAt - a.failedAt);
  failureListeners.forEach((listener) => listener());
}

export function getStorageWriteFailures() { return failureSnapshot; }
export function subscribeStorageWriteFailures(listener: () => void) {
  failureListeners.add(listener);
  return () => failureListeners.delete(listener);
}

function enqueueStorageWrite(key: string, pending: PendingStorageWrite): Promise<void> {
  pendingWrites.set(key, pending);
  const previous = writeTails.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    // 每个 awaited 调用都确实落库；失败重试另外选择最新 generation。
    try {
      await pending.execute();
      if (pendingWrites.get(key)?.generation === pending.generation) {
        pendingWrites.delete(key);
        failures.delete(key);
        publishFailures();
      }
    } catch (error) {
      if (pendingWrites.get(key)?.generation === pending.generation) {
        failures.set(key, { key, message: error instanceof Error ? error.message : String(error), failedAt: Date.now() });
        publishFailures();
      }
      throw error;
    }
  });
  const tail = operation.catch(() => undefined);
  writeTails.set(key, tail);
  void tail.finally(() => { if (writeTails.get(key) === tail) writeTails.delete(key); });
  return operation;
}

export async function flushStorageWrites() {
  await Promise.all([...writeTails.values()]);
}

export async function retryFailedStorageWrites() {
  const retries = [...pendingWrites.entries()].filter(([key]) => failures.has(key)).map(([key, pending]) => enqueueStorageWrite(key, pending));
  await Promise.allSettled(retries);
  return failureSnapshot;
}

/** 非 KV 存储也共享可见失败和重试；key 是同一数据集合的串行化边界。 */
export function persistStorageOperation(key: string, execute: () => Promise<unknown>) {
  return enqueueStorageWrite(key, { generation: ++nextGeneration, execute });
}

type AppStoragePayload = {
  entries: Record<string, string>;
};

export type MemoryStoragePayload = {
  projectMemoriesJson?: string | null;
  userPreferencesJson?: string | null;
  sessionSummariesJson?: string | null;
};

export type AutomationStoragePayload = {
  scheduledTasksJson?: string | null;
};

function canUseTauriInvoke() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function bootstrapSqliteStorage(keys: string[]) {
  if (typeof window === "undefined" || keys.length === 0) return;

  const uniqueKeys = Array.from(new Set(keys));
  // 先排空当前窗口尚未完成的保存，再拉取 SQLite，避免启动期旧快照覆盖新值。
  await Promise.all(uniqueKeys.map((key) => writeTails.get(key)).filter((tail): tail is Promise<void> => Boolean(tail)));
  const legacyEntries = Object.fromEntries(
    uniqueKeys
      .map((key) => [key, localStorage.getItem(key)])
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );

  if (!canUseTauriInvoke()) {
    return;
  }

  try {
    const payload = await invoke<AppStoragePayload>("load_app_kv", {
      keys: uniqueKeys,
      legacyEntries,
    });

    Object.entries(payload.entries).forEach(([key, value]) => {
      if (pendingWrites.has(key)) return;
      // 仅在与本地值不同时才覆盖并通知，避免向监听者广播无变化的事件。
      if (localStorage.getItem(key) === value) {
        return;
      }
      localStorage.setItem(key, value);
      window.dispatchEvent(new StorageEvent("storage", { key, newValue: value }));
    });
  } catch {
    // 保持 localStorage 兜底
  }
}

export function readSqliteBackedValue(key: string) {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(key);
}

export function readSqliteBackedJson<T>(key: string, fallback: T): T {
  const raw = readSqliteBackedValue(key);
  if (!raw) return fallback;

  try {
    const parsed = JSON.parse(raw);
    // 数组 fallback 不能按对象 spread 合并，否则会变成 {0:..., 1:...} 并丢失数组结构。
    if (Array.isArray(fallback)) {
      return Array.isArray(parsed) ? (parsed as T) : fallback;
    }
    // 对象沿用浅合并行为，保证新增字段有默认值。
    if (fallback && typeof fallback === "object") {
      return { ...fallback, ...parsed } as T;
    }
    return parsed as T;
  } catch {
    return fallback;
  }
}

export function saveSqliteBackedValue(key: string, value: string) {
  if (typeof window === "undefined") return;

  const unchanged = localStorage.getItem(key) === value;

  // 值未变化时只跳过 setItem 与 storage 事件派发。
  // 否则「写入 → storage 事件 → 监听回调再次写入」会形成同步无限递归
  // （主题同步链路曾因此 Maximum call stack size exceeded）。
  // 仍然照常落库：localStorage 有值并不代表 SQLite 里一定有（换库/首次迁移）。
  if (!unchanged) {
    localStorage.setItem(key, value);
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: value }));
  }

  if (!canUseTauriInvoke()) {
    return;
  }

  void persistStorageOperation(key, () => invoke("save_app_kv", { key, value })).catch(() => undefined);
}

export function removeSqliteBackedValue(key: string) {
  if (typeof window === "undefined") return;

  // 同 saveSqliteBackedValue：键本就不存在时不再派发事件（避免无意义回环），
  // 但仍照常请求删除，保证 SQLite 侧同步。
  if (localStorage.getItem(key) !== null) {
    localStorage.removeItem(key);
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: null }));
  }

  if (!canUseTauriInvoke()) {
    return;
  }

  void persistStorageOperation(key, () => invoke("remove_app_kv", { key })).catch(() => undefined);
}

export async function loadMemoryStorage() {
  if (!canUseTauriInvoke()) {
    return {
      projectMemoriesJson: null,
      userPreferencesJson: null,
      sessionSummariesJson: null,
    } satisfies MemoryStoragePayload;
  }

  return invoke<MemoryStoragePayload>("load_memory_storage_command");
}

export async function saveMemoryStorage(payload: MemoryStoragePayload) {
  if (!canUseTauriInvoke()) return;
  await persistStorageOperation("memory", () => invoke("save_memory_storage_command", payload));
}

export async function loadAutomationStorage() {
  if (!canUseTauriInvoke()) {
    return {
      scheduledTasksJson: null,
    } satisfies AutomationStoragePayload;
  }

  return invoke<AutomationStoragePayload>("load_automation_storage_command");
}

export async function saveAutomationStorage(payload: AutomationStoragePayload) {
  if (!canUseTauriInvoke()) return;
  await persistStorageOperation("automation", () => invoke("save_automation_storage_command", payload));
}


export async function loadAppKvEntries(keys: string[]) {
  if (typeof window === "undefined" || keys.length === 0 || !canUseTauriInvoke()) {
    return {} as Record<string, string>;
  }

  const payload = await invoke<AppStoragePayload>("load_app_kv", {
    keys: Array.from(new Set(keys)),
    legacyEntries: {},
  });

  return payload.entries;
}

export async function saveAppKvEntry(key: string, value: string) {
  if (!canUseTauriInvoke()) return;
  await persistStorageOperation(key, () => invoke("save_app_kv", { key, value }));
}

export async function removeAppKvEntry(key: string) {
  if (!canUseTauriInvoke()) return;
  await persistStorageOperation(key, () => invoke("remove_app_kv", { key }));
}
