import { useCallback, useEffect, useRef } from "react";
import { currentMonitor, cursorPosition, getCurrentWindow, monitorFromPoint } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { loadProviderConfigs, modelRegistry } from "../adapters/registry";
import { executeChatTurn } from "../chat/engine";
import {
  CHARACTER_MODEL_OPTIONS,
  COMPACT_APPEARANCE_OPTIONS,
  COMPACT_MENU_CLOSE_DELAY_MS,
  CURRENT_MODEL_STORAGE_KEY,
  EXTERNAL_CHAT_ENTRIES,
  MAIN_VIEW_STORAGE_KEY,
  MAIN_WINDOW_LABEL,
} from "../app/constants";
import type { BasicSettings, CompactReply } from "../app/types";
import type { CharacterModel, CompactAppearance } from "./useCompactWindowState";
import {
  clampCharacterScale,
  type CharacterModel as CharacterModelType,
  type CompactAppearance as CompactAppearanceType,
} from "./useCompactWindowState";
import {
  getExpandedCompactViewportSizeForAppearance,
  getMonitorForCursor,
  isCharacterPointerInHitArea,
  moveCompactWindowToMonitor,
  openInternalChatWindow,
  persistCompactPosition,
  restoreMainWindow,
} from "../app/window";

const appWindow = getCurrentWindow();
const COMPACT_MENU_HEIGHT = 280;
const COMPACT_MENU_EDGE_PADDING = 8;
const COMPACT_MENU_WIDTH = 200;
const COMPACT_MENU_GAP = 6;
const COMPACT_MENU_SUBMENU_WIDTH = 176;
const COMPACT_DRAG_START_THRESHOLD = 6;
const COMPACT_INTERACTION_GUARD_MS = 1200;

