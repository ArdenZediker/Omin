import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { cursorPosition, getCurrentWindow, monitorFromPoint, type Monitor } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { CHARACTER_SCALE_BASELINE, CHAT_WINDOW_SIZE, COMPACT_MENU_PANEL_HEIGHT, COMPACT_MENU_PANEL_WIDTH, COMPACT_APPEARANCE_PRESETS, COMPACT_POSITION_STORAGE_KEY, DEFAULT_BASIC_SETTINGS, EXPANDED_SIZE, MAIN_POSITION_STORAGE_KEY, MAIN_VIEW_STORAGE_KEY, MAIN_WINDOW_LABEL, SETTINGS_SIZE, THEME_MODE_STORAGE_KEY } from "./constants";
import type { BasicSettings, ExternalChatEntry, ViewMode } from "./types";
import type { CompactAppearance } from "../hooks/useCompactWindowState";
import { readSqliteBackedJson, readSqliteBackedValue, saveSqliteBackedValue } from "./sqliteStorage";

export function isCharacterPointerInHitArea(element: HTMLElement, clientX: number, clientY: number) {
  if (element.dataset.hitMode === "full") {
    return true;
  }
  const rect = element.getBoundingClientRect();
  const relativeX = (clientX - rect.left) / rect.width;
  const relativeY = (clientY - rect.top) / rect.height;
  return relativeX >= 0.38 && relativeX <= 0.66 && relativeY >= 0.04 && relativeY <= 0.98;
}

export function getBasicSettings(): BasicSettings {
  if (typeof window === "undefined") return DEFAULT_BASIC_SETTINGS;
  return readSqliteBackedJson("omni_basic_settings", DEFAULT_BASIC_SETTINGS);
}

export function clampWindowSize(value: number, fallback: number, min: number, max: number) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

export function normalizeShortcutKey(event: KeyboardEvent) {
  if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return "";
  return [
    event.ctrlKey ? "Ctrl" : "",
    event.shiftKey ? "Shift" : "",
    event.altKey ? "Alt" : "",
    event.metaKey ? "Meta" : "",
    event.key.length === 1 ? event.key.toUpperCase() : event.key,
  ].filter(Boolean).join("+");
}

export function applyThemeFromStorage() {
  if (typeof window === "undefined") return;
  const saved = readSqliteBackedValue(THEME_MODE_STORAGE_KEY);
  const mode = saved === "dark" || saved === "light" ? saved : "auto";
  const resolved = mode === "auto" ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : mode;
  document.documentElement.dataset.omniThemeMode = mode;
  document.documentElement.dataset.omniTheme = resolved;
}

export function getStoredCompactPosition() {
  if (typeof window === "undefined") return null;
  try {
    const saved = readSqliteBackedValue(COMPACT_POSITION_STORAGE_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved) as { x?: number; y?: number };
    const { x, y } = parsed;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    return { x: Math.round(x as number), y: Math.round(y as number) };
  } catch {
    return null;
  }
}

export function persistCompactPosition(position: { x: number; y: number }) {
  if (typeof window === "undefined") return;
  saveSqliteBackedValue(
    COMPACT_POSITION_STORAGE_KEY,
    JSON.stringify({
      x: Math.round(position.x),
      y: Math.round(position.y),
    })
  );
}

export function getCompactAnchorPositionForMonitor(monitor: Monitor, size: { width: number; height: number }) {
  const workArea = getLogicalWorkArea(monitor);
  const verticalRange = Math.max(0, workArea.height - size.height);
  const centerOffset = Math.round(verticalRange * 0.42);
  return {
    x: Math.round(workArea.left + workArea.width - size.width - 24),
    y: Math.round(workArea.top + centerOffset),
  };
}

function getLogicalWorkArea(monitor: Monitor) {
  const scale = monitor.scaleFactor || 1;
  return {
    left: monitor.workArea.position.x / scale,
    top: monitor.workArea.position.y / scale,
    width: monitor.workArea.size.width / scale,
    height: monitor.workArea.size.height / scale,
  };
}

