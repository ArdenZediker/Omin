import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import { availableMonitors, cursorPosition, getCurrentWindow, monitorFromPoint, type Monitor } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit, emitTo } from "@tauri-apps/api/event";
import {
  CHARACTER_SCALE_BASELINE,
  CHAT_WINDOW_SIZE,
  COMPACT_MENU_PANEL_HEIGHT,
  COMPACT_MENU_PANEL_WIDTH,
  COMPACT_APPEARANCE_PRESETS,
  COMPACT_POSITION_STORAGE_KEY,
  DEFAULT_BASIC_SETTINGS,
  EXPANDED_SIZE,
  MAIN_POSITION_STORAGE_KEY,
  MAIN_VIEW_STORAGE_KEY,
  MAIN_WINDOW_LABEL,
  PET_THOUGHT_WINDOW_LABEL,
  THEME_MODE_STORAGE_KEY,
} from "./constants";
import { applyThemeMode } from "./settings";
import type { BasicSettings, ExternalChatEntry, ViewMode } from "./types";
import { isCompactPetHidden } from "./compactVisibility";
import type { CompactAppearance } from "../hooks/useCompactWindowState";
import { getCompactMenuViewportMinWidth } from "../hooks/compactMenuGeometry";
import { readSqliteBackedJson, readSqliteBackedValue, saveSqliteBackedValue } from "./sqliteStorage";
import {
  PET_WINDOW_DECORATION_MARGIN_RIGHT,
  PET_WINDOW_DECORATION_MARGIN_TOP,
  PET_WINDOW_SAFE_MARGIN_X,
  PET_WINDOW_SAFE_MARGIN_Y,
  PET_WINDOW_TOP_OVERSCROLL,
} from "./pets/codexPetSizing";

const PET_THOUGHT_BUBBLE_WIDTH = 250;
const PET_THOUGHT_VIEWPORT_HORIZONTAL_PADDING = 44;
const PET_THOUGHT_VIEWPORT_MIN_WIDTH = PET_THOUGHT_BUBBLE_WIDTH + PET_THOUGHT_VIEWPORT_HORIZONTAL_PADDING * 2;
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

export function getBasicSettings(): BasicSettings {
  if (typeof window === "undefined") return DEFAULT_BASIC_SETTINGS;
  return readSqliteBackedJson("omni_basic_settings", DEFAULT_BASIC_SETTINGS);
}

export function clampWindowSize(value: number, fallback: number, min: number, max: number) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

export function applyThemeFromStorage() {
  if (typeof window === "undefined") return;
  const saved = readSqliteBackedValue(THEME_MODE_STORAGE_KEY);
  const mode = saved === "dark" || saved === "light" ? saved : "auto";
  // applyThemeMode 会设置 data-* 属性、持久化并广播跨窗口同步事件。
  applyThemeMode(THEME_MODE_STORAGE_KEY, mode);
}

// ── 紧凑窗几何：统一使用**物理像素** ───────────────────────────────────────────
//
// 为什么必须物理：Windows 上写 LogicalPosition 时，tao 用的是**窗口当前所在屏**
// 的 scale 来换算（tao-0.34.8/src/platform_impl/windows/window.rs:229
// `position.to_physical::<i32>(self.scale_factor())`），而被塞进那个参数里的值，
// 却是在**目标屏**的逻辑空间里算出来的。两者不是同一个空间：
//   DISPLAY1(150%) → DISPLAY2(100%)，目标屏逻辑 x=4300 ⇒ 实际写 4300×1.5=6450，
//   越出虚拟桌面右边界(4480) ⇒ 悬浮球整块跑到屏外、看不见。
// 反方向只错位 763px 不越界，所以症状是「单向、时有时无」。
//
// 因此本模块的位置一律物理像素（虚拟桌面坐标系，与 cursorPosition() /
// outerPosition() / monitor.workArea 同一空间）；**尺寸仍是逻辑像素（CSS）**，
// 只在几何边界处按**目标屏** scale 显式换算成物理。换算规则可审计：
// 原先在「某块屏的逻辑空间」里成立的公式，物理化 = 工作区换成物理工作区、
// 每个逻辑常量/尺寸都乘上那块屏的 scaleFactor。

