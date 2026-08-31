import { emit } from "@tauri-apps/api/event";
import type { BasicSettings } from "./types";
import { readSqliteBackedJson, readSqliteBackedValue, saveSqliteBackedValue } from "./sqliteStorage";

export type ThemeMode = "auto" | "dark" | "light";
type LegacyBasicSettings = BasicSettings & {
  settingsWindowWidth?: number;
  settingsWindowHeight?: number;
};

export function normalizeBasicSettings(settings: LegacyBasicSettings): BasicSettings {
  const { settingsWindowWidth: _settingsWindowWidth, settingsWindowHeight: _settingsWindowHeight, ...normalized } = settings;
  return normalized;
}

export function getInitialThemeMode(themeStorageKey: string): ThemeMode {
  if (typeof window === "undefined") return "auto";
  const saved = readSqliteBackedValue(themeStorageKey);
  return saved === "dark" || saved === "light" ? saved : "auto";
}

export function resolveThemeMode(mode: ThemeMode) {
  if (mode !== "auto") return mode;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyThemeMode(themeStorageKey: string, mode: ThemeMode, emitEvent = true) {
  const resolved = resolveThemeMode(mode);
  const previous = readSqliteBackedValue(themeStorageKey);
  document.documentElement.dataset.omniThemeMode = mode;
  document.documentElement.dataset.omniTheme = resolved;
  saveSqliteBackedValue(themeStorageKey, mode);
  // 只有真正发生变化时才广播：否则「emit → 对端 applyThemeMode → 再 emit」会在
  // 多窗口之间来回触发，与 storage 事件叠加后形成回环。
  if (emitEvent && previous !== mode && typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    void emit("omni-theme-mode-changed", { mode });
  }
}

export function loadBasicSettings(storageKey: string, defaults: BasicSettings): BasicSettings {
  if (typeof window === "undefined") return defaults;
  return normalizeBasicSettings(readSqliteBackedJson(storageKey, defaults));
}

export function saveBasicSettings(storageKey: string, settings: BasicSettings) {
  saveSqliteBackedValue(storageKey, JSON.stringify(normalizeBasicSettings(settings as LegacyBasicSettings)));
}