export function mapCompactPositionToMonitor(
  position: { x: number; y: number },
  sourceMonitor: Monitor,
  targetMonitor: Monitor,
  size: { width: number; height: number }
) {
  const source = getLogicalWorkArea(sourceMonitor);
  const target = getLogicalWorkArea(targetMonitor);
  const sourceRangeX = Math.max(1, source.width - size.width);
  const sourceRangeY = Math.max(1, source.height - size.height);
  const targetRangeX = Math.max(0, target.width - size.width);
  const targetRangeY = Math.max(0, target.height - size.height);
  const relativeX = Math.min(1, Math.max(0, (position.x - source.left) / sourceRangeX));
  const relativeY = Math.min(1, Math.max(0, (position.y - source.top) / sourceRangeY));

  return {
    x: Math.round(target.left + targetRangeX * relativeX),
    y: Math.round(target.top + targetRangeY * relativeY),
  };
}

export async function getMonitorForCursor() {
  const cursor = await cursorPosition();
  return monitorFromPoint(cursor.x, cursor.y);
}

export async function moveCompactWindowToMonitor(
  targetWindow: ReturnType<typeof getCurrentWindow>,
  monitor: Monitor,
  size: { width: number; height: number },
  options?: {
    sourceMonitor?: Monitor | null;
    currentPosition?: { x: number; y: number } | null;
    persistPosition?: boolean;
  }
) {
  const nextPosition =
    options?.sourceMonitor && options?.currentPosition
      ? mapCompactPositionToMonitor(options.currentPosition, options.sourceMonitor, monitor, size)
      : getCompactAnchorPositionForMonitor(monitor, size);
  await targetWindow.setPosition(new LogicalPosition(nextPosition.x, nextPosition.y));
  if (options?.persistPosition !== false) {
    persistCompactPosition(nextPosition);
  }
}

export async function clampCompactWindowToMonitor(
  targetWindow: ReturnType<typeof getCurrentWindow>,
  monitor: Monitor,
  size: { width: number; height: number }
) {
  const scaleFactor = await targetWindow.scaleFactor();
  const currentPosition = (await targetWindow.outerPosition()).toLogical(scaleFactor);
  const monitorScale = monitor.scaleFactor || scaleFactor || 1;
  const workAreaLeft = monitor.workArea.position.x / monitorScale;
  const workAreaRight = (monitor.workArea.position.x + monitor.workArea.size.width) / monitorScale;
  const maxX = Math.max(workAreaLeft, workAreaRight - size.width);
  const nextX = Math.min(maxX, Math.max(workAreaLeft, currentPosition.x));

  if (Math.round(nextX) !== Math.round(currentPosition.x)) {
    await targetWindow.setPosition(new LogicalPosition(Math.round(nextX), Math.round(currentPosition.y)));
  }
}

export function getStoredMainPosition() {
  if (typeof window === "undefined") return null;
  try {
    const saved = readSqliteBackedValue(MAIN_POSITION_STORAGE_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved) as { x?: number; y?: number };
    const { x, y } = parsed;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    return { x: Math.round(x as number), y: Math.round(y as number) };
  } catch {
    return null;
  }
}

export function persistMainPosition(position: { x: number; y: number }) {
  if (typeof window === "undefined") return;
  saveSqliteBackedValue(
    MAIN_POSITION_STORAGE_KEY,
    JSON.stringify({
      x: Math.round(position.x),
      y: Math.round(position.y),
    })
  );
}

export function getStoredMainView(): ViewMode {
  if (typeof window === "undefined") return "chat";
  const saved = readSqliteBackedValue(MAIN_VIEW_STORAGE_KEY);
  return saved === "settings" || saved === "knowledge" ? saved : "chat";
}

export function getMainWindowSizeForView(viewMode: ViewMode) {
  const settings = getBasicSettings();
  if (viewMode === "settings") {
    return {
      width: clampWindowSize(settings.settingsWindowWidth, SETTINGS_SIZE.width, 640, 1800),
      height: clampWindowSize(settings.settingsWindowHeight, SETTINGS_SIZE.height, 480, 1400),
    };
  }
  return {
    width: clampWindowSize(settings.mainWindowWidth, EXPANDED_SIZE.width, 640, 1800),
    height: clampWindowSize(settings.mainWindowHeight, EXPANDED_SIZE.height, 480, 1400),
  };
}

