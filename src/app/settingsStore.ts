import type { BasicSettings } from "./types";
import { DEFAULT_USAGE_PREFERENCES, USAGE_PREFERENCES_STORAGE_KEY } from "../chat/storage";
import { readSqliteBackedJson, removeSqliteBackedValue, saveSqliteBackedValue } from "./sqliteStorage";

const MODEL_CONNECTION_STATUS_KEY = "omni_model_connection_status";

export function loadUsagePreferences() {
  return readSqliteBackedJson(USAGE_PREFERENCES_STORAGE_KEY, DEFAULT_USAGE_PREFERENCES);
}

export function saveUsagePreferences(prefs: typeof DEFAULT_USAGE_PREFERENCES) {
  saveSqliteBackedValue(USAGE_PREFERENCES_STORAGE_KEY, JSON.stringify(prefs));
}

export function saveModelConnectionStatus(modelId: string, connected: boolean) {
  try {
    const status = readSqliteBackedJson<Record<string, boolean>>(MODEL_CONNECTION_STATUS_KEY, {});
    status[modelId] = connected;
    saveSqliteBackedValue(MODEL_CONNECTION_STATUS_KEY, JSON.stringify(status));
  } catch {
    saveSqliteBackedValue(MODEL_CONNECTION_STATUS_KEY, JSON.stringify({ [modelId]: connected }));
  }
}

export function removeModelConnectionStatus(modelId: string) {
  try {
    const status = readSqliteBackedJson<Record<string, boolean>>(MODEL_CONNECTION_STATUS_KEY, {});
    delete status[modelId];
    saveSqliteBackedValue(MODEL_CONNECTION_STATUS_KEY, JSON.stringify(status));
  } catch {
    removeSqliteBackedValue(MODEL_CONNECTION_STATUS_KEY);
  }
}

export function loadBasicSettings(storageKey: string, defaults: BasicSettings): BasicSettings {
  if (typeof window === "undefined") return defaults;
  return readSqliteBackedJson(storageKey, defaults);
}

export function saveBasicSettings(storageKey: string, settings: BasicSettings) {
  saveSqliteBackedValue(storageKey, JSON.stringify(settings));
}
