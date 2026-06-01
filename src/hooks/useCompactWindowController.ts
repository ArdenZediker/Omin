import { useCallback, useEffect, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { availableMonitors, currentMonitor, cursorPosition, getCurrentWindow, monitorFromPoint, type Monitor } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { loadProviderConfigs, modelRegistry } from "../adapters/registry";
import { readSqliteBackedValue } from "../app/sqliteStorage";
import { executeChatTurn } from "../chat/engine";
import {
  CHARACTER_SCALE_BASELINE,
  COMPACT_APPEARANCE_OPTIONS,
  COMPACT_MENU_CLOSE_DELAY_MS,
  CURRENT_MODEL_STORAGE_KEY,
  EXTERNAL_CHAT_ENTRIES,
  MAIN_WINDOW_LABEL,
} from "../app/constants";
import type { BasicSettings, CompactReply, PetThoughtState } from "../app/types";
import { PET_WINDOW_DECORATION_MARGIN_TOP } from "../app/pets/codexPetSizing";
import type { CompactAppearance } from "./useCompactWindowState";
import {
  clampCharacterScale,
  type CompactAppearance as CompactAppearanceType,
} from "./useCompactWindowState";
import {
  getMonitorForCursor,
  getCompactWindowSize,
  getPetCompactMenuViewport,
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
  return Math.max(0, Math.round(visualY - PET_WINDOW_DECORATION_MARGIN_TOP));
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

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
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
}: UseCompactWindowControllerArgs) {
  const PET_CLICK_DRAG_THRESHOLD_PX = 4;
  const PET_CLICK_SUPPRESS_AFTER_DRAG_MS = 320;
  const PET_DRAG_MOTION_SWITCH_PX = 9;
  const PET_DRAG_VERTICAL_SWITCH_PX = 12;
  const [isCharacterDragging, setIsCharacterDragging] = useState(false);
  const [characterDragMotion, setCharacterDragMotion] = useState<"running-left" | "running-right" | "running" | null>(null);
  const [previewCharacterScale, setPreviewCharacterScale] = useState<number | null>(null);
  const [scaleGestureVersion, setScaleGestureVersion] = useState(0);
  const hasPetThought = Boolean(petThought);
  const compactMenuCloseTimerRef = useRef<number | null>(null);
  const compactMenuOpeningRef = useRef(false);
  const isCharacterDraggingRef = useRef(false);
  const characterPointerDownRef = useRef<{ screenX: number; screenY: number } | null>(null);
  const characterDragOriginRef = useRef<{ screenX: number; screenY: number; windowX: number; windowY: number } | null>(null);
  const characterDragRafRef = useRef<number | null>(null);
  const characterDragPendingRef = useRef<{ x: number; y: number } | null>(null);
  const characterDragLastTargetRef = useRef<{ x: number; y: number } | null>(null);
  const characterDragLastPersistedRef = useRef<{ x: number; y: number } | null>(null);
  const characterPointerMovedRef = useRef(false);
  const lastCharacterDragPointerRef = useRef<{ screenX: number; screenY: number } | null>(null);
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
  const compactInternalMoveRef = useRef(false);
  const compactInteractionUntilRef = useRef(0);
  const compactSuppressBlurUntilRef = useRef(0);
  const lastAppliedCompactSizeRef = useRef<{ width: number; height: number } | null>(null);
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
      const shouldShowThoughtWindow =
        compactAppearance === "pet" &&
        (hasThoughtQueue || Boolean(currentThought)) &&
        !arePetThoughtsCollapsed &&
        !isCharacterDraggingRef.current &&
        !isCompactMenuOpen &&
        !isCompactQueryOpen &&
        !isCompactReplyLoading &&
        !compactReply;
      if (!shouldShowThoughtWindow) {
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
      const modelId = event.payload?.modelId;
      if (!modelId) {
        return;
      }
      setCurrentModel(modelId);
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

  const resolveCompactMenuSides = useCallback(async (anchorX?: number, anchorY?: number) => {
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
    return resolveCompactMenuSidesFromSpace(leftSpace, rightSpace);
  }, [isCompactWindow]);

  const resolveCompactMenuPosition = useCallback(
    async (
      anchorX: number,
      anchorY: number,
      side: "left" | "right",
      viewportOverride?: { width: number; height: number }
    ) => {
      const scaleFactor = await appWindow.scaleFactor();
      const windowSize = (await appWindow.outerSize()).toLogical(scaleFactor);
      const viewportWidth = viewportOverride?.width ?? compactViewportSize?.width ?? windowSize.width;
      const viewportHeight = viewportOverride?.height ?? compactViewportSize?.height ?? windowSize.height;
      return resolveCompactMenuPositionFromViewport(anchorX, anchorY, side, viewportWidth, viewportHeight);
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
      }
      return;
    }

    let cancelled = false;
    const syncCompactMonitor = async () => {
      try {
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
          return;
        }

        compactFollowMonitorRef.current = nextMonitorKey;
        await moveCompactWindowToMonitor(appWindow, monitor, compactSize);
      } catch {
        // 闂傚倸鍊搁崐鎼佸磹閹间讲鈧箓顢楅崟顐わ紱闂佸憡娲﹂崐瀣洪鍕庘晠鏌嶆潪鎷屽厡闁哄睙鍐炬富闁靛牆妫楁慨褏绱掗悩鍐茬仴閺佸牓鏌＄仦璇插姕闁绘挻鐟╅弻锝呂旈埀顒勬偋婵犲嫭顐介柡灞诲劜閻撴洘绻涢崱妤呯崪闂婎剦鍓熼弻锛勪沪閸撗勫垱濡ょ姷鍋為敋妞ゎ亜鍟撮幃娆擃敆婢跺鏋堢紓鍌氬€风欢锟犲窗濮樿泛鏋侀悹鍥ф▕濞兼牗绻涘顔荤凹妞ゃ儱鐗撻弻宥夊传閸曨偅娈堕梺闈涚墢閸忔ê顫忓ú顏勫窛濠电姴鍟伴崣鍡涙⒑濞茶骞栭柛濠傛健閹即顢氶埀顒€鐣峰鈧、娆撴嚃閳哄﹤鏅梻鍌欑缂嶅﹪銆傞敃鍌涘€块柨鏇楀亾妞も晛銈告俊鎼佸煛閸屾瀚奸梻鍌氬€搁悧濠冪瑹濡も偓鍗遍柛顐ｆ礃閻撴洟骞栭幖顓炴灈闁诲骏绱曠槐鎺楀磼濮樻瘷锝囩磼鏉炴壆鐭欑€规洏鍔嶇换婵嬪磼濞嗗繐顕?
      }
    };

    void syncCompactMonitor();
    const timer = window.setInterval(() => {
      void syncCompactMonitor();
    }, 450);

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
        if (hasSizeChanged || currentSizeChanged) {
          await Promise.all([
            appWindow.setSize(new LogicalSize(targetSize.width, targetSize.height)),
            updatePetThoughtWindowForCurrentPositionAndSize(targetSize),
          ]);
          lastAppliedCompactSizeRef.current = { ...targetSize };
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
        const scaleFactor = await appWindow.scaleFactor();
        const pos = event.payload.toLogical(scaleFactor);
        const visualPos = {
          x: Math.round(pos.x),
          y: compactAppearance === "pet" ? toVisualPetWindowY(pos.y) : Math.round(pos.y),
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
      characterDragMotionAccumRef.current = { x: 0, y: 0 };
      characterDragMotionRef.current = null;
      setCharacterDragMotion(null);
    };
  }, []);

  const flushCharacterDragPosition = useCallback(() => {
    const pending = characterDragPendingRef.current;
    if (!pending) {
      return;
    }

    characterDragPendingRef.current = null;
    void appWindow
      .setPosition(new LogicalPosition(Math.round(pending.x), toNativePetWindowY(pending.y)))
      .catch(() => undefined);
  }, []);

  const scheduleCharacterDragPosition = useCallback((x: number, y: number) => {
    characterDragPendingRef.current = { x, y };
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
        };
      }

      const origin = characterDragOriginRef.current;
      if (!origin) {
        return false;
      }
      const nextWindowX = origin.windowX + deltaX;
      const nextWindowY = Math.max(0, origin.windowY + deltaY);
      characterDragLastTargetRef.current = { x: nextWindowX, y: nextWindowY };
      scheduleCharacterDragPosition(nextWindowX, nextWindowY);
      return true;
    },
    [hidePetThoughtWindowForDrag, scheduleCharacterDragPosition, setCharacterDragMotionFromPointer]
  );

  const closeCompactMenu = useCallback(() => {
    if (compactMenuCloseTimerRef.current !== null) {
      window.clearTimeout(compactMenuCloseTimerRef.current);
    }

    compactMenuCloseTimerRef.current = window.setTimeout(() => {
      closeCompactMenuPanels();
      compactMenuCloseTimerRef.current = null;
    }, COMPACT_MENU_CLOSE_DELAY_MS);
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
      if (event.button !== 0) {
        characterPointerDownRef.current = null;
        characterDragOriginRef.current = null;
        characterDragLastTargetRef.current = null;
        characterPointerMovedRef.current = false;
        isCharacterDraggingRef.current = false;
        setIsCharacterDragging(false);
        lastCharacterDragPointerRef.current = null;
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
        setIsCharacterDragging(false);
        lastCharacterDragPointerRef.current = null;
        characterDragMotionAccumRef.current = { x: 0, y: 0 };
        characterDragMotionRef.current = null;
        setCharacterDragMotion(null);
        resetCompactFloatingUi();
        return;
      }

      isCharacterDraggingRef.current = false;
      characterDragLastTargetRef.current = null;
      lastCharacterDragPointerRef.current = null;
      characterDragMotionAccumRef.current = { x: 0, y: 0 };
      characterDragMotionRef.current = null;
      setCharacterDragMotion(null);
      characterPointerDownRef.current = { screenX: event.screenX, screenY: event.screenY };
      characterDragOriginRef.current = null;
      characterPointerMovedRef.current = false;
    },
    [resetCompactFloatingUi]
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
      const finalVisualPosition = {
        x: Math.round(pendingDragPosition.x),
        y: Math.round(pendingDragPosition.y),
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
        const finalVisualPosition = {
          x: Math.round(position.x),
          y: toVisualPetWindowY(position.y),
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
    characterDragMotionAccumRef.current = { x: 0, y: 0 };
    characterDragMotionRef.current = null;
    setCharacterDragMotion(null);
  }, [compactSize.height, compactSize.width, flushCharacterDragPosition, updatePetThoughtWindowForRect]);

  useEffect(() => {
    if (!isCompactWindow) {
      return;
    }

    const onWindowMouseMove = (event: MouseEvent) => {
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

    window.addEventListener("mousemove", onWindowMouseMove, { capture: true });
    window.addEventListener("mouseup", onWindowMouseUp, { capture: true });
    return () => {
      window.removeEventListener("mousemove", onWindowMouseMove, { capture: true });
      window.removeEventListener("mouseup", onWindowMouseUp, { capture: true });
    };
  }, [continueCharacterDrag, handleCharacterPointerUp, isCompactWindow]);

  const handleCompactQuerySubmit = useCallback(
    async (openMain = false) => {
      const draft = compactQuery.trim();
      if (!draft) {
        return;
      }

      await loadProviderConfigs();
      const savedModel = readSqliteBackedValue(CURRENT_MODEL_STORAGE_KEY);
      const resolvedModel =
        savedModel && modelRegistry.getModelConfig(savedModel) ? savedModel : modelRegistry.getCurrentModel();
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
        setCompactReply({ question: draft, answer: "", isError: false });

        let streamedAnswer = "";
        const response = await executeChatTurn({
          model: resolvedModel,
          messages: [{ role: "user", content: draft }],
          onChunk: (chunk) => {
            streamedAnswer += chunk;
            setCompactReply({ question: draft, answer: streamedAnswer, isError: false });
          },
        });
        setCompactReply({ question: draft, answer: response.content || streamedAnswer, isError: false });
        setIsCompactQueryOpen(false);
        setCompactQuery("");
        setIsCompactQueryOpen(false);
        setCompactQuery("");
      } catch (error) {
        setCompactReply({ question: draft, answer: error instanceof Error ? error.message : "閺屻儴顕楁径杈Е", isError: true });
      } finally {
        setIsCompactReplyLoading(false);
      }
    },
    [compactQuery, currentModel, onRestoreMain, setCompactQuery, setCompactReply, setCurrentModel, setIsCompactQueryOpen, setIsCompactReplyLoading]
  );

  const handleCompactWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (compactAppearance !== "pet") {
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
          await appWindow.setSize(new LogicalSize(previewSize.width, previewSize.height));
          lastAppliedCompactSizeRef.current = { ...previewSize };
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
    [characterScale, compactAppearance, markCompactInteraction, setCharacterScale, updatePetThoughtWindowForCurrentPositionAndSize]
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
    await raiseCompactWindow();
    if (compactMenuOpeningRef.current || isCompactMenuOpen) {
      return;
    }

    compactMenuOpeningRef.current = true;
    if (compactMenuCloseTimerRef.current !== null) {
      window.clearTimeout(compactMenuCloseTimerRef.current);
      compactMenuCloseTimerRef.current = null;
    }
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
          ? anchorClientX - windowPosition.x
          : pointer
            ? pointer.x / scaleFactor - windowPosition.x
            : Math.max(0, fallbackSize.width / 2);
      const anchorY =
        typeof anchorClientY === "number"
          ? anchorClientY - windowPosition.y
          : pointer
            ? pointer.y / scaleFactor - windowPosition.y
            : Math.max(0, fallbackSize.height / 2);
      const { menuSide, submenuSide } = await resolveCompactMenuSides(anchorX, anchorY);
      const petMenuViewport =
        compactAppearance === "pet"
          ? getPetCompactMenuViewport(compactSize)
          : null;
      const menuAnchorX = petMenuViewport ? Math.round(petMenuViewport.width / 2) : anchorX;
      setCompactMenuSide(menuSide);
      setCompactSubmenuSide(submenuSide);
      setCharacterMenuPosition(await resolveCompactMenuPosition(menuAnchorX, anchorY, menuSide, petMenuViewport ?? undefined));
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
      characterDragMotionAccumRef.current = { x: 0, y: 0 };
      characterDragMotionRef.current = null;
      setCharacterDragMotion(null);
      clearPendingDragTimer(compactMenuCloseTimerRef.current);
      compactMenuCloseTimerRef.current = null;

      const { menuSide, submenuSide } = await resolveCompactMenuSides(event.clientX, event.clientY);
      const petMenuViewport =
        compactAppearance === "pet"
          ? getPetCompactMenuViewport(compactSize)
          : null;
      const menuPosition = await resolveCompactMenuPosition(
        petMenuViewport ? Math.round(petMenuViewport.width / 2) : event.clientX,
        event.clientY,
        menuSide,
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
    closeCompactMenu,
    closeCompactMenuNow,
    entries: EXTERNAL_CHAT_ENTRIES,
    handleCharacterContextMenu,
    handleCharacterPointerDown,
    handleCharacterPointerMove,
    handleCharacterPointerUp,
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
  };
}
