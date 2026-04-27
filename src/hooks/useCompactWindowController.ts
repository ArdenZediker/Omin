import { useCallback, useEffect, useRef } from "react";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
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

type UseCompactWindowControllerArgs = {
  basicSettings: BasicSettings;
  characterPanelSide: "left" | "right";
  clearCompactReply: () => void;
  closeCompactMenuPanels: () => void;
  closeCompactMenus: () => void;
  compactAppearance: CompactAppearance;
  compactQuery: string;
  compactReply: CompactReply | null;
  compactSize: { width: number; height: number };
  compactViewportSize: { width: number; height: number } | null;
  currentModel: string;
  effectiveCompactScale: number;
  isCharacterAppearance: boolean;
  isCharacterMenuPinned: boolean;
  isCompactMenuOpen: boolean;
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
  characterPanelSide,
  clearCompactReply,
  closeCompactMenuPanels,
  closeCompactMenus,
  compactAppearance,
  compactQuery,
  compactReply,
  compactSize,
  compactViewportSize,
  currentModel,
  effectiveCompactScale,
  isCharacterAppearance,
  isCharacterMenuPinned,
  isCompactMenuOpen,
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
  const characterDragTimerRef = useRef<number | null>(null);
  const isCharacterDraggingRef = useRef(false);
  const compactFollowMonitorRef = useRef<string | null>(null);

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
      compactFollowMonitorRef.current = null;
      return;
    }

    let cancelled = false;
    const syncCompactMonitor = async () => {
      try {
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

    let unlisten: (() => void) | undefined;
    void appWindow
      .onFocusChanged(({ payload }) => {
        if (payload) {
          void appWindow.setAlwaysOnTop(true);
          return;
        }
        resetCompactFloatingUi();
      })
      .then((fn) => {
        unlisten = fn;
      });

    return () => {
      unlisten?.();
    };
  }, [isCompactWindow, resetCompactFloatingUi]);

  useEffect(() => {
    if (!isCompactWindow) {
      return;
    }

    const targetSize = compactViewportSize ?? compactSize;
    void (async () => {
      if (isCharacterAppearance) {
        const scaleFactor = await appWindow.scaleFactor();
        const currentSize = (await appWindow.outerSize()).toLogical(scaleFactor);
        const currentPosition = (await appWindow.outerPosition()).toLogical(scaleFactor);
        const anchorRight = characterPanelSide === "left";
        const nextX = anchorRight
          ? Math.round(currentPosition.x + currentSize.width - targetSize.width)
          : Math.round(currentPosition.x);

        await Promise.all([
          appWindow.setPosition(new LogicalPosition(nextX, Math.round(currentPosition.y))),
          appWindow.setSize(new LogicalSize(targetSize.width, targetSize.height)),
        ]);
        return;
      }

      await appWindow.setSize(new LogicalSize(targetSize.width, targetSize.height));
    })();
  }, [characterPanelSide, compactSize, compactViewportSize, isCharacterAppearance, isCompactWindow]);

  useEffect(() => {
    if (!isCompactWindow) {
      return;
    }

    let unlisten: (() => void) | undefined;
    void appWindow
      .onMoved(async (event) => {
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

  const handleCompactDrag = useCallback(
    async (event: React.MouseEvent<HTMLDivElement>) => {
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
        await appWindow.startDragging();
      }
    },
    [
      compactAppearance,
      isCharacterMenuPinned,
      setCompactReply,
      setIsCharacterMenuPinned,
      setIsCharacterModelOpen,
      setIsCompactAppearanceOpen,
      setIsCompactMenuOpen,
      setIsCompactModelOpen,
      setIsCompactQueryOpen,
    ]
  );

  const openCompactMenu = useCallback(() => {
    if (compactMenuCloseTimerRef.current !== null) {
      window.clearTimeout(compactMenuCloseTimerRef.current);
      compactMenuCloseTimerRef.current = null;
    }
    if (isCompactQueryOpen) {
      return;
    }
    setIsCompactMenuOpen(true);
    setIsCompactModelOpen(false);
    setIsCompactAppearanceOpen(false);
    setIsCharacterModelOpen(false);
    setIsCharacterMenuPinned(false);
    setIsCompactQueryOpen(false);
  }, [
    isCompactQueryOpen,
    setIsCharacterMenuPinned,
    setIsCharacterModelOpen,
    setIsCompactAppearanceOpen,
    setIsCompactMenuOpen,
    setIsCompactModelOpen,
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

      const nextSide = await resolveCharacterPanelSide();
      setCharacterPanelSide(nextSide);
      const scaleFactor = await appWindow.scaleFactor();
      const currentSize = (await appWindow.outerSize()).toLogical(scaleFactor);
      const expandedSize = getExpandedCompactViewportSizeForAppearance(compactAppearance, effectiveCompactScale, {
        includeReply: false,
        includeHorizontalPanel: false,
      });
      const expandedDelta = Math.max(0, expandedSize.width - currentSize.width);
      const menuWidth = 176;
      const menuHeight = 260;
      const futureMouseX = nextSide === "left" ? event.clientX + expandedDelta : event.clientX;

      setCharacterMenuPosition({
        x: Math.max(8, Math.min(futureMouseX, expandedSize.width - menuWidth - 8)),
        y: Math.max(8, Math.min(event.clientY, Math.max(window.innerHeight, expandedSize.height) - menuHeight - 8)),
      });
      setIsCompactMenuOpen(true);
      setIsCompactModelOpen(false);
      setIsCompactAppearanceOpen(false);
      setIsCharacterModelOpen(false);
      setIsCharacterMenuPinned(true);
      setIsCompactQueryOpen(false);
    },
    [
      compactAppearance,
      effectiveCompactScale,
      resolveCharacterPanelSide,
      setCharacterMenuPosition,
      setCharacterPanelSide,
      setIsCharacterMenuPinned,
      setIsCharacterModelOpen,
      setIsCompactAppearanceOpen,
      setIsCompactMenuOpen,
      setIsCompactModelOpen,
      setIsCompactQueryOpen,
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
