import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { availableMonitors, cursorPosition, getCurrentWindow, monitorFromPoint, type Monitor } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit } from "@tauri-apps/api/event";
import { CHARACTER_SCALE_BASELINE, CHAT_WINDOW_SIZE, COMPACT_MENU_PANEL_HEIGHT, COMPACT_MENU_PANEL_WIDTH, COMPACT_APPEARANCE_PRESETS, COMPACT_POSITION_STORAGE_KEY, DEFAULT_BASIC_SETTINGS, EXPANDED_SIZE, MAIN_POSITION_STORAGE_KEY, MAIN_VIEW_STORAGE_KEY, MAIN_WINDOW_LABEL, PET_THOUGHT_WINDOW_LABEL, SETTINGS_WINDOW_LABEL, SETTINGS_WINDOW_SIZE, THEME_MODE_STORAGE_KEY } from "./constants";
import type { BasicSettings, ExternalChatEntry, ViewMode } from "./types";
import { isCompactPetHidden } from "./compactVisibility";
import type { CompactAppearance } from "../hooks/useCompactWindowState";
import { readSqliteBackedJson, readSqliteBackedValue, saveSqliteBackedValue } from "./sqliteStorage";
import { PET_WINDOW_DECORATION_MARGIN_RIGHT, PET_WINDOW_DECORATION_MARGIN_TOP, PET_WINDOW_SAFE_MARGIN_X, PET_WINDOW_SAFE_MARGIN_Y } from "./pets/codexPetSizing";

const PET_THOUGHT_VIEWPORT_MIN_WIDTH = 320;
const PET_THOUGHT_VIEWPORT_EXTRA_HEIGHT = 128;
const PET_THOUGHT_VIEWPORT_SIDE_EXTRA_WIDTH = 316;
const PET_THOUGHT_VIEWPORT_SIDE_MIN_HEIGHT = 188;
export const PET_THOUGHT_WINDOW_SIZE = {
  width: 300,
  height: 278,
} as const;

export type PetThoughtPlacement = "top" | "right" | "left" | "bottom";

export function isCharacterPointerInHitArea(element: HTMLElement, clientX: number, clientY: number) {
  if (element.dataset.hitMode === "full") {
    return true;
  }
  const rect = element.getBoundingClientRect();
  const relativeX = (clientX - rect.left) / rect.width;
  const relativeY = (clientY - rect.top) / rect.height;
  return relativeX >= 0.38 && relativeX <= 0.66 && relativeY >= 0.04 && relativeY <= 0.98;
}

