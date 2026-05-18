import { useCallback, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { currentMonitor, cursorPosition, getCurrentWindow, monitorFromPoint } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { loadProviderConfigs, modelRegistry } from "../adapters/registry";
import { readSqliteBackedValue } from "../app/sqliteStorage";
import { executeChatTurn } from "../chat/engine";
import {
  COMPACT_APPEARANCE_OPTIONS,
  COMPACT_MENU_CLOSE_DELAY_MS,
  CURRENT_MODEL_STORAGE_KEY,
  EXTERNAL_CHAT_ENTRIES,
  MAIN_WINDOW_LABEL,
} from "../app/constants";
import type { BasicSettings, CompactReply } from "../app/types";
import type { CompactAppearance } from "./useCompactWindowState";
import {
  clampCharacterScale,
  type CompactAppearance as CompactAppearanceType,
} from "./useCompactWindowState";
import {
  getMonitorForCursor,
  getPetCompactMenuViewport,
  isCharacterPointerInHitArea,
  isCharacterPointerInResizeArea,
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
  closeCompactMenuPanels: () => void;
  closeCompactMenus: () => void;
  characterScale: number;
  compactAppearance: CompactAppearance;
  compactMenuSide: "left" | "right";
  compactSubmenuSide: "left" | "right";
  compactQuery: string;
  compactReply: CompactReply | null;
  compactSize: { width: number; height: number };
  compactViewportSize: { width: number; height: number } | null;
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
  closeCompactMenuPanels,
  closeCompactMenus,
  characterScale,
  compactAppearance,
  compactMenuSide,
  compactSubmenuSide,
  compactQuery,
  compactReply,
  compactSize,
  compactViewportSize,
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
  const PET_CLICK_DRAG_THRESHOLD_PX = 6;
  const PET_CLICK_SUPPRESS_AFTER_DRAG_MS = 320;
  const PET_RESIZE_SCALE_PER_PIXEL = 0.005;
  const compactMenuCloseTimerRef = useRef<number | null>(null);
  const compactMenuOpeningRef = useRef(false);
  const characterDragTimerRef = useRef<number | null>(null);
  const isCharacterDraggingRef = useRef(false);
  const characterPointerDownRef = useRef<{ x: number; y: number } | null>(null);
  const characterPointerMovedRef = useRef(false);
  const characterResizeRef = useRef<{ startClientY: number; startScale: number } | null>(null);
  const suppressPetClickUntilRef = useRef(0);
  const compactFollowMonitorRef = useRef<string | null>(null);
  const compactInternalMoveRef = useRef(false);
  const compactInteractionUntilRef = useRef(0);
  const compactSuppressBlurUntilRef = useRef(0);
  const lastAppliedCompactSizeRef = useRef<{ width: number; height: number } | null>(null);
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
      await appWindow.setAlwaysOnTop(false);
    } catch {
      // Ignore z-order refresh failures.
    }
    await appWindow.setAlwaysOnTop(true);
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
          void raiseCompactWindow();
          resetCompactFloatingUi();
        }).catch(() => {
          if (payload) {
            void raiseCompactWindow();
            return;
          }
          if (Date.now() <= compactSuppressBlurUntilRef.current) {
            return;
          }
          void raiseCompactWindow();
          resetCompactFloatingUi();
        });
      })
      .then((fn) => {
        unlisten = fn;
      });

    return () => {
      unlisten?.();
    };
  }, [isCompactWindow, raiseCompactWindow, resetCompactFloatingUi]);

  useEffect(() => {
    if (!isCompactWindow || !basicSettings.showCompactBall) {
      return;
    }

    let cancelled = false;
    const ensureTopmost = async () => {
      try {
        if (cancelled) {
          return;
        }
        const isVisible = await appWindow.isVisible();
        if (!isVisible) {
          return;
        }
        await appWindow.setAlwaysOnTop(false);
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

    const targetSize = compactViewportSize ?? compactSize;
    const isCompactSubmenuOpen = isCompactMenuOpen && (isCompactModelOpen || isCompactAppearanceOpen);
    void (async () => {
      const scaleFactor = await appWindow.scaleFactor();
      const currentPosition = (await appWindow.outerPosition()).toLogical(scaleFactor);
      const currentSize = (await appWindow.outerSize()).toLogical(scaleFactor);
      suppressCompactBlur();
      if (compactAppearance === "pet") {
        await appWindow.setAlwaysOnTop(true);
        const lastSize = lastAppliedCompactSizeRef.current;
        const hasSizeChanged =
          !lastSize ||
          Math.round(lastSize.width) !== Math.round(targetSize.width) ||
          Math.round(lastSize.height) !== Math.round(targetSize.height);
        const currentSizeChanged =
          Math.round(currentSize.width) !== Math.round(targetSize.width) ||
          Math.round(currentSize.height) !== Math.round(targetSize.height);

        if (hasSizeChanged || currentSizeChanged) {
          if (compactAppearance === "pet") {
            const nextX = Math.round(currentPosition.x - (targetSize.width - currentSize.width) / 2);
            if (nextX !== Math.round(currentPosition.x)) {
              compactInternalMoveRef.current = true;
              await appWindow.setPosition(new LogicalPosition(nextX, Math.round(currentPosition.y)));
              window.setTimeout(() => {
                compactInternalMoveRef.current = false;
              }, 120);
            }
          }
          await appWindow.setSize(new LogicalSize(targetSize.width, targetSize.height));
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
    isCompactAppearanceOpen,
    isCompactMenuOpen,
    isCompactModelOpen,
    isCompactQueryOpen,
    isCompactReplyLoading,
    isCompactWindow,
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
      if (characterDragTimerRef.current !== null) {
        window.clearTimeout(characterDragTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isCompactWindow) {
      return;
    }

    const handleMouseMove = (event: MouseEvent) => {
      const resizeState = characterResizeRef.current;
      if (!resizeState) {
        return;
      }

      const nextScale = clampCharacterScale(
        resizeState.startScale + (resizeState.startClientY - event.clientY) * PET_RESIZE_SCALE_PER_PIXEL
      );

      characterPointerMovedRef.current = true;
      setCharacterScale(nextScale);
    };

    const finishResize = () => {
      if (!characterResizeRef.current) {
        return;
      }

      characterResizeRef.current = null;
      characterPointerDownRef.current = null;
      if (characterPointerMovedRef.current) {
        suppressPetClickUntilRef.current = Date.now() + PET_CLICK_SUPPRESS_AFTER_DRAG_MS;
      }
      characterPointerMovedRef.current = false;
      isCharacterDraggingRef.current = false;
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", finishResize);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", finishResize);
    };
  }, [isCompactWindow, setCharacterScale]);

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
    await raiseCompactWindow();

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
  }, [onRestoreMain, raiseCompactWindow, suppressCompactBlur]);

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
      event.stopPropagation();
      if (event.button !== 0) {
        clearPendingDragTimer(characterDragTimerRef.current);
        characterDragTimerRef.current = null;
        characterPointerDownRef.current = null;
        characterPointerMovedRef.current = false;
        characterResizeRef.current = null;
        return;
      }

      if (compactAppearance === "pet" && isCharacterPointerInResizeArea(event.currentTarget, event.clientX, event.clientY)) {
        clearPendingDragTimer(characterDragTimerRef.current);
        characterDragTimerRef.current = null;
        isCharacterDraggingRef.current = false;
        characterPointerDownRef.current = { x: event.clientX, y: event.clientY };
        characterPointerMovedRef.current = false;
        characterResizeRef.current = {
          startClientY: event.clientY,
          startScale: characterScale,
        };
        return;
      }

      const isInCharacterHitArea = isCharacterPointerInHitArea(event.currentTarget, event.clientX, event.clientY);
      if (!isInCharacterHitArea) {
        clearPendingDragTimer(compactMenuCloseTimerRef.current);
        compactMenuCloseTimerRef.current = null;
        characterPointerDownRef.current = null;
        characterPointerMovedRef.current = false;
        characterResizeRef.current = null;
        resetCompactFloatingUi();
        return;
      }

      isCharacterDraggingRef.current = false;
      characterPointerDownRef.current = { x: event.clientX, y: event.clientY };
      characterPointerMovedRef.current = false;
      clearPendingDragTimer(characterDragTimerRef.current);
      characterDragTimerRef.current = window.setTimeout(() => {
        isCharacterDraggingRef.current = true;
        characterPointerMovedRef.current = true;
        void appWindow.startDragging();
        characterDragTimerRef.current = null;
      }, 180);
    },
    [characterScale, compactAppearance, resetCompactFloatingUi]
  );

  const handleCharacterPointerMove = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    if (characterResizeRef.current) {
      return;
    }

    const pointerDown = characterPointerDownRef.current;
    if (!pointerDown) {
      return;
    }

    const deltaX = event.clientX - pointerDown.x;
    const deltaY = event.clientY - pointerDown.y;
    if (Math.hypot(deltaX, deltaY) < PET_CLICK_DRAG_THRESHOLD_PX) {
      return;
    }

    characterPointerMovedRef.current = true;
  }, []);

  const handleCharacterPointerUp = useCallback(() => {
    clearPendingDragTimer(characterDragTimerRef.current);
    characterDragTimerRef.current = null;
    if (characterResizeRef.current) {
      characterResizeRef.current = null;
    }
    characterPointerDownRef.current = null;
    if (characterPointerMovedRef.current || isCharacterDraggingRef.current) {
      suppressPetClickUntilRef.current = Date.now() + PET_CLICK_SUPPRESS_AFTER_DRAG_MS;
    }
    characterPointerMovedRef.current = false;
    isCharacterDraggingRef.current = false;
  }, []);

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
      event.preventDefault();
      setCharacterScale((value) => clampCharacterScale(value + (event.deltaY < 0 ? 0.08 : -0.08)));
    },
    [compactAppearance, setCharacterScale]
  );

  const handleCompactAppearanceChange = useCallback(
    (appearance: CompactAppearanceType) => {
      setCompactAppearance(appearance);
      closeCompactMenus();
    },
    [closeCompactMenus, setCompactAppearance]
  );

  const handleCompactScaleReset = useCallback(() => {
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
      clearPendingDragTimer(characterDragTimerRef.current);
      characterDragTimerRef.current = null;
      isCharacterDraggingRef.current = false;
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
    openCompactMenu,
  };
}