function clampToRange(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

type UseCompactWindowControllerArgs = {
  basicSettings: BasicSettings;
  clearCompactReply: () => void;
  closeCompactMenuPanels: () => void;
  closeCompactMenus: () => void;
  compactAppearance: CompactAppearance;
  compactMenuSide: "left" | "right";
  compactSubmenuSide: "left" | "right";
  compactQuery: string;
  compactReply: CompactReply | null;
  compactSize: { width: number; height: number };
  compactViewportSize: { width: number; height: number } | null;
  currentModel: string;
  effectiveCompactScale: number;
  isCharacterAppearance: boolean;
  isCharacterMenuPinned: boolean;
  isCharacterModelOpen: boolean;
  isCompactAppearanceOpen: boolean;
  isCompactMenuOpen: boolean;
  isCompactModelOpen: boolean;
  isCompactQueryOpen: boolean;
  isCompactReplyLoading: boolean;
  isCompactWindow: boolean;
  onRestoreMain: (focusInput?: boolean) => Promise<void>;
  resetCompactFloatingUi: () => void;
  setCharacterMenuPosition: React.Dispatch<React.SetStateAction<{ x: number; y: number } | null>>;
  setCharacterModel: React.Dispatch<React.SetStateAction<CharacterModel>>;
  setCharacterPanelSide: React.Dispatch<React.SetStateAction<"left" | "right">>;
  setCharacterScale: React.Dispatch<React.SetStateAction<number>>;
  setCompactAppearance: React.Dispatch<React.SetStateAction<CompactAppearance>>;
  setCompactQuery: React.Dispatch<React.SetStateAction<string>>;
  setCompactReply: React.Dispatch<React.SetStateAction<CompactReply | null>>;
  setCompactMenuSide: React.Dispatch<React.SetStateAction<"left" | "right">>;
  setCompactSubmenuSide: React.Dispatch<React.SetStateAction<"left" | "right">>;
  setCurrentModel: React.Dispatch<React.SetStateAction<string>>;
  setIsCharacterMenuPinned: React.Dispatch<React.SetStateAction<boolean>>;
  setIsCharacterModelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsCompactAppearanceOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsCompactMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsCompactModelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsCompactQueryOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsCompactReplyLoading: React.Dispatch<React.SetStateAction<boolean>>;
};

export function useCompactWindowController({
  basicSettings,
  clearCompactReply,
  closeCompactMenuPanels,
  closeCompactMenus,
  compactAppearance,
  compactMenuSide,
  compactSubmenuSide,
  compactQuery,
  compactReply,
  compactSize,
  compactViewportSize,
  currentModel,
  effectiveCompactScale,
  isCharacterAppearance,
  isCharacterMenuPinned,
  isCharacterModelOpen,
  isCompactAppearanceOpen,
  isCompactMenuOpen,
  isCompactModelOpen,
  isCompactQueryOpen,
  isCompactReplyLoading,
  isCompactWindow,
  onRestoreMain,
  resetCompactFloatingUi,
  setCharacterMenuPosition,
  setCharacterModel,
  setCharacterPanelSide,
  setCharacterScale,
  setCompactAppearance,
  setCompactQuery,
  setCompactReply,
  setCompactMenuSide,
  setCompactSubmenuSide,
  setCurrentModel,
  setIsCharacterMenuPinned,
  setIsCharacterModelOpen,
  setIsCompactAppearanceOpen,
  setIsCompactMenuOpen,
  setIsCompactModelOpen,
  setIsCompactQueryOpen,
  setIsCompactReplyLoading,
}: UseCompactWindowControllerArgs) {
  const compactMenuCloseTimerRef = useRef<number | null>(null);
  const compactMenuOpeningRef = useRef(false);
  const characterDragTimerRef = useRef<number | null>(null);
  const isCharacterDraggingRef = useRef(false);
  const compactFollowMonitorRef = useRef<string | null>(null);
  const compactInternalMoveRef = useRef(false);
  const compactInteractionUntilRef = useRef(0);
  const compactUserDraggingRef = useRef(false);
  const compactUserDragIdleTimerRef = useRef<number | null>(null);
  const compactDragStartRef = useRef<{ x: number; y: number } | null>(null);
  const compactViewportAnchorSideRef = useRef<"left" | null>(null);

  const markCompactInteraction = useCallback(() => {
    compactInteractionUntilRef.current = Date.now() + COMPACT_INTERACTION_GUARD_MS;
  }, []);

  const raiseCompactWindow = useCallback(async () => {
    if (!isCompactWindow) {
      return;
    }

    await appWindow.setAlwaysOnTop(true);
    await appWindow.show();
  }, [isCompactWindow]);

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
    const menuFootprint = COMPACT_MENU_WIDTH + COMPACT_MENU_GAP;
    const submenuFootprint = COMPACT_MENU_SUBMENU_WIDTH + COMPACT_MENU_GAP;
    const menuSide =
      rightSpace >= menuFootprint
        ? ("right" as const)
        : leftSpace >= menuFootprint
          ? ("left" as const)
          : leftSpace > rightSpace
            ? ("left" as const)
            : ("right" as const);
    const submenuSide =
      menuSide === "right"
        ? rightSpace - menuFootprint >= submenuFootprint
          ? ("right" as const)
          : ("left" as const)
        : leftSpace - menuFootprint >= submenuFootprint
          ? ("left" as const)
          : ("right" as const);

    return { menuSide, submenuSide };
  }, [isCompactWindow]);

  const resolveCompactMenuPosition = useCallback(
    async (anchorX: number, anchorY: number, side: "left" | "right") => {
      const scaleFactor = await appWindow.scaleFactor();
      const windowSize = (await appWindow.outerSize()).toLogical(scaleFactor);
      const viewportWidth = compactViewportSize?.width ?? windowSize.width;
      const viewportHeight = compactViewportSize?.height ?? windowSize.height;
      const minLeft =
        side === "left"
          ? COMPACT_MENU_SUBMENU_WIDTH + COMPACT_MENU_GAP + COMPACT_MENU_EDGE_PADDING
          : COMPACT_MENU_EDGE_PADDING;
      const maxLeft =
        side === "right"
          ? Math.max(
              COMPACT_MENU_EDGE_PADDING,
              viewportWidth -
                COMPACT_MENU_WIDTH -
                COMPACT_MENU_SUBMENU_WIDTH -
                COMPACT_MENU_GAP -
                COMPACT_MENU_EDGE_PADDING
            )
          : Math.max(minLeft, viewportWidth - COMPACT_MENU_WIDTH - COMPACT_MENU_EDGE_PADDING);
      const minTop = COMPACT_MENU_EDGE_PADDING;
      const maxTop = Math.max(
        minTop,
        viewportHeight - COMPACT_MENU_HEIGHT - COMPACT_MENU_EDGE_PADDING
      );

      return {
        x: Math.round(
          clampToRange(
            side === "left" ? anchorX - COMPACT_MENU_WIDTH - COMPACT_MENU_GAP : anchorX + COMPACT_MENU_GAP,
            minLeft,
            maxLeft
          )
        ),
        y: Math.round(clampToRange(anchorY - 16, minTop, maxTop)),
      };
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
      !compactReply &&
      !isCharacterMenuPinned;

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

        const sourceMonitor = await currentMonitor();
        const scaleFactor = await appWindow.scaleFactor();
        const currentPosition = (await appWindow.outerPosition()).toLogical(scaleFactor);

        compactFollowMonitorRef.current = nextMonitorKey;
        await moveCompactWindowToMonitor(appWindow, monitor, compactSize, {
          sourceMonitor,
          currentPosition: { x: Math.round(currentPosition.x), y: Math.round(currentPosition.y) },
          persistPosition: false,
        });
      } catch {
        // 忽略显示器同步失败
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
    isCharacterMenuPinned,
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
        if (payload) {
          void raiseCompactWindow();
          return;
        }
        void raiseCompactWindow();
        resetCompactFloatingUi();
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
        await appWindow.setAlwaysOnTop(true);
      } catch {
        // 忽略置顶恢复失败
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
    const isCompactSubmenuOpen = isCompactMenuOpen && (isCompactModelOpen || isCompactAppearanceOpen || isCharacterModelOpen);
    void (async () => {
      const scaleFactor = await appWindow.scaleFactor();
      const currentPosition = (await appWindow.outerPosition()).toLogical(scaleFactor);
      const currentSize = (await appWindow.outerSize()).toLogical(scaleFactor);
      if (isCharacterAppearance) {
        compactViewportAnchorSideRef.current = null;
        await appWindow.setSize(new LogicalSize(targetSize.width, targetSize.height));
        return;
      }

      const shouldAnchorLeft =
        (isCompactMenuOpen && !isCharacterMenuPinned && compactMenuSide === "left") ||
        (isCompactSubmenuOpen && compactSubmenuSide === "left");
      const shouldRestoreFromLeftAnchor = compactViewportAnchorSideRef.current === "left" && compactViewportSize === null;

      if (shouldAnchorLeft || shouldRestoreFromLeftAnchor) {
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
      compactViewportAnchorSideRef.current = shouldAnchorLeft ? "left" : null;
      await appWindow.setAlwaysOnTop(true);
    })();
  }, [
    compactReply,
    compactSize,
    compactViewportSize,
    compactMenuSide,
    compactSubmenuSide,
    isCharacterModelOpen,
    isCharacterAppearance,
    isCompactAppearanceOpen,
    isCompactMenuOpen,
    isCompactModelOpen,
    isCompactQueryOpen,
    isCompactReplyLoading,
    isCompactWindow,
  ]);

  useEffect(() => {
    if (!isCompactWindow) {
      return;
    }

    let unlisten: (() => void) | undefined;
    void appWindow
      .onMoved(async (event) => {
        if (compactInternalMoveRef.current || basicSettings.followCursorScreen || !compactUserDraggingRef.current) {
          return;
        }
        const scaleFactor = await appWindow.scaleFactor();
        const pos = event.payload.toLogical(scaleFactor);
        persistCompactPosition({ x: Math.round(pos.x), y: Math.round(pos.y) });
        if (compactUserDragIdleTimerRef.current !== null) {
          window.clearTimeout(compactUserDragIdleTimerRef.current);
        }
        compactUserDragIdleTimerRef.current = window.setTimeout(() => {
          compactUserDraggingRef.current = false;
          compactUserDragIdleTimerRef.current = null;
        }, 180);
      })
      .then((fn) => {
        unlisten = fn;
      });

    return () => {
      unlisten?.();
    };
  }, [basicSettings.followCursorScreen, isCompactWindow]);

  useEffect(() => {
    return () => {
      if (compactMenuCloseTimerRef.current !== null) {
        window.clearTimeout(compactMenuCloseTimerRef.current);
      }
      if (characterDragTimerRef.current !== null) {
        window.clearTimeout(characterDragTimerRef.current);
      }
      if (compactUserDragIdleTimerRef.current !== null) {
        window.clearTimeout(compactUserDragIdleTimerRef.current);
      }
    };
  }, []);

  const closeCompactMenu = useCallback(() => {
    if (isCharacterMenuPinned) {
      return;
    }

    if (compactMenuCloseTimerRef.current !== null) {
      window.clearTimeout(compactMenuCloseTimerRef.current);
    }

    compactMenuCloseTimerRef.current = window.setTimeout(() => {
      closeCompactMenuPanels();
      compactMenuCloseTimerRef.current = null;
    }, COMPACT_MENU_CLOSE_DELAY_MS);
  }, [closeCompactMenuPanels, isCharacterMenuPinned]);

  const closeCompactMenuNow = useCallback(() => {
    if (compactMenuCloseTimerRef.current !== null) {
      window.clearTimeout(compactMenuCloseTimerRef.current);
      compactMenuCloseTimerRef.current = null;
    }

    setIsCharacterMenuPinned(false);
    closeCompactMenuPanels();
  }, [closeCompactMenuPanels, setIsCharacterMenuPinned]);

  useEffect(() => {
    if (!isCompactWindow || isCharacterAppearance || isCharacterMenuPinned || !isCompactMenuOpen) {
      return;
    }

    const isPointInsideInteractiveArea = (x: number, y: number) => {
      const selectors = [".compact-bar", ".compact-menu", ".compact-submenu", ".compact-search-popover"];
      const padding = 8;
      return selectors.some((selector) =>
        Array.from(document.querySelectorAll<HTMLElement>(selector)).some((element) => {
          const rect = element.getBoundingClientRect();
          return x >= rect.left - padding && x <= rect.right + padding && y >= rect.top - padding && y <= rect.bottom + padding;
        })
      );
    };

    const scheduleCloseIfOutside = (event: MouseEvent) => {
      if (isPointInsideInteractiveArea(event.clientX, event.clientY)) {
        if (compactMenuCloseTimerRef.current !== null) {
          window.clearTimeout(compactMenuCloseTimerRef.current);
          compactMenuCloseTimerRef.current = null;
        }
        return;
      }
      closeCompactMenu();
    };

    window.addEventListener("mousemove", scheduleCloseIfOutside);
    window.addEventListener("mouseleave", closeCompactMenuNow);
    window.addEventListener("blur", closeCompactMenuNow);
    document.addEventListener("visibilitychange", closeCompactMenuNow);
    return () => {
      window.removeEventListener("mousemove", scheduleCloseIfOutside);
      window.removeEventListener("mouseleave", closeCompactMenuNow);
      window.removeEventListener("blur", closeCompactMenuNow);
      document.removeEventListener("visibilitychange", closeCompactMenuNow);
    };
  }, [closeCompactMenu, closeCompactMenuNow, isCharacterAppearance, isCharacterMenuPinned, isCompactMenuOpen, isCompactWindow]);

  useEffect(() => {
    if (!isCompactWindow || !isCharacterMenuPinned || !isCompactMenuOpen) {
      return;
    }

    const closeOnBlur = () => closeCompactMenuNow();
    window.addEventListener("blur", closeOnBlur);
    window.addEventListener("mouseleave", closeOnBlur);
    document.addEventListener("visibilitychange", closeOnBlur);
    return () => {
      window.removeEventListener("blur", closeOnBlur);
      window.removeEventListener("mouseleave", closeOnBlur);
      document.removeEventListener("visibilitychange", closeOnBlur);
    };
  }, [closeCompactMenuNow, isCharacterMenuPinned, isCompactMenuOpen, isCompactWindow]);

  const handleOpenSettingsFromCompact = useCallback(async () => {
    closeCompactMenus();
    localStorage.setItem(MAIN_VIEW_STORAGE_KEY, "settings");
    await restoreMainWindow(false);
    const mainWindow = await WebviewWindow.getByLabel(MAIN_WINDOW_LABEL);
    await mainWindow?.emit("omni-open-settings");
  }, [closeCompactMenus]);

  const handleToggleMainFromCompact = useCallback(async () => {
    await appWindow.setAlwaysOnTop(true);
    closeCompactMenus();
    setIsCompactQueryOpen(false);
    clearCompactReply();

    const mainWindow = await WebviewWindow.getByLabel(MAIN_WINDOW_LABEL);
    if (!mainWindow) {
      await restoreMainWindow(false);
      return;
    }

    try {
      const isVisible = await mainWindow.isVisible();
      const isMinimized = await mainWindow.isMinimized();
      if (isVisible && !isMinimized) {
        await mainWindow.hide();
        return;
      }
    } catch {
      // 忽略状态检查失败
    }

    await restoreMainWindow(false);
  }, [clearCompactReply, closeCompactMenus, setIsCompactQueryOpen]);

  const resolveCharacterPanelSide = useCallback(async () => {
    if (!isCompactWindow || !isCharacterAppearance) {
      return "left" as const;
    }

    const scaleFactor = await appWindow.scaleFactor();
    const currentPosition = (await appWindow.outerPosition()).toLogical(scaleFactor);
    const currentSize = (await appWindow.outerSize()).toLogical(scaleFactor);
    const monitor = await currentMonitor();
    const monitorScale = monitor?.scaleFactor || scaleFactor || 1;
    const workAreaLeft = monitor ? monitor.workArea.position.x / monitorScale : 0;
    const workAreaWidth = monitor
      ? monitor.workArea.size.width / monitorScale
      : Number(window.screen.availWidth || window.screen.width || 0);
    const workAreaRight = workAreaLeft + workAreaWidth;
    const expandedSize = getExpandedCompactViewportSizeForAppearance(compactAppearance, effectiveCompactScale, {
      includeReply: true,
      includeHorizontalPanel: false,
    });
    const panelWidth = Math.max(176, expandedSize.width - compactSize.width + 12);
    const leftSpace = Math.max(0, currentPosition.x - workAreaLeft);
    const rightSpace = Math.max(0, workAreaRight - (currentPosition.x + currentSize.width));
    const canOpenLeft = leftSpace >= panelWidth;
    const canOpenRight = rightSpace >= panelWidth;

    if (!canOpenLeft && canOpenRight) {
      return "right" as const;
    }
    if (canOpenLeft && !canOpenRight) {
      return "left" as const;
    }

    return leftSpace >= rightSpace ? "left" as const : "right" as const;
  }, [compactAppearance, compactSize.width, effectiveCompactScale, isCharacterAppearance, isCompactWindow]);

  const handleOpenCompactQuery = useCallback(async () => {
    closeCompactMenus();
    if (isCompactWindow && isCharacterAppearance) {
      setCharacterPanelSide(await resolveCharacterPanelSide());
    }
    setIsCompactQueryOpen(true);
  }, [closeCompactMenus, isCharacterAppearance, isCompactWindow, resolveCharacterPanelSide, setCharacterPanelSide, setIsCompactQueryOpen]);

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
        if (characterDragTimerRef.current !== null) {
          window.clearTimeout(characterDragTimerRef.current);
          characterDragTimerRef.current = null;
        }
        return;
      }

      const isInCharacterHitArea = isCharacterPointerInHitArea(event.currentTarget, event.clientX, event.clientY);
      if (!isInCharacterHitArea) {
        if (compactMenuCloseTimerRef.current !== null) {
          window.clearTimeout(compactMenuCloseTimerRef.current);
          compactMenuCloseTimerRef.current = null;
        }
        resetCompactFloatingUi();
        return;
      }

      isCharacterDraggingRef.current = false;
      if (characterDragTimerRef.current !== null) {
        window.clearTimeout(characterDragTimerRef.current);
      }
      characterDragTimerRef.current = window.setTimeout(() => {
        isCharacterDraggingRef.current = true;
        void appWindow.startDragging();
        characterDragTimerRef.current = null;
      }, 180);
    },
    [resetCompactFloatingUi]
  );

  const handleCharacterPointerUp = useCallback(() => {
    if (characterDragTimerRef.current !== null) {
      window.clearTimeout(characterDragTimerRef.current);
      characterDragTimerRef.current = null;
    }
  }, []);

  const handleCompactQuerySubmit = useCallback(
    async (openMain = false) => {
      const draft = compactQuery.trim();
      if (!draft) {
        return;
      }

      loadProviderConfigs();
      const savedModel = localStorage.getItem(CURRENT_MODEL_STORAGE_KEY);
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

        setCompactReply({ question: draft, answer: response.content });
        setIsCompactQueryOpen(false);
        setCompactQuery("");
      } catch (error) {
        setCompactReply({ question: draft, answer: error instanceof Error ? error.message : "查询失败" });
      } finally {
        setIsCompactReplyLoading(false);
      }
    },
    [compactQuery, currentModel, onRestoreMain, setCompactQuery, setCompactReply, setCurrentModel, setIsCompactQueryOpen, setIsCompactReplyLoading]
  );

  const handleCompactWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (compactAppearance !== "character") {
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

  const handleCharacterModelChange = useCallback(
    (model: CharacterModelType) => {
      setCharacterModel(model);
      closeCompactMenus();
    },
    [closeCompactMenus, setCharacterModel]
  );

  const handleCompactScaleReset = useCallback(() => {
    setCharacterScale(1);
    closeCompactMenus();
  }, [closeCompactMenus, setCharacterScale]);

  const handleCompactPointerUp = useCallback(() => {
    compactDragStartRef.current = null;
  }, []);

  const handleCompactDrag = useCallback(
    async (event: React.MouseEvent<HTMLDivElement>) => {
      markCompactInteraction();
      void raiseCompactWindow();
      const target = event.target as HTMLElement;
      if (isCharacterMenuPinned && !target.closest(".compact-menu") && !target.closest(".compact-menu-anchor")) {
        setIsCharacterMenuPinned(false);
        setIsCompactMenuOpen(false);
        setIsCompactModelOpen(false);
        setIsCompactAppearanceOpen(false);
        setIsCharacterModelOpen(false);
      }

      if (
        compactAppearance === "character" &&
        !target.closest(".compact-menu-anchor") &&
        !target.closest(".compact-query") &&
        !target.closest(".compact-reply")
      ) {
        setIsCompactQueryOpen(false);
        setCompactReply(null);
      }

      if (compactAppearance === "character") {
        return;
      }
      if (target.closest(".no-drag")) {
        return;
      }
      if (event.button === 0) {
        compactDragStartRef.current = { x: event.clientX, y: event.clientY };
      }
    },
    [
      compactAppearance,
      isCharacterMenuPinned,
      markCompactInteraction,
      raiseCompactWindow,
      setCompactReply,
      setIsCharacterMenuPinned,
      setIsCharacterModelOpen,
      setIsCompactAppearanceOpen,
      setIsCompactMenuOpen,
      setIsCompactModelOpen,
      setIsCompactQueryOpen,
    ]
  );

  const handleCompactPointerMove = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!compactDragStartRef.current || compactAppearance === "character") {
      return;
    }

    const deltaX = Math.abs(event.clientX - compactDragStartRef.current.x);
    const deltaY = Math.abs(event.clientY - compactDragStartRef.current.y);
    if (deltaX < COMPACT_DRAG_START_THRESHOLD && deltaY < COMPACT_DRAG_START_THRESHOLD) {
      return;
    }

    compactDragStartRef.current = null;
    compactUserDraggingRef.current = true;
    if (compactUserDragIdleTimerRef.current !== null) {
      window.clearTimeout(compactUserDragIdleTimerRef.current);
      compactUserDragIdleTimerRef.current = null;
    }
    void appWindow.startDragging();
  }, [compactAppearance]);

  const openCompactMenu = useCallback(async (anchorClientX?: number, anchorClientY?: number) => {
    markCompactInteraction();
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
      const { menuSide, submenuSide } = await resolveCompactMenuSides(anchorX, anchorY);
      setCompactMenuSide(menuSide);
      setCompactSubmenuSide(submenuSide);
      setCharacterMenuPosition(await resolveCompactMenuPosition(anchorX, anchorY, menuSide));
      setIsCompactMenuOpen(true);
      setIsCompactModelOpen(false);
      setIsCompactAppearanceOpen(false);
      setIsCharacterModelOpen(false);
      setIsCharacterMenuPinned(false);
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
    setIsCharacterMenuPinned,
    setIsCharacterModelOpen,
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
      if (characterDragTimerRef.current !== null) {
        window.clearTimeout(characterDragTimerRef.current);
        characterDragTimerRef.current = null;
      }
      isCharacterDraggingRef.current = false;
      if (compactMenuCloseTimerRef.current !== null) {
        window.clearTimeout(compactMenuCloseTimerRef.current);
        compactMenuCloseTimerRef.current = null;
      }

      const nextCharacterPanelSide = await resolveCharacterPanelSide();
      setCharacterPanelSide(nextCharacterPanelSide);

      const { menuSide, submenuSide } = await resolveCompactMenuSides(event.clientX, event.clientY);
      const menuPosition = await resolveCompactMenuPosition(event.clientX, event.clientY, menuSide);

      setCompactMenuSide(menuSide);
      setCompactSubmenuSide(submenuSide);
      setCharacterMenuPosition(menuPosition);
      setIsCompactMenuOpen(true);
      setIsCompactModelOpen(false);
      setIsCompactAppearanceOpen(false);
      setIsCharacterModelOpen(false);
      setIsCharacterMenuPinned(true);
      setIsCompactQueryOpen(false);
    },
    [
      resolveCharacterPanelSide,
      resolveCompactMenuSides,
      setCharacterMenuPosition,
      setCharacterPanelSide,
      setIsCharacterMenuPinned,
      setIsCharacterModelOpen,
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
    characterModelOptions: CHARACTER_MODEL_OPTIONS,
    closeCompactMenu,
    closeCompactMenuNow,
    entries: EXTERNAL_CHAT_ENTRIES,
    handleCharacterContextMenu,
    handleCharacterModelChange,
    handleCharacterPointerDown,
    handleCharacterPointerUp,
    handleCompactAppearanceChange,
    handleCompactDrag,
    handleCompactPointerMove,
    handleCompactPointerUp,
    handleCompactQuerySubmit,
    handleCompactScaleReset,
    handleCompactWheel,
    handleOpenCompactQuery,
    handleOpenExternalChat,
    handleOpenSettingsFromCompact,
    handleToggleMainFromCompact,
    isCharacterDragging: isCharacterDraggingRef.current,
    openCompactMenu,
  };
}