export function isMainPositionVisible(position: { x: number; y: number }) {
  if (typeof window === "undefined") return false;

  const screenInfo = window.screen as Screen & { availLeft?: number; availTop?: number };
  const left = Number(screenInfo.availLeft ?? 0);
  const top = Number(screenInfo.availTop ?? 0);
  const width = Number(screenInfo.availWidth || screenInfo.width);
  const height = Number(screenInfo.availHeight || screenInfo.height);

  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return false;
  }

  const right = left + width;
  const bottom = top + height;
  const visibleMargin = 80;
  const restoredSize = getMainWindowSizeForView(getStoredMainView());

  return (
    position.x < right - visibleMargin &&
    position.x + restoredSize.width > left + visibleMargin &&
    position.y < bottom - visibleMargin &&
    position.y + restoredSize.height > top + visibleMargin
  );
}

export function getCompactWindowSize(appearance: CompactAppearance, scale: number) {
  const preset = COMPACT_APPEARANCE_PRESETS[appearance];
  return {
    width: Math.round(preset.width * scale),
    height: Math.round(preset.height * scale),
  };
}

export function getExpandedCompactViewportSize(includeReply = false) {
  const maxPresetWidth = Math.max(...Object.values(COMPACT_APPEARANCE_PRESETS).map((preset) => preset.width));
  const maxPresetHeight = Math.max(...Object.values(COMPACT_APPEARANCE_PRESETS).map((preset) => preset.height));
  return {
    width: Math.max(
      Math.round(maxPresetWidth * 4.2 * CHARACTER_SCALE_BASELINE) + (includeReply ? 380 : 12),
      COMPACT_MENU_PANEL_WIDTH
    ),
    height:
      Math.max(
        Math.round(COMPACT_APPEARANCE_PRESETS.character.height * 4.2 * CHARACTER_SCALE_BASELINE) + 12,
        maxPresetHeight
      ) + COMPACT_MENU_PANEL_HEIGHT,
  };
}

export function getExpandedCompactViewportSizeForAppearance(
  appearance: CompactAppearance,
  scale: number,
  options: { includeReply?: boolean; includeHorizontalPanel?: boolean } = {}
) {
  const compactSize = getCompactWindowSize(appearance, scale);
  const baseExpanded = getExpandedCompactViewportSize(Boolean(options.includeReply));
  const horizontalPanelWidth = options.includeHorizontalPanel ? COMPACT_MENU_PANEL_WIDTH : 0;

  return {
    width: Math.max(baseExpanded.width, compactSize.width + horizontalPanelWidth + 24),
    height: Math.max(baseExpanded.height, compactSize.height + COMPACT_MENU_PANEL_HEIGHT),
  };
}

export function getPetCompactMenuViewport(size: { width: number; height: number }) {
  return {
    width: Math.max(size.width, 430),
    height: size.height + 260,
  };
}

export function getPetCompactViewportSize(options: {
  compactSize: { width: number; height: number };
  isCompactMenuOpen: boolean;
  isCompactQueryOpen: boolean;
  isCompactReplyLoading: boolean;
  hasCompactReply: boolean;
}) {
  const { compactSize, isCompactMenuOpen, isCompactQueryOpen, isCompactReplyLoading, hasCompactReply } = options;

  if (isCompactMenuOpen) {
    return getPetCompactMenuViewport(compactSize);
  }

  if (isCompactQueryOpen && !isCompactReplyLoading && !hasCompactReply) {
    return {
      width: Math.max(compactSize.width, 330),
      height: compactSize.height + 64,
    };
  }

  if (isCompactReplyLoading || hasCompactReply) {
    return {
      width: Math.max(compactSize.width, 392),
      height: compactSize.height + 238,
    };
  }

  return null;
}

export async function resizeWindow(targetWindow: ReturnType<typeof getCurrentWindow>, width: number, height: number) {
  await targetWindow.setSize(new LogicalSize(width, height));
}

export async function applyCompactWindowChrome(targetWindow: ReturnType<typeof getCurrentWindow>) {
  await Promise.all([
    targetWindow.setShadow(false),
    targetWindow.setResizable(false),
    targetWindow.setAlwaysOnTop(true),
    targetWindow.setSkipTaskbar(true),
  ]);

  try {
    await targetWindow.setVisibleOnAllWorkspaces(true);
  } catch {
    // Some platforms do not support this flag.
  }
}

export async function applyExpandedWindowChrome(targetWindow: ReturnType<typeof getCurrentWindow>) {
  await Promise.all([
    targetWindow.setShadow(false),
    targetWindow.setResizable(true),
    targetWindow.setAlwaysOnTop(false),
    targetWindow.setSkipTaskbar(false),
    targetWindow.setDecorations(false),
  ]);
}

