import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { THEME_CONFIG_STORAGE_KEY, THEME_MODE_STORAGE_KEY } from "../app/constants";
import {
  applyThemeConfig,
  applyThemeMode,
  applyActiveThemeConfig,
  getInitialThemeConfig,
  getInitialThemeMode,
  getInitialThemeSettings,
  normalizeThemeConfig,
  normalizeThemeSettings,
  resolveActiveThemeConfig,
  saveThemeSettings,
  type ThemeConfig,
  type ThemeMode,
  type ThemeSettings,
} from "../app/settings";

export function useThemeSync(trackState = true) {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getInitialThemeMode(THEME_MODE_STORAGE_KEY));
  const [themeConfig, setThemeConfigState] = useState<ThemeConfig>(() => getInitialThemeConfig());
  const [themeSettings, setThemeSettings] = useState<ThemeSettings>(() => getInitialThemeSettings());

  // 初始化时应用当前保存的主题（不再次触发事件，避免启动时循环广播）。
  useEffect(() => {
    applyActiveThemeConfig(themeMode, themeSettings);
    applyThemeMode(THEME_MODE_STORAGE_KEY, themeMode, false);
  }, []);

  // 「自动」跟随系统外观；系统切换时模式值没变，但 active visual style 会变。
  useEffect(() => {
    if (themeMode !== "auto") return undefined;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const refresh = () => {
      const settings = getInitialThemeSettings();
      if (trackState) setThemeConfigState(resolveActiveThemeConfig(settings, "auto"));
      applyActiveThemeConfig("auto", settings);
    };
    media.addEventListener("change", refresh);
    return () => media.removeEventListener("change", refresh);
  }, [themeMode, trackState]);

  // 监听其它窗口/组件切换主题的事件，同步更新本地状态与 data-* 属性。
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    void (async () => {
      unlisten = await listen<{ mode: ThemeMode }>("omni-theme-mode-changed", (event) => {
        const mode = event.payload.mode;
        const settings = getInitialThemeSettings(mode);
        if (trackState) {
          setThemeMode(mode);
          setThemeSettings(settings);
          setThemeConfigState(resolveActiveThemeConfig(settings, mode));
        }
        applyThemeMode(THEME_MODE_STORAGE_KEY, mode, false, settings);
      });
    })();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [trackState]);

  useEffect(() => {
    let unlistenSettings: (() => void) | null = null;
    let unlistenLegacy: (() => void) | null = null;
    void (async () => {
      unlistenSettings = await listen<{ settings: ThemeSettings }>("omni-theme-settings-changed", (event) => {
        const settings = normalizeThemeSettings(event.payload.settings);
        const mode = getInitialThemeMode(THEME_MODE_STORAGE_KEY);
        if (trackState) {
          setThemeSettings(settings);
          setThemeConfigState(resolveActiveThemeConfig(settings, mode));
        }
        applyActiveThemeConfig(mode, settings);
      });
      unlistenLegacy = await listen<{ config: ThemeConfig }>("omni-theme-config-changed", (event) => {
        const config = normalizeThemeConfig(event.payload.config);
        if (trackState) setThemeConfigState(config);
        applyThemeConfig(config, false, false);
      });
    })();
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_CONFIG_STORAGE_KEY || !event.newValue) return;
      try {
        const settings = normalizeThemeSettings(JSON.parse(event.newValue));
        const mode = getInitialThemeMode(THEME_MODE_STORAGE_KEY);
        if (trackState) {
          setThemeSettings(settings);
          setThemeConfigState(resolveActiveThemeConfig(settings, mode));
        }
        applyActiveThemeConfig(mode, settings);
      } catch {
        // Ignore malformed values and keep the last applied theme.
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      unlistenSettings?.();
      unlistenLegacy?.();
      window.removeEventListener("storage", onStorage);
    };
  }, [trackState]);

  const setMode = (mode: ThemeMode) => {
    const settings = getInitialThemeSettings(mode);
    if (trackState) {
      setThemeMode(mode);
      setThemeSettings(settings);
      setThemeConfigState(resolveActiveThemeConfig(settings, mode));
    }
    applyThemeMode(THEME_MODE_STORAGE_KEY, mode, true, settings);
  };

  const setThemeConfig = (config: ThemeConfig) => {
    const normalized = normalizeThemeConfig(config);
    if (trackState) setThemeConfigState(normalized);
    const settings = getInitialThemeSettings();
    const next = { ...settings, [normalized.variant]: normalized };
    if (trackState) setThemeSettings(next);
    saveThemeSettings(next);
  };

  const updateThemeSettings = (next: ThemeSettings) => {
    const normalized = normalizeThemeSettings(next);
    const mode = getInitialThemeMode(THEME_MODE_STORAGE_KEY);
    if (trackState) {
      setThemeSettings(normalized);
      setThemeConfigState(resolveActiveThemeConfig(normalized, mode));
    }
    saveThemeSettings(normalized);
  };

  return { themeMode, setMode, themeConfig, setThemeConfig, themeSettings, setThemeSettings: updateThemeSettings };
}
