import { emit } from "@tauri-apps/api/event";
import type { BasicSettings } from "./types";
import { DEFAULT_BASIC_SETTINGS } from "./constants";
import { readSqliteBackedJson, readSqliteBackedValue, saveSqliteBackedValue } from "./sqliteStorage";
import { THEME_CONFIG_STORAGE_KEY, THEME_MODE_STORAGE_KEY } from "./constants";

export type ThemeMode = "auto" | "dark" | "light";
export type ThemeVariant = "dark" | "light";
export type ThemeConfig = {
  codeThemeId: string;
  theme: {
    accent: string;
    accentSource: "custom" | "preset";
    contrast: number;
    fonts: { code: string | null; ui: string | null };
    ink: string;
    opaqueWindows: boolean;
    semanticColors: { diffAdded: string; diffRemoved: string; skill: string };
    surface: string;
  };
  variant: ThemeVariant;
};

/** 始终保存浅色和深色配置；separateVariants 只控制设置页是否同时展示两套编辑器。 */
export type ThemeSettings = {
  separateVariants: boolean;
  light: ThemeConfig;
  dark: ThemeConfig;
};

export const DEFAULT_THEME_CONFIG: ThemeConfig = {
  codeThemeId: "github",
  theme: {
    accent: "#1f6feb",
    accentSource: "custom",
    contrast: 60,
    fonts: { code: null, ui: null },
    ink: "#e6edf3",
    opaqueWindows: false,
    semanticColors: { diffAdded: "#3fb950", diffRemoved: "#f85149", skill: "#bc8cff" },
    surface: "#0d1117",
  },
  variant: "dark",
};

export const DEFAULT_LIGHT_THEME_CONFIG: ThemeConfig = {
  codeThemeId: "github",
  theme: {
    accent: "#0969da",
    accentSource: "custom",
    contrast: 64,
    fonts: { code: null, ui: null },
    ink: "#1f2328",
    opaqueWindows: true,
    semanticColors: { diffAdded: "#1a7f37", diffRemoved: "#cf222e", skill: "#8250df" },
    surface: "#ffffff",
  },
  variant: "light",
};

export const DEFAULT_THEME_SETTINGS: ThemeSettings = {
  separateVariants: false,
  light: DEFAULT_LIGHT_THEME_CONFIG,
  dark: DEFAULT_THEME_CONFIG,
};

const THEME_PRESET_COLORS: Record<string, [string, string, string]> = {
  absolutely: ["#ff8c42", "#202124", "#f2f2f2"],
  ayu: ["#e6b450", "#0b0e14", "#b3b1ad"],
  catppuccin: ["#cba6f7", "#1e1e2e", "#cdd6f4"],
  codex: ["#10a37f", "#111111", "#f7f7f8"],
  dracula: ["#bd93f9", "#282a36", "#f8f8f2"],
  everforest: ["#a7c080", "#2d353b", "#d3c6aa"],
  github: ["#1f6feb", "#0d1117", "#e6edf3"],
  gruvbox: ["#fabd2f", "#282828", "#ebdbb2"],
  linear: ["#5e6ad2", "#171719", "#f7f7f7"],
  lobster: ["#ff5a5f", "#1b1b1b", "#fff3e6"],
  material: ["#82aaff", "#263238", "#eeffff"],
  matrix: ["#00ff41", "#001b00", "#00ff41"],
  monokai: ["#a6e22e", "#272822", "#f8f8f2"],
  "night-owl": ["#82aaff", "#011627", "#d6deeb"],
  nord: ["#88c0d0", "#2e3440", "#eceff4"],
  notion: ["#2eaadc", "#202020", "#f7f6f3"],
  og: ["#ff7a59", "#0f1115", "#fafafa"],
  oscurange: ["#ff9d00", "#1e1e1e", "#f0f0e0"],
  one: ["#61afef", "#282c34", "#abb2bf"],
  proof: ["#1a73e8", "#f7f8fa", "#202124"],
  raycast: ["#ff6363", "#1d1d1f", "#f5f5f7"],
  "rose-pine": ["#c4a7e7", "#191724", "#e0def4"],
  sentry: ["#f05545", "#1f1f23", "#e8e8e8"],
  solarized: ["#b58900", "#002b36", "#839496"],
  temple: ["#c084fc", "#1a1720", "#f2e8ff"],
  "tokyo-night": ["#7aa2f7", "#1a1b26", "#a9b1d6"],
  vercel: ["#0070f3", "#000000", "#ededed"],
  "vscode-plus": ["#007acc", "#1e1e1e", "#d4d4d4"],
  xcode: ["#0a84ff", "#1f1f24", "#f2f2f7"],
};

