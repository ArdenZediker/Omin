import { beforeEach, describe, expect, it } from "vitest";
import { THEME_CONFIG_STORAGE_KEY, THEME_MODE_STORAGE_KEY } from "./constants";
import {
  applyThemeConfig,
  applyThemeMode,
  DEFAULT_LIGHT_THEME_CONFIG,
  DEFAULT_THEME_CONFIG,
  normalizeThemeConfig,
  normalizeThemeSettings,
  resolveActiveThemeConfig,
  THEME_PRESET_LABELS,
  THEME_PRESETS,
  type ThemeSettings,
} from "./settings";
import { readSqliteBackedValue, saveSqliteBackedValue } from "./sqliteStorage";

describe("Codex-compatible theme configuration", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("style");
    document.documentElement.removeAttribute("data-omni-theme");
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  });

  it("normalizes the copied codex-theme-v1 format and keeps system fonts as null", () => {
    const config = normalizeThemeConfig({
      codeThemeId: "github",
      theme: {
        accent: "#1F6FEB",
        accentSource: "custom",
        contrast: 60,
        fonts: { code: null, ui: null },
        ink: "#E6EDF3",
        opaqueWindows: false,
        semanticColors: { diffAdded: "#3FB950", diffRemoved: "#F85149", skill: "#BC8CFF" },
        surface: "#0D1117",
      },
      variant: "dark",
    });

    expect(config).toEqual(DEFAULT_THEME_CONFIG);
    expect(config.theme.fonts).toEqual({ code: null, ui: null });
  });

  it("rejects invalid colors, clamps contrast, applies CSS variables, and persists", () => {
    const config = normalizeThemeConfig({
      ...DEFAULT_THEME_CONFIG,
      theme: { ...DEFAULT_THEME_CONFIG.theme, accent: "red", contrast: 140 },
    });

    applyThemeConfig(config, false);

    expect(config.theme.accent).toBe(DEFAULT_THEME_CONFIG.theme.accent);
    expect(config.theme.contrast).toBe(100);
    expect(document.documentElement.style.getPropertyValue("--omni-accent")).toBe(DEFAULT_THEME_CONFIG.theme.accent);
    expect(document.documentElement.style.getPropertyValue("--omni-app-bg")).toBe(DEFAULT_THEME_CONFIG.theme.surface);
    const stored = normalizeThemeSettings(JSON.parse(readSqliteBackedValue(THEME_CONFIG_STORAGE_KEY) ?? "null"));
    expect(stored.dark).toEqual({ ...DEFAULT_THEME_CONFIG, theme: { ...DEFAULT_THEME_CONFIG.theme, contrast: 100 } });
    expect(stored.light).toEqual(DEFAULT_LIGHT_THEME_CONFIG);
  });

  it("exposes the Codex built-in theme identifiers in the same selection list", () => {
    expect(Object.keys(THEME_PRESETS).sort()).toEqual(Object.keys(THEME_PRESET_LABELS).sort());
    expect(THEME_PRESETS).toHaveProperty("catppuccin");
    expect(THEME_PRESETS).toHaveProperty("tokyo-night");
    expect(Object.keys(THEME_PRESETS)).toHaveLength(29);
  });

  it("migrates a legacy single theme into separate light and dark visual styles", () => {
    const settings = normalizeThemeSettings(DEFAULT_THEME_CONFIG);
    expect(settings.separateVariants).toBe(false);
    expect(settings.dark).toEqual(DEFAULT_THEME_CONFIG);
    expect(settings.light).toEqual(DEFAULT_LIGHT_THEME_CONFIG);
  });

  it("resolves independent visual styles for auto, light and dark", () => {
    const settings: ThemeSettings = {
      separateVariants: true,
      light: DEFAULT_LIGHT_THEME_CONFIG,
      dark: DEFAULT_THEME_CONFIG,
    };
    expect(resolveActiveThemeConfig(settings, "light")).toEqual(DEFAULT_LIGHT_THEME_CONFIG);
    expect(resolveActiveThemeConfig(settings, "dark")).toEqual(DEFAULT_THEME_CONFIG);
    const collapsedLight = resolveActiveThemeConfig({ ...settings, separateVariants: false }, "light");
    expect(collapsedLight).toEqual(DEFAULT_LIGHT_THEME_CONFIG);
  });

  it("reapplies the matching visual style when the theme mode changes", () => {
    saveSqliteBackedValue(THEME_CONFIG_STORAGE_KEY, JSON.stringify({
      separateVariants: true,
      light: DEFAULT_LIGHT_THEME_CONFIG,
      dark: DEFAULT_THEME_CONFIG,
    }));
    applyThemeMode(THEME_MODE_STORAGE_KEY, "light", false);
    expect(document.documentElement.dataset.omniTheme).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--omni-app-bg")).toBe("#ffffff");
    expect(document.documentElement.style.getPropertyValue("--omni-app-text")).toBe("#1f2328");
    applyThemeMode(THEME_MODE_STORAGE_KEY, "dark", false);
    expect(document.documentElement.dataset.omniTheme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--omni-app-bg")).toBe("#0d1117");
    expect(document.documentElement.style.getPropertyValue("--omni-app-text")).toBe("#e6edf3");
  });

  it("keeps light surfaces near white while preserving the dark palette", () => {
    saveSqliteBackedValue(THEME_CONFIG_STORAGE_KEY, JSON.stringify({
      separateVariants: true,
      light: DEFAULT_LIGHT_THEME_CONFIG,
      dark: DEFAULT_THEME_CONFIG,
    }));

    applyThemeMode(THEME_MODE_STORAGE_KEY, "light", false);
    expect(document.documentElement.style.getPropertyValue("--omni-panel-bg")).toBe("#ffffff");
    expect(document.documentElement.style.getPropertyValue("--omni-card-bg")).toBe("#ffffff");
    expect(document.documentElement.style.getPropertyValue("--omni-app-surface-2")).toContain("#ffffff 99%");
    expect(document.documentElement.style.getPropertyValue("--omni-app-surface-3")).toContain("#ffffff 97%");
    expect(document.documentElement.style.getPropertyValue("--omni-input-bg")).toBe("#ffffff");

    applyThemeMode(THEME_MODE_STORAGE_KEY, "dark", false);
    expect(document.documentElement.style.getPropertyValue("--omni-panel-bg")).toContain("#0d1117 94%");
    expect(document.documentElement.style.getPropertyValue("--omni-card-bg")).toContain("#0d1117 88%");
    expect(document.documentElement.style.getPropertyValue("--omni-app-surface-3")).toContain("#0d1117 82%");
  });

  it("selects the matching stored variant even when the editor shows only one configuration", () => {
    saveSqliteBackedValue(THEME_CONFIG_STORAGE_KEY, JSON.stringify({
      separateVariants: false,
      light: DEFAULT_LIGHT_THEME_CONFIG,
      dark: DEFAULT_THEME_CONFIG,
    }));
    applyThemeMode(THEME_MODE_STORAGE_KEY, "light", false);
    expect(document.documentElement.style.getPropertyValue("--omni-app-bg")).toBe(DEFAULT_LIGHT_THEME_CONFIG.theme.surface);
    expect(document.documentElement.style.getPropertyValue("--omni-app-text")).toBe(DEFAULT_LIGHT_THEME_CONFIG.theme.ink);
    applyThemeMode(THEME_MODE_STORAGE_KEY, "dark", false);
    expect(document.documentElement.style.getPropertyValue("--omni-app-bg")).toBe(DEFAULT_THEME_CONFIG.theme.surface);
    expect(document.documentElement.style.getPropertyValue("--omni-app-text")).toBe(DEFAULT_THEME_CONFIG.theme.ink);
  });

  it("migrates the previous shared editor value into the currently active variant", () => {
    const oldShared = {
      ...DEFAULT_THEME_CONFIG,
      codeThemeId: "absolutely",
      theme: { ...DEFAULT_THEME_CONFIG.theme, accent: "#ff8c42" },
    };
    const settings = normalizeThemeSettings({
      separateVariants: false,
      shared: oldShared,
      light: DEFAULT_LIGHT_THEME_CONFIG,
      dark: DEFAULT_THEME_CONFIG,
    }, "light");
    expect(settings.light.codeThemeId).toBe("absolutely");
    expect(settings.light.theme.accent).toBe("#ff8c42");
    expect(settings.light.theme.surface).toBe(DEFAULT_LIGHT_THEME_CONFIG.theme.surface);
    expect(settings.dark).toEqual(DEFAULT_THEME_CONFIG);
  });

  it("switches modes from the previous shared storage format even when the editor is collapsed", () => {
    saveSqliteBackedValue(THEME_CONFIG_STORAGE_KEY, JSON.stringify({
      separateVariants: false,
      shared: {
        ...DEFAULT_THEME_CONFIG,
        codeThemeId: "absolutely",
        theme: { ...DEFAULT_THEME_CONFIG.theme, accent: "#ff8c42" },
      },
      light: DEFAULT_LIGHT_THEME_CONFIG,
      dark: DEFAULT_THEME_CONFIG,
    }));
    applyThemeMode(THEME_MODE_STORAGE_KEY, "light", false);
    expect(document.documentElement.style.getPropertyValue("--omni-app-bg")).toBe("#ffffff");
    expect(document.documentElement.style.getPropertyValue("--omni-app-text")).toBe("#1f2328");
    expect(document.documentElement.style.getPropertyValue("--omni-accent")).toBe("#ff8c42");
    applyThemeMode(THEME_MODE_STORAGE_KEY, "dark", false);
    expect(document.documentElement.style.getPropertyValue("--omni-app-bg")).toBe("#0d1117");
    expect(document.documentElement.style.getPropertyValue("--omni-accent")).toBe("#ff8c42");
  });
});
