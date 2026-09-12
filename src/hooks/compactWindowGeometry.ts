import type { Monitor } from "@tauri-apps/api/window";
import { availableMonitors, currentMonitor, monitorFromPoint } from "@tauri-apps/api/window";
import { PET_THOUGHT_WINDOW_SIZE, type PetThoughtPlacement } from "../app/window";
import {
  PET_WINDOW_DECORATION_MARGIN_TOP,
  PET_WINDOW_NATIVE_TOP_LIMIT,
} from "../app/pets/codexPetSizing";

// 这些常量仅被下面的宠物气泡/拖拽几何计算使用，随几何逻辑一起抽到本模块。
const PET_THOUGHT_SCREEN_MARGIN = 12;
const PET_THOUGHT_TAIL_ANCHOR_RATIO_X = 0.72;
const PET_THOUGHT_VISIBLE_TOP_RATIO = 0.02;
const PET_THOUGHT_VISIBLE_BOTTOM_RATIO = 0.78;
const PET_THOUGHT_STACK_EDGE_GAP = 6;
const PET_THOUGHT_BUBBLE_WIDTH = 250;
const PET_THOUGHT_BUBBLE_TAIL_RATIO_X = 0.76;
const PET_THOUGHT_BADGE_ANCHOR_RATIO_X = 0.56;
const PET_THOUGHT_BADGE_ANCHOR_RATIO_Y = 0.18;
const PET_THOUGHT_VISIBLE_BUBBLE_LIMIT = 3;
const PET_THOUGHT_ESTIMATED_BUBBLE_HEIGHT = 78;
const PET_THOUGHT_STACK_GAP = 6;
const PET_THOUGHT_WINDOW_VERTICAL_PADDING = 10;
const PET_THOUGHT_WINDOW_SAFE_INSET = 12;

export type CharacterDragPosition = { x: number; y: number };

/** 竖直的一条窗口边（也是悬浮球在窗口内的贴边）。 */
export type CompactWindowEdge = "left" | "right";

/**
 * 悬浮球贴窗口的哪一条竖边 —— 组件（CSS 的 justify-content）与窗口几何
 * （尺寸变化时保留哪条边）**必须共用这一个判据**。
 *
 * ⚠️ 只允许依赖**持久**的菜单方向 `compactMenuSide`，绝不能掺入「菜单是否展开」：
 * 贴边用的 CSS 类在 React 提交那一帧就改变，而窗口 x 的补偿要等 setPosition
 * 落地（数个 IPC 往返）。两者取不同的边时，中间那几帧球会被画在窗口的另一侧，
 * 而展开态窗口宽达 812（见 getExpandedCompactViewportSize），于是视觉上就是
 * 「展开 / 收起菜单时悬浮球瞬移一整个窗口宽」——「悬浮球在最边上把菜单展开时
 * 拖动悬浮球，球直接瞬移很长一段距离」的根因。
 *
 * 判据（单测锁死）：本函数与窗口锚边取的是同一个值，所以「窗口长大 / 缩小」对
 * 球的屏幕位置是恒等变换；反过来，只要有人把开关态写进这里，立刻会漏一个
 * 「窗口宽 - 球宽」的平移。
 */
export function resolveCompactBallEdge(menuSide: "left" | "right"): CompactWindowEdge {
  // 菜单在左边 → 球贴窗口右边（窗口朝左长）；菜单在右边 → 球贴窗口左边（朝右长）。
  return menuSide === "left" ? "right" : "left";
}

/**
 * 求「保持 anchoredEdge 不动」的新窗口 x。
 *
 * right：右边缘不动，窗口向左长大（球贴右边时球不动）；
 * left：左边缘不动，窗口向右长大（球贴左边时球不动）。
 */
export function resolveAnchoredCompactWindowX(
  currentX: number,
  currentWidth: number,
  targetWidth: number,
  anchoredEdge: CompactWindowEdge
): number {
  return anchoredEdge === "right"
    ? Math.round(currentX + currentWidth - targetWidth)
    : Math.round(currentX);
}

/**
 * 显示器工作区矩形（物理像素，虚拟桌面坐标系，与 cursorPosition() /
 * outerPosition() 同一空间）。
 */
