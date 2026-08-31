import { invoke } from "@tauri-apps/api/core";

type AppStoragePayload = {
  entries: Record<string, string>;
};

export type ManifestStoragePayload = {
  projectPresetsJson?: string | null;
  toolManifestsJson?: string | null;
  skillManifestsJson?: string | null;
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
    return { ...fallback, ...JSON.parse(raw) };
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

  void invoke("save_app_kv", { key, value }).catch(() => {
    // 浏览器或异常环境继续保留 localStorage
  });
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

  void invoke("remove_app_kv", { key }).catch(() => {
    // 浏览器或异常环境继续保留 localStorage
  });
}

export async function loadManifestStorage() {
  if (!canUseTauriInvoke()) {
    return {
      projectPresetsJson: null,
      toolManifestsJson: null,
      skillManifestsJson: null,
    } satisfies ManifestStoragePayload;
  }

  return invoke<ManifestStoragePayload>("load_manifest_storage_command");
}

export async function saveManifestStorage(payload: ManifestStoragePayload) {
  if (!canUseTauriInvoke()) return;
  await invoke("save_manifest_storage_command", payload);
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
  await invoke("save_memory_storage_command", payload);
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
  await invoke("save_automation_storage_command", payload);
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
  await invoke("save_app_kv", { key, value });
}

export async function removeAppKvEntry(key: string) {
  if (!canUseTauriInvoke()) return;
  await invoke("remove_app_kv", { key });
}
