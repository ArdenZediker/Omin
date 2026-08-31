import { useCallback, useEffect, type MutableRefObject } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PET_THOUGHT_WINDOW_LABEL } from "../app/constants";
import type { CompactReply, PetThoughtState } from "../app/types";
import {
  ensurePetThoughtWindow,
  PET_THOUGHT_WINDOW_SIZE,
  type PetThoughtPlacement,
} from "../app/window";
import {
  resolveMonitorForRect,
  resolvePetThoughtWindowLayout,
  toVisualPetWindowY,
} from "./compactWindowGeometry";
import {
  appWindow,
  PET_THOUGHT_COLLAPSE_HIDE_DELAY_MS,
  PET_THOUGHT_POSITION_EPSILON,
} from "./compactWindowRuntime";
import type { CompactAppearance } from "./useCompactWindowState";

type UseCompactPetThoughtWindowsArgs = {
  isCompactWindow: boolean;
  compactAppearance: CompactAppearance;
  arePetThoughtsCollapsed: boolean;
  isCompactMenuOpen: boolean;
  isCompactQueryOpen: boolean;
  isCompactReplyLoading: boolean;
  compactReply: CompactReply | null;
  compactSize: { width: number; height: number };
  petThought: PetThoughtState | null;
  petThoughtCount: number;
  setPetThoughtPlacement: React.Dispatch<React.SetStateAction<PetThoughtPlacement>>;
  petThoughtPlacementRef: MutableRefObject<PetThoughtPlacement>;
  petThoughtStateRef: MutableRefObject<PetThoughtState | null>;
  petThoughtQueueRef: MutableRefObject<PetThoughtState[]>;
  petThoughtCountRef: MutableRefObject<number>;
  petThoughtLayoutRequestRef: MutableRefObject<number>;
  petThoughtCollapseHideTimerRef: MutableRefObject<number | null>;
  petThoughtCollapseHideVersionRef: MutableRefObject<number>;
  lastPetThoughtWindowLayoutRef: MutableRefObject<{
    x: number;
    y: number;
    height: number;
    anchorX: number;
    anchorY: number;
    badgeAnchorX: number;
    badgeAnchorY: number;
    placement: PetThoughtPlacement;
  } | null>;
  isCharacterDraggingRef: MutableRefObject<boolean>;
};

/**
 * 宠物想法气泡窗口子系统：布局解析、窗口同步、折叠延迟隐藏。
 * 回调与对应 effect（E5–E10）一起搬移，保证 effect 注册顺序与拆分前一致。
 */
export function useCompactPetThoughtWindows(args: UseCompactPetThoughtWindowsArgs) {
  const {
    isCompactWindow,
    compactAppearance,
    arePetThoughtsCollapsed,
    isCompactMenuOpen,
    isCompactQueryOpen,
    isCompactReplyLoading,
    compactReply,
    compactSize,
    petThought,
    petThoughtCount,
    setPetThoughtPlacement,
    petThoughtPlacementRef,
    petThoughtStateRef,
    petThoughtQueueRef,
    petThoughtCountRef,
    petThoughtLayoutRequestRef,
    petThoughtCollapseHideTimerRef,
    petThoughtCollapseHideVersionRef,
    lastPetThoughtWindowLayoutRef,
    isCharacterDraggingRef,
  } = args;

  const hasPetThought = Boolean(petThought);

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
          const monitor = await resolveMonitorForRect(petRect, scaleFactor);
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
      const monitor = await resolveMonitorForRect(petRect, scaleFactor);
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

  return {
    updatePetThoughtWindowForRect,
    updatePetThoughtWindowForCurrentPositionAndSize,
    updatePetThoughtWindowFromCurrentPosition,
    hidePetThoughtWindowForDrag,
  };
}
