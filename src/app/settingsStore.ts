import type { BasicSettings } from "./types";
import { DEFAULT_USAGE_PREFERENCES, USAGE_PREFERENCES_STORAGE_KEY } from "../chat/storage";

const MODEL_CONNECTION_STATUS_KEY = "omni_model_connection_status";

export function loadUsagePreferences() {
  try {
    return { ...DEFAULT_USAGE_PREFERENCES, ...JSON.parse(localStorage.getItem(USAGE_PREFERENCES_STORAGE_KEY) || "{}") };
  } catch {
    return DEFAULT_USAGE_PREFERENCES;
  }
}

export function saveUsagePreferences(prefs: typeof DEFAULT_USAGE_PREFERENCES) {
  localStorage.setItem(USAGE_PREFERENCES_STORAGE_KEY, JSON.stringify(prefs));
}

export function saveModelConnectionStatus(modelId: string, connected: boolean) {
  try {
    const status = JSON.parse(localStorage.getItem(MODEL_CONNECTION_STATUS_KEY) || "{}") as Record<string, boolean>;
    status[modelId] = connected;
    localStorage.setItem(MODEL_CONNECTION_STATUS_KEY, JSON.stringify(status));
  } catch {
    localStorage.setItem(MODEL_CONNECTION_STATUS_KEY, JSON.stringify({ [modelId]: connected }));
  }
}

export function removeModelConnectionStatus(modelId: string) {
  try {
    const status = JSON.parse(localStorage.getItem(MODEL_CONNECTION_STATUS_KEY) || "{}") as Record<string, boolean>;
    delete status[modelId];
    localStorage.setItem(MODEL_CONNECTION_STATUS_KEY, JSON.stringify(status));
  } catch {
    localStorage.removeItem(MODEL_CONNECTION_STATUS_KEY);
  }
}

export function loadBasicSettings(storageKey: string, defaults: BasicSettings): BasicSettings {
  if (typeof window === "undefined") return defaults;
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(storageKey) || "{}") };
  } catch {
    return defaults;
  }
}

export function saveBasicSettings(storageKey: string, settings: BasicSettings) {
  localStorage.setItem(storageKey, JSON.stringify(settings));
  window.dispatchEvent(new StorageEvent("storage", { key: storageKey, newValue: JSON.stringify(settings) }));
}
