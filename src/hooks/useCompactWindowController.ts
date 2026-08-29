import { useCallback, useEffect, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { availableMonitors, currentMonitor, cursorPosition, getCurrentWindow, monitorFromPoint, type Monitor } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { loadProviderConfigs, modelRegistry } from "../adapters/registry";
import { bootstrapSqliteStorage, readSqliteBackedValue } from "../app/sqliteStorage";
import { executeChatTurn } from "../chat/engine";
import { resolveCurrentModelId } from "../chat/modelSelection";
import { USAGE_PREFERENCES_STORAGE_KEY } from "../chat/storage";
import type { ChatSession } from "../chat/types";
import type { Message } from "../adapters/types";
import {
  CHARACTER_SCALE_BASELINE,
  COMPACT_APPEARANCE_OPTIONS,
  COMPACT_MENU_CLOSE_DELAY_MS,
  CURRENT_MODEL_STORAGE_KEY,
  EXTERNAL_CHAT_ENTRIES,
  MAIN_WINDOW_LABEL,
} from "../app/constants";
import type { BasicSettings, CompactReply, PetThoughtState } from "../app/types";
import { PET_WINDOW_DECORATION_MARGIN_TOP, PET_WINDOW_NATIVE_TOP_LIMIT, PET_WINDOW_TOP_OVERSCROLL } from "../app/pets/codexPetSizing";
import type { CompactAppearance } from "./useCompactWindowState";
import {
  clampCharacterScale,
  type CompactAppearance as CompactAppearanceType,
} from "./useCompactWindowState";
import {
  getMonitorForCursor,
  getCompactWindowSize,
  getPetCompactMenuViewport,
  getPetThoughtAnchorOffset,
  getStoredCompactPosition,
  ensurePetThoughtWindow,
  PET_THOUGHT_WINDOW_SIZE,
  type PetThoughtPlacement,
  isCharacterPointerInHitArea,
  moveCompactWindowToMonitor,
  openInternalChatWindow,
  persistCompactPosition,
  showSettingsWindow,
} from "../app/window";
import { PET_THOUGHT_WINDOW_LABEL } from "../app/constants";
import {
  resolvePetMenuAnchorX,
  resolvePetMenuAnchorY,
  resolvePetMenuViewportOffset,
  resolveCompactMenuPositionFromViewport,
  resolveCompactMenuSidesFromSpace,
} from "./compactMenuGeometry";
import {
  clearPendingDragTimer,
  isNoDragTarget,
  shouldCloseCharacterReplyPanel,
} from "./compactInteractionGuards";

function getSafeCurrentWindow() {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

const appWindow = getSafeCurrentWindow() as ReturnType<typeof getCurrentWindow>;

function toNativePetWindowY(visualY: number) {
  // 宠物本体贴到屏幕最上方时，窗口顶边本来就要向上超出一个装饰边距；
  // 气泡/菜单把视口撑大后还要再往上超一个视口偏移，所以这里只保留防御性下限，
  // 真正的上边界由拖动逻辑按「宠物视觉顶边」计算。
  return Math.max(PET_WINDOW_NATIVE_TOP_LIMIT, Math.round(visualY - PET_WINDOW_DECORATION_MARGIN_TOP));
}

function toVisualPetWindowY(nativeY: number) {
  return Math.round(nativeY + PET_WINDOW_DECORATION_MARGIN_TOP);
}

const PET_THOUGHT_SCREEN_MARGIN = 12;
const PET_THOUGHT_POSITION_EPSILON = 2;
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
const PET_THOUGHT_COLLAPSE_HIDE_DELAY_MS = 170;
const COMPACT_FOLLOW_CURSOR_SCREEN_INTERVAL_MS = 220;

type CharacterDragPosition = { x: number; y: number };

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function waitForNextAnimationFrame() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function deferToAfterWindowMoveSettles(callback: () => void) {
  window.setTimeout(callback, 120);
}

function getLogicalMonitorWorkArea(monitor: Monitor) {
  const scale = monitor.scaleFactor || 1;
  return {
    left: monitor.workArea.position.x / scale,
    top: monitor.workArea.position.y / scale,
    width: monitor.workArea.size.width / scale,
    height: monitor.workArea.size.height / scale,
  };
}

function resolvePetThoughtWindowLayout(
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

function resolveCharacterDragMotion(
  deltaX: number,
  deltaY: number
): "running-left" | "running-right" | "running" {
  const horizontalDominant = Math.abs(deltaX) >= Math.abs(deltaY) * 0.7;
  if (!horizontalDominant) {
    return "running";
  }
  return deltaX < 0 ? "running-left" : "running-right";
}

type UseCompactWindowControllerArgs = {
  basicSettings: BasicSettings;
  characterScale: number;
  closeCompactMenuPanels: () => void;
  closeCompactMenus: () => void;
  compactAppearance: CompactAppearance;
  compactMenuSide: "left" | "right";
  compactSubmenuSide: "left" | "right";
  compactQuery: string;
  compactReply: CompactReply | null;
  compactSize: { width: number; height: number };
  compactViewportSize: { width: number; height: number } | null;
  petThought: PetThoughtState | null;
  petThoughtQueue: PetThoughtState[];
  petThoughtCount: number;
  petThoughtPlacement: PetThoughtPlacement;
  arePetThoughtsCollapsed: boolean;
  currentModel: string;
  isCompactAppearanceOpen: boolean;
  isCompactMenuOpen: boolean;
  isCompactModelOpen: boolean;
  isCompactQueryOpen: boolean;
  isCompactReplyLoading: boolean;
  isCompactWindow: boolean;
  onRestoreMain: (focusInput?: boolean, options?: { restoreGeometry?: boolean }) => Promise<void>;
  resetCompactFloatingUi: () => void;
  setCharacterMenuPosition: React.Dispatch<React.SetStateAction<{ x: number; y: number } | null>>;
  setCharacterScale: React.Dispatch<React.SetStateAction<number>>;
  setCompactAppearance: React.Dispatch<React.SetStateAction<CompactAppearance>>;
  setCompactQuery: React.Dispatch<React.SetStateAction<string>>;
  setCompactReply: React.Dispatch<React.SetStateAction<CompactReply | null>>;
  setCompactMenuSide: React.Dispatch<React.SetStateAction<"left" | "right">>;
  setCompactSubmenuSide: React.Dispatch<React.SetStateAction<"left" | "right">>;
  setCurrentModel: React.Dispatch<React.SetStateAction<string>>;
  setIsCompactAppearanceOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsCompactMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsCompactModelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsCompactQueryOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsCompactReplyLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setPetThoughtPlacement: React.Dispatch<React.SetStateAction<PetThoughtPlacement>>;
  // 宠物窗口对话接入共享的持久化会话 store（useChatSessions），使宠物对话重启后不丢失、
  // 并出现在工作台的话题列表中。
  chatSessions: ChatSession[];
  activeProjectId: string;
  createSessionFromMessages: (messages: Message[], projectId?: string) => ChatSession;
  updateChatSessionMessages: (
    sessionId: string,
    nextMessages: Message[] | ((current: Message[]) => Message[])
  ) => void;
};

export function useCompactWindowController({
  basicSettings,
  characterScale,
  closeCompactMenuPanels,
  closeCompactMenus,
  compactAppearance,
  compactMenuSide,
  compactSubmenuSide,
  compactQuery,
  compactReply,
  compactSize,
  compactViewportSize,
  petThought,
  petThoughtQueue,
  petThoughtCount,
  petThoughtPlacement,
  arePetThoughtsCollapsed,
  currentModel,
  isCompactAppearanceOpen,
  isCompactMenuOpen,
  isCompactModelOpen,
  isCompactQueryOpen,
  isCompactReplyLoading,
  isCompactWindow,
  onRestoreMain,
  resetCompactFloatingUi,
  setCharacterMenuPosition,
  setCharacterScale,
  setCompactAppearance,
  setCompactQuery,
  setCompactReply,
  setCompactMenuSide,
  setCompactSubmenuSide,
  setCurrentModel,
  setIsCompactAppearanceOpen,
  setIsCompactMenuOpen,
  setIsCompactModelOpen,
  setIsCompactQueryOpen,
  setIsCompactReplyLoading,
  setPetThoughtPlacement,
  chatSessions,
  activeProjectId,
  createSessionFromMessages,
  updateChatSessionMessages,
}: UseCompactWindowControllerArgs) {
  const PET_CLICK_DRAG_THRESHOLD_PX = 4;
  const PET_CLICK_SUPPRESS_AFTER_DRAG_MS = 320;
  const PET_DRAG_MOTION_SWITCH_PX = 9;
  const PET_DRAG_VERTICAL_SWITCH_PX = 12;
  const [isCharacterDragging, setIsCharacterDragging] = useState(false);
  const [characterDragMotion, setCharacterDragMotion] = useState<"running-left" | "running-right" | "running" | null>(null);
  const [previewCharacterScale, setPreviewCharacterScale] = useState<number | null>(null);
  const [scaleGestureVersion, setScaleGestureVersion] = useState(0);
  // 已提交的宠物视口偏移。它只在窗口几何（位置/大小）更新完成后才追上目标值，
  // 避免 "CSS offset 已同步应用、但 Tauri setPosition 还是异步" 导致的那一帧跳变
  // （菜单展开/收起时宠物闪烁移动的根因）。
  const [committedPetOffset, setCommittedPetOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const hasPetThought = Boolean(petThought);
  const compactMenuCloseTimerRef = useRef<number | null>(null);
  const compactMenuOpeningRef = useRef(false);
  const isCharacterDraggingRef = useRef(false);
  const characterPointerDownRef = useRef<{ screenX: number; screenY: number } | null>(null);
  const characterDragOriginRef = useRef<{
    screenX: number;
    screenY: number;
    windowX: number;
    windowY: number;
    petViewportOffsetY: number;
  } | null>(null);
  const characterDragRafRef = useRef<number | null>(null);
  const characterDragPendingRef = useRef<CharacterDragPosition | null>(null);
  const characterDragMoveDrainRef = useRef<Promise<void> | null>(null);
  const characterDragWindowMoveActiveRef = useRef(false);
  const characterDragLastTargetRef = useRef<CharacterDragPosition | null>(null);
  const characterDragLastPersistedRef = useRef<CharacterDragPosition | null>(null);
  const characterPointerMovedRef = useRef(false);
  const lastCharacterDragPointerRef = useRef<{ screenX: number; screenY: number } | null>(null);
  const characterDragLastHandledPointerRef = useRef<{ screenX: number; screenY: number } | null>(null);
  const characterDragMotionAccumRef = useRef({ x: 0, y: 0 });
  const characterDragMotionRef = useRef<"running-left" | "running-right" | "running" | null>(null);
  const scaleWheelTimerRef = useRef<number | null>(null);
  const scaleGestureScaleRef = useRef<number | null>(null);
  const scaleGestureSequenceRef = useRef(0);
  const isScaleGestureActiveRef = useRef(false);
  const petThoughtPlacementRef = useRef<PetThoughtPlacement>(petThoughtPlacement);
  const petThoughtStateRef = useRef<PetThoughtState | null>(petThought);
  const petThoughtQueueRef = useRef<PetThoughtState[]>(petThoughtQueue);
  const petThoughtCountRef = useRef<number>(petThoughtCount);
  // 宠物窗口当前正在使用的持久化会话（与工作台共享 useChatSessions store）。
  const activePetSessionIdRef = useRef<string | null>(null);
  const petSessionMessagesRef = useRef<Message[]>([]);
  const petThoughtLayoutRequestRef = useRef(0);
  const lastPetThoughtWindowLayoutRef = useRef<{
    x: number;
    y: number;
    height: number;
    anchorX: number;
    anchorY: number;
    badgeAnchorX: number;
    badgeAnchorY: number;
    placement: PetThoughtPlacement;
  } | null>(null);
  const wasCompactMenuOpenRef = useRef(isCompactMenuOpen);
  const suppressPetClickUntilRef = useRef(0);
  const compactFollowMonitorRef = useRef<string | null>(null);
  const compactFollowMonitorSnapshotRef = useRef<Monitor | null>(null);
  const compactFollowSyncRunningRef = useRef(false);
  const compactInternalMoveRef = useRef(false);
  const compactInteractionUntilRef = useRef(0);
  const compactSuppressBlurUntilRef = useRef(0);
  const lastAppliedCompactSizeRef = useRef<{ width: number; height: number } | null>(null);
  const lastAppliedPetViewportOffsetRef = useRef({ x: 0, y: 0 });
  // 上一次真正应用的「宠物本体尺寸」（不含气泡预留空间）。
  // 以宠物中心为锚点调整窗口位置时，必须用宠物尺寸而不是窗口尺寸：
  // 想法气泡存在时窗口被撑大、宠物被 offset 推离窗口中心，两者并不相等。
  const lastAppliedPetSizeRef = useRef<{ width: number; height: number } | null>(null);
  const petThoughtCollapseHideTimerRef = useRef<number | null>(null);
  const petThoughtCollapseHideVersionRef = useRef(0);

  const setCharacterDragMotionFromPointer = useCallback(
    (
      pointerScreenX: number,
      pointerScreenY: number,
      fallbackMotion: "running-left" | "running-right" | "running" = "running"
    ) => {
      const previousPointer = lastCharacterDragPointerRef.current;
      lastCharacterDragPointerRef.current = { screenX: pointerScreenX, screenY: pointerScreenY };

      let nextMotion: "running-left" | "running-right" | "running" = fallbackMotion;
      if (previousPointer) {
        const instantDeltaX = pointerScreenX - previousPointer.screenX;
        const instantDeltaY = pointerScreenY - previousPointer.screenY;
        characterDragMotionAccumRef.current = {
          x: characterDragMotionAccumRef.current.x + instantDeltaX,
          y: characterDragMotionAccumRef.current.y + instantDeltaY,
        };
        const accumulatedX = characterDragMotionAccumRef.current.x;
        const accumulatedY = characterDragMotionAccumRef.current.y;

        if (Math.abs(accumulatedX) >= PET_DRAG_MOTION_SWITCH_PX) {
          nextMotion = accumulatedX < 0 ? "running-left" : "running-right";
          characterDragMotionAccumRef.current = { x: 0, y: 0 };
        } else if (Math.abs(accumulatedY) >= PET_DRAG_VERTICAL_SWITCH_PX && Math.abs(accumulatedY) > Math.abs(accumulatedX) * 1.35) {
          nextMotion = "running";
          characterDragMotionAccumRef.current = { x: 0, y: 0 };
        } else if (characterDragMotionRef.current) {
          nextMotion = characterDragMotionRef.current;
        }
      }

      if (characterDragMotionRef.current !== nextMotion) {
        characterDragMotionRef.current = nextMotion;
        setCharacterDragMotion(nextMotion);
      }
    },
    []
  );

  useEffect(() => {
    petThoughtPlacementRef.current = petThoughtPlacement;
  }, [petThoughtPlacement]);

  useEffect(() => {
    petThoughtStateRef.current = petThought;
  }, [petThought]);

  useEffect(() => {
    petThoughtQueueRef.current = petThoughtQueue;
  }, [petThoughtQueue]);

  useEffect(() => {
    petThoughtCountRef.current = petThoughtCount;
  }, [petThoughtCount]);

  const updatePetThoughtWindowForRect = useCallback(
    async (petRect: { left: number; top: number; width: number; height: number }) => {
      if (!isCompactWindow) {
        return;
      }
      const requestId = ++petThoughtLayoutRequestRef.current;
      const isLatestRequest = () => requestId === petThoughtLayoutRequestRef.current;

      const currentThought = petThoughtStateRef.current;
      const currentQueue = petThoughtQueueRef.current;
      const hasThoughtQueue = currentQueue.length > 0;
      const shouldResolveThoughtLayout =
        compactAppearance === "pet" &&
        (hasThoughtQueue || Boolean(currentThought)) &&
        !arePetThoughtsCollapsed &&
        !isCharacterDraggingRef.current &&
        !isCompactMenuOpen &&
        !isCompactQueryOpen &&
        !isCompactReplyLoading &&
        !compactReply;
      const shouldUseDetachedThoughtWindow = false;
      const shouldShowThoughtWindow =
        shouldUseDetachedThoughtWindow &&
        shouldResolveThoughtLayout;
      if (!shouldShowThoughtWindow) {
        if (shouldResolveThoughtLayout) {
          const scaleFactor = await appWindow.scaleFactor();
          let monitor =
            (await monitorFromPoint(
              Math.round((petRect.left + petRect.width / 2) * scaleFactor),
              Math.round((petRect.top + petRect.height / 2) * scaleFactor)
            ).catch(() => null)) ?? (await currentMonitor().catch(() => null));
          if (!monitor) {
            const monitors = await availableMonitors().catch(() => []);
            monitor = monitors[0] ?? null;
          }
          if (!isLatestRequest()) {
            return;
          }
          if (monitor) {
            const resolvedThoughtCount = Math.max(currentQueue.length, currentThought ? 1 : 0, petThoughtCountRef.current);
            const layout = resolvePetThoughtWindowLayout(petRect, monitor, resolvedThoughtCount);
            if (layout.placement !== petThoughtPlacementRef.current) {
              petThoughtPlacementRef.current = layout.placement;
              setPetThoughtPlacement(layout.placement);
            }
          }
        }
        const thoughtWindow = await WebviewWindow.getByLabel(PET_THOUGHT_WINDOW_LABEL);
        if (!isLatestRequest()) {
          return;
        }
        if (!thoughtWindow) {
          return;
        }

        if (petThoughtCollapseHideTimerRef.current !== null) {
          window.clearTimeout(petThoughtCollapseHideTimerRef.current);
          petThoughtCollapseHideTimerRef.current = null;
        }

        if (arePetThoughtsCollapsed) {
          petThoughtCollapseHideVersionRef.current += 1;
          const actionVersion = petThoughtCollapseHideVersionRef.current;
          petThoughtCollapseHideTimerRef.current = window.setTimeout(() => {
            if (petThoughtCollapseHideVersionRef.current !== actionVersion) {
              return;
            }
            void thoughtWindow.setIgnoreCursorEvents(true).catch(() => undefined);
            void thoughtWindow.hide().catch(() => undefined);
            petThoughtCollapseHideTimerRef.current = null;
          }, PET_THOUGHT_COLLAPSE_HIDE_DELAY_MS);
          return;
        }

        petThoughtCollapseHideVersionRef.current += 1;
        if (!isLatestRequest()) {
          return;
        }
        await thoughtWindow.setIgnoreCursorEvents(true).catch(() => undefined);
        await thoughtWindow.hide().catch(() => undefined);
        return;
      }

      petThoughtCollapseHideVersionRef.current += 1;
      if (petThoughtCollapseHideTimerRef.current !== null) {
        window.clearTimeout(petThoughtCollapseHideTimerRef.current);
        petThoughtCollapseHideTimerRef.current = null;
      }

      const thoughtWindow = await ensurePetThoughtWindow();
      if (!isLatestRequest()) {
        return;
      }
      const scaleFactor = await appWindow.scaleFactor();
      let monitor =
        (await monitorFromPoint(
          Math.round((petRect.left + petRect.width / 2) * scaleFactor),
          Math.round((petRect.top + petRect.height / 2) * scaleFactor)
        ).catch(() => null)) ?? (await currentMonitor().catch(() => null));
      if (!monitor) {
        const monitors = await availableMonitors().catch(() => []);
        monitor = monitors[0] ?? null;
      }
      if (!isLatestRequest()) {
        return;
      }
      if (!monitor) {
        return;
      }

      const resolvedThoughtCount = Math.max(currentQueue.length, currentThought ? 1 : 0, petThoughtCountRef.current);
      const layout = resolvePetThoughtWindowLayout(petRect, monitor, resolvedThoughtCount);
      if (layout.placement !== petThoughtPlacementRef.current) {
        petThoughtPlacementRef.current = layout.placement;
        setPetThoughtPlacement(layout.placement);
      }
      const previousLayout = lastPetThoughtWindowLayoutRef.current;
      const shouldMove =
        !previousLayout ||
        Math.abs(previousLayout.x - layout.position.x) > PET_THOUGHT_POSITION_EPSILON ||
        Math.abs(previousLayout.y - layout.position.y) > PET_THOUGHT_POSITION_EPSILON;
      if (!isLatestRequest()) {
        return;
      }
      await Promise.all([
        shouldMove
          ? thoughtWindow.setPosition(new LogicalPosition(layout.position.x, layout.position.y))
          : Promise.resolve(),
        thoughtWindow.setSize(new LogicalSize(PET_THOUGHT_WINDOW_SIZE.width, layout.size.height)).catch(() => undefined),
      ]);
      // Always sync placement when the thought window is shown.
      // The thought webview can be recreated independently and lose in-memory anchor state.
      if (!isLatestRequest()) {
        return;
      }
      const synchronizedQueue = currentQueue.length > 0 ? currentQueue : currentThought ? [currentThought] : [];
      await emitTo(PET_THOUGHT_WINDOW_LABEL, "omni-pet-thought-queue-changed", synchronizedQueue).catch(() => undefined);
      if (!isLatestRequest()) {
        return;
      }
      await thoughtWindow.emit("omni-pet-thought-placement", {
        placement: layout.placement,
        anchor: layout.anchor,
        badgeAnchor: layout.badgeAnchor,
      });
      lastPetThoughtWindowLayoutRef.current = {
        x: layout.position.x,
        y: layout.position.y,
        height: layout.size.height,
        anchorX: layout.anchor.x,
        anchorY: layout.anchor.y,
        badgeAnchorX: layout.badgeAnchor.x,
        badgeAnchorY: layout.badgeAnchor.y,
        placement: layout.placement,
      };
      if (!isLatestRequest()) {
        return;
      }
      await thoughtWindow.show();
      await thoughtWindow.setIgnoreCursorEvents(true).catch(() => undefined);
      await thoughtWindow.setAlwaysOnTop(true).catch(() => undefined);
      // Some platforms may transiently lose click-through right after show.
      // Re-apply once on the next tick to keep pet interactions responsive.
      window.setTimeout(() => {
        void thoughtWindow.setIgnoreCursorEvents(true).catch(() => undefined);
      }, 0);
    },
    [
      compactAppearance,
      compactReply,
      arePetThoughtsCollapsed,
      isCompactMenuOpen,
      isCompactQueryOpen,
      isCompactReplyLoading,
      isCompactWindow,
      setPetThoughtPlacement,
    ]
  );

  const updatePetThoughtWindowForCurrentPositionAndSize = useCallback(async (size: { width: number; height: number }) => {
    const scaleFactor = await appWindow.scaleFactor();
    const position = (await appWindow.outerPosition()).toLogical(scaleFactor);
    await updatePetThoughtWindowForRect({
      left: Math.round(position.x),
      top: toVisualPetWindowY(position.y),
      width: size.width,
      height: size.height,
    });
  }, [updatePetThoughtWindowForRect]);

  const updatePetThoughtWindowFromCurrentPosition = useCallback(async () => {
    await updatePetThoughtWindowForCurrentPositionAndSize(compactSize);
  }, [compactSize, updatePetThoughtWindowForCurrentPositionAndSize]);

  const hidePetThoughtWindowForDrag = useCallback(async () => {
    petThoughtLayoutRequestRef.current += 1;
    const thoughtWindow = await WebviewWindow.getByLabel(PET_THOUGHT_WINDOW_LABEL);
    await thoughtWindow?.hide().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!isCompactWindow) {
      return;
    }

    let cancelled = false;
    void (async () => {
      if (cancelled) {
        return;
      }
      await updatePetThoughtWindowFromCurrentPosition();
    })().catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [
    compactAppearance,
    compactReply,
    arePetThoughtsCollapsed,
    compactSize.height,
    compactSize.width,
    hasPetThought,
    isCompactMenuOpen,
    isCompactQueryOpen,
    isCompactReplyLoading,
    isCompactWindow,
    updatePetThoughtWindowFromCurrentPosition,
  ]);

  useEffect(() => {
    if (!isCompactWindow || petThoughtCount <= 0 || arePetThoughtsCollapsed) {
      return;
    }
    if (
      compactAppearance !== "pet" ||
      isCompactMenuOpen ||
      isCompactQueryOpen ||
      isCompactReplyLoading ||
      compactReply
    ) {
      return;
    }

    let cancelled = false;
    void (async () => {
      if (cancelled) {
        return;
      }
      await updatePetThoughtWindowFromCurrentPosition();
    })().catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [
    arePetThoughtsCollapsed,
    compactAppearance,
    compactReply,
    compactSize.height,
    compactSize.width,
    isCompactMenuOpen,
    isCompactQueryOpen,
    isCompactReplyLoading,
    isCompactWindow,
    petThoughtCount,
    updatePetThoughtWindowFromCurrentPosition,
  ]);

  useEffect(() => {
    if (
      !isCompactWindow ||
      petThoughtCount <= 0 ||
      arePetThoughtsCollapsed ||
      compactAppearance !== "pet" ||
      isCompactMenuOpen ||
      isCompactQueryOpen ||
      isCompactReplyLoading ||
      compactReply
    ) {
      return;
    }

    const timers = [80, 260, 620].map((delayMs) =>
      window.setTimeout(() => {
        if (isCharacterDraggingRef.current) {
          return;
        }
        void updatePetThoughtWindowFromCurrentPosition().catch(() => undefined);
      }, delayMs)
    );

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [
    arePetThoughtsCollapsed,
    compactAppearance,
    compactReply,
    isCompactMenuOpen,
    isCompactQueryOpen,
    isCompactReplyLoading,
    isCompactWindow,
    petThoughtCount,
    updatePetThoughtWindowFromCurrentPosition,
  ]);

  useEffect(() => {
    return () => {
      petThoughtCollapseHideVersionRef.current += 1;
      if (petThoughtCollapseHideTimerRef.current !== null) {
        window.clearTimeout(petThoughtCollapseHideTimerRef.current);
        petThoughtCollapseHideTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!isCompactWindow) {
      return;
    }

    return () => {
      void WebviewWindow.getByLabel(PET_THOUGHT_WINDOW_LABEL).then((thoughtWindow) => {
        void thoughtWindow?.hide().catch(() => undefined);
      });
    };
  }, [isCompactWindow]);

  useEffect(() => {
    if (!isCompactWindow) {
      return;
    }

    let unlisten: (() => void) | undefined;
    void listen("omni-pet-thought-window-ready", () => {
      void updatePetThoughtWindowFromCurrentPosition().catch(() => undefined);
    }).then((cleanup) => {
      unlisten = cleanup;
    });

    return () => {
      unlisten?.();
    };
  }, [isCompactWindow, updatePetThoughtWindowFromCurrentPosition]);

  useEffect(() => {
    const previousMenuOpen = wasCompactMenuOpenRef.current;
    wasCompactMenuOpenRef.current = isCompactMenuOpen;

    if (
      compactAppearance !== "pet" ||
      !hasPetThought ||
      isCompactMenuOpen ||
      isCompactQueryOpen ||
      isCompactReplyLoading ||
      compactReply
    ) {
      return;
    }

    void (async () => {
      if (previousMenuOpen !== isCompactMenuOpen) {
        return;
      }
      const scaleFactor = await appWindow.scaleFactor();
      const position = (await appWindow.outerPosition()).toLogical(scaleFactor);
      await updatePetThoughtWindowForRect({
        left: Math.round(position.x),
        top: toVisualPetWindowY(position.y),
        width: compactSize.width,
        height: compactSize.height,
      });
    })();
  }, [
    compactAppearance,
    compactReply,
    compactSize.height,
    compactSize.width,
    isCompactMenuOpen,
    isCompactQueryOpen,
    isCompactReplyLoading,
    hasPetThought,
    updatePetThoughtWindowForRect,
  ]);

  useEffect(() => {
    if (!isCompactWindow) {
      return;
    }

    let unlisten: (() => void) | undefined;
    void listen<{ modelId?: string }>("omni-model-changed", (event) => {
      void (async () => {
        await loadProviderConfigs();
        const resolvedModel = resolveCurrentModelId({
          savedModelId: event.payload?.modelId ?? readSqliteBackedValue(CURRENT_MODEL_STORAGE_KEY),
          registryModelId: modelRegistry.getCurrentModel(),
          availableModels: modelRegistry.getAvailableModels(),
        });
        setCurrentModel(resolvedModel);
      })();
    }).then((cleanup) => {
      unlisten = cleanup;
    });

    return () => {
      unlisten?.();
    };
  }, [isCompactWindow, setCurrentModel]);

  useEffect(() => {
    if (!isCompactWindow) {
      return;
    }

    let unlisten: (() => void) | undefined;
    void listen("omni-usage-preferences-changed", () => {
      void bootstrapSqliteStorage([USAGE_PREFERENCES_STORAGE_KEY]);
    }).then((cleanup) => {
      unlisten = cleanup;
    });

    return () => {
      unlisten?.();
    };
  }, [isCompactWindow]);

  useEffect(() => {
    if (!isCompactWindow) {
      return;
    }

    let unlisten: (() => void) | undefined;
    void listen("omni-knowledge-embedding-profile-changed", () => {
      void loadProviderConfigs();
    }).then((cleanup) => {
      unlisten = cleanup;
    });

    return () => {
      unlisten?.();
    };
  }, [isCompactWindow]);

  const markCompactInteraction = useCallback(() => {
    compactInteractionUntilRef.current = Date.now() + 900;
  }, []);

  const releaseCharacterDragWindowMove = useCallback(() => {
    deferToAfterWindowMoveSettles(() => {
      if (
        !characterPointerDownRef.current &&
        !isCharacterDraggingRef.current &&
        !characterDragPendingRef.current &&
        !characterDragMoveDrainRef.current
      ) {
        characterDragWindowMoveActiveRef.current = false;
        compactInternalMoveRef.current = false;
      }
    });
  }, []);

  const suppressCompactBlur = useCallback((durationMs = 360) => {
    compactSuppressBlurUntilRef.current = Date.now() + durationMs;
  }, []);

  const raiseCompactWindow = useCallback(async () => {
    if (!isCompactWindow) {
      return;
    }

    suppressCompactBlur();
    await appWindow.show();
    try {
      await appWindow.setAlwaysOnTop(true);
    } catch {
      // Ignore z-order refresh failures.
    }
  }, [isCompactWindow, suppressCompactBlur]);

  const resolveCompactMenuSides = useCallback(async (
    anchorX?: number,
    anchorY?: number,
    viewportOverride?: { width: number; height: number },
    anchorXOverride?: number,
    petCompactSize?: { width: number; height: number }
  ) => {
    if (!isCompactWindow) {
      return { menuSide: "right" as const, submenuSide: "right" as const };
    }

    const scaleFactor = await appWindow.scaleFactor();
    const currentPosition = await appWindow.outerPosition();
    const currentSize = await appWindow.outerSize();
    const pointer = Number.isFinite(anchorX) && Number.isFinite(anchorY) ? null : await cursorPosition().catch(() => null);
    const anchorPhysicalX = Number.isFinite(anchorX)
      ? currentPosition.x + Number(anchorX) * scaleFactor
      : pointer
        ? pointer.x
        : currentPosition.x + currentSize.width / 2;
    const anchorPhysicalY = Number.isFinite(anchorY)
      ? currentPosition.y + Number(anchorY) * scaleFactor
      : pointer
        ? pointer.y
        : currentPosition.y + currentSize.height / 2;
    const monitor = (await monitorFromPoint(Math.round(anchorPhysicalX), Math.round(anchorPhysicalY))) ?? (await currentMonitor());
    const monitorScale = monitor?.scaleFactor || scaleFactor || 1;
    const workAreaLeft = monitor ? monitor.workArea.position.x : 0;
    const workAreaRight = monitor
      ? monitor.workArea.position.x + monitor.workArea.size.width
      : Number(window.screen.availWidth || window.screen.width || 0) * monitorScale;
    const leftSpace = Math.max(0, (anchorPhysicalX - workAreaLeft) / monitorScale);
    const rightSpace = Math.max(0, (workAreaRight - anchorPhysicalX) / monitorScale);
    const viewportWidth = viewportOverride?.width ?? compactViewportSize?.width ?? currentSize.width / scaleFactor;
    const viewportAnchorX = typeof anchorXOverride === "number" ? anchorXOverride : Number(anchorX);
    const viewportLeftSpace = Number.isFinite(viewportAnchorX) ? Math.max(0, viewportAnchorX) : undefined;
    const viewportRightSpace = Number.isFinite(viewportAnchorX)
      ? Math.max(0, viewportWidth - viewportAnchorX)
      : undefined;
    return resolveCompactMenuSidesFromSpace(leftSpace, rightSpace, {
      viewportLeftSpace,
      viewportRightSpace,
      petCompactSize,
      petViewportSize: viewportOverride,
    });
  }, [compactViewportSize, isCompactWindow]);

  const resolveCompactMenuPosition = useCallback(
    async (
      anchorX: number,
      anchorY: number,
      side: "left" | "right",
      submenuSide: "left" | "right",
      viewportOverride?: { width: number; height: number }
    ) => {
      const scaleFactor = await appWindow.scaleFactor();
      const windowSize = (await appWindow.outerSize()).toLogical(scaleFactor);
      const viewportWidth = viewportOverride?.width ?? compactViewportSize?.width ?? windowSize.width;
      const viewportHeight = viewportOverride?.height ?? compactViewportSize?.height ?? windowSize.height;
      return resolveCompactMenuPositionFromViewport(anchorX, anchorY, side, submenuSide, viewportWidth, viewportHeight);
    },
    [compactViewportSize]
  );

  useEffect(() => {
    if (!isCompactWindow || basicSettings.showCompactBall) {
      return;
    }

    void appWindow.hide();
  }, [basicSettings.showCompactBall, isCompactWindow]);

  useEffect(() => {
    if (!isCompactWindow || !basicSettings.showCompactBall) {
      return;
    }

    let cancelled = false;
    void (async () => {
      const storedPosition = getStoredCompactPosition();
      if (!storedPosition) {
        return;
      }
      const scaleFactor = await appWindow.scaleFactor();
      const currentPosition = (await appWindow.outerPosition()).toLogical(scaleFactor);
      if (cancelled) {
        return;
      }

      const shouldRestorePosition =
        Math.abs(Math.round(currentPosition.x) - storedPosition.x) > 4 ||
        Math.abs(toVisualPetWindowY(currentPosition.y) - storedPosition.y) > 4;
      if (!shouldRestorePosition) {
        return;
      }

      compactInternalMoveRef.current = true;
      await appWindow.setPosition(new LogicalPosition(storedPosition.x, toNativePetWindowY(storedPosition.y)));
      window.setTimeout(() => {
        compactInternalMoveRef.current = false;
      }, 120);
    })().catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [basicSettings.showCompactBall, isCompactWindow]);

  useEffect(() => {
    if (!isCompactWindow) {
      return;
    }

    const canFollowCursorScreen =
      basicSettings.followCursorScreen &&
      basicSettings.showCompactBall &&
      !isCompactMenuOpen &&
      !isCompactQueryOpen &&
      !isCompactReplyLoading &&
      !compactReply;

    if (!canFollowCursorScreen) {
      if (!basicSettings.followCursorScreen || !basicSettings.showCompactBall) {
        compactFollowMonitorRef.current = null;
        compactFollowMonitorSnapshotRef.current = null;
      }
      return;
    }

    let cancelled = false;
    const syncCompactMonitor = async () => {
      try {
        if (compactFollowSyncRunningRef.current) {
          return;
        }
        compactFollowSyncRunningRef.current = true;

        if (isCharacterDraggingRef.current || characterPointerDownRef.current) {
          return;
        }

        if (Date.now() <= compactInteractionUntilRef.current) {
          return;
        }

        const isVisible = await appWindow.isVisible();
        if (!isVisible) {
          return;
        }

        const monitor = await getMonitorForCursor();
        if (!monitor || cancelled) {
          return;
        }

        const nextMonitorKey = [
          monitor.name ?? "unknown",
          monitor.position.x,
          monitor.position.y,
          monitor.size.width,
          monitor.size.height,
        ].join(":");

        if (nextMonitorKey === compactFollowMonitorRef.current) {
          compactFollowMonitorSnapshotRef.current = monitor;
          return;
        }

        const scaleFactor = await appWindow.scaleFactor();
        const currentPosition = (await appWindow.outerPosition()).toLogical(scaleFactor);
        const currentLogicalPosition = {
          x: Math.round(currentPosition.x),
          y: Math.round(currentPosition.y),
        };
        const previousMonitor = compactFollowMonitorSnapshotRef.current;
        compactInternalMoveRef.current = true;
        try {
          await moveCompactWindowToMonitor(appWindow, monitor, compactSize, {
            sourceMonitor: previousMonitor,
            currentPosition: previousMonitor ? currentLogicalPosition : null,
            persistPosition: false,
          });
          compactFollowMonitorRef.current = nextMonitorKey;
          compactFollowMonitorSnapshotRef.current = monitor;
        } finally {
          window.setTimeout(() => {
            compactInternalMoveRef.current = false;
          }, 120);
        }
      } catch {
        // Ignore monitor sync failures and keep the current compact position.
      } finally {
        compactFollowSyncRunningRef.current = false;
      }
    };

    void syncCompactMonitor();
    const timer = window.setInterval(() => {
      void syncCompactMonitor();
    }, COMPACT_FOLLOW_CURSOR_SCREEN_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    basicSettings.followCursorScreen,
    basicSettings.showCompactBall,
    compactReply,
    compactSize,
    isCompactMenuOpen,
    isCompactQueryOpen,
    isCompactReplyLoading,
    isCompactWindow,
  ]);

  useEffect(() => {
    if (!isCompactWindow) {
      return;
    }

    void raiseCompactWindow();

    let unlisten: (() => void) | undefined;
    void appWindow
      .onFocusChanged(({ payload }) => {
        void appWindow.isVisible().then((isVisible) => {
          if (!isVisible) {
            return;
          }

          if (payload) {
            void raiseCompactWindow();
            return;
          }

          if (Date.now() <= compactSuppressBlurUntilRef.current) {
            return;
          }
          if (isCompactMenuOpen || isCompactQueryOpen || isCompactReplyLoading || compactReply) {
            resetCompactFloatingUi();
          }
        }).catch(() => {
          if (payload) {
            void raiseCompactWindow();
            return;
          }
          if (Date.now() <= compactSuppressBlurUntilRef.current) {
            return;
          }
          if (isCompactMenuOpen || isCompactQueryOpen || isCompactReplyLoading || compactReply) {
            resetCompactFloatingUi();
          }
        });
      })
      .then((fn) => {
        unlisten = fn;
      });

    return () => {
      unlisten?.();
    };
  }, [
    compactReply,
    isCompactMenuOpen,
    isCompactQueryOpen,
    isCompactReplyLoading,
    isCompactWindow,
    raiseCompactWindow,
    resetCompactFloatingUi,
  ]);

  useEffect(() => {
    if (!isCompactWindow || !basicSettings.showCompactBall) {
      return;
    }

    let cancelled = false;
    const ensureTopmost = async () => {
      try {
        if (cancelled || isCharacterDraggingRef.current) {
          return;
        }
        const isVisible = await appWindow.isVisible();
        if (!isVisible) {
          return;
        }
        await appWindow.setAlwaysOnTop(true);
      } catch {
        // Ignore visibility polling failures on platforms that don't support it.
      }
    };

    void ensureTopmost();
    const timer = window.setInterval(() => {
      void ensureTopmost();
    }, 1200);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [basicSettings.showCompactBall, isCompactWindow]);

  useEffect(() => {
    if (!isCompactWindow) {
      return;
    }

    const previewCompactSize =
      compactAppearance === "pet" && typeof previewCharacterScale === "number"
        ? getCompactWindowSize("pet", previewCharacterScale * CHARACTER_SCALE_BASELINE)
        : compactSize;
    const targetSize =
      compactAppearance === "pet" && typeof previewCharacterScale === "number"
        ? previewCompactSize
        : compactAppearance === "pet"
        ? compactViewportSize ?? previewCompactSize
        : compactViewportSize ?? compactSize;
    const isCompactSubmenuOpen = isCompactMenuOpen && (isCompactModelOpen || isCompactAppearanceOpen);
    const shouldReservePetThoughtSpace =
      compactAppearance === "pet" &&
      !previewCharacterScale &&
      (petThoughtCount > 0 || petThoughtQueue.length > 0 || Boolean(petThought)) &&
      !arePetThoughtsCollapsed &&
      !isCompactMenuOpen &&
      !isCompactQueryOpen &&
      !isCompactReplyLoading &&
      !compactReply &&
      Boolean(compactViewportSize);
    const targetPetViewportOffset =
      compactAppearance === "pet" && compactViewportSize
        ? isCompactMenuOpen
          ? resolvePetMenuViewportOffset(compactSize, compactViewportSize, {
              menuSide: compactMenuSide,
              submenuSide: compactSubmenuSide,
            })
          : shouldReservePetThoughtSpace
            ? getPetThoughtAnchorOffset(compactViewportSize, compactSize)
            : { x: 0, y: 0 }
        : { x: 0, y: 0 };
    void (async () => {
      const scaleFactor = await appWindow.scaleFactor();
      const currentPosition = (await appWindow.outerPosition()).toLogical(scaleFactor);
      const currentSize = (await appWindow.outerSize()).toLogical(scaleFactor);
      suppressCompactBlur();
      if (compactAppearance === "pet") {
        const hasSizeChanged =
          !lastAppliedCompactSizeRef.current ||
          Math.round(lastAppliedCompactSizeRef.current.width) !== Math.round(targetSize.width) ||
          Math.round(lastAppliedCompactSizeRef.current.height) !== Math.round(targetSize.height);
        const currentSizeChanged =
          Math.round(currentSize.width) !== Math.round(targetSize.width) ||
          Math.round(currentSize.height) !== Math.round(targetSize.height);
        const previousPetViewportOffset = lastAppliedPetViewportOffsetRef.current;
        const hasPetViewportOffsetChanged =
          previousPetViewportOffset.x !== targetPetViewportOffset.x ||
          previousPetViewportOffset.y !== targetPetViewportOffset.y;
        if (hasSizeChanged || currentSizeChanged || hasPetViewportOffsetChanged) {
          // 以「宠物中心」为锚点：宠物中心在窗口内 = viewportOffset + 宠物本体尺寸/2。
          // 注意必须用宠物尺寸，不能用窗口尺寸——想法气泡存在时窗口被撑大、
          // 宠物被 offset 推离窗口中心，两者不相等，用窗口尺寸会让宠物上下乱跳。
          const previousPetSize = lastAppliedPetSizeRef.current ?? compactSize;
          const prevCenterX = previousPetViewportOffset.x + previousPetSize.width / 2;
          const prevCenterY = previousPetViewportOffset.y + previousPetSize.height / 2;
          const nextCenterX = targetPetViewportOffset.x + previewCompactSize.width / 2;
          const nextCenterY = targetPetViewportOffset.y + previewCompactSize.height / 2;
          const nextX = Math.round(currentPosition.x + prevCenterX - nextCenterX);
          const nextVisualY = toVisualPetWindowY(currentPosition.y) + prevCenterY - nextCenterY;
          compactInternalMoveRef.current = true;
          await Promise.all([
            appWindow.setPosition(new LogicalPosition(nextX, toNativePetWindowY(nextVisualY))),
            appWindow.setSize(new LogicalSize(targetSize.width, targetSize.height)),
            updatePetThoughtWindowForCurrentPositionAndSize(targetSize),
          ]);
          window.setTimeout(() => {
            compactInternalMoveRef.current = false;
          }, 120);
          lastAppliedCompactSizeRef.current = { ...targetSize };
          lastAppliedPetSizeRef.current = { ...previewCompactSize };
          lastAppliedPetViewportOffsetRef.current = targetPetViewportOffset;
          setCommittedPetOffset(targetPetViewportOffset);
        }
        return;
      }

      if (compactMenuSide === "left" || (isCompactSubmenuOpen && compactSubmenuSide === "left")) {
        const nextX = Math.round(currentPosition.x + currentSize.width - targetSize.width);
        if (nextX !== Math.round(currentPosition.x)) {
          compactInternalMoveRef.current = true;
          await appWindow.setPosition(new LogicalPosition(nextX, Math.round(currentPosition.y)));
          window.setTimeout(() => {
            compactInternalMoveRef.current = false;
          }, 120);
        }
      }
      await appWindow.setSize(new LogicalSize(targetSize.width, targetSize.height));
      await appWindow.setAlwaysOnTop(true);
    })();
  }, [
    compactReply,
    compactSize,
    compactViewportSize,
    compactMenuSide,
    compactSubmenuSide,
    compactAppearance,
    previewCharacterScale,
    isCompactAppearanceOpen,
    isCompactMenuOpen,
    isCompactModelOpen,
    isCompactQueryOpen,
    isCompactReplyLoading,
    isCompactWindow,
    arePetThoughtsCollapsed,
    petThought,
    petThoughtCount,
    petThoughtQueue.length,
    petThoughtPlacement,
    scaleGestureVersion,
    suppressCompactBlur,
    updatePetThoughtWindowForCurrentPositionAndSize,
  ]);

  useEffect(() => {
    if (!isCompactWindow) {
      return;
    }

    let unlisten: (() => void) | undefined;
    void appWindow
      .onMoved(async (event) => {
        if (isCharacterDraggingRef.current) {
          return;
        }
        if (characterDragWindowMoveActiveRef.current) {
          return;
        }
        const scaleFactor = await appWindow.scaleFactor();
        const pos = event.payload.toLogical(scaleFactor);
        const petOffset = lastAppliedPetViewportOffsetRef.current;
        const isPetAppearance = compactAppearance === "pet";
        // 记录「宠物本体」的视觉位置而不是窗口位置：想法气泡/菜单展开时宠物会被
        // --pet-viewport-offset-* 推离窗口左上角，直接记窗口坐标的话，
        // 气泡消失/重启后宠物会整体跑偏。想法气泡窗口同样锚在宠物本体上。
        const visualPos = {
          x: Math.round(pos.x) + (isPetAppearance ? petOffset.x : 0),
          y: isPetAppearance ? toVisualPetWindowY(pos.y) + petOffset.y : Math.round(pos.y),
        };
        if (!compactInternalMoveRef.current) {
          persistCompactPosition(visualPos);
          characterDragLastPersistedRef.current = visualPos;
        }
        await updatePetThoughtWindowForRect({
          left: visualPos.x,
          top: visualPos.y,
          width: compactSize.width,
          height: compactSize.height,
        });
      })
      .then((fn) => {
        unlisten = fn;
      });

    return () => {
      unlisten?.();
    };
  }, [compactAppearance, compactSize.height, compactSize.width, isCompactWindow, updatePetThoughtWindowForRect]);

  useEffect(() => {
    return () => {
      if (compactMenuCloseTimerRef.current !== null) {
        window.clearTimeout(compactMenuCloseTimerRef.current);
      }
      if (characterDragRafRef.current !== null) {
        window.cancelAnimationFrame(characterDragRafRef.current);
        characterDragRafRef.current = null;
      }
      characterDragMoveDrainRef.current = null;
      characterDragWindowMoveActiveRef.current = false;
      characterDragLastTargetRef.current = null;
      if (scaleWheelTimerRef.current !== null) {
        window.clearTimeout(scaleWheelTimerRef.current);
        scaleWheelTimerRef.current = null;
      }
      scaleGestureScaleRef.current = null;
      scaleGestureSequenceRef.current += 1;
      setPreviewCharacterScale(null);
      isScaleGestureActiveRef.current = false;
      lastCharacterDragPointerRef.current = null;
      characterDragLastHandledPointerRef.current = null;
      characterDragMotionAccumRef.current = { x: 0, y: 0 };
      characterDragMotionRef.current = null;
      setCharacterDragMotion(null);
    };
  }, []);

  const flushCharacterDragPosition = useCallback(() => {
    if (characterDragMoveDrainRef.current) {
      return characterDragMoveDrainRef.current;
    }

    if (!characterDragPendingRef.current) {
      return Promise.resolve();
    }

    characterDragWindowMoveActiveRef.current = true;
    compactInternalMoveRef.current = true;
    const drain = (async () => {
      try {
        while (characterDragPendingRef.current) {
          const nextPosition = characterDragPendingRef.current;
          characterDragPendingRef.current = null;
          await appWindow
            .setPosition(new LogicalPosition(Math.round(nextPosition.x), toNativePetWindowY(nextPosition.y)))
            .catch(() => undefined);
          if (characterDragPendingRef.current) {
            await waitForNextAnimationFrame();
          }
        }
      } finally {
        characterDragMoveDrainRef.current = null;
        if (!characterPointerDownRef.current && !isCharacterDraggingRef.current && !characterDragPendingRef.current) {
          releaseCharacterDragWindowMove();
        }
      }
    })();
    characterDragMoveDrainRef.current = drain;
    return drain;
  }, [releaseCharacterDragWindowMove]);

  const scheduleCharacterDragPosition = useCallback((x: number, y: number) => {
    characterDragWindowMoveActiveRef.current = true;
    compactInternalMoveRef.current = true;
    characterDragPendingRef.current = { x, y };
    if (characterDragMoveDrainRef.current) {
      return;
    }
    if (characterDragRafRef.current !== null) {
      return;
    }

    characterDragRafRef.current = window.requestAnimationFrame(() => {
      characterDragRafRef.current = null;
      void flushCharacterDragPosition();
    });
  }, [flushCharacterDragPosition]);

  const continueCharacterDrag = useCallback(
    (pointerScreenX: number, pointerScreenY: number) => {
      const pointerDown = characterPointerDownRef.current;
      if (!pointerDown) {
        return false;
      }

      const deltaX = pointerScreenX - pointerDown.screenX;
      const deltaY = pointerScreenY - pointerDown.screenY;
      const moveDistance = Math.hypot(deltaX, deltaY);
      if (moveDistance < PET_CLICK_DRAG_THRESHOLD_PX) {
        return false;
      }

      const lastHandledPointer = characterDragLastHandledPointerRef.current;
      if (
        lastHandledPointer &&
        lastHandledPointer.screenX === pointerScreenX &&
        lastHandledPointer.screenY === pointerScreenY
      ) {
        return true;
      }
      characterDragLastHandledPointerRef.current = { screenX: pointerScreenX, screenY: pointerScreenY };

      markCompactInteraction();
      characterPointerMovedRef.current = true;
      if (!isCharacterDraggingRef.current) {
        setIsCharacterDragging(true);
        void hidePetThoughtWindowForDrag();
      }
      isCharacterDraggingRef.current = true;
      setCharacterDragMotionFromPointer(pointerScreenX, pointerScreenY, resolveCharacterDragMotion(deltaX, deltaY));

      if (!characterDragOriginRef.current) {
        characterDragOriginRef.current = {
          screenX: pointerDown.screenX,
          screenY: pointerDown.screenY,
          windowX: Number(window.screenX || 0),
          windowY: Number(window.screenY || 0),
          petViewportOffsetY: lastAppliedPetViewportOffsetRef.current.y,
        };
      }

      const origin = characterDragOriginRef.current;
      if (!origin) {
        return false;
      }
      const nextWindowX = origin.windowX + deltaX;
      // origin.windowY 是 Tauri 窗口的 native Y；先转成视觉坐标再叠加拖动偏移。
      // 上边界按「宠物本体的视觉顶边」算：想法气泡/菜单展开时宠物会被
      // --pet-viewport-offset-y 推离窗口顶边，只限制窗口顶边的话，宠物就再也贴不到屏幕最上方。
      const minWindowVisualY = -PET_WINDOW_TOP_OVERSCROLL - origin.petViewportOffsetY;
      const nextWindowY = Math.max(minWindowVisualY, toVisualPetWindowY(origin.windowY) + deltaY);
      characterDragLastTargetRef.current = { x: nextWindowX, y: nextWindowY };
      scheduleCharacterDragPosition(nextWindowX, nextWindowY);
      return true;
    },
    [hidePetThoughtWindowForDrag, markCompactInteraction, scheduleCharacterDragPosition, setCharacterDragMotionFromPointer]
  );

  const cancelCompactMenuClose = useCallback(() => {
    if (compactMenuCloseTimerRef.current !== null) {
      window.clearTimeout(compactMenuCloseTimerRef.current);
      compactMenuCloseTimerRef.current = null;
    }
  }, []);

  const closeCompactMenu = useCallback((delayMs = COMPACT_MENU_CLOSE_DELAY_MS) => {
    if (compactMenuCloseTimerRef.current !== null) {
      return;
    }

    const closeDelay = Math.max(0, delayMs);
    compactMenuCloseTimerRef.current = window.setTimeout(() => {
      closeCompactMenuPanels();
      compactMenuCloseTimerRef.current = null;
    }, closeDelay);
  }, [closeCompactMenuPanels]);

  const closeCompactMenuNow = useCallback(() => {
    if (compactMenuCloseTimerRef.current !== null) {
      window.clearTimeout(compactMenuCloseTimerRef.current);
      compactMenuCloseTimerRef.current = null;
    }
    closeCompactMenuPanels();
  }, [closeCompactMenuPanels]);

  useEffect(() => {
    if (!isCompactWindow || (!isCompactMenuOpen && !isCompactQueryOpen)) {
      return;
    }

    const closeOnBlur = () => {
      if (Date.now() <= compactSuppressBlurUntilRef.current) {
        return;
      }
      closeCompactMenuNow();
    };
    window.addEventListener("blur", closeOnBlur);
    document.addEventListener("visibilitychange", closeOnBlur);
    return () => {
      window.removeEventListener("blur", closeOnBlur);
      document.removeEventListener("visibilitychange", closeOnBlur);
    };
  }, [closeCompactMenuNow, isCompactMenuOpen, isCompactQueryOpen, isCompactWindow]);

  const handleOpenSettingsFromCompact = useCallback(async () => {
    closeCompactMenus();
    await showSettingsWindow();
  }, [closeCompactMenus]);

  const handleOpenCompactQuery = useCallback(async () => {
    suppressCompactBlur();
    closeCompactMenus();
    setIsCompactQueryOpen(true);
  }, [closeCompactMenus, setIsCompactQueryOpen, suppressCompactBlur]);

  const handlePetPrimaryClick = useCallback(async () => {
    suppressCompactBlur();

    if (isCharacterDraggingRef.current || Date.now() <= suppressPetClickUntilRef.current) {
      isCharacterDraggingRef.current = false;
      return;
    }

    const mainWindow = await WebviewWindow.getByLabel(MAIN_WINDOW_LABEL);
    if (!mainWindow) {
      await onRestoreMain(false, { restoreGeometry: false });
      return;
    }

    try {
      const [isVisible, isMinimized] = await Promise.all([
        mainWindow.isVisible(),
        mainWindow.isMinimized(),
      ]);

      if (!isVisible || isMinimized) {
        await onRestoreMain(false, { restoreGeometry: false });
        return;
      }

      await mainWindow.minimize();
      return;

    } catch {
      await onRestoreMain(false, { restoreGeometry: false });
    }
  }, [onRestoreMain, suppressCompactBlur]);

  const handleOpenExternalChat = useCallback(
    async (entry: (typeof EXTERNAL_CHAT_ENTRIES)[number]) => {
      closeCompactMenus();

      if (entry.kind === "main") {
        await onRestoreMain(true);
        return;
      }

      await openInternalChatWindow(entry);
    },
    [closeCompactMenus, onRestoreMain]
  );

  const handleCharacterPointerDown = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      markCompactInteraction();
      if (event.button !== 0) {
        characterPointerDownRef.current = null;
        characterDragOriginRef.current = null;
        characterDragLastTargetRef.current = null;
        characterPointerMovedRef.current = false;
        isCharacterDraggingRef.current = false;
        characterDragWindowMoveActiveRef.current = false;
        compactInternalMoveRef.current = false;
        setIsCharacterDragging(false);
        lastCharacterDragPointerRef.current = null;
        characterDragLastHandledPointerRef.current = null;
        characterDragMotionAccumRef.current = { x: 0, y: 0 };
        characterDragMotionRef.current = null;
        setCharacterDragMotion(null);
        return;
      }

      const isInCharacterHitArea = isCharacterPointerInHitArea(event.currentTarget, event.clientX, event.clientY);
      if (!isInCharacterHitArea) {
        clearPendingDragTimer(compactMenuCloseTimerRef.current);
        compactMenuCloseTimerRef.current = null;
        characterPointerDownRef.current = null;
        characterDragOriginRef.current = null;
        characterDragLastTargetRef.current = null;
        characterPointerMovedRef.current = false;
        characterDragWindowMoveActiveRef.current = false;
        compactInternalMoveRef.current = false;
        setIsCharacterDragging(false);
        lastCharacterDragPointerRef.current = null;
        characterDragLastHandledPointerRef.current = null;
        characterDragMotionAccumRef.current = { x: 0, y: 0 };
        characterDragMotionRef.current = null;
        setCharacterDragMotion(null);
        resetCompactFloatingUi();
        return;
      }

      isCharacterDraggingRef.current = false;
      characterDragLastTargetRef.current = null;
      lastCharacterDragPointerRef.current = null;
      characterDragLastHandledPointerRef.current = null;
      characterDragMotionAccumRef.current = { x: 0, y: 0 };
      characterDragMotionRef.current = null;
      setCharacterDragMotion(null);
      characterPointerDownRef.current = { screenX: event.screenX, screenY: event.screenY };
      characterDragOriginRef.current = null;
      characterPointerMovedRef.current = false;
    },
    [markCompactInteraction, resetCompactFloatingUi]
  );

  const handleCharacterPointerMove = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (continueCharacterDrag(event.screenX, event.screenY)) {
        event.preventDefault();
      }
    },
    [continueCharacterDrag]
  );

  const handleCharacterPointerUp = useCallback(() => {
    const pendingDragPosition = characterDragPendingRef.current ?? characterDragLastTargetRef.current;
    const shouldSuppressPetClick = characterPointerMovedRef.current || isCharacterDraggingRef.current;
    characterPointerDownRef.current = null;
    characterDragOriginRef.current = null;
    characterDragLastTargetRef.current = null;
    isCharacterDraggingRef.current = false;
    if (characterDragRafRef.current !== null) {
      window.cancelAnimationFrame(characterDragRafRef.current);
      characterDragRafRef.current = null;
    }
    if (pendingDragPosition) {
      characterDragPendingRef.current = pendingDragPosition;
      void flushCharacterDragPosition();
    } else {
      characterDragPendingRef.current = null;
    }
    if (pendingDragPosition) {
      const petOffset = lastAppliedPetViewportOffsetRef.current;
      // 与 onMoved 一致：持久化「宠物本体」的视觉位置（窗口位置 + 宠物视口偏移）。
      const finalVisualPosition = {
        x: Math.round(pendingDragPosition.x + petOffset.x),
        y: Math.round(pendingDragPosition.y + petOffset.y),
      };
      const lastPersisted = characterDragLastPersistedRef.current;
      if (!lastPersisted || lastPersisted.x !== finalVisualPosition.x || lastPersisted.y !== finalVisualPosition.y) {
        persistCompactPosition(finalVisualPosition);
        characterDragLastPersistedRef.current = finalVisualPosition;
      }
      void updatePetThoughtWindowForRect({
        left: finalVisualPosition.x,
        top: finalVisualPosition.y,
        width: compactSize.width,
        height: compactSize.height,
      });
    } else {
      void (async () => {
        const scaleFactor = await appWindow.scaleFactor();
        const position = (await appWindow.outerPosition()).toLogical(scaleFactor);
        const petOffset = lastAppliedPetViewportOffsetRef.current;
        const finalVisualPosition = {
          x: Math.round(position.x + petOffset.x),
          y: toVisualPetWindowY(position.y) + petOffset.y,
        };
        const lastPersisted = characterDragLastPersistedRef.current;
        if (!lastPersisted || lastPersisted.x !== finalVisualPosition.x || lastPersisted.y !== finalVisualPosition.y) {
          persistCompactPosition(finalVisualPosition);
          characterDragLastPersistedRef.current = finalVisualPosition;
        }
        await updatePetThoughtWindowForRect({
          left: finalVisualPosition.x,
          top: finalVisualPosition.y,
          width: compactSize.width,
          height: compactSize.height,
        });
      })();
    }
    if (shouldSuppressPetClick) {
      suppressPetClickUntilRef.current = Date.now() + PET_CLICK_SUPPRESS_AFTER_DRAG_MS;
    }
    characterPointerMovedRef.current = false;
    setIsCharacterDragging(false);
    lastCharacterDragPointerRef.current = null;
    characterDragLastHandledPointerRef.current = null;
    characterDragMotionAccumRef.current = { x: 0, y: 0 };
    characterDragMotionRef.current = null;
    setCharacterDragMotion(null);
    if (!pendingDragPosition && !characterDragMoveDrainRef.current) {
      releaseCharacterDragWindowMove();
    }
  }, [compactSize.height, compactSize.width, flushCharacterDragPosition, releaseCharacterDragWindowMove, updatePetThoughtWindowForRect]);

  // Pet-mode window drag.
  //
  // Reuses the SAME JS-driven drag loop the character uses: arming the press by
  // setting characterPointerDownRef makes the always-on window-capture listener
  // (continueCharacterDrag) drive the drag. That loop moves the window via
  // setPosition on every pointer move AND updates characterDragMotion to the
  // running direction, so the webview keeps repainting and the pet's running
  // animation actually plays.
  //
  // A previous version used appWindow.startDragging() (OS-native drag). That
  // freezes the webview for the duration of the drag, so the animation never
  // repaints — the pet looked like it only ever waved. JS-driven drag avoids
  // that. The capture-phase listener also keeps working even when the cursor
  // leaves the (small) pet button, which fixed the earlier "unresponsive drag".
  const handlePetPointerDown = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      markCompactInteraction();
      void raiseCompactWindow();
      if (event.button !== 0) {
        return;
      }
      if (isCharacterDraggingRef.current || characterPointerDownRef.current) {
        return;
      }
      // Arm the shared drag loop. No hit-area check here — any press on the
      // pet body should start a drag.
      characterPointerDownRef.current = { screenX: event.screenX, screenY: event.screenY };
      characterDragOriginRef.current = null;
      characterPointerMovedRef.current = false;
      characterDragLastTargetRef.current = null;
      characterDragLastHandledPointerRef.current = null;
      lastCharacterDragPointerRef.current = null;
      characterDragMotionAccumRef.current = { x: 0, y: 0 };
      characterDragMotionRef.current = null;
      setCharacterDragMotion(null);
      isCharacterDraggingRef.current = false;
      setIsCharacterDragging(false);
      compactInternalMoveRef.current = false;
      characterDragWindowMoveActiveRef.current = false;
    },
    [markCompactInteraction, raiseCompactWindow]
  );

  // Kept for wiring compatibility; the always-on window-capture mouseup
  // listener owns the canonical drag cleanup (handleCharacterPointerUp).
  const handlePetPointerMove = useCallback(() => {}, []);

  // The shared drag loop's window mouseup handler already calls
  // handleCharacterPointerUp, which resets state and persists the position.
  // This is a no-op kept for wiring compatibility.
  const handlePetPointerUp = useCallback(() => {}, []);

  useEffect(() => {
    if (!isCompactWindow) {
      return;
    }

    // Drop any drag state that survived without a matching mouseup (e.g. the
    // release happened outside the webview while dragging the floating pet).
    // Without this, a stuck `characterPointerDownRef` makes every later
    // mousemove silently drag the pet to follow the cursor — it looks like the
    // pet jumps to other positions on its own.
    const resetStaleDragState = () => {
      if (
        !characterPointerDownRef.current &&
        !isCharacterDraggingRef.current &&
        !characterDragPendingRef.current &&
        !characterPointerMovedRef.current
      ) {
        return;
      }
      characterPointerDownRef.current = null;
      characterDragOriginRef.current = null;
      characterDragLastTargetRef.current = null;
      characterPointerMovedRef.current = false;
      isCharacterDraggingRef.current = false;
      characterDragMotionAccumRef.current = { x: 0, y: 0 };
      characterDragMotionRef.current = null;
      lastCharacterDragPointerRef.current = null;
      characterDragLastHandledPointerRef.current = null;
      if (characterDragRafRef.current !== null) {
        window.cancelAnimationFrame(characterDragRafRef.current);
        characterDragRafRef.current = null;
      }
      characterDragPendingRef.current = null;
      characterDragMoveDrainRef.current = null;
      characterDragWindowMoveActiveRef.current = false;
      compactInternalMoveRef.current = false;
      setCharacterDragMotion(null);
    };

    const onWindowMouseMove = (event: MouseEvent) => {
      // Only a real drag (primary button held) may move the pet. If the button
      // is already up, any armed drag is stale — clear it instead of following
      // the cursor.
      if (!(event.buttons & 1)) {
        resetStaleDragState();
        return;
      }
      const consumed = continueCharacterDrag(event.screenX, event.screenY);
      if (consumed) {
        event.preventDefault();
      }
    };

    const onWindowMouseUp = () => {
      if (!characterPointerDownRef.current && !isCharacterDraggingRef.current && !characterPointerMovedRef.current) {
        return;
      }
      handleCharacterPointerUp();
    };

    const onWindowBlur = () => {
      resetStaleDragState();
    };

    window.addEventListener("mousemove", onWindowMouseMove, { capture: true });
    window.addEventListener("mouseup", onWindowMouseUp, { capture: true });
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("mousemove", onWindowMouseMove, { capture: true });
      window.removeEventListener("mouseup", onWindowMouseUp, { capture: true });
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [continueCharacterDrag, handleCharacterPointerUp, isCompactWindow]);

  // 启动后把宠物窗口绑定到上一次的持久化会话：之后在宠物窗口的提问会继续追加到
  // 这个会话（出现在工作台话题列表里），但**不再把上一轮问答回填进回答气泡**——
  // 那样每次启动都会莫名其妙冒出上次的回答。
  useEffect(() => {
    if (activePetSessionIdRef.current !== null) return;
    const target = [...chatSessions]
      .filter((session) => session.projectId === activeProjectId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!target) return;
    const messages = target.messages ?? [];
    petSessionMessagesRef.current = messages;
    activePetSessionIdRef.current = target.id;
  }, [chatSessions, activeProjectId]);

  const handleCompactQuerySubmit = useCallback(
    async (openMain = false) => {
      const draft = compactQuery.trim();
      if (!draft) {
        return;
      }

      await loadProviderConfigs();
      const savedModel = readSqliteBackedValue(CURRENT_MODEL_STORAGE_KEY);
      const resolvedModel = resolveCurrentModelId({
        savedModelId: savedModel,
        registryModelId: modelRegistry.getCurrentModel(),
        availableModels: modelRegistry.getAvailableModels(),
      });
      if (!resolvedModel) {
        return;
      }
      modelRegistry.setCurrentModel(resolvedModel);
      if (resolvedModel !== currentModel) {
        setCurrentModel(resolvedModel);
      }

      if (openMain) {
        await onRestoreMain(true);
        const mainWindow = await WebviewWindow.getByLabel(MAIN_WINDOW_LABEL);
        if (mainWindow) {
          await mainWindow.emit("omni-set-draft", { draft });
        }
        setIsCompactQueryOpen(false);
        setCompactQuery("");
        return;
      }

      try {
        setIsCompactReplyLoading(true);

        let streamedAnswer = "";
        const response = await executeChatTurn({
          model: resolvedModel,
          messages: [{ role: "user", content: draft }],
          onChunk: (chunk) => {
            streamedAnswer += chunk;
          },
        });
        const finalAnswer = response.content || streamedAnswer;

        // 把这一轮问答写入共享持久化 store，使宠物对话重启后不丢失，
        // 并出现在工作台的话题列表中。
        const nextMessages: Message[] = [
          ...petSessionMessagesRef.current,
          { role: "user", content: draft },
          { role: "project", content: finalAnswer },
        ];
        petSessionMessagesRef.current = nextMessages;
        if (activePetSessionIdRef.current) {
          updateChatSessionMessages(activePetSessionIdRef.current, nextMessages);
        } else {
          const session = createSessionFromMessages(nextMessages, activeProjectId);
          activePetSessionIdRef.current = session.id;
        }

        setIsCompactQueryOpen(false);
        setCompactQuery("");
        setIsCompactQueryOpen(false);
        setCompactQuery("");
      } catch (error) {
        // 回答气泡已移除，错误不再显示在宠物窗口；需要时可在工作台查看。
      } finally {
        setIsCompactReplyLoading(false);
      }
    },
    [compactQuery, currentModel, onRestoreMain, setCompactQuery, setCurrentModel, setIsCompactQueryOpen, setIsCompactReplyLoading, activeProjectId, createSessionFromMessages, updateChatSessionMessages]
  );

  const handleCompactWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (compactAppearance !== "pet") {
        return;
      }
      // 鼠标在可滚动面板上滚动时，让面板自己处理滚动，不要缩放宠物。
      const target = event.target;
      if (
        target instanceof Element &&
        (target.closest(".compact-reply") ||
          target.closest(".pet-thought-bubble") ||
          target.closest(".compact-query"))
      ) {
        return;
      }
      markCompactInteraction();
      event.preventDefault();
      if (!isScaleGestureActiveRef.current) {
        isScaleGestureActiveRef.current = true;
        scaleGestureScaleRef.current = null;
      }

      const nextScale = clampCharacterScale(
        (scaleGestureScaleRef.current ?? characterScale) + (event.deltaY < 0 ? 0.08 : -0.08)
      );
      scaleGestureScaleRef.current = nextScale;
      const gestureSequence = (scaleGestureSequenceRef.current += 1);
      const previewSize = getCompactWindowSize("pet", nextScale * CHARACTER_SCALE_BASELINE);
      setPreviewCharacterScale(nextScale);
      void updatePetThoughtWindowForCurrentPositionAndSize(previewSize).catch(() => undefined);
      void (async () => {
        try {
          const scaleFactor = await appWindow.scaleFactor();
          const currentPosition = (await appWindow.outerPosition()).toLogical(scaleFactor);
          // 以「宠物中心」为锚点：想法气泡存在时窗口被撑大、宠物被 offset 推开，
          // 所以要用 offset + 宠物本体尺寸/2 算中心，而不是用窗口尺寸。
          const previousPetSize = lastAppliedPetSizeRef.current ?? compactSize;
          const previousPetViewportOffset = lastAppliedPetViewportOffsetRef.current;
          const prevCenterX = previousPetViewportOffset.x + previousPetSize.width / 2;
          const prevCenterY = previousPetViewportOffset.y + previousPetSize.height / 2;
          const nextX = Math.round(currentPosition.x + prevCenterX - previewSize.width / 2);
          const nextVisualY = toVisualPetWindowY(currentPosition.y) + prevCenterY - previewSize.height / 2;
          await appWindow.setPosition(new LogicalPosition(nextX, toNativePetWindowY(nextVisualY)));
          await appWindow.setSize(new LogicalSize(previewSize.width, previewSize.height));
          lastAppliedCompactSizeRef.current = { ...previewSize };
          lastAppliedPetSizeRef.current = { ...previewSize };
          // 预览缩放期间不预留气泡空间，窗口就是宠物本体，offset 归零。
          lastAppliedPetViewportOffsetRef.current = { x: 0, y: 0 };
        } catch {
          // Fall back to React-driven resizing if the immediate native resize fails.
        }
        if (scaleGestureSequenceRef.current !== gestureSequence || scaleGestureScaleRef.current !== nextScale) {
          return;
        }
        void updatePetThoughtWindowForCurrentPositionAndSize(previewSize).catch(() => undefined);
      })();
      if (scaleWheelTimerRef.current !== null) {
        window.clearTimeout(scaleWheelTimerRef.current);
      }

      scaleWheelTimerRef.current = window.setTimeout(() => {
        scaleWheelTimerRef.current = null;
        const committedScale = scaleGestureScaleRef.current;
        scaleGestureScaleRef.current = null;
        scaleGestureSequenceRef.current += 1;
        setPreviewCharacterScale(null);
        if (typeof committedScale === "number") {
          setCharacterScale(committedScale);
        }
        isScaleGestureActiveRef.current = false;
        setScaleGestureVersion((value) => value + 1);
      }, 120);
    },
    [characterScale, compactAppearance, compactSize, markCompactInteraction, setCharacterScale, updatePetThoughtWindowForCurrentPositionAndSize]
  );

  const handleCompactAppearanceChange = useCallback(
    (appearance: CompactAppearanceType) => {
      setCompactAppearance(appearance);
      closeCompactMenus();
    },
    [closeCompactMenus, setCompactAppearance]
  );

  const handleCompactScaleReset = useCallback(() => {
    scaleGestureScaleRef.current = null;
    setPreviewCharacterScale(null);
    setCharacterScale(1);
    closeCompactMenus();
  }, [closeCompactMenus, setCharacterScale]);

  const handleCompactDrag = useCallback(
    async (event: React.MouseEvent<HTMLDivElement>) => {
      markCompactInteraction();
      void raiseCompactWindow();
      const target = event.target as HTMLElement;
      if (compactAppearance === "pet" && shouldCloseCharacterReplyPanel(target)) {
        setIsCompactQueryOpen(false);
        setCompactReply(null);
      }

      if (isNoDragTarget(target)) {
        return;
      }
      if (event.button === 0) {
        await appWindow.startDragging();
      }
    },
    [
      compactAppearance,
      markCompactInteraction,
      raiseCompactWindow,
      setCompactReply,
      setIsCompactQueryOpen,
    ]
  );

  const openCompactMenu = useCallback(async (anchorClientX?: number, anchorClientY?: number) => {
    markCompactInteraction();
    suppressCompactBlur();
    if (compactMenuCloseTimerRef.current !== null) {
      window.clearTimeout(compactMenuCloseTimerRef.current);
      compactMenuCloseTimerRef.current = null;
    }
    await raiseCompactWindow();
    if (compactMenuOpeningRef.current || isCompactMenuOpen) {
      return;
    }

    compactMenuOpeningRef.current = true;
    try {
      if (isCompactQueryOpen) {
        return;
      }
      const scaleFactor = await appWindow.scaleFactor();
      const windowPosition = (await appWindow.outerPosition()).toLogical(scaleFactor);
      const fallbackSize = await appWindow.outerSize().then((size) => size.toLogical(scaleFactor));
      const pointer = await cursorPosition().catch(() => null);
      const anchorX =
        typeof anchorClientX === "number"
          ? anchorClientX
          : pointer
            ? pointer.x / scaleFactor - windowPosition.x
            : Math.max(0, fallbackSize.width / 2);
      const anchorY =
        typeof anchorClientY === "number"
          ? anchorClientY
          : pointer
            ? pointer.y / scaleFactor - windowPosition.y
            : Math.max(0, fallbackSize.height / 2);
      const petMenuViewport =
        compactAppearance === "pet"
          ? getPetCompactMenuViewport(compactSize)
          : null;
      const { menuSide, submenuSide } = await resolveCompactMenuSides(anchorX, anchorY, petMenuViewport ?? undefined, undefined, compactSize);
      const menuAnchorX = petMenuViewport
        ? resolvePetMenuAnchorX(compactSize, petMenuViewport, { menuSide, submenuSide })
        : anchorX;
      const menuAnchorY = petMenuViewport
        ? resolvePetMenuAnchorY(compactSize, petMenuViewport, anchorY, { menuSide, submenuSide })
        : anchorY;
      setCompactMenuSide(menuSide);
      setCompactSubmenuSide(submenuSide);
      setCharacterMenuPosition(await resolveCompactMenuPosition(menuAnchorX, menuAnchorY, menuSide, submenuSide, petMenuViewport ?? undefined));
      setIsCompactMenuOpen(true);
      setIsCompactModelOpen(false);
      setIsCompactAppearanceOpen(false);
      setIsCompactQueryOpen(false);
    } finally {
      compactMenuOpeningRef.current = false;
    }
  }, [
    resolveCompactMenuSides,
    resolveCompactMenuPosition,
    isCompactMenuOpen,
    isCompactQueryOpen,
    markCompactInteraction,
    raiseCompactWindow,
    suppressCompactBlur,
    setIsCompactAppearanceOpen,
    setIsCompactMenuOpen,
    setIsCompactModelOpen,
    setCompactMenuSide,
    setCompactSubmenuSide,
    setIsCompactQueryOpen,
  ]);

  const handleCharacterContextMenu = useCallback(
    async (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      suppressCompactBlur();
      isCharacterDraggingRef.current = false;
      setIsCharacterDragging(false);
      lastCharacterDragPointerRef.current = null;
      characterDragLastHandledPointerRef.current = null;
      characterDragMotionAccumRef.current = { x: 0, y: 0 };
      characterDragMotionRef.current = null;
      setCharacterDragMotion(null);
      clearPendingDragTimer(compactMenuCloseTimerRef.current);
      compactMenuCloseTimerRef.current = null;

      const petMenuViewport =
        compactAppearance === "pet"
          ? getPetCompactMenuViewport(compactSize)
          : null;
      const { menuSide, submenuSide } = await resolveCompactMenuSides(
        event.clientX,
        event.clientY,
        petMenuViewport ?? undefined,
        undefined,
        compactSize
      );
      const menuAnchorX = petMenuViewport
        ? resolvePetMenuAnchorX(compactSize, petMenuViewport, { menuSide, submenuSide })
        : event.clientX;
      const menuAnchorY = petMenuViewport
        ? resolvePetMenuAnchorY(compactSize, petMenuViewport, event.clientY, { menuSide, submenuSide })
        : event.clientY;
      const menuPosition = await resolveCompactMenuPosition(
        menuAnchorX,
        menuAnchorY,
        menuSide,
        submenuSide,
        petMenuViewport ?? undefined
      );

      setCompactMenuSide(menuSide);
      setCompactSubmenuSide(submenuSide);
      setCharacterMenuPosition(menuPosition);
      setIsCompactMenuOpen(true);
      setIsCompactModelOpen(false);
      setIsCompactAppearanceOpen(false);
      setIsCompactQueryOpen(false);
    },
    [
      resolveCompactMenuSides,
      suppressCompactBlur,
      setCharacterMenuPosition,
      setIsCompactAppearanceOpen,
      setIsCompactMenuOpen,
      setIsCompactModelOpen,
      setIsCompactQueryOpen,
      setCompactMenuSide,
      setCompactSubmenuSide,
    ]
  );

  return {
    appearanceOptions: COMPACT_APPEARANCE_OPTIONS,
    cancelCompactMenuClose,
    closeCompactMenu,
    closeCompactMenuNow,
    entries: EXTERNAL_CHAT_ENTRIES,
    handleCharacterContextMenu,
    handleCharacterPointerDown,
    handleCharacterPointerMove,
    handleCharacterPointerUp,
    handlePetPointerDown,
    handlePetPointerMove,
    handlePetPointerUp,
    handleCompactAppearanceChange,
    handleCompactDrag,
    handlePetPrimaryClick,
    handleCompactQuerySubmit,
    handleCompactScaleReset,
    handleCompactWheel,
    handleOpenCompactQuery,
    handleOpenExternalChat,
    handleOpenSettingsFromCompact,
    characterDragMotion,
    isCharacterDragging,
    openCompactMenu,
    previewCharacterScale,
    committedPetOffset,
  };
}