function createThemePreset(codeThemeId: string, [accent, surface, ink]: [string, string, string]): ThemeConfig {
  return {
    codeThemeId,
    theme: {
      accent,
      accentSource: "preset",
      contrast: 60,
      fonts: { code: null, ui: null },
      ink,
      opaqueWindows: false,
      semanticColors: { diffAdded: "#3fb950", diffRemoved: "#f85149", skill: "#bc8cff" },
      surface,
    },
    variant: surface === "#f7f8fa" ? "light" : "dark",
  };
}

export const THEME_PRESETS: Record<string, ThemeConfig> = Object.fromEntries(
  Object.entries(THEME_PRESET_COLORS).map(([id, colors]) => [id, id === "github" ? DEFAULT_THEME_CONFIG : createThemePreset(id, colors)])
);

export const THEME_PRESET_LABELS: Record<string, string> = {
  absolutely: "Absolutely",
  ayu: "Ayu",
  catppuccin: "Catppuccin",
  codex: "Codex",
  dracula: "Dracula",
  everforest: "Everforest",
  github: "GitHub",
  gruvbox: "Gruvbox",
  linear: "Linear",
  lobster: "Lobster",
  material: "Material",
  matrix: "Matrix",
  monokai: "Monokai",
  "night-owl": "Night Owl",
  nord: "Nord",
  notion: "Notion",
  og: "OG",
  oscurange: "Oscurange",
  one: "One",
  proof: "Proof",
  raycast: "Raycast",
  "rose-pine": "Rose Pine",
  sentry: "Sentry",
  solarized: "Solarized",
  temple: "Temple",
  "tokyo-night": "Tokyo Night",
  vercel: "Vercel",
  "vscode-plus": "VS Code Plus",
  xcode: "Xcode",
};

const HEX_COLOR_PATTERN = /^#[\da-f]{6}$/i;

export function isHexColor(value: string): boolean {
  return HEX_COLOR_PATTERN.test(value);
}

export function normalizeThemeConfig(value: unknown): ThemeConfig {
  if (!value || typeof value !== "object") return DEFAULT_THEME_CONFIG;
  const candidate = value as Partial<ThemeConfig>;
  const theme = candidate.theme;
  if (!theme || typeof theme !== "object") return DEFAULT_THEME_CONFIG;
  const color = (input: unknown, fallback: string) =>
    typeof input === "string" && isHexColor(input) ? input.toLowerCase() : fallback;
  const fonts = theme.fonts && typeof theme.fonts === "object" ? theme.fonts : DEFAULT_THEME_CONFIG.theme.fonts;
  const semanticColors = theme.semanticColors && typeof theme.semanticColors === "object"
    ? theme.semanticColors
    : DEFAULT_THEME_CONFIG.theme.semanticColors;
  return {
    codeThemeId: typeof candidate.codeThemeId === "string" ? candidate.codeThemeId : DEFAULT_THEME_CONFIG.codeThemeId,
    theme: {
      accent: color(theme.accent, DEFAULT_THEME_CONFIG.theme.accent),
      accentSource: theme.accentSource === "preset" ? "preset" : "custom",
      contrast: Number.isFinite(theme.contrast) ? Math.min(100, Math.max(0, theme.contrast)) : DEFAULT_THEME_CONFIG.theme.contrast,
      fonts: {
        code: typeof fonts.code === "string" && fonts.code.trim() ? fonts.code.trim() : null,
        ui: typeof fonts.ui === "string" && fonts.ui.trim() ? fonts.ui.trim() : null,
      },
      ink: color(theme.ink, DEFAULT_THEME_CONFIG.theme.ink),
      opaqueWindows: Boolean(theme.opaqueWindows),
      semanticColors: {
        diffAdded: color(semanticColors.diffAdded, DEFAULT_THEME_CONFIG.theme.semanticColors.diffAdded),
        diffRemoved: color(semanticColors.diffRemoved, DEFAULT_THEME_CONFIG.theme.semanticColors.diffRemoved),
        skill: color(semanticColors.skill, DEFAULT_THEME_CONFIG.theme.semanticColors.skill),
      },
      surface: color(theme.surface, DEFAULT_THEME_CONFIG.theme.surface),
    },
    variant: candidate.variant === "light" ? "light" : "dark",
  };
}