export type CompactPhysicalPosition = { x: number; y: number };

/** 持久化记录的坐标空间标识。旧记录没有 unit 字段 ⇒ 是逻辑坐标，需要一次性迁移。 */
const COMPACT_POSITION_PHYSICAL_UNIT = "physical";

/** 锚点距工作区右边缘的距离（逻辑像素）。 */
const COMPACT_ANCHOR_INSET = 24;
/** 锚点在工作区竖直可移动范围内的比例。 */
const COMPACT_ANCHOR_VERTICAL_RATIO = 0.42;

/** 显示器工作区（物理像素）。monitor.workArea 本身就是物理值，**不要再除以 scaleFactor**。 */
export function getPhysicalWorkArea(monitor: Monitor) {
  const { position, size } = monitor.workArea;
  return {
    left: position.x,
    top: position.y,
    right: position.x + size.width,
    bottom: position.y + size.height,
    width: size.width,
    height: size.height,
  };
}

/**
 * 逻辑尺寸 → 物理尺寸。
 *
 * 窗口跨 DPI 屏时 tao 会**保持逻辑尺寸不变**（WM_DPICHANGED 处理器把旧物理尺寸
 * 折算回逻辑、再按新 scale 折算回物理：tao .../windows/event_loop.rs:1966），
 * 所以落在目标屏上的物理尺寸 = 逻辑尺寸 × 目标屏 scaleFactor。
 */
export function toPhysicalSize(size: { width: number; height: number }, scale: number) {
  const factor = scale || 1;
  return {
    width: Math.max(1, Math.round(size.width * factor)),
    height: Math.max(1, Math.round(size.height * factor)),
  };
}

/**
 * 逻辑坐标 → 物理坐标。必须显式传入**该坐标所属显示器**的 scale —— 这正是本次
 * 修复的要害：过去把「目标屏逻辑坐标」交给不带 scale 的 LogicalPosition 写入，
 * 换算基准（窗口当前所在屏）与坐标空间（目标屏）不一致。
 */
export function toCompactPhysicalPosition(position: { x: number; y: number }, scale: number): CompactPhysicalPosition {
  const factor = scale || 1;
  return { x: Math.round(position.x * factor), y: Math.round(position.y * factor) };
}

type StoredCompactPosition = {
  x: number;
  y: number;
  /** true = 已是物理像素；false = 旧版逻辑坐标记录（由调用方迁移）。 */
  isPhysical: boolean;
  /** 持久化时窗口所在显示器的 scaleFactor（旧记录为 0）。 */
  scale: number;
};

export function getStoredCompactPosition(): StoredCompactPosition | null {
  if (typeof window === "undefined") return null;
  try {
    const saved = readSqliteBackedValue(COMPACT_POSITION_STORAGE_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved) as { x?: number; y?: number; unit?: string; scale?: number };
    const { x, y } = parsed;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    const position = { x: Math.round(x as number), y: Math.round(y as number) };
    // 透明无边框窗口在创建瞬间常在 (0,0) 闪现并触发一次 moved 事件，
    // 这类退化坐标一律当作「无记录」处理，回落到确定性兜底位置，
    // 避免每次启动都贴左上角（main 窗口已有同样保护，这里补齐）。
    if (position.x <= 0 && position.y <= 0) {
      return null;
    }
    const scale = parsed.scale;
    return {
      ...position,
      isPhysical: parsed.unit === COMPACT_POSITION_PHYSICAL_UNIT,
      scale: typeof scale === "number" && Number.isFinite(scale) && scale > 0 ? scale : 0,
    };
  } catch {
    return null;
  }
}

/**
 * 持久化紧凑窗位置。`position` 必须是**物理像素**、且是「宠物本体视觉位置」
 * （非宠物外观时即窗口位置）；`scale` 为写入时窗口所在显示器的缩放因子 ——
 * 恢复时用它把视觉位置换算回窗口顶边（宠物外观带装饰边距），避免再去反推是哪块屏。
 */
