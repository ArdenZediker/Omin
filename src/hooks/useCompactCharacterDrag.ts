import { useCallback, type MutableRefObject } from "react";
import type * as React from "react";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { cursorPosition } from "@tauri-apps/api/window";
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
    // ⚠️ windowX/windowY/cursorX/cursorY 均为**物理像素**：window 来自
    // outerPosition() 原生返回值、cursor 来自 cursorPosition()（GetCursorPos
    // 全局虚拟屏幕坐标）。位置源**禁止**用 event.screenX/screenY——它在
    // Windows 高 DPI 下是 DIP，且按光标所在显示器的 scale 换算，跨 DPI 屏
    // 瞬间同一物理光标点的换算值会跳变（如主屏 100% 时 x=1920 ↔ 副屏 150%
    // 同一点 x≈1280），导致「跨屏落点与鼠标移入位置错位」。
    windowX: number;
    windowY: number;
    cursorX: number;
    cursorY: number;
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
 * 由物理光标位置（cursorPosition，GetCursorPos 全局虚拟屏幕坐标）解出窗口
 * 目标位置。全程物理像素：窗口物理基准 + 光标物理位移，不经过逻辑/DIP
 * 换算，跨 DPI 屏连续，落点与鼠标实际位置精确一致。
 */
function resolveDragTarget(
  origin: {
    windowX: number;
    windowY: number;
    cursorX: number;
    cursorY: number;
    scaleFactor: number;
    petViewportOffsetY: number;
  },
  cursorX: number,
  cursorY: number,
): CharacterDragPosition {
  const scale = origin.scaleFactor || 1;
  const nextWindowX = Math.round(origin.windowX + (cursorX - origin.cursorX));
  // 上边界按「宠物本体的视觉顶边」算：想法气泡/菜单展开时宠物会被
  // --pet-viewport-offset-y 推离窗口顶边，只限制窗口顶边的话，宠物就再也
  // 贴不到屏幕最上方。
  const minWindowVisualPhysicalY = -(PET_WINDOW_TOP_OVERSCROLL + origin.petViewportOffsetY) * scale;
  const rawVisualY = origin.windowY + PET_WINDOW_DECORATION_MARGIN_TOP * scale + (cursorY - origin.cursorY);
  const nextWindowY = Math.round(Math.max(minWindowVisualPhysicalY, rawVisualY) - PET_WINDOW_DECORATION_MARGIN_TOP * scale);
  return { x: nextWindowX, y: nextWindowY };
}

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

    if (!characterDragPendingRef.current && !isCharacterDraggingRef.current) {
      return Promise.resolve();
    }

    characterDragWindowMoveActiveRef.current = true;
    compactInternalMoveRef.current = true;
    const drain = (async () => {
      try {
        // 拖拽循环：每帧查询 cursorPosition()（物理像素、全局连续，GetCursorPos
        // 不经过 DIP 换算），与按下时校准的物理基准做差得目标位置，fire-and-forget
        // 发送 setPosition。相比「pointermove 里用 event.screenX 算目标」：
        // ① 位置源是原生物理值，跨 DPI 屏不随光标所在屏的 scale 换算基准变化，
        //    落点与鼠标实际位置精确一致（修复「跨屏落点错位」）；
        // ② 每帧取的都是那一刻的最新光标位置，天然跟手——鼠标快速甩动时循环
        //    每帧都在采样，而不是等下一个 mousemove 事件；
        // ③ 不 await IPC 返回，更新率 = rAF 频率，不受 IPC 往返延迟钳制。
        while (isCharacterDraggingRef.current && characterDragOriginRef.current) {
          const origin = characterDragOriginRef.current;
          const cursor = await cursorPosition().catch(() => null);
          if (!cursor) {
            await waitForNextAnimationFrame();
            continue;
          }
          const target = resolveDragTarget(origin, cursor.x, cursor.y);
          characterDragLastTargetRef.current = target;
          // 物理像素写入：跨 DPI 屏时 PhysicalPosition 不经过 scale 换算，
          // 窗口物理位置直接落在目标物理坐标上，避免 LogicalPosition 抖动。
          appWindow
            .setPosition(new PhysicalPosition(target.x, target.y))
            .catch(() => undefined);
          await waitForNextAnimationFrame();
        }
      } finally {
        characterDragMoveDrainRef.current = null;
        // 收尾落位：循环退出（松手）后，把最终目标 await 发送一次，保证窗口
        // 真正停在最后位置（fire-and-forget 的 in-flight 写入可能未完成，直接
        // 读 outerPosition 会拿到旧值）。最终目标优先取松手时写回的 pending。
        const finalTarget = characterDragPendingRef.current ?? characterDragLastTargetRef.current;
        if (finalTarget) {
          characterDragPendingRef.current = null;
          await appWindow
            .setPosition(new PhysicalPosition(Math.round(finalTarget.x), Math.round(finalTarget.y)))
            .catch(() => undefined);
        }
        if (!characterPointerDownRef.current && !isCharacterDraggingRef.current && !characterDragPendingRef.current) {
          releaseCharacterDragWindowMove();
        }
      }
    })();
    characterDragMoveDrainRef.current = drain;
    return drain;
  }, [releaseCharacterDragWindowMove]);

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
      // event.screenX/screenY 仅用于拖动判定与运动方向（同屏内 DIP 近似物理）；
      // 窗口目标位置一律由拖拽循环内的 cursorPosition() 物理像素计算。
      setCharacterDragMotionFromPointer(pointerScreenX, pointerScreenY, resolveCharacterDragMotion(deltaX, deltaY));

      if (!characterDragOriginRef.current) {
        // 基准坐标用物理像素：outerPosition() 原生物理值 + cursorPosition()
        // 原生物理光标位置。先占位、随后用 Tauri 官方 API 异步校准。
        // ⚠️ 不要用 window.screenX / event.screenX 做位置基准——它是逻辑/DIP
        // 值，多 DPI 下与物理像素有 scale 差，跨屏落点会错位。
        characterDragOriginRef.current = {
          screenX: pointerDown.screenX,
          screenY: pointerDown.screenY,
          windowX: Number(window.screenX || 0),
          windowY: Number(window.screenY || 0),
          cursorX: pointerScreenX,
          cursorY: pointerScreenY,
          scaleFactor: 1,
          petViewportOffsetY: lastAppliedPetViewportOffsetRef.current.y,
        };
        void Promise.all([appWindow.outerPosition(), cursorPosition(), appWindow.scaleFactor()])
          .then(([position, cursor, scale]) => {
            const origin = characterDragOriginRef.current;
            if (!origin || origin.screenX !== pointerDown.screenX) {
              return;
            }
            origin.windowX = position.x;
            origin.windowY = position.y;
            origin.cursorX = cursor.x;
            origin.cursorY = cursor.y;
            origin.scaleFactor = scale;
            // 校准完成：立即用可靠基准算一次当前位置，把第一帧基于占位基准
            // 的偏差拉回来。
            const calibratedTarget = resolveDragTarget(origin, cursor.x, cursor.y);
            characterDragLastTargetRef.current = calibratedTarget;
            appWindow
              .setPosition(new PhysicalPosition(calibratedTarget.x, calibratedTarget.y))
              .catch(() => undefined);
            void flushCharacterDragPosition();
          })
          .catch(() => undefined);
      }

      // 确保拖拽循环在跑：目标位置由循环内每帧 cursorPosition() 计算，
      // pointermove 只负责唤醒/维持循环，位置永远是最新光标物理值。
      void flushCharacterDragPosition();
      return true;
    },
    [flushCharacterDragPosition, hidePetThoughtWindowForDrag, markCompactInteraction, setCharacterDragMotionFromPointer]
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
    const didDrag = characterPointerMovedRef.current || isCharacterDraggingRef.current;
    // ⚠️ 必须**同步**落闸（在任何 await 之前）：浏览器的 click 事件紧跟 mouseup
    // 派发，而本函数在第一个 await 之后就被挂起了（等 rAF / IPC 往返，几十到
    // 几百 ms）。若把落闸放在 await 之后，click 早就先执行完了——表现为
    //「拖动宠物松手也会切换主界面显隐」，这是本次修复的根因。
    if (didDrag) {
      suppressPetClickUntilRef.current = Date.now() + PET_CLICK_SUPPRESS_AFTER_DRAG_MS;
    }
    // 松手：先把最终目标写回 pending（drain 收尾以它为准 await 落位），再清
    // 拖拽状态让循环退出，最后 await flush 等待最终位置真正写入完成。
    if (pendingDragPosition) {
      characterDragPendingRef.current = pendingDragPosition;
    }
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
    await flushCharacterDragPosition();
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

  /**
   * 同步判断「这次 click 其实是拖拽的收尾」。click 一定晚于 mouseup，而
   * handleCharacterPointerUp 的重置逻辑排在 await 之后，所以此刻这些 ref 还
   * 保留着刚结束的那次拖拽的信息，可被 click 直接读取。
   */
  const shouldSuppressPetClick = useCallback(
    () =>
      isCharacterDraggingRef.current ||
      characterPointerMovedRef.current ||
      Date.now() <= suppressPetClickUntilRef.current,
    []
  );

  const handlePetPrimaryClick = useCallback(async () => {
    // 拖拽收尾的 click：直接吞掉，不动主界面。
    if (shouldSuppressPetClick()) {
      isCharacterDraggingRef.current = false;
      characterPointerMovedRef.current = false;
      return;
    }
    suppressCompactBlur();

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
  }, [onRestoreMain, shouldSuppressPetClick, suppressCompactBlur]);

  return {
    shouldSuppressPetClick,
    setCharacterDragMotionFromPointer,
    flushCharacterDragPosition,
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