function hasThemeShape(value: unknown): value is Partial<ThemeConfig> {
  return Boolean(value && typeof value === "object" && (value as Partial<ThemeConfig>).theme);
}

/** 兼容旧的单份配置和上一版 shared 配置，统一迁移到始终独立的 light/dark 槽位。 */
export function normalizeThemeSettings(value: unknown, activeMode: ThemeVariant = "dark"): ThemeSettings {
  if (!value || typeof value !== "object") return DEFAULT_THEME_SETTINGS;
  const legacy = hasThemeShape(value) ? normalizeThemeConfig(value) : null;
  const candidate = value as Partial<ThemeSettings>;
  const oldShared = normalizeThemeConfig((candidate as Partial<ThemeSettings> & { shared?: ThemeConfig }).shared ?? DEFAULT_THEME_CONFIG);
  const source = legacy ?? ((candidate as Partial<ThemeSettings> & { shared?: ThemeConfig }).shared ? oldShared : null);
  const light = normalizeThemeConfig(candidate.light ?? (source?.variant === "light" ? source : DEFAULT_LIGHT_THEME_CONFIG));
  const dark = normalizeThemeConfig(candidate.dark ?? (source?.variant === "dark" ? source : DEFAULT_THEME_CONFIG));
  const migratedLight = source && activeMode === "light" && (legacy || (candidate as { shared?: ThemeConfig }).shared)
    ? adaptThemeConfigToVariant(source, "light")
    : { ...light, variant: "light" as const };
  const migratedDark = source && activeMode === "dark" && (legacy || (candidate as { shared?: ThemeConfig }).shared)
    ? adaptThemeConfigToVariant(source, "dark")
    : { ...dark, variant: "dark" as const };
  return {
    separateVariants: typeof candidate.separateVariants === "boolean"
      ? candidate.separateVariants
      : false,
    light: migratedLight,
    dark: migratedDark,
  };
}

export function resolveActiveThemeConfig(settingsValue: ThemeSettings, mode: ThemeMode = "auto"): ThemeConfig {
  const settings = normalizeThemeSettings(settingsValue);
  const resolved = mode === "auto" ? resolveThemeMode(mode) : mode;
  return resolved === "light" ? settings.light : settings.dark;
}

/** 旧 shared 配置迁移到目标明暗槽位时，保留主题包/强调色/字体并替换明暗基色。 */
function adaptThemeConfigToVariant(configValue: ThemeConfig, variant: ThemeVariant): ThemeConfig {
  const config = normalizeThemeConfig(configValue);
  if (config.variant === variant) return config;
  const base = variant === "light" ? DEFAULT_LIGHT_THEME_CONFIG : DEFAULT_THEME_CONFIG;
  return {
    ...config,
    theme: {
      ...config.theme,
      ink: base.theme.ink,
      opaqueWindows: base.theme.opaqueWindows,
      semanticColors: { ...base.theme.semanticColors },
      surface: base.theme.surface,
    },
    variant,
  };
}

export function getInitialThemeSettings(targetMode?: ThemeMode): ThemeSettings {
  const raw = readSqliteBackedValue(THEME_CONFIG_STORAGE_KEY);
  if (!raw) return DEFAULT_THEME_SETTINGS;
  try {
    // readSqliteBackedJson 会把默认 light/dark 浅合并进旧单配置，不能用于格式迁移。
    const savedMode = readSqliteBackedValue(THEME_MODE_STORAGE_KEY);
    const mode = targetMode ?? (savedMode === "light" || savedMode === "dark" ? savedMode : "auto");
    return normalizeThemeSettings(JSON.parse(raw), mode === "auto" ? resolveThemeMode("auto") : mode);
  } catch {
    return DEFAULT_THEME_SETTINGS;
  }
}

export function getInitialThemeConfig(): ThemeConfig {
  if (typeof window === "undefined") return DEFAULT_THEME_CONFIG;
  return resolveActiveThemeConfig(getInitialThemeSettings(), getInitialThemeMode(THEME_MODE_STORAGE_KEY));
}