export function isCharacterPointerInResizeArea(element: HTMLElement, clientX: number, clientY: number) {
  const rect = element.getBoundingClientRect();
  const edgeThickness = Math.max(10, Math.min(18, Math.min(rect.width, rect.height) * 0.14));
  const offsetX = clientX - rect.left;
  const offsetY = clientY - rect.top;
  const isInsideRect = offsetX >= 0 && offsetX <= rect.width && offsetY >= 0 && offsetY <= rect.height;

  if (!isInsideRect) {
    return false;
  }

  return (
    offsetX <= edgeThickness ||
    offsetX >= rect.width - edgeThickness ||
    offsetY <= edgeThickness ||
    offsetY >= rect.height - edgeThickness
  );
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

function toNativePetCompactPosition(appearance: CompactAppearance, position: { x: number; y: number }) {
  return appearance === "pet"
    ? { x: position.x, y: Math.max(0, Math.round(position.y - PET_WINDOW_DECORATION_MARGIN_TOP)) }
    : position;
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
  return saved === "knowledge" ? "knowledge" : "chat";
}

export function getMainWindowSizeForView(_viewMode: ViewMode) {
  const settings = getBasicSettings();
  return {
    width: clampWindowSize(settings.mainWindowWidth, EXPANDED_SIZE.width, 640, 1800),
    height: clampWindowSize(settings.mainWindowHeight, EXPANDED_SIZE.height, 480, 1400),
  };
}

export function getSettingsWindowSize() {
  return {
    width: SETTINGS_WINDOW_SIZE.width,
    height: SETTINGS_WINDOW_SIZE.height,
  };
}

export function isMainPositionVisible(position: { x: number; y: number }) {
  const restoredSize = getMainWindowSizeForView(getStoredMainView());
  return isWindowRectVisible(position, restoredSize);
}

export function isWindowRectVisible(
  position: { x: number; y: number },
  size: { width: number; height: number }
) {
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

  return (
    position.x < right - visibleMargin &&
    position.x + size.width > left + visibleMargin &&
    position.y < bottom - visibleMargin &&
    position.y + size.height > top + visibleMargin
  );
}

function isWindowRectVisibleInMonitor(
  position: { x: number; y: number },
  size: { width: number; height: number },
  monitor: Monitor
) {
  const scale = monitor.scaleFactor || 1;
  const left = monitor.workArea.position.x / scale;
  const top = monitor.workArea.position.y / scale;
  const right = left + monitor.workArea.size.width / scale;
  const bottom = top + monitor.workArea.size.height / scale;
  const visibleMargin = Math.min(80, Math.max(12, Math.min(size.width, size.height) / 2));

  return (
    position.x < right - visibleMargin &&
    position.x + size.width > left + visibleMargin &&
    position.y < bottom - visibleMargin &&
    position.y + size.height > top + visibleMargin
  );
}

function isWindowRectVisibleOnAnyMonitor(
  position: { x: number; y: number },
  size: { width: number; height: number },
  monitors: Monitor[]
) {
  return monitors.some((monitor) => isWindowRectVisibleInMonitor(position, size, monitor));
}

export function getCompactWindowSize(appearance: CompactAppearance, scale: number) {
  const preset = COMPACT_APPEARANCE_PRESETS[appearance];
  if (appearance === "pet") {
    return {
      width: Math.round(preset.width * scale) + PET_WINDOW_SAFE_MARGIN_X + PET_WINDOW_DECORATION_MARGIN_RIGHT,
      height: Math.round(preset.height * scale) + PET_WINDOW_SAFE_MARGIN_Y + PET_WINDOW_DECORATION_MARGIN_TOP,
    };
  }
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
        Math.round(COMPACT_APPEARANCE_PRESETS.pet.height * 4.2 * CHARACTER_SCALE_BASELINE) + 12,
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
    width: Math.max(size.width, 462),
    height: Math.max(size.height + 360, 560),
  };
}

export function getPetThoughtViewportHeight(compactWidth: number) {
  return Math.max(PET_THOUGHT_VIEWPORT_EXTRA_HEIGHT, Math.round(compactWidth * 0.62 + 64));
}

export function getPetThoughtViewportSize(
  compactSize: { width: number; height: number },
  placement: PetThoughtPlacement
) {
  if (placement === "left" || placement === "right") {
    return {
      width: Math.max(PET_THOUGHT_VIEWPORT_MIN_WIDTH, compactSize.width + PET_THOUGHT_VIEWPORT_SIDE_EXTRA_WIDTH),
      height: Math.max(PET_THOUGHT_VIEWPORT_SIDE_MIN_HEIGHT, compactSize.height + 28),
    };
  }

  const extraHeight = getPetThoughtViewportHeight(compactSize.width);
  return {
    width: Math.max(compactSize.width, PET_THOUGHT_VIEWPORT_MIN_WIDTH),
    height: compactSize.height + extraHeight * 2,
  };
}

export function getPetThoughtAnchorOffset(
  viewportSize: { width: number; height: number },
  compactSize: { width: number; height: number }
) {
  return {
    x: Math.max(0, Math.round((viewportSize.width - compactSize.width) / 2)),
    y: Math.max(0, Math.round((viewportSize.height - compactSize.height) / 2)),
  };
}