export function persistCompactPosition(position: { x: number; y: number }, scale: number) {
  if (typeof window === "undefined") return;
  saveSqliteBackedValue(
    COMPACT_POSITION_STORAGE_KEY,
    JSON.stringify({
      x: Math.round(position.x),
      y: Math.round(position.y),
      unit: COMPACT_POSITION_PHYSICAL_UNIT,
      scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
    })
  );
}

/**
 * 旧版记录的迁移：旧记录是「某块屏逻辑空间」的坐标，且没记下是哪块屏。
 * 用各显示器自己的逻辑矩形做包含判定反推（旧值必然落在它当时所在屏的逻辑矩形内），
 * 命中即乘该屏 scale 得到物理坐标。一块都没命中（显示器布局已变）⇒ 返回 null，
 * 由调用方当作「无记录」处理、回落到确定性锚点。
 *
 * 已知边界：混合 DPI 且两台显示器的逻辑矩形互相重叠时，理论上可能反推到另一块屏
 * （顺序取第一个命中）。这只影响迁移这一次，且最坏结果只是一次落点偏差。
 */
export function migrateLogicalCompactPositionToPhysical(
  position: { x: number; y: number },
  monitors: Monitor[]
): CompactPhysicalPosition | null {
  for (const monitor of monitors) {
    const scale = monitor.scaleFactor || 1;
    const area = getPhysicalWorkArea(monitor);
    const left = area.left / scale;
    const top = area.top / scale;
    const right = area.right / scale;
    const bottom = area.bottom / scale;
    if (position.x >= left && position.x <= right && position.y >= top && position.y <= bottom) {
      return toCompactPhysicalPosition(position, scale);
    }
  }
  return null;
}

/** 按物理点找它落在哪块显示器上，取该屏 scale（找不到返回 null）。 */
function resolveMonitorScaleForPhysicalPoint(position: { x: number; y: number }, monitors: Monitor[]) {
  const monitor = monitors.find((candidate) => {
    const area = getPhysicalWorkArea(candidate);
    return position.x >= area.left && position.x <= area.right && position.y >= area.top && position.y <= area.bottom;
  });
  return monitor ? monitor.scaleFactor || 1 : null;
}

/**
 * 「宠物本体视觉位置」（物理）→ 窗口顶边位置（物理）：宠物外观要减去装饰边距。
 * 存储里存的一律是视觉位置（气泡/菜单撑大窗口时窗口顶边会跑，宠物本体不会），
 * 而落位要的是窗口顶边，两者靠这个换算对齐。
 */
export function toNativePetCompactPosition(
  appearance: CompactAppearance,
  position: CompactPhysicalPosition,
  scale: number
): CompactPhysicalPosition {
  if (appearance !== "pet") {
    return position;
  }
  const factor = scale || 1;
  return {
    x: position.x,
    // 保存的是「宠物本体」的视觉位置（已不含视口偏移），恢复时窗口顶边需要向上
    // 超出一个装饰边距；再额外给一点 overscroll，让贴顶拖动过的宠物能原样回来。
    // 边距与 overscroll 都是逻辑像素，换算到物理要乘 scale。
    y: Math.max(
      Math.round(-(PET_WINDOW_DECORATION_MARGIN_TOP + PET_WINDOW_TOP_OVERSCROLL) * factor),
      Math.round(position.y - PET_WINDOW_DECORATION_MARGIN_TOP * factor)
    ),
  };
}

/** 窗口顶边位置（物理）→ 宠物本体视觉位置（物理）：宠物外观要加上装饰边距。 */
export function toVisualPetCompactPosition(
  appearance: CompactAppearance,
  position: CompactPhysicalPosition,
  scale: number
): CompactPhysicalPosition {
  if (appearance !== "pet") {
    return position;
  }
  const factor = scale || 1;
  return { x: position.x, y: position.y + Math.round(PET_WINDOW_DECORATION_MARGIN_TOP * factor) };
}