/** 更新指定明暗槽位，不论设置页当前展示一套还是两套。 */
export function applyThemeConfig(configValue: ThemeConfig, emitEvent = true, persist = true) {
  const config = normalizeThemeConfig(configValue);
  if (!persist) {
    applyThemeVisualConfig(config);
    return;
  }
  const settings = getInitialThemeSettings();
  const next = { ...settings, [config.variant]: config };
  saveThemeSettings(next, emitEvent);
}

function applyThemeVisualConfig(configValue: ThemeConfig) {
  const config = normalizeThemeConfig(configValue);
  const root = document.documentElement;
  root.dataset.omniThemePreset = config.codeThemeId;
  root.dataset.omniThemeVariant = config.variant;
  root.style.setProperty("--omni-theme-accent", config.theme.accent);
  root.style.setProperty("--omni-theme-surface", config.theme.surface);
  root.style.setProperty("--omni-theme-ink", config.theme.ink);
  root.style.setProperty("--omni-font-ui", config.theme.fonts.ui ? `\"${config.theme.fonts.ui.replace(/[\"\\;]/g, "")}\", sans-serif` : "system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif");
  root.style.setProperty("--omni-font-mono", config.theme.fonts.code ? `\"${config.theme.fonts.code.replace(/[\"\\;]/g, "")}\", ui-monospace, monospace` : "ui-monospace, SFMono-Regular, Consolas, monospace");
  root.style.setProperty("--omni-semantic-added", config.theme.semanticColors.diffAdded);
  root.style.setProperty("--omni-semantic-removed", config.theme.semanticColors.diffRemoved);
  root.style.setProperty("--omni-semantic-skill", config.theme.semanticColors.skill);
  root.style.setProperty("--omni-theme-opaque-windows", config.theme.opaqueWindows ? "1" : "0");
  root.style.setProperty("--omni-accent", config.theme.accent);
  root.style.setProperty("--omni-primary", config.theme.accent);
  root.style.setProperty("--omni-accent-strong", `color-mix(in srgb, ${config.theme.accent} 78%, white)`);
  root.style.setProperty("--omni-accent-soft", `color-mix(in srgb, ${config.theme.accent} 15%, transparent)`);
  root.style.setProperty("--omni-app-bg", config.theme.surface);
  root.style.setProperty("--omni-bg", config.theme.surface);
  root.style.setProperty("--omni-soft-bg", `color-mix(in srgb, ${config.theme.surface} 94%, ${config.theme.ink} 6%)`);
  root.style.setProperty("--omni-app-text", config.theme.ink);
  root.style.setProperty("--omni-app-fg", config.theme.ink);
  root.style.setProperty("--omni-button-text", config.theme.ink);
  root.style.setProperty("--omni-message-text", config.theme.ink);
  root.style.setProperty("--omni-message-strong", `color-mix(in srgb, ${config.theme.ink} 92%, white)`);
  root.style.setProperty("--omni-message-muted", `color-mix(in srgb, ${config.theme.ink} 65%, ${config.theme.surface})`);
  root.style.setProperty("--omni-message-code-text", config.theme.ink);
  const light = config.variant === "light";
  const panel = light
    ? config.theme.surface
    : `color-mix(in srgb, ${config.theme.surface} 94%, ${config.theme.ink} 6%)`;
  const card = light
    ? config.theme.surface
    : `color-mix(in srgb, ${config.theme.surface} 88%, ${config.theme.ink} 12%)`;
  const surface2 = light
    ? `color-mix(in srgb, ${config.theme.surface} 99%, ${config.theme.ink} 1%)`
    : `color-mix(in srgb, ${config.theme.surface} 88%, ${config.theme.ink} 12%)`;
  const surface3 = light
    ? `color-mix(in srgb, ${config.theme.surface} 97%, ${config.theme.ink} 3%)`
    : `color-mix(in srgb, ${config.theme.surface} 82%, ${config.theme.ink} 18%)`;
  const border = `color-mix(in srgb, ${config.theme.ink} ${light ? 12 : 22}%, transparent)`;
  root.style.setProperty("--omni-soft-bg", light ? `color-mix(in srgb, ${config.theme.surface} 99%, ${config.theme.ink} 1%)` : `color-mix(in srgb, ${config.theme.surface} 94%, ${config.theme.ink} 6%)`);
  root.style.setProperty("--omni-panel-bg", panel);
  root.style.setProperty("--omni-card-bg", card);
  root.style.setProperty("--omni-app-surface-1", panel);
  root.style.setProperty("--omni-app-surface-2", surface2);
  root.style.setProperty("--omni-app-surface-3", surface3);
  root.style.setProperty("--omni-panel-border", border);
  root.style.setProperty("--omni-app-border", border);
  root.style.setProperty("--omni-frame-border", border);
  root.style.setProperty("--omni-divider-strong", `color-mix(in srgb, ${config.theme.ink} ${light ? 16 : 26}%, transparent)`);
  root.style.setProperty("--omni-input-bg", light ? config.theme.surface : `color-mix(in srgb, ${config.theme.surface} 96%, ${config.theme.ink} 4%)`);
  root.style.setProperty("--omni-app-muted", `color-mix(in srgb, ${config.theme.ink} 62%, ${config.theme.surface})`);
  root.style.setProperty("--omni-diff-added", config.theme.semanticColors.diffAdded);
  root.style.setProperty("--omni-diff-removed", config.theme.semanticColors.diffRemoved);
  root.style.setProperty("--omni-skill", config.theme.semanticColors.skill);
  root.style.setProperty("--omni-skill-bg", `color-mix(in srgb, ${config.theme.semanticColors.skill} 15%, transparent)`);
  root.style.setProperty("--omni-link", config.theme.accent);
}

