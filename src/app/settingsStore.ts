import type { BasicSettings } from "./types";
import { DEFAULT_USAGE_PREFERENCES, USAGE_PREFERENCES_STORAGE_KEY } from "../chat/storage";
import { loadAppKvEntries, removeAppKvEntry, readSqliteBackedJson, readSqliteBackedValue, removeSqliteBackedValue, saveAppKvEntry, saveSqliteBackedValue } from "./sqliteStorage";
import { BASIC_SETTINGS_STORAGE_KEY, DEFAULT_BASIC_SETTINGS, MAIN_POSITION_STORAGE_KEY } from "./constants";

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

/** 一次性迁移标记：把「打开主窗口」的定位偏好从旧的默认值 remember 迁到 center。 */
const MAIN_WINDOW_POSITION_MIGRATION_KEY = "omni_main_window_position_migrated_v1";

/**
 * 一次性迁移「打开主窗口」的定位偏好。
 *
 * 早期版本该字段的默认值是 `remember`（记住上次位置），多数用户从未显式改过它；而记忆位置
 * 只要被写过一次，之后每次启动都会回到那个落点——一旦显示器缩放/分辨率或窗口尺寸变化，
 * 那个落点就不再居中，表现就是"一启动窗口就偏在屏幕一角"。
 *
 * 这里把仍为 `remember` 的存量值迁移为 `center`，并清掉旧记忆位置；用户之后仍可在设置里
 * 显式选回「记住上次位置」（迁移标记已写，不会再被覆盖）。返回本次是否发生了迁移。
 */
export function migrateMainWindowPositionPreference(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  if (readSqliteBackedValue(MAIN_WINDOW_POSITION_MIGRATION_KEY) === "done") {
    return false;
  }
  saveSqliteBackedValue(MAIN_WINDOW_POSITION_MIGRATION_KEY, "done");

  const settings = loadBasicSettings(BASIC_SETTINGS_STORAGE_KEY, DEFAULT_BASIC_SETTINGS);
  if (settings.mainWindowPositionMode !== "remember") {
    return false;
  }

  saveBasicSettings(BASIC_SETTINGS_STORAGE_KEY, { ...settings, mainWindowPositionMode: "center" });
  removeSqliteBackedValue(MAIN_POSITION_STORAGE_KEY);
  return true;
}
