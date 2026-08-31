import { useCallback, type MutableRefObject } from "react";
import { COMPACT_MENU_CLOSE_DELAY_MS } from "../app/constants";
import { deferToAfterWindowMoveSettles, type CharacterDragPosition } from "./compactWindowGeometry";
import { appWindow } from "./compactWindowRuntime";

type UseCompactPrimitivesArgs = {
  isCompactWindow: boolean;
  closeCompactMenuPanels: () => void;
  compactMenuCloseTimerRef: MutableRefObject<number | null>;
  compactInteractionUntilRef: MutableRefObject<number>;
  compactSuppressBlurUntilRef: MutableRefObject<number>;
  compactInternalMoveRef: MutableRefObject<boolean>;
  characterPointerDownRef: MutableRefObject<{ screenX: number; screenY: number } | null>;
  isCharacterDraggingRef: MutableRefObject<boolean>;
  characterDragPendingRef: MutableRefObject<CharacterDragPosition | null>;
  characterDragMoveDrainRef: MutableRefObject<Promise<void> | null>;
  characterDragWindowMoveActiveRef: MutableRefObject<boolean>;
};

/**
 * 原子基础回调：只写 ref / 调原生窗口 API，不依赖其它子系统回调。
 * 单独抽成子钩子，供拖拽 / 菜单 / 主控制器共享（避免循环依赖）。
 */
export function useCompactPrimitives(args: UseCompactPrimitivesArgs) {
  const {
    isCompactWindow,
    closeCompactMenuPanels,
    compactMenuCloseTimerRef,
    compactInteractionUntilRef,
    compactSuppressBlurUntilRef,
    compactInternalMoveRef,
    characterPointerDownRef,
    isCharacterDraggingRef,
    characterDragPendingRef,
    characterDragMoveDrainRef,
    characterDragWindowMoveActiveRef,
  } = args;

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

  return {
    markCompactInteraction,
    suppressCompactBlur,
    raiseCompactWindow,
    releaseCharacterDragWindowMove,
    cancelCompactMenuClose,
    closeCompactMenu,
    closeCompactMenuNow,
  };
}