export function saveThemeSettings(settingsValue: ThemeSettings, emitEvent = true) {
  const settings = normalizeThemeSettings(settingsValue);
  const previous = readSqliteBackedValue(THEME_CONFIG_STORAGE_KEY);
  const serialized = JSON.stringify(settings);
  saveSqliteBackedValue(THEME_CONFIG_STORAGE_KEY, serialized);
  applyThemeVisualConfig(resolveActiveThemeConfig(settings, getInitialThemeMode(THEME_MODE_STORAGE_KEY)));
  if (emitEvent && previous !== serialized && typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    void emit("omni-theme-settings-changed", { settings });
  }
}

export function applyThemeSettings(settingsValue: ThemeSettings, emitEvent = false) {
  applyActiveThemeConfig(getInitialThemeMode(THEME_MODE_STORAGE_KEY), settingsValue);
  if (emitEvent) saveThemeSettings(settingsValue, true);
}

/** 读取当前两套设置，并把指定模式对应的视觉风格写入根元素。 */
export function applyActiveThemeConfig(mode: ThemeMode, settingsValue?: ThemeSettings) {
  const settings = normalizeThemeSettings(settingsValue ?? getInitialThemeSettings());
  applyThemeVisualConfig(resolveActiveThemeConfig(settings, mode));
}
type LegacyBasicSettings = BasicSettings & {
  settingsWindowWidth?: number;
  settingsWindowHeight?: number;
};

export function normalizeBasicSettings(settings: LegacyBasicSettings): BasicSettings {
  const { settingsWindowWidth: _settingsWindowWidth, settingsWindowHeight: _settingsWindowHeight, ...normalized } = settings;
  const sandboxMode: BasicSettings["sandboxMode"] =
    normalized.sandboxMode === "read-only" ||
    normalized.sandboxMode === "workspace-write" ||
    normalized.sandboxMode === "danger-full-access"
      ? normalized.sandboxMode
      : typeof normalized.sandboxEnabled === "boolean"
        ? normalized.sandboxEnabled
          ? "workspace-write"
          : "danger-full-access"
        : DEFAULT_BASIC_SETTINGS.sandboxMode;
  return {
    ...normalized,
    sandboxMode,
    sandboxEnabled: sandboxMode !== "danger-full-access",
  };
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

export function applyThemeMode(
  themeStorageKey: string,
  mode: ThemeMode,
  emitEvent = true,
  settingsValue?: ThemeSettings,
) {
  const resolved = resolveThemeMode(mode);
  const previous = readSqliteBackedValue(themeStorageKey);
  document.documentElement.dataset.omniThemeMode = mode;
  document.documentElement.dataset.omniTheme = resolved;
  saveSqliteBackedValue(themeStorageKey, mode);
  const settings = settingsValue ? normalizeThemeSettings(settingsValue, resolved) : getInitialThemeSettings(resolved);
  if (settingsValue) saveThemeSettings(settings, false);
  // 模式按钮传入已解析的配置，应用结果不依赖开关状态或旧存储格式。
  applyThemeVisualConfig(resolveActiveThemeConfig(settings, mode));
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