export type DragScreenBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 把拖拽目标位置钳制在光标所在显示器的工作区内。
 *
 * 为什么必须有这一步：拖拽循环的原始目标是「按下时的窗口位置 + 光标位移」，
 * 它没有任何屏幕边界概念。多屏拼出的虚拟桌面上存在「没有显示器的死区」
 * （两台显示器分辨率/摆放不对齐时尤其明显），窗口一旦被拖进去就整块不可见，
 * 表现就是「悬浮窗移着移着自动消失在桌面」；单屏下往屏幕边缘外拖同样会把
 * 它推出可见区域。
 *
 * 钳制基于**宠物本体的可视矩形**而不是窗口矩形：想法气泡/菜单展开时窗口被
 * 撑大、宠物被 --pet-viewport-offset-* 推离窗口左上角，若按窗口矩形钳制，
 * 宠物会被误判成越界而拖不到屏幕边缘。
 */
export function clampDragTargetToWorkArea(
  target: CharacterDragPosition,
  bounds: DragScreenBounds | null | undefined,
  options: {
    scaleFactor: number;
    /** 宠物本体尺寸（逻辑像素）；取不到时不钳制。 */
    petSize: { width: number; height: number } | null;
    /** 宠物本体相对窗口左上角的偏移（逻辑像素，即 --pet-viewport-offset-*）。 */
    petViewportOffset: { x: number; y: number };
    /** 允许宠物视觉顶边越过工作区顶边的量（沿用原有贴顶手感）。 */
    topOverscroll: number;
  }
): CharacterDragPosition {
  if (!bounds || !options.petSize) {
    return target;
  }

  const scale = options.scaleFactor || 1;
  const petWidth = Math.max(1, Math.round(options.petSize.width * scale));
  const petHeight = Math.max(1, Math.round(options.petSize.height * scale));
  const offsetX = options.petViewportOffset.x * scale;
  const offsetY = options.petViewportOffset.y * scale;

  // 宠物本体左边缘 = 窗口 x + offsetX，所以窗口 x 的可行区间要整体减掉 offsetX。
  const boundX = [bounds.left - offsetX, bounds.right - petWidth - offsetX];
  // 上边界沿用拖拽原始公式的手感（允许贴顶多出一个 overscroll），只是把
  // 「屏幕顶 = 0」换成工作区顶 —— 多屏上下排列时工作区 top ≠ 0，写死 0 会算错。
  const boundY = [
    bounds.top - (options.topOverscroll + options.petViewportOffset.y) * scale,
    bounds.bottom - petHeight - offsetY,
  ];

  return {
    x: Math.round(clampNumber(target.x, Math.min(...boundX), Math.max(...boundX))),
    y: Math.round(clampNumber(target.y, Math.min(...boundY), Math.max(...boundY))),
  };
}

export function toNativePetWindowY(visualY: number) {
  // 宠物本体贴到屏幕最上方时，窗口顶边本来就要向上超出一个装饰边距；
  // 气泡/菜单把视口撑大后还要再往上超一个视口偏移，所以这里只保留防御性下限，
  // 真正的上边界由拖动逻辑按「宠物视觉顶边」计算。
  return Math.max(PET_WINDOW_NATIVE_TOP_LIMIT, Math.round(visualY - PET_WINDOW_DECORATION_MARGIN_TOP));
}

export function toVisualPetWindowY(nativeY: number) {
  return Math.round(nativeY + PET_WINDOW_DECORATION_MARGIN_TOP);
}

export function waitForNextAnimationFrame() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

export function deferToAfterWindowMoveSettles(callback: () => void) {
  window.setTimeout(callback, 120);
}

/**
 * 找出矩形中心点所在的显示器。
 *
 * 三级降级：中心点命中 -> 当前显示器 -> 第一块可用显示器；
 * 全部失败才返回 null。多显示器下如果只用 currentMonitor()，
 * 宠物被拖到副屏时会拿到错误的工作区导致气泡飞出屏幕。
 */
export async function resolveMonitorForRect(
  rect: { left: number; top: number; width: number; height: number },
  scaleFactor: number,
): Promise<Monitor | null> {
  const centerMonitor = await monitorFromPoint(
    Math.round((rect.left + rect.width / 2) * scaleFactor),
    Math.round((rect.top + rect.height / 2) * scaleFactor),
  ).catch(() => null);
  if (centerMonitor) {
    return centerMonitor;
  }

  const fallbackMonitor = await currentMonitor().catch(() => null);
  if (fallbackMonitor) {
    return fallbackMonitor;
  }

  const monitors = await availableMonitors().catch(() => []);
  return monitors[0] ?? null;
}