export function getCompactAnchorPositionForMonitor(
  monitor: Monitor,
  size: { width: number; height: number }
): CompactPhysicalPosition {
  const scale = monitor.scaleFactor || 1;
  const workArea = getPhysicalWorkArea(monitor);
  const physicalSize = toPhysicalSize(size, scale);
  const verticalRange = Math.max(0, workArea.height - physicalSize.height);
  const centerOffset = Math.round(verticalRange * COMPACT_ANCHOR_VERTICAL_RATIO);
  return {
    x: Math.round(workArea.right - physicalSize.width - Math.round(COMPACT_ANCHOR_INSET * scale)),
    y: Math.round(workArea.top + centerOffset),
  };
}

/**
 * 把窗口在源屏上的相对位置，等比映射到目标屏（**物理像素**，两个矩形都取自
 * monitor.workArea，无需任何 scale 换算）。
 */
export function mapCompactPositionToMonitor(
  position: CompactPhysicalPosition,
  sourceMonitor: Monitor,
  targetMonitor: Monitor,
  size: { width: number; height: number }
): CompactPhysicalPosition {
  const source = getPhysicalWorkArea(sourceMonitor);
  const target = getPhysicalWorkArea(targetMonitor);
  const sourceSize = toPhysicalSize(size, sourceMonitor.scaleFactor || 1);
  const targetSize = toPhysicalSize(size, targetMonitor.scaleFactor || 1);
  const sourceRangeX = Math.max(1, source.width - sourceSize.width);
  const sourceRangeY = Math.max(1, source.height - sourceSize.height);
  const targetRangeX = Math.max(0, target.width - targetSize.width);
  const targetRangeY = Math.max(0, target.height - targetSize.height);
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
    /** 窗口当前物理位置（outerPosition() 的原生值）。 */
    currentPosition?: CompactPhysicalPosition | null;
    persistPosition?: boolean;
    /** 仅用于把持久化的「窗口位置」换算成「宠物视觉位置」；缺省按非宠物处理。 */
    appearance?: CompactAppearance;
  }
) {
  const nextPosition =
    options?.sourceMonitor && options?.currentPosition
      ? mapCompactPositionToMonitor(options.currentPosition, options.sourceMonitor, monitor, size)
      : getCompactAnchorPositionForMonitor(monitor, size);
  const scale = monitor.scaleFactor || 1;
  // ⚠️ 必须物理写入。写 LogicalPosition 时 tao 会用「窗口当前所在屏」的 scale 换算，
  // 而 nextPosition 属于**目标屏**的逻辑空间 —— 跨不同 DPI 的屏时落点会整体放大到屏外。
  await targetWindow.setPosition(new PhysicalPosition(nextPosition.x, nextPosition.y));
  if (options?.persistPosition !== false) {
    const appearance = options?.appearance;
    const visualPosition =
      appearance === "pet" ? toVisualPetCompactPosition(appearance, nextPosition, scale) : nextPosition;
    persistCompactPosition(visualPosition, scale);
  }
}

export async function clampCompactWindowToMonitor(
  targetWindow: ReturnType<typeof getCurrentWindow>,
  monitor: Monitor,
  size: { width: number; height: number }
) {
  // 全程物理像素：outerPosition() 原生就是物理值，**不要**再 toLogical —— 那会换到
  // 「窗口当前所在屏」的逻辑空间，与 monitor（目标屏）不是同一个空间。
  const currentPosition = await targetWindow.outerPosition();
  const workArea = getPhysicalWorkArea(monitor);
  const physicalSize = toPhysicalSize(size, monitor.scaleFactor || 1);
  const maxX = Math.max(workArea.left, workArea.right - physicalSize.width);
  const nextX = Math.min(maxX, Math.max(workArea.left, currentPosition.x));

  if (Math.round(nextX) !== Math.round(currentPosition.x)) {
    await targetWindow.setPosition(new PhysicalPosition(Math.round(nextX), currentPosition.y));
  }
}

/**
 * 存储的主窗位置。与紧凑窗**同一口径**（见 getStoredCompactPosition）：
 * 物理像素、虚拟桌面坐标系。
 */
type StoredMainPosition = {
  x: number;
  y: number;
  /** true = 已是物理像素；false = 旧版逻辑坐标记录（由调用方迁移）。 */
  isPhysical: boolean;
  /** 持久化时窗口所在显示器的 scaleFactor（旧记录为 0）。 */
  scale: number;
};