export function getPetCompactViewportSize(options: {
  compactSize: { width: number; height: number };
  isCompactMenuOpen: boolean;
  isCompactQueryOpen: boolean;
  isCompactReplyLoading: boolean;
  hasCompactReply: boolean;
  thoughtPlacement?: PetThoughtPlacement;
  reservePetThoughtSpace?: boolean;
}) {
  const {
    compactSize,
    isCompactMenuOpen,
    isCompactQueryOpen,
    isCompactReplyLoading,
    hasCompactReply,
    thoughtPlacement = "top",
    reservePetThoughtSpace,
  } = options;

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

  if (reservePetThoughtSpace) {
    return getPetThoughtViewportSize(compactSize, thoughtPlacement);
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

export async function ensurePetThoughtWindow() {
  let petThoughtWindow = await WebviewWindow.getByLabel(PET_THOUGHT_WINDOW_LABEL);

  if (!petThoughtWindow) {
    petThoughtWindow = new WebviewWindow(PET_THOUGHT_WINDOW_LABEL, {
      url: "/?petThought=1",
      title: "Omni Pet Thought",
      width: PET_THOUGHT_WINDOW_SIZE.width,
      height: PET_THOUGHT_WINDOW_SIZE.height,
      minWidth: PET_THOUGHT_WINDOW_SIZE.width,
      minHeight: PET_THOUGHT_WINDOW_SIZE.height,
      maxWidth: PET_THOUGHT_WINDOW_SIZE.width,
      maxHeight: PET_THOUGHT_WINDOW_SIZE.height,
      decorations: false,
      transparent: true,
      shadow: false,
      alwaysOnTop: true,
      visibleOnAllWorkspaces: true,
      skipTaskbar: true,
      resizable: false,
      visible: false,
      focus: false,
    });

    await new Promise<void>((resolve, reject) => {
      petThoughtWindow?.once("tauri://created", () => resolve());
      petThoughtWindow?.once("tauri://error", (event) => reject(event.payload));
    });
  }

  await applyCompactWindowChrome(petThoughtWindow);
  await petThoughtWindow.setIgnoreCursorEvents(false).catch(() => undefined);
  await petThoughtWindow.setSize(new LogicalSize(PET_THOUGHT_WINDOW_SIZE.width, PET_THOUGHT_WINDOW_SIZE.height));
  return petThoughtWindow;
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
  const monitors = await availableMonitors().catch(() => [] as Monitor[]);
  const safeStoredPosition =
    storedPosition && isWindowRectVisibleOnAnyMonitor(storedPosition, size, monitors) ? storedPosition : null;
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
      center: safeStoredPosition == null,
      x: safeStoredPosition?.x,
      y: safeStoredPosition?.y,
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
  compactWindowLabel: string,
  options: { avoidMainWindowOverlap?: boolean } = {}
) {
  if (appearance === "pet" && isCompactPetHidden()) {
    const compactWindow = await WebviewWindow.getByLabel(compactWindowLabel);
    if (compactWindow) {
      await compactWindow.hide().catch(() => undefined);
    }
    return;
  }

  const compactWindow = await ensureCompactWindow(appearance, scale, compactWindowLabel);
  const settings = getBasicSettings();
  const size = getCompactWindowSize(appearance, scale);
  const storedPosition = getStoredCompactPosition();
  const monitors = await availableMonitors().catch(() => [] as Monitor[]);
  const safeStoredPosition =
    storedPosition && isWindowRectVisibleOnAnyMonitor(storedPosition, size, monitors) ? storedPosition : null;
  const mainWindow = await WebviewWindow.getByLabel(MAIN_WINDOW_LABEL);
  const cursorMonitor = settings.followCursorScreen ? await getMonitorForCursor() : null;

  if (settings.followCursorScreen) {
    if (cursorMonitor) {
      await moveCompactWindowToMonitor(compactWindow, cursorMonitor, size);
    } else if (safeStoredPosition) {
      const nativePosition = toNativePetCompactPosition(appearance, safeStoredPosition);
      await compactWindow.setPosition(new LogicalPosition(nativePosition.x, nativePosition.y));
    }
  } else if (safeStoredPosition) {
    const nativePosition = toNativePetCompactPosition(appearance, safeStoredPosition);
    await compactWindow.setPosition(new LogicalPosition(nativePosition.x, nativePosition.y));
  }

  if (cursorMonitor) {
    await clampCompactWindowToMonitor(compactWindow, cursorMonitor, size);
  }

  try {
    const scaleFactor = await compactWindow.scaleFactor();
    const currentPosition = (await compactWindow.outerPosition()).toLogical(scaleFactor);
    if (!isWindowRectVisibleOnAnyMonitor({ x: currentPosition.x, y: currentPosition.y }, size, monitors)) {
      const fallbackMonitor = (await getMonitorForCursor().catch(() => null)) ?? monitors[0] ?? null;
      if (fallbackMonitor) {
        await moveCompactWindowToMonitor(compactWindow, fallbackMonitor, size);
      }
    }
  } catch {
    // Keep showing the compact window even if the platform cannot report geometry.
  }

  if (mainWindow && options.avoidMainWindowOverlap !== false) {
    try {
      const mainVisible = await mainWindow.isVisible();
      if (mainVisible) {
        const [compactScaleFactor, mainScaleFactor] = await Promise.all([
          compactWindow.scaleFactor(),
          mainWindow.scaleFactor(),
        ]);
        const compactPosition = (await compactWindow.outerPosition()).toLogical(compactScaleFactor);
        const mainPosition = (await mainWindow.outerPosition()).toLogical(mainScaleFactor);
        const mainSize = (await mainWindow.outerSize()).toLogical(mainScaleFactor);
        const compactRight = compactPosition.x + size.width;
        const compactBottom = compactPosition.y + size.height;
        const mainRight = mainPosition.x + mainSize.width;
        const mainBottom = mainPosition.y + mainSize.height;
        const overlapsMainWindow =
          compactPosition.x < mainRight &&
          compactRight > mainPosition.x &&
          compactPosition.y < mainBottom &&
          compactBottom > mainPosition.y;

        if (overlapsMainWindow) {
          const nextX = Math.max(0, Math.round(mainPosition.x - size.width - 12));
          await compactWindow.setPosition(new LogicalPosition(nextX, Math.round(compactPosition.y)));
          persistCompactPosition({ x: nextX, y: Math.round(compactPosition.y) });
        }
      }
    } catch {
      // Ignore cross-window geometry failures.
    }
  }

  await compactWindow.show();
  await compactWindow.setAlwaysOnTop(true);
}

export async function ensureSettingsWindow() {
  const size = getSettingsWindowSize();
  let settingsWindow = await WebviewWindow.getByLabel(SETTINGS_WINDOW_LABEL);

  if (!settingsWindow) {
    settingsWindow = new WebviewWindow(SETTINGS_WINDOW_LABEL, {
      url: "/?settings=1",
      title: "Omni Settings",
      width: size.width,
      height: size.height,
      minWidth: 720,
      minHeight: 560,
      decorations: false,
      transparent: true,
      shadow: false,
      alwaysOnTop: false,
      skipTaskbar: false,
      resizable: true,
      visible: false,
      focus: false,
      center: true,
    });

    await new Promise<void>((resolve, reject) => {
      settingsWindow?.once("tauri://created", () => resolve());
      settingsWindow?.once("tauri://error", (event) => reject(event.payload));
    });

    await applyExpandedWindowChrome(settingsWindow);
    await settingsWindow.setSize(new LogicalSize(size.width, size.height));
    return settingsWindow;
  }

  await applyExpandedWindowChrome(settingsWindow);
  await settingsWindow.setSize(new LogicalSize(size.width, size.height));
  return settingsWindow;
}

export async function showSettingsWindow() {
  const settingsWindow = await ensureSettingsWindow();
  await settingsWindow.show();
  await settingsWindow.setFocus();
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

export async function restoreMainWindow(
  focusInput = false,
  options: { restoreGeometry?: boolean } = {}
) {
  const mainWindow = await WebviewWindow.getByLabel(MAIN_WINDOW_LABEL);

  if (mainWindow) {
    try {
      const isMinimized = await mainWindow.isMinimized();
      if (isMinimized) {
        await mainWindow.unminimize();
      }
    } catch {
      // Ignore platforms that do not support minimized-state checks.
    }

    await applyExpandedWindowChrome(mainWindow);
    await mainWindow.show();
    if (options.restoreGeometry !== false) {
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
    }

    await mainWindow.setFocus();
    await emit("omni-pet-thought-viewed");

    if (focusInput) {
      await mainWindow.emit("omni-focus-input");
    }
  }
}
