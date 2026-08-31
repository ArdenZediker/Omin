import { getCurrentWindow } from "@tauri-apps/api/window";

// 以下常量仅在主窗口 compact hook 体系内使用（宠物气泡命中区域 / 自动收起延迟 / 跟随光标间隔）。
export const PET_THOUGHT_POSITION_EPSILON = 2;
export const PET_THOUGHT_COLLAPSE_HIDE_DELAY_MS = 170;
export const COMPACT_FOLLOW_CURSOR_SCREEN_INTERVAL_MS = 220;

function getSafeCurrentWindow() {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

// 主窗口单例：各子钩子共享同一实例，避免重复 getCurrentWindow()。
export const appWindow = getSafeCurrentWindow() as ReturnType<typeof getCurrentWindow>;
