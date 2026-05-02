import type { BasicSettings } from "./types";
import { DEFAULT_USAGE_PREFERENCES, USAGE_PREFERENCES_STORAGE_KEY } from "../chat/storage";
import { loadAppKvEntries, removeAppKvEntry, readSqliteBackedJson, removeSqliteBackedValue, saveAppKvEntry, saveSqliteBackedValue } from "./sqliteStorage";

const MODEL_CONNECTION_STATUS_KEY = "omni_model_connection_status";

function canUseTauriStorage() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function loadUsagePreferences() {
  return readSqliteBackedJson(USAGE_PREFERENCES_STORAGE_KEY, DEFAULT_USAGE_PREFERENCES);
}

export function saveUsagePreferences(prefs: typeof DEFAULT_USAGE_PREFERENCES) {
  saveSqliteBackedValue(USAGE_PREFERENCES_STORAGE_KEY, JSON.stringify(prefs));
}

export async function saveModelConnectionStatus(modelId: string, connected: boolean) {
  try {
    const status = canUseTauriStorage()
      ? JSON.parse((await loadAppKvEntries([MODEL_CONNECTION_STATUS_KEY]))[MODEL_CONNECTION_STATUS_KEY] || "{}")
      : readSqliteBackedJson<Record<string, boolean>>(MODEL_CONNECTION_STATUS_KEY, {});
    status[modelId] = connected;

    if (canUseTauriStorage()) {
      await saveAppKvEntry(MODEL_CONNECTION_STATUS_KEY, JSON.stringify(status));
      localStorage.removeItem(MODEL_CONNECTION_STATUS_KEY);
    } else {
      saveSqliteBackedValue(MODEL_CONNECTION_STATUS_KEY, JSON.stringify(status));
    }
  } catch {
    if (canUseTauriStorage()) {
      await saveAppKvEntry(MODEL_CONNECTION_STATUS_KEY, JSON.stringify({ [modelId]: connected }));
      localStorage.removeItem(MODEL_CONNECTION_STATUS_KEY);
    } else {
      saveSqliteBackedValue(MODEL_CONNECTION_STATUS_KEY, JSON.stringify({ [modelId]: connected }));
    }
  }
}

export async function removeModelConnectionStatus(modelId: string) {
  try {
    const status = canUseTauriStorage()
      ? JSON.parse((await loadAppKvEntries([MODEL_CONNECTION_STATUS_KEY]))[MODEL_CONNECTION_STATUS_KEY] || "{}")
      : readSqliteBackedJson<Record<string, boolean>>(MODEL_CONNECTION_STATUS_KEY, {});
    delete status[modelId];

    if (Object.keys(status).length === 0) {
      if (canUseTauriStorage()) {
        await removeAppKvEntry(MODEL_CONNECTION_STATUS_KEY);
        localStorage.removeItem(MODEL_CONNECTION_STATUS_KEY);
      } else {
        removeSqliteBackedValue(MODEL_CONNECTION_STATUS_KEY);
      }
      return;
    }

    if (canUseTauriStorage()) {
      await saveAppKvEntry(MODEL_CONNECTION_STATUS_KEY, JSON.stringify(status));
      localStorage.removeItem(MODEL_CONNECTION_STATUS_KEY);
    } else {
      saveSqliteBackedValue(MODEL_CONNECTION_STATUS_KEY, JSON.stringify(status));
    }
  } catch {
    if (canUseTauriStorage()) {
      await removeAppKvEntry(MODEL_CONNECTION_STATUS_KEY);
      localStorage.removeItem(MODEL_CONNECTION_STATUS_KEY);
    } else {
      removeSqliteBackedValue(MODEL_CONNECTION_STATUS_KEY);
    }
  }
}

export function loadBasicSettings(storageKey: string, defaults: BasicSettings): BasicSettings {
  if (typeof window === "undefined") return defaults;
  return readSqliteBackedJson(storageKey, defaults);
}

export function saveBasicSettings(storageKey: string, settings: BasicSettings) {
  saveSqliteBackedValue(storageKey, JSON.stringify(settings));
}
