import { useCallback, type MutableRefObject } from "react";
import type * as React from "react";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { MAIN_WINDOW_LABEL } from "../app/constants";
import {
  PET_WINDOW_DECORATION_MARGIN_TOP,
  PET_WINDOW_TOP_OVERSCROLL,
} from "../app/pets/codexPetSizing";
import { clearPendingDragTimer } from "./compactInteractionGuards";
import { isCharacterPointerInHitArea, persistCompactPosition } from "../app/window";
import {
  resolveCharacterDragMotion,
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
    // windowX/windowY 为**物理像素**（outerPosition 原生返回值，不 toLogical）。
    // 拖拽全程用物理坐标系：event.screenX 差值本身是物理像素、setPosition 用
    // PhysicalPosition，跨 DPI 屏时物理坐标全局连续，不随窗口所在屏的 scale
    // 换算基准变化，避免跨屏瞬间 LogicalPosition 换算抖动造成快速闪烁。
    windowX: number;
    windowY: number;
    scaleFactor: number;
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
          // 物理像素写入：跨 DPI 屏时 PhysicalPosition 不经过 scale 换算，
          // 窗口物理位置直接落在目标物理坐标上，避免 LogicalPosition 抖动。
          await appWindow
            .setPosition(new PhysicalPosition(Math.round(nextPosition.x), Math.round(nextPosition.y)))
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
        // 基准坐标用物理像素：outerPosition() 原生返回 PhysicalPosition，
        // 与 event.screenX/screenY 的物理像素差值同坐标系。透明无边框窗口在
        // WebView2 里 window.screenX/screenY（逻辑值）多 DPI / 副屏负坐标下
        // 不可靠，先占位、随后用 Tauri 官方 API 异步校准。
        // ⚠️ 拖拽目标与写入全程物理坐标：setPosition(PhysicalPosition) 不经过
        // 逻辑换算，跨 DPI 屏时不会因窗口所在屏的 scaleFactor 变化而抖动。
        characterDragOriginRef.current = {
          screenX: pointerDown.screenX,
          screenY: pointerDown.screenY,
          windowX: Number(window.screenX || 0),
          windowY: Number(window.screenY || 0),
          scaleFactor: 1,
          petViewportOffsetY: lastAppliedPetViewportOffsetRef.current.y,
        };
        void appWindow
          .outerPosition()
          .then((position) => {
            const origin = characterDragOriginRef.current;
            if (!origin || origin.screenX !== pointerDown.screenX) {
              return;
            }
            return appWindow.scaleFactor().then((scale) => {
              const prevWindowX = origin.windowX;
              // outerPosition 原生返回物理像素，直接采用（不再 toLogical）。
              origin.windowX = position.x;
              origin.windowY = position.y;
              origin.scaleFactor = scale;
              // 校准完成时若已进入拖动（delta 已产生），立即用可靠基准重算
              // 当前位置，把第一帧基于 screenX 的偏差拉回来。
              const calibratedDeltaX = pointerScreenX - pointerDown.screenX;
              const calibratedDeltaY = pointerScreenY - pointerDown.screenY;
              if (
                Math.abs(calibratedDeltaX) >= PET_CLICK_DRAG_THRESHOLD_PX ||
                Math.abs(calibratedDeltaY) >= PET_CLICK_DRAG_THRESHOLD_PX ||
                prevWindowX !== origin.windowX
              ) {
                const calibratedX = Math.round(origin.windowX + calibratedDeltaX);
                const calibratedY = Math.max(
                  // 物理域上边界：宠物视觉顶边 = nativeY + 装饰边距(物理)，
                  // 允许再向上超一个 overscroll(物理)。
                  -(PET_WINDOW_TOP_OVERSCROLL + origin.petViewportOffsetY) * scale -
                    PET_WINDOW_DECORATION_MARGIN_TOP * scale,
                  origin.windowY + PET_WINDOW_DECORATION_MARGIN_TOP * scale + calibratedDeltaY -
                    PET_WINDOW_DECORATION_MARGIN_TOP * scale,
                );
                characterDragLastTargetRef.current = { x: calibratedX, y: calibratedY };
                scheduleCharacterDragPosition(calibratedX, calibratedY);
              }
            });
          })
          .catch(() => undefined);
      }

      const origin = characterDragOriginRef.current;
      if (!origin) {
        return false;
      }
      // 全程物理像素：origin 物理基准 + screenX 物理差值。
      const nextWindowX = origin.windowX + deltaX;
      // origin.windowY 是 Tauri 窗口 native 物理 Y；先转成视觉物理 Y 再叠加拖动偏移。
      // 上边界按「宠物本体的视觉顶边」算：想法气泡/菜单展开时宠物会被
      // --pet-viewport-offset-y 推离窗口顶边，只限制窗口顶边的话，宠物就再也贴不到屏幕最上方。
      const scale = origin.scaleFactor || 1;
      const minWindowVisualPhysicalY = -(PET_WINDOW_TOP_OVERSCROLL + origin.petViewportOffsetY) * scale;
      const nextWindowY = Math.max(
        minWindowVisualPhysicalY,
        origin.windowY + PET_WINDOW_DECORATION_MARGIN_TOP * scale + deltaY,
      ) - PET_WINDOW_DECORATION_MARGIN_TOP * scale;
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

  const handleCharacterPointerUp = useCallback(async () => {
    const pendingDragPosition = characterDragPendingRef.current ?? characterDragLastTargetRef.current;
    const shouldSuppressPetClick = characterPointerMovedRef.current || isCharacterDraggingRef.current;
    characterPointerDownRef.current = null;
    characterDragOriginRef.current = null;
    characterDragLastTargetRef.current = null;
    isCharacterDraggingRef.current = false;
    // 拖拽放置后刷新交互豁免：松手瞬间若不延长，followCursorScreen（鼠标随航）
    // 的 monitor sync 会在 900ms 豁免到期后把宠物拉回光标所在屏，表现为
    // 「拖到副屏一松手就弹回原屏」。
    markCompactInteraction();
    if (characterDragRafRef.current !== null) {
      window.cancelAnimationFrame(characterDragRafRef.current);
      characterDragRafRef.current = null;
    }
    if (pendingDragPosition) {
      characterDragPendingRef.current = pendingDragPosition;
      // 等 drain 真正把窗口移到最终目标位置（await 返回的 promise，
      // 若已有 drain 则等待其完成），避免此时读 outerPosition 拿到旧位置。
      await flushCharacterDragPosition();
    } else {
      characterDragPendingRef.current = null;
    }
    // 与 onMoved 一致：持久化「宠物本体」的视觉位置（逻辑坐标 = 窗口逻辑位置
    // + 宠物视口偏移）。拖拽目标虽是物理像素，但写入后窗口实际位置即目标，
    // 读 outerPosition().toLogical 换算回逻辑坐标最准确，跨 DPI 屏松手也正确。
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
  }, [compactSize.height, compactSize.width, flushCharacterDragPosition, markCompactInteraction, releaseCharacterDragWindowMove, updatePetThoughtWindowForRect]);

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