export function getLogicalMonitorWorkArea(monitor: Monitor) {
  const scale = monitor.scaleFactor || 1;
  return {
    left: monitor.workArea.position.x / scale,
    top: monitor.workArea.position.y / scale,
    width: monitor.workArea.size.width / scale,
    height: monitor.workArea.size.height / scale,
  };
}

export function resolvePetThoughtWindowLayout(
  petRect: { left: number; top: number; width: number; height: number },
  monitor: Monitor,
  thoughtCount: number
) {
  const workArea = getLogicalMonitorWorkArea(monitor);
  const workAreaRight = workArea.left + workArea.width;
  const workAreaBottom = workArea.top + workArea.height;
  const viewportWidth = PET_THOUGHT_WINDOW_SIZE.width;
  const contentLeft = PET_THOUGHT_WINDOW_SAFE_INSET;
  const contentRight = viewportWidth - PET_THOUGHT_WINDOW_SAFE_INSET;
  const visibleThoughtCount = Math.max(1, Math.min(PET_THOUGHT_VISIBLE_BUBBLE_LIMIT, thoughtCount || 1));
  const viewportHeight = Math.min(
    PET_THOUGHT_WINDOW_SIZE.height,
    PET_THOUGHT_WINDOW_SAFE_INSET +
      PET_THOUGHT_WINDOW_VERTICAL_PADDING +
      visibleThoughtCount * PET_THOUGHT_ESTIMATED_BUBBLE_HEIGHT +
      Math.max(0, visibleThoughtCount - 1) * PET_THOUGHT_STACK_GAP
  );
  const topSpace = petRect.top - workArea.top - PET_THOUGHT_SCREEN_MARGIN;
  const bottomSpace = workAreaBottom - (petRect.top + petRect.height) - PET_THOUGHT_SCREEN_MARGIN;
  const placement: PetThoughtPlacement =
    topSpace >= viewportHeight || topSpace >= bottomSpace ? "top" : "bottom";
  const tailAnchorX = petRect.left + petRect.width * PET_THOUGHT_TAIL_ANCHOR_RATIO_X;
  const badgeAnchorX = petRect.left + petRect.width * PET_THOUGHT_BADGE_ANCHOR_RATIO_X;
  const badgeAnchorY = petRect.top + petRect.height * PET_THOUGHT_BADGE_ANCHOR_RATIO_Y;
  const visiblePetTop = petRect.top + petRect.height * PET_THOUGHT_VISIBLE_TOP_RATIO;
  const visiblePetBottom = petRect.top + petRect.height * PET_THOUGHT_VISIBLE_BOTTOM_RATIO;
  const preferredWindowX =
    tailAnchorX - contentLeft - PET_THOUGHT_BUBBLE_WIDTH * PET_THOUGHT_BUBBLE_TAIL_RATIO_X;
  const x = Math.min(
    workAreaRight - viewportWidth,
    Math.max(workArea.left, preferredWindowX)
  );
  const y =
    placement === "top"
      ? Math.max(workArea.top, visiblePetTop - viewportHeight)
      : Math.min(workAreaBottom - viewportHeight, visiblePetBottom);

  return {
    placement,
    position: {
      x: Math.round(x),
      y: Math.round(y),
    },
    size: {
      width: viewportWidth,
      height: Math.round(viewportHeight),
    },
    anchor: {
      x: Math.round(clampNumber(tailAnchorX - x, contentLeft, contentRight)),
      y: Math.round(
        clampNumber(
          (placement === "top" ? visiblePetTop - y : visiblePetBottom - y) +
            (placement === "top" ? -PET_THOUGHT_STACK_EDGE_GAP : PET_THOUGHT_STACK_EDGE_GAP),
          PET_THOUGHT_STACK_EDGE_GAP,
          viewportHeight - PET_THOUGHT_STACK_EDGE_GAP
        )
      ),
    },
    badgeAnchor: {
      x: Math.round(clampNumber(badgeAnchorX - x, contentLeft + 18, contentRight - 18)),
      y: Math.round(clampNumber(badgeAnchorY - y, 18, viewportHeight - 18)),
    },
  };
}

export function resolveCharacterDragMotion(
  deltaX: number,
  deltaY: number
): "running-left" | "running-right" | "running" {
  const horizontalDominant = Math.abs(deltaX) >= Math.abs(deltaY) * 0.7;
  if (!horizontalDominant) {
    return "running";
  }
  return deltaX < 0 ? "running-left" : "running-right";
}
