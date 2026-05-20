import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { currentMonitor, cursorPosition, getCurrentWindow, monitorFromPoint } from "@tauri-apps/api/window";
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
import type { CompactAppearance } from "./useCompactWindowState";
import {
  clampCharacterScale,
  type CompactAppearance as CompactAppearanceType,
} from "./useCompactWindowState";
import {
  getMonitorForCursor,
  getCompactWindowSize,
  getPetCompactMenuViewport,
  type PetThoughtPlacement,
  isCharacterPointerInHitArea,
  isWindowRectVisible,
  moveCompactWindowToMonitor,
  openInternalChatWindow,
  persistCompactPosition,
  showSettingsWindow,
} from "../app/window";
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
  petThoughtPlacement: PetThoughtPlacement;
  currentModel: string;
  isCompactAppearanceOpen: boolean;
  isCompactMenuOpen: boolean;
  isCompactModelOpen: boolean;
  isCompactQueryOpen: boolean;
  isCompactReplyLoading: boolean;
  isCompactWindow: boolean;
  onRestoreMain: (focusInput?: boolean) => Promise<void>;
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
  petThoughtPlacement,
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
}: UseCompactWindowControllerArgs) {
  const PET_CLICK_DRAG_THRESHOLD_PX = 4;
  const PET_CLICK_SUPPRESS_AFTER_DRAG_MS = 320;
  const PET_DRAG_MOTION_DEADZONE_PX = 1.5;
  const [isCharacterDragging, setIsCharacterDragging] = useState(false);
  const [characterDragMotion, setCharacterDragMotion] = useState<"running-left" | "running-right" | "running" | null>(null);
  const [previewCharacterScale, setPreviewCharacterScale] = useState<number | null>(null);
  const [scaleGestureVersion, setScaleGestureVersion] = useState(0);
  const compactMenuCloseTimerRef = useRef<number | null>(null);
  const compactMenuOpeningRef = useRef(false);
  const isCharacterDraggingRef = useRef(false);
  const characterPointerDownRef = useRef<{ screenX: number; screenY: number } | null>(null);
  const characterDragOriginRef = useRef<{ screenX: number; screenY: number; windowX: number; windowY: number } | null>(null);
  const characterDragRafRef = useRef<number | null>(null);
  const characterDragPendingRef = useRef<{ x: number; y: number } | null>(null);
  const characterDragApplyingRef = useRef(false);
  const characterPointerMovedRef = useRef(false);
  const lastCharacterDragPointerRef = useRef<{ screenX: number; screenY: number } | null>(null);
  const characterDragMotionRef = useRef<"running-left" | "running-right" | "running" | null>(null);
  const scaleWheelTimerRef = useRef<number | null>(null);
  const scaleGestureScaleRef = useRef<number | null>(null);
  const scaleGestureSequenceRef = useRef(0);
  const isScaleGestureActiveRef = useRef(false);
  const suppressPetClickUntilRef = useRef(0);
  const compactFollowMonitorRef = useRef<string | null>(null);
  const compactInternalMoveRef = useRef(false);
  const compactInteractionUntilRef = useRef(0);
  const compactSuppressBlurUntilRef = useRef(0);
  const lastAppliedCompactSizeRef = useRef<{ width: number; height: number } | null>(null);
  const lastAppliedPetAnchorOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
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
        await appWindow.setAlwaysOnTop(true);
        const hasSizeChanged =
          !lastAppliedCompactSizeRef.current ||
          Math.round(lastAppliedCompactSizeRef.current.width) !== Math.round(targetSize.width) ||
          Math.round(lastAppliedCompactSizeRef.current.height) !== Math.round(targetSize.height);
        const currentSizeChanged =
          Math.round(currentSize.width) !== Math.round(targetSize.width) ||
          Math.round(currentSize.height) !== Math.round(targetSize.height);
        const nextAnchorOffset = {
          x:
            petThought &&
            !isCompactMenuOpen &&
            !isCompactQueryOpen &&
            !isCompactReplyLoading &&
            !compactReply &&
            petThoughtPlacement === "left"
              ? Math.max(0, Math.round(targetSize.width - previewCompactSize.width))
              : 0,
          y:
            petThought &&
            !isCompactMenuOpen &&
            !isCompactQueryOpen &&
            !isCompactReplyLoading &&
            !compactReply &&
            petThoughtPlacement === "top"
              ? Math.max(0, Math.round(targetSize.height - previewCompactSize.height))
              : 0,
        };
        const previousAnchorOffset = lastAppliedPetAnchorOffsetRef.current;
        const anchorOffsetChanged =
          previousAnchorOffset.x !== nextAnchorOffset.x || previousAnchorOffset.y !== nextAnchorOffset.y;

        if (hasSizeChanged || currentSizeChanged || anchorOffsetChanged) {
          const nextX = Math.round(currentPosition.x + previousAnchorOffset.x - nextAnchorOffset.x);
          const nextY = Math.round(currentPosition.y + previousAnchorOffset.y - nextAnchorOffset.y);

          if (nextX !== Math.round(currentPosition.x) || nextY !== Math.round(currentPosition.y)) {
            compactInternalMoveRef.current = true;
            await appWindow.setPosition(new LogicalPosition(nextX, nextY));
            window.setTimeout(() => {
              compactInternalMoveRef.current = false;
            }, 120);
          }
          await appWindow.setSize(new LogicalSize(targetSize.width, targetSize.height));
          lastAppliedCompactSizeRef.current = { ...targetSize };
          lastAppliedPetAnchorOffsetRef.current = nextAnchorOffset;
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
    petThought,
    petThoughtPlacement,
    scaleGestureVersion,
    suppressCompactBlur,
  ]);

  useEffect(() => {
    if (!isCompactWindow) {
      return;
    }

    let unlisten: (() => void) | undefined;
    void appWindow
      .onMoved(async (event) => {
        if (compactInternalMoveRef.current) {
          return;
        }
        const scaleFactor = await appWindow.scaleFactor();
        const pos = event.payload.toLogical(scaleFactor);
        persistCompactPosition({ x: Math.round(pos.x), y: Math.round(pos.y) });
      })
      .then((fn) => {
        unlisten = fn;
      });

    return () => {
      unlisten?.();
    };
  }, [isCompactWindow]);

  useEffect(() => {
    return () => {
      if (compactMenuCloseTimerRef.current !== null) {
        window.clearTimeout(compactMenuCloseTimerRef.current);
      }
      if (characterDragRafRef.current !== null) {
        window.cancelAnimationFrame(characterDragRafRef.current);
        characterDragRafRef.current = null;
      }
      if (scaleWheelTimerRef.current !== null) {
        window.clearTimeout(scaleWheelTimerRef.current);
        scaleWheelTimerRef.current = null;
      }
      scaleGestureScaleRef.current = null;
      scaleGestureSequenceRef.current += 1;
      setPreviewCharacterScale(null);
      isScaleGestureActiveRef.current = false;
      characterDragApplyingRef.current = false;
      lastCharacterDragPointerRef.current = null;
      characterDragMotionRef.current = null;
      setCharacterDragMotion(null);
    };
  }, []);

  const flushCharacterDragPosition = useCallback(async () => {
    if (characterDragApplyingRef.current) {
      return;
    }

    characterDragApplyingRef.current = true;
    try {
      while (characterDragPendingRef.current) {
        const pending = characterDragPendingRef.current;
        characterDragPendingRef.current = null;
        await appWindow.setPosition(new LogicalPosition(Math.round(pending.x), Math.round(pending.y)));
      }
    } finally {
      characterDragApplyingRef.current = false;
      if (characterDragPendingRef.current) {
        void flushCharacterDragPosition();
      }
    }
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

      const previousPointer = lastCharacterDragPointerRef.current ?? pointerDown;
      const instantDeltaX = pointerScreenX - previousPointer.screenX;
      const instantDeltaY = pointerScreenY - previousPointer.screenY;
      lastCharacterDragPointerRef.current = { screenX: pointerScreenX, screenY: pointerScreenY };
      if (!isCharacterDraggingRef.current) {
        setIsCharacterDragging(true);
      }
      isCharacterDraggingRef.current = true;
      const instantDistance = Math.hypot(instantDeltaX, instantDeltaY);
      if (instantDistance >= PET_DRAG_MOTION_DEADZONE_PX) {
        const horizontalDominant = Math.abs(instantDeltaX) >= Math.abs(instantDeltaY) * 0.7;
        const nextMotion = horizontalDominant
          ? instantDeltaX < 0
            ? "running-left"
            : "running-right"
          : "running";
        if (characterDragMotionRef.current !== nextMotion) {
          characterDragMotionRef.current = nextMotion;
          setCharacterDragMotion(nextMotion);
        }
      }
      scheduleCharacterDragPosition(origin.windowX + deltaX, origin.windowY + deltaY);
      return true;
    },
    [scheduleCharacterDragPosition]
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
      await onRestoreMain(false);
      return;
    }

    try {
      const [isVisible, isMinimized] = await Promise.all([
        mainWindow.isVisible(),
        mainWindow.isMinimized(),
      ]);

      if (!isVisible || isMinimized) {
        await onRestoreMain(false);
        return;
      }

      const scaleFactor = await mainWindow.scaleFactor();
      const position = (await mainWindow.outerPosition()).toLogical(scaleFactor);
      const size = (await mainWindow.outerSize()).toLogical(scaleFactor);
      const isOnScreen = isWindowRectVisible(
        { x: Math.round(position.x), y: Math.round(position.y) },
        { width: Math.round(size.width), height: Math.round(size.height) }
      );

      if (!isOnScreen) {
        await onRestoreMain(false);
      }
    } catch {
      await onRestoreMain(false);
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
        characterPointerMovedRef.current = false;
        isCharacterDraggingRef.current = false;
        setIsCharacterDragging(false);
        lastCharacterDragPointerRef.current = null;
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
        characterPointerMovedRef.current = false;
        setIsCharacterDragging(false);
        lastCharacterDragPointerRef.current = null;
        characterDragMotionRef.current = null;
        setCharacterDragMotion(null);
        resetCompactFloatingUi();
        return;
      }

      isCharacterDraggingRef.current = false;
      lastCharacterDragPointerRef.current = null;
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
    characterPointerDownRef.current = null;
    characterDragOriginRef.current = null;
    characterDragPendingRef.current = null;
    if (characterDragRafRef.current !== null) {
      window.cancelAnimationFrame(characterDragRafRef.current);
      characterDragRafRef.current = null;
    }
    if (characterPointerMovedRef.current || isCharacterDraggingRef.current) {
      suppressPetClickUntilRef.current = Date.now() + PET_CLICK_SUPPRESS_AFTER_DRAG_MS;
    }
    characterPointerMovedRef.current = false;
    isCharacterDraggingRef.current = false;
    setIsCharacterDragging(false);
    lastCharacterDragPointerRef.current = null;
    characterDragMotionRef.current = null;
    setCharacterDragMotion(null);
  }, []);

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
        setCompactReply(null);

        const response = await executeChatTurn({
          model: resolvedModel,
          messages: [{ role: "user", content: draft }],
        });
        setCompactReply({ question: draft, answer: response.content, isError: false });
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
      void (async () => {
        try {
          await appWindow.setSize(new LogicalSize(previewSize.width, previewSize.height));
          lastAppliedCompactSizeRef.current = { ...previewSize };
        } catch {
          // Fall back to React-driven resizing if the immediate native resize fails.
        }
        if (scaleGestureSequenceRef.current === gestureSequence && scaleGestureScaleRef.current === nextScale) {
          setPreviewCharacterScale(nextScale);
        }
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
    [characterScale, compactAppearance, markCompactInteraction, setCharacterScale]
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




