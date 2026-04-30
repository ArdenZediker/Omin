import { invoke } from "@tauri-apps/api/core";

type AppStoragePayload = {
  entries: Record<string, string>;
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
  localStorage.setItem(key, value);
  window.dispatchEvent(new StorageEvent("storage", { key, newValue: value }));

  if (!canUseTauriInvoke()) {
    return;
  }

  void invoke("save_app_kv", { key, value }).catch(() => {
    // 浏览器或异常环境继续保留 localStorage
  });
}

export function removeSqliteBackedValue(key: string) {
  if (typeof window === "undefined") return;
  localStorage.removeItem(key);
  window.dispatchEvent(new StorageEvent("storage", { key, newValue: null }));

  if (!canUseTauriInvoke()) {
    return;
  }

  void invoke("remove_app_kv", { key }).catch(() => {
    // 浏览器或异常环境继续保留 localStorage
  });
}