export function getStoredMainPosition(): StoredMainPosition | null {
  if (typeof window === "undefined") return null;
  try {
    const saved = readSqliteBackedValue(MAIN_POSITION_STORAGE_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved) as { x?: number; y?: number; unit?: string; scale?: number };
    const { x, y } = parsed;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    const position = { x: Math.round(x as number), y: Math.round(y as number) };
    // 透明无边框窗口在创建瞬间经常在 (0,0) 闪现并触发一次 moved 事件，
    // 把这种退化坐标当作「无记录」处理，回落到居中，避免每次启动都贴左上角。
    if (position.x <= 0 && position.y <= 0) {
      return null;
    }
    const scale = parsed.scale;
    return {
      ...position,
      isPhysical: parsed.unit === COMPACT_POSITION_PHYSICAL_UNIT,
      scale: typeof scale === "number" && Number.isFinite(scale) && scale > 0 ? scale : 0,
    };
  } catch {
    return null;
  }
}

/**
 * 持久化主窗位置。`position` 必须是**物理像素**的窗口左上角（主窗没有装饰边距，
 * 与紧凑窗存「宠物本体视觉位置」不同）；`scale` 为写入时窗口所在显示器的缩放因子。
 *
 * 为什么必须带 scale：Windows 上 tao 的 `set_outer_position` 用**窗口当前所在屏**
 * 的缩放去换算逻辑坐标（tao .../windows/window.rs:230），所以「逻辑值」离开了
 * 保存它的那块屏就没有意义 —— 记下 scale 才能把位置钉在正确的坐标空间里。
 */
