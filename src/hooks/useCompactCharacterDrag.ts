import { useCallback, type MutableRefObject } from "react";
import type * as React from "react";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { MAIN_WINDOW_LABEL } from "../app/constants";
import { PET_WINDOW_TOP_OVERSCROLL } from "../app/pets/codexPetSizing";
import { clearPendingDragTimer } from "./compactInteractionGuards";
import { isCharacterPointerInHitArea, persistCompactPosition } from "../app/window";
import {
  resolveCharacterDragMotion,
  toNativePetWindowY,
  toVisualPetWindowY,
  waitForNextAnimationFrame,
  type CharacterDragPosition,
} from "./compactWindowGeometry";
import { appWindow } from "./compactWindowRuntime";

type UseCompactCharacterDragArgs = {
  compactSize: { width: number; height: number };
  onRestoreMain: (focusInput?: boolean, options?: { restoreGeometry?: boolean }) => Promise<void>;
  resetCompactFloatingUi: () => void;
  setIsCharacterDragging: React.Dispatch<React.SetStateAction<boolean>>;
  setCharacterDragMotion: React.Dispatch<
    React.SetStateAction<"running-left" | "running-right" | "running" | null>
  >;
  // 交叉依赖：由主控制器注入其它子系统的回调。
  markCompactInteraction: () => void;
  suppressCompactBlur: (durationMs?: number) => void;
  raiseCompactWindow: () => Promise<void>;
  releaseCharacterDragWindowMove: () => void;
  hidePetThoughtWindowForDrag: () => Promise<void>;
  updatePetThoughtWindowForRect: (petRect: { left: number; top: number; width: number; height: number }) => Promise<void>;
  compactMenuCloseTimerRef: MutableRefObject<number | null>;
  characterPointerDownRef: MutableRefObject<{ screenX: number; screenY: number } | null>;
  characterDragOriginRef: MutableRefObject<{
    screenX: number;
    screenY: number;
    windowX: number;
    windowY: number;
    petViewportOffsetY: number;
  } | null>;
  characterDragRafRef: MutableRefObject<number | null>;
  characterDragPendingRef: MutableRefObject<CharacterDragPosition | null>;
  characterDragMoveDrainRef: MutableRefObject<Promise<void> | null>;
  characterDragWindowMoveActiveRef: MutableRefObject<boolean>;
  characterDragLastTargetRef: MutableRefObject<CharacterDragPosition | null>;
  characterDragLastPersistedRef: MutableRefObject<CharacterDragPosition | null>;
  characterPointerMovedRef: MutableRefObject<boolean>;
  lastCharacterDragPointerRef: MutableRefObject<{ screenX: number; screenY: number } | null>;
  characterDragLastHandledPointerRef: MutableRefObject<{ screenX: number; screenY: number } | null>;
  characterDragMotionAccumRef: MutableRefObject<{ x: number; y: number }>;
  characterDragMotionRef: MutableRefObject<"running-left" | "running-right" | "running" | null>;
  isCharacterDraggingRef: MutableRefObject<boolean>;
  compactInternalMoveRef: MutableRefObject<boolean>;
  suppressPetClickUntilRef: MutableRefObject<number>;
  lastAppliedPetViewportOffsetRef: MutableRefObject<{ x: number; y: number }>;
};

/**
 * 角色/宠物拖拽子系统：JS 驱动拖拽循环（复用窗口级 mousemove 捕获监听）、
 * 运动方向判定、拖拽后位置持久化与想法窗口重同步。
 */
export function useCompactCharacterDrag(args: UseCompactCharacterDragArgs) {
  const {
    compactSize,
    onRestoreMain,
    resetCompactFloatingUi,
    setIsCharacterDragging,
    setCharacterDragMotion,
    markCompactInteraction,
    suppressCompactBlur,
    raiseCompactWindow,
    releaseCharacterDragWindowMove,
    hidePetThoughtWindowForDrag,
    updatePetThoughtWindowForRect,
    compactMenuCloseTimerRef,
    characterPointerDownRef,
    characterDragOriginRef,
    characterDragRafRef,
    characterDragPendingRef,
    characterDragMoveDrainRef,
    characterDragWindowMoveActiveRef,
    characterDragLastTargetRef,
    characterDragLastPersistedRef,
    characterPointerMovedRef,
    lastCharacterDragPointerRef,
    characterDragLastHandledPointerRef,
    characterDragMotionAccumRef,
    characterDragMotionRef,
    isCharacterDraggingRef,
    compactInternalMoveRef,
    suppressPetClickUntilRef,
    lastAppliedPetViewportOffsetRef,
  } = args;

  const PET_CLICK_DRAG_THRESHOLD_PX = 4;
  const PET_CLICK_SUPPRESS_AFTER_DRAG_MS = 320;
  const PET_DRAG_MOTION_SWITCH_PX = 9;
  const PET_DRAG_VERTICAL_SWITCH_PX = 12;

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

  return {
    setCharacterDragMotionFromPointer,
    flushCharacterDragPosition,
    scheduleCharacterDragPosition,
    continueCharacterDrag,
    handleCharacterPointerDown,
    handleCharacterPointerMove,
    handleCharacterPointerUp,
    handlePetPointerDown,
    handlePetPointerMove,
    handlePetPointerUp,
    handlePetPrimaryClick,
  };
}