export async function ensureCompactWindow(appearance: CompactAppearance, scale: number, compactWindowLabel: string) {
  const size = getCompactWindowSize(appearance, scale);
  const expandedViewport = getExpandedCompactViewportSize(true);
  const storedPosition = getStoredCompactPosition();
  let compactWindow = await WebviewWindow.getByLabel(compactWindowLabel);

  if (!compactWindow) {
    compactWindow = new WebviewWindow(compactWindowLabel, {
      url: "/?compact=1",
      title: "Omni Compact",
      width: size.width,
      height: size.height,
      minWidth: size.width,
      minHeight: size.height,
      maxWidth: expandedViewport.width,
      maxHeight: expandedViewport.height,
      decorations: false,
      transparent: true,
      shadow: false,
      alwaysOnTop: true,
      visibleOnAllWorkspaces: true,
      skipTaskbar: true,
      resizable: false,
      visible: false,
      focus: false,
      center: storedPosition == null,
      x: storedPosition?.x,
      y: storedPosition?.y,
    });

    await new Promise<void>((resolve, reject) => {
      compactWindow?.once("tauri://created", () => resolve());
      compactWindow?.once("tauri://error", (event) => reject(event.payload));
    });
  }

  await applyCompactWindowChrome(compactWindow);
  await compactWindow.setSize(new LogicalSize(size.width, size.height));
  return compactWindow;
}

export async function showCompactWindow(
  appearance: CompactAppearance,
  scale: number,
  compactWindowLabel: string
) {
  const compactWindow = await ensureCompactWindow(appearance, scale, compactWindowLabel);
  const settings = getBasicSettings();
  const size = getCompactWindowSize(appearance, scale);
  const storedPosition = getStoredCompactPosition();

  if (settings.followCursorScreen) {
    const monitor = await getMonitorForCursor();
    if (monitor) {
      await moveCompactWindowToMonitor(compactWindow, monitor, size);
    } else if (storedPosition) {
      await compactWindow.setPosition(new LogicalPosition(storedPosition.x, storedPosition.y));
    }
  } else if (storedPosition) {
    await compactWindow.setPosition(new LogicalPosition(storedPosition.x, storedPosition.y));
  }

  await compactWindow.show();
  await compactWindow.setAlwaysOnTop(true);
}

export async function openInternalChatWindow(entry: ExternalChatEntry) {
  if (entry.kind !== "external" || !entry.url) return;

  const label = `chat-${entry.id}`;
  let chatWindow = await WebviewWindow.getByLabel(label);

  if (!chatWindow) {
    chatWindow = new WebviewWindow(label, {
      url: entry.url,
      title: entry.title,
      width: CHAT_WINDOW_SIZE.width,
      height: CHAT_WINDOW_SIZE.height,
      minWidth: 960,
      minHeight: 640,
      center: true,
      decorations: true,
      transparent: false,
      resizable: true,
      alwaysOnTop: false,
      skipTaskbar: false,
      focus: true,
    });

    await new Promise<void>((resolve, reject) => {
      chatWindow?.once("tauri://created", () => resolve());
      chatWindow?.once("tauri://error", (event) => reject(event.payload));
    });
  }

  await chatWindow.show();
  await chatWindow.setFocus();
}

export async function restoreMainWindow(focusInput = false) {
  const mainWindow = await WebviewWindow.getByLabel(MAIN_WINDOW_LABEL);

  if (mainWindow) {
    try {
      const isMinimized = await mainWindow.isMinimized();
      if (isMinimized) {
        await mainWindow.unminimize();
      }
    } catch {
      // 某些平台不支持此状态检查，直接忽略。
    }

    await applyExpandedWindowChrome(mainWindow);
    await mainWindow.show();
    const restoredSize = getMainWindowSizeForView(getStoredMainView());
    await resizeWindow(mainWindow, restoredSize.width, restoredSize.height);

    const settings = getBasicSettings();
    if (settings.mainWindowPositionMode !== "center") {
      const storedMainPos = getStoredMainPosition();
      if (storedMainPos && isMainPositionVisible(storedMainPos)) {
        await mainWindow.setPosition(new LogicalPosition(storedMainPos.x, storedMainPos.y));
      } else {
        await mainWindow.center();
      }
    } else {
      await mainWindow.center();
    }

    await mainWindow.setFocus();

    if (focusInput) {
      await mainWindow.emit("omni-focus-input");
    }
  }
}