export function persistMainPosition(position: { x: number; y: number }, scale: number) {
  if (typeof window === "undefined") return;
  saveSqliteBackedValue(
    MAIN_POSITION_STORAGE_KEY,
    JSON.stringify({
      x: Math.round(position.x),
      y: Math.round(position.y),
      unit: COMPACT_POSITION_PHYSICAL_UNIT,
      scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
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

/**
 * 读取主窗存储位置，归一化到**物理像素**并校验可见性。与
 * getSafeStoredCompactPosition 同一套口径与降级策略：
 * - 旧版逻辑坐标记录 ⇒ 按各屏自己的逻辑矩形反推所属屏、一次性迁移成物理值；
 * - 物理值不依赖显示器枚举，枚举失败（返回空）时可直接信任。
 *
 * 为什么必须归一化（本次修复的要害）：
 * 1. 主窗由 tauri.conf.json 以 `center:true` 创建，启动时通常落在主屏；而位置
 *    可能是在另一块缩放不同的屏上保存的。`setPosition(LogicalPosition)` 会以
 *    **主屏** scale 去换算 —— 落点既可能整块跑到虚拟桌面外，也会偏到别的屏上。
 * 2. 旧的可见性判定读 `window.screen`（**当前屏**的逻辑工作区）去比对存储值，
 *    跨屏保存的位置会被判成「不可见」而回落居中 —— 表现为「记住上次位置」
 *    形同虚设。归一化后用物理工作区判定，与存储值同处一个坐标空间。
 */
export async function getSafeStoredMainPosition(
  size: { width: number; height: number }
): Promise<{ position: CompactPhysicalPosition; scale: number } | null> {
  const stored = getStoredMainPosition();
  if (!stored) {
    return null;
  }
  // 显示器枚举偶发失败（空数组 / reject），重试一次；仍为空时物理值仍可信，
  // 旧版逻辑值则无屏可依、只能当作无记录（回落居中）。
  let monitors = await availableMonitors().catch(() => [] as Monitor[]);
  if (monitors.length === 0) {
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    monitors = await availableMonitors().catch(() => [] as Monitor[]);
  }

  if (!stored.isPhysical) {
    const migrated = migrateLogicalCompactPositionToPhysical({ x: stored.x, y: stored.y }, monitors);
    if (!migrated) {
      return null;
    }
    const migratedScale = resolveMonitorScaleForPhysicalPoint(migrated, monitors) ?? 1;
    persistMainPosition(migrated, migratedScale);
    if (!isWindowRectVisibleOnAnyMonitor(migrated, size, monitors)) {
      return null;
    }
    return { position: migrated, scale: migratedScale };
  }

  const position = { x: stored.x, y: stored.y };
  if (monitors.length === 0 || isWindowRectVisibleOnAnyMonitor(position, size, monitors)) {
    return {
      position,
      scale: stored.scale || resolveMonitorScaleForPhysicalPoint(position, monitors) || 1,
    };
  }
  return null;
}

function isWindowRectVisibleInMonitor(
  position: CompactPhysicalPosition,
  size: { width: number; height: number },
  monitor: Monitor
) {
  const scale = monitor.scaleFactor || 1;
  const area = getPhysicalWorkArea(monitor);
  const physicalSize = toPhysicalSize(size, scale);
  // 边距原本是逻辑像素的 12~80，物理化后同样乘 scale，保持与旧判定等价。
  const visibleMargin = Math.min(80, Math.max(12, Math.min(size.width, size.height) / 2)) * scale;

  return (
    position.x < area.right - visibleMargin &&
    position.x + physicalSize.width > area.left + visibleMargin &&
    position.y < area.bottom - visibleMargin &&
    position.y + physicalSize.height > area.top + visibleMargin
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

/** The inline ask bar replaces the ball; it does not need the full menu viewport. */
export function getCompactQueryViewportSize(size: { width: number; height: number }) {
  return { width: Math.max(374, size.width), height: Math.max(74, size.height) };
}

export function getPetCompactMenuViewport(size: { width: number; height: number }) {
  return {
    width: Math.max(size.width, getCompactMenuViewportMinWidth()),
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
  await targetWindow.setShadow(false);
  await targetWindow.setResizable(false);
  await targetWindow.setAlwaysOnTop(true);
  await targetWindow.setSkipTaskbar(true);

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
  await petThoughtWindow.setIgnoreCursorEvents(true).catch(() => undefined);
  await petThoughtWindow.setSize(new LogicalSize(PET_THOUGHT_WINDOW_SIZE.width, PET_THOUGHT_WINDOW_SIZE.height));
  return petThoughtWindow;
}

export async function applyExpandedWindowChrome(targetWindow: ReturnType<typeof getCurrentWindow>) {
  await targetWindow.setShadow(false);
  await targetWindow.setResizable(true);
  await targetWindow.setAlwaysOnTop(false);
  await targetWindow.setSkipTaskbar(false);
  await targetWindow.setDecorations(false);
}

/**
 * 读取存储的紧凑窗口位置，归一化到**物理像素**，并校验它是否落在某个显示器的
 * 可见范围内。返回值里的 scale 是这份位置所属显示器的缩放因子，供调用方把
 * 「宠物视觉位置」换算回窗口顶边（见 toNativePetCompactPosition）。
 *
 * 注意：availableMonitors() 偶发失败（返回空数组 / reject），此时不能再把
 * 有效位置判为「不可见」丢弃——位置本来就是在真实显示器上保存的，丢弃后
 * 窗口会以无坐标方式创建，在 Windows 上落到默认位置（≈屏幕左上角）。
 * 因此显示器枚举为空时做一次重试；仍为空时，物理值不依赖枚举可直接信任，
 * 旧版逻辑值则无屏可依、只能丢弃（回落到确定性锚点）。
 */
export async function getSafeStoredCompactPosition(
  size: { width: number; height: number }
): Promise<{ position: CompactPhysicalPosition; scale: number } | null> {
  const stored = getStoredCompactPosition();
  if (!stored) {
    return null;
  }
  let monitors = await availableMonitors().catch(() => [] as Monitor[]);
  if (monitors.length === 0) {
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    monitors = await availableMonitors().catch(() => [] as Monitor[]);
  }

  if (!stored.isPhysical) {
    // 旧版记录：逻辑坐标、且没记是哪块屏 ⇒ 按各屏逻辑矩形反推后一次性迁移成物理值。
    const migrated = migrateLogicalCompactPositionToPhysical({ x: stored.x, y: stored.y }, monitors);
    if (!migrated) {
      return null;
    }
    const migratedScale = resolveMonitorScaleForPhysicalPoint(migrated, monitors) ?? 1;
    persistCompactPosition(migrated, migratedScale);
    if (!isWindowRectVisibleOnAnyMonitor(migrated, size, monitors)) {
      return null;
    }
    return { position: migrated, scale: migratedScale };
  }

  const position = { x: stored.x, y: stored.y };
  if (monitors.length === 0 || isWindowRectVisibleOnAnyMonitor(position, size, monitors)) {
    return {
      position,
      scale: stored.scale || resolveMonitorScaleForPhysicalPoint(position, monitors) || 1,
    };
  }
  return null;
}

export async function ensureCompactWindow(appearance: CompactAppearance, scale: number, compactWindowLabel: string) {
  const size = getCompactWindowSize(appearance, scale);
  const expandedViewport = getExpandedCompactViewportSize(true);
  const safeStored = await getSafeStoredCompactPosition(size);
  let compactWindow = await WebviewWindow.getByLabel(compactWindowLabel);
  let created = false;

  if (!compactWindow) {
    created = true;
    // 创建参数里的 x/y 是**逻辑**坐标，且换算基准是创建时的系统 DPI（不一定是目标屏）——
    // 跨 DPI 时正是这类隐式换算把窗口送到屏外。所以这里不再用它们定位，改为创建后
    // 显式写物理坐标（窗口此刻 visible:false，不会有闪跳）。
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
      center: false,
    });

    await new Promise<void>((resolve, reject) => {
      compactWindow?.once("tauri://created", () => resolve());
      compactWindow?.once("tauri://error", (event) => reject(event.payload));
    });
  }

  await applyCompactWindowChrome(compactWindow);
  await compactWindow.setSize(new LogicalSize(size.width, size.height));

  if (safeStored && created) {
    // 只有「新建」时才按存储位置落位：已存在的窗口正被用户使用，不该被拉回旧位置。
    const native = toNativePetCompactPosition(appearance, safeStored.position, safeStored.scale);
    await compactWindow.setPosition(new PhysicalPosition(native.x, native.y)).catch(() => undefined);
  } else if (!safeStored) {
    // Windows/WebView2 对 visible:false 的隐藏窗口，center:true 经常不生效，窗口
    // 会落到系统默认位置（≈屏幕左上角）。改用主显示器的确定性锚点位置显式定位。
    try {
      const fallbackMonitors = await availableMonitors().catch(() => [] as Monitor[]);
      const primaryMonitor = fallbackMonitors[0];
      if (primaryMonitor) {
        const fallback = getCompactAnchorPositionForMonitor(primaryMonitor, size);
        await compactWindow
          .setPosition(new PhysicalPosition(fallback.x, fallback.y))
          .catch(() => undefined);
      } else {
        await compactWindow.center().catch(() => undefined);
      }
    } catch {
      await compactWindow.center().catch(() => undefined);
    }
  }
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
  const safeStored = await getSafeStoredCompactPosition(size);
  const mainWindow = await WebviewWindow.getByLabel(MAIN_WINDOW_LABEL);
  const cursorMonitor = settings.followCursorScreen ? await getMonitorForCursor() : null;

  if (settings.followCursorScreen) {
    if (cursorMonitor) {
      await moveCompactWindowToMonitor(compactWindow, cursorMonitor, size, { appearance });
    } else if (safeStored) {
      const nativePosition = toNativePetCompactPosition(appearance, safeStored.position, safeStored.scale);
      await compactWindow.setPosition(new PhysicalPosition(nativePosition.x, nativePosition.y));
    }
  } else if (safeStored) {
    const nativePosition = toNativePetCompactPosition(appearance, safeStored.position, safeStored.scale);
    await compactWindow.setPosition(new PhysicalPosition(nativePosition.x, nativePosition.y));
  }

  if (cursorMonitor) {
    await clampCompactWindowToMonitor(compactWindow, cursorMonitor, size);
  }

  try {
    // 物理像素判定：outerPosition() 原生就是物理值，直接与各屏物理工作区比较。
    const currentPosition = await compactWindow.outerPosition();
    const currentMonitors = await availableMonitors().catch(() => [] as Monitor[]);
    if (
      currentMonitors.length > 0 &&
      !isWindowRectVisibleOnAnyMonitor({ x: currentPosition.x, y: currentPosition.y }, size, currentMonitors)
    ) {
      const fallbackMonitor = (await getMonitorForCursor().catch(() => null)) ?? currentMonitors[0] ?? null;
      if (fallbackMonitor) {
        await moveCompactWindowToMonitor(compactWindow, fallbackMonitor, size, { appearance });
      }
    }
  } catch {
    // Keep showing the compact window even if the platform cannot report geometry.
  }

  // 仅当用户此前没有手动放置过宠物（无持久化位置）时，才在显示时避让主窗口。
  // 一旦用户已经拖动过（safeStored 存在），就尊重用户位置，不再自动推开，
  // 也不再把「推走后的位置」写回存储——否则每次重启/重开主窗口都会把宠物拽离用户位置。
  if (mainWindow && options.avoidMainWindowOverlap !== false && !safeStored) {
    try {
      const mainVisible = await mainWindow.isVisible();
      if (mainVisible) {
        const compactScaleFactor = await compactWindow.scaleFactor();
        // 两个窗口的 outerPosition()/outerSize() 都是物理值，所以这段跨窗口几何
        // 在物理空间里天然一致，不需要（也不能）各自换算到「自己那块屏」的逻辑空间。
        const compactPosition = await compactWindow.outerPosition();
        const mainPosition = await mainWindow.outerPosition();
        const mainSize = await mainWindow.outerSize();
        const compactPhysicalSize = toPhysicalSize(size, compactScaleFactor);
        const compactRight = compactPosition.x + compactPhysicalSize.width;
        const compactBottom = compactPosition.y + compactPhysicalSize.height;
        const mainRight = mainPosition.x + mainSize.width;
        const mainBottom = mainPosition.y + mainSize.height;
        const overlapsMainWindow =
          compactPosition.x < mainRight &&
          compactRight > mainPosition.x &&
          compactPosition.y < mainBottom &&
          compactBottom > mainPosition.y;

        if (overlapsMainWindow) {
          const gap = Math.round(12 * compactScaleFactor);
          const nextX = Math.max(0, Math.round(mainPosition.x - compactPhysicalSize.width - gap));
          const nextY = Math.round(compactPosition.y);
          await compactWindow.setPosition(new PhysicalPosition(nextX, nextY));
          // 存储口径统一为「宠物本体视觉位置」，所以这里补上装饰边距（非宠物外观时是恒等）。
          const visualPosition = toVisualPetCompactPosition(
            appearance,
            { x: nextX, y: nextY },
            compactScaleFactor
          );
          persistCompactPosition(visualPosition, compactScaleFactor);
        }
      }
    } catch {
      // Ignore cross-window geometry failures.
    }
  }

  await compactWindow.show();
  await compactWindow.setAlwaysOnTop(true);
}

export async function showSettingsWindow() {
  await restoreMainWindow(false, { restoreGeometry: false });
  await emitTo(MAIN_WINDOW_LABEL, "omni-open-settings");
}

export async function isMainWindowUserVisible() {
  const mainWindow = await WebviewWindow.getByLabel(MAIN_WINDOW_LABEL);
  if (!mainWindow) {
    return false;
  }

  const [isVisible, isMinimized] = await Promise.all([
    mainWindow.isVisible().catch(() => false),
    mainWindow.isMinimized().catch(() => true),
  ]);

  return isVisible && !isMinimized;
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
        const safeStored = await getSafeStoredMainPosition(restoredSize);
        if (safeStored) {
          // 物理坐标 + 物理写入：与紧凑窗同一口径。若用 LogicalPosition，tao 会按
          // **窗口当前所在屏**的 scale 换算（windows/window.rs:230），跨屏保存的
          // 位置必然落错屏/出屏。
          await mainWindow.setPosition(
            new PhysicalPosition(safeStored.position.x, safeStored.position.y)
          );
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
