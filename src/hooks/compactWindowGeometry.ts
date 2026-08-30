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

export function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
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
