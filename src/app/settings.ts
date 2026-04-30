import type { BasicSettings } from "./types";
import { readSqliteBackedJson, readSqliteBackedValue, saveSqliteBackedValue } from "./sqliteStorage";

export type ThemeMode = "auto" | "dark" | "light";

export function getInitialThemeMode(themeStorageKey: string): ThemeMode {
  if (typeof window === "undefined") return "auto";
  const saved = readSqliteBackedValue(themeStorageKey);
  return saved === "dark" || saved === "light" ? saved : "auto";
}

export function resolveThemeMode(mode: ThemeMode) {
  if (mode !== "auto") return mode;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyThemeMode(themeStorageKey: string, mode: ThemeMode) {
  const resolved = resolveThemeMode(mode);
  document.documentElement.dataset.omniThemeMode = mode;
  document.documentElement.dataset.omniTheme = resolved;
  saveSqliteBackedValue(themeStorageKey, mode);
}

export function loadBasicSettings(storageKey: string, defaults: BasicSettings): BasicSettings {
  if (typeof window === "undefined") return defaults;
  return readSqliteBackedJson(storageKey, defaults);
}

export function saveBasicSettings(storageKey: string, settings: BasicSettings) {
  saveSqliteBackedValue(storageKey, JSON.stringify(settings));
}
