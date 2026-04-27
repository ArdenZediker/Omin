import type { BasicSettings } from "./types";

export type ThemeMode = "auto" | "dark" | "light";

export function getInitialThemeMode(themeStorageKey: string): ThemeMode {
  if (typeof window === "undefined") return "auto";
  const saved = localStorage.getItem(themeStorageKey);
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
  localStorage.setItem(themeStorageKey, mode);
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
