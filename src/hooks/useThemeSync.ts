import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { THEME_MODE_STORAGE_KEY } from "../app/constants";
import { applyThemeMode, getInitialThemeMode, type ThemeMode } from "../app/settings";

export function useThemeSync(trackState = true) {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getInitialThemeMode(THEME_MODE_STORAGE_KEY));

  // 初始化时应用当前保存的主题（不再次触发事件，避免启动时循环广播）。
  useEffect(() => {
    applyThemeMode(THEME_MODE_STORAGE_KEY, themeMode, false);
  }, []);

  // 监听其它窗口/组件切换主题的事件，同步更新本地状态与 data-* 属性。
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    void (async () => {
      unlisten = await listen<{ mode: ThemeMode }>("omni-theme-mode-changed", (event) => {
        const mode = event.payload.mode;
        if (trackState) {
          setThemeMode(mode);
        }
        applyThemeMode(THEME_MODE_STORAGE_KEY, mode, false);
      });
    })();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [trackState]);

  const setMode = (mode: ThemeMode) => {
    if (trackState) {
      setThemeMode(mode);
    }
    applyThemeMode(THEME_MODE_STORAGE_KEY, mode);
  };

  return { themeMode, setMode };
}
