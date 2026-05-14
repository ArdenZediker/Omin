import { useCallback, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { currentMonitor, cursorPosition, getCurrentWindow, monitorFromPoint } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { loadProviderConfigs, modelRegistry } from "../adapters/registry";
import { readSqliteBackedValue } from "../app/sqliteStorage";
import { executeChatTurn } from "../chat/engine";
import {
  CHARACTER_MODEL_OPTIONS,
  COMPACT_APPEARANCE_OPTIONS,
  COMPACT_MENU_CLOSE_DELAY_MS,
  CURRENT_MODEL_STORAGE_KEY,
  EXTERNAL_CHAT_ENTRIES,
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
  getPetCompactMenuViewport,
  isCharacterPointerInHitArea,
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
  isOutsidePinnedCharacterMenu,
  shouldCloseCharacterReplyPanel,
} from "./compactInteractionGuards";

const appWindow = getCurrentWindow();

type UseCompactWindowControllerArgs = {
  basicSettings: BasicSettings;
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

        compactFollowMonitorRef.current = nextMonitorKey;
        await moveCompactWindowToMonitor(appWindow, monitor, compactSize);
      } catch {
        // 蹇界暐鏄剧ず鍣ㄥ悓姝ュけ璐?
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
        if (Date.now() <= compactSuppressBlurUntilRef.current) {
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
        await appWindow.setAlwaysOnTop(false);
        await appWindow.setAlwaysOnTop(true);
      } catch {
        // 韫囩晫鏆愮純顕€銆婇幁銏狀槻婢惰精瑙?      }
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
      suppressCompactBlur();
      if (isCharacterAppearance || compactAppearance === "pet") {
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
    isCharacterModelOpen,
    isCharacterAppearance,
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
    if (!isCompactWindow || isCharacterMenuPinned || (!isCompactMenuOpen && !isCompactQueryOpen)) {
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
  }, [closeCompactMenuNow, isCharacterMenuPinned, isCompactMenuOpen, isCompactQueryOpen, isCompactWindow]);

  useEffect(() => {
    if (!isCompactWindow || !isCharacterMenuPinned || !isCompactMenuOpen) {
      return;
    }

    const closeOnBlur = () => {
      if (Date.now() <= compactSuppressBlurUntilRef.current) {
        return;
      }
      closeCompactMenuNow();
    };
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
    await showSettingsWindow();
  }, [closeCompactMenus]);

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
    suppressCompactBlur();
    closeCompactMenus();
    if (isCompactWindow && isCharacterAppearance) {
      setCharacterPanelSide(await resolveCharacterPanelSide());
    }
    setIsCompactQueryOpen(true);
  }, [closeCompactMenus, isCharacterAppearance, isCompactWindow, resolveCharacterPanelSide, setCharacterPanelSide, setIsCompactQueryOpen, suppressCompactBlur]);

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
        return;
      }

      const isInCharacterHitArea = isCharacterPointerInHitArea(event.currentTarget, event.clientX, event.clientY);
      if (!isInCharacterHitArea) {
        clearPendingDragTimer(compactMenuCloseTimerRef.current);
        compactMenuCloseTimerRef.current = null;
        resetCompactFloatingUi();
        return;
      }

      isCharacterDraggingRef.current = false;
      clearPendingDragTimer(characterDragTimerRef.current);
      characterDragTimerRef.current = window.setTimeout(() => {
        isCharacterDraggingRef.current = true;
        void appWindow.startDragging();
        characterDragTimerRef.current = null;
      }, 180);
    },
    [compactAppearance, resetCompactFloatingUi]
  );

  const handleCharacterPointerUp = useCallback(() => {
    clearPendingDragTimer(characterDragTimerRef.current);
    characterDragTimerRef.current = null;
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
        setCompactReply({ question: draft, answer: error instanceof Error ? error.message : "鏌ヨ澶辫触", isError: true });
      } finally {
        setIsCompactReplyLoading(false);
      }
    },
    [compactQuery, currentModel, onRestoreMain, setCompactQuery, setCompactReply, setCurrentModel, setIsCompactQueryOpen, setIsCompactReplyLoading]
  );

  const handleCompactWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (compactAppearance !== "character" && compactAppearance !== "pet") {
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
      markCompactInteraction();
      void raiseCompactWindow();
      const target = event.target as HTMLElement;
      if (isCharacterMenuPinned && isOutsidePinnedCharacterMenu(target)) {
        setIsCharacterMenuPinned(false);
        setIsCompactMenuOpen(false);
        setIsCompactModelOpen(false);
        setIsCompactAppearanceOpen(false);
        setIsCharacterModelOpen(false);
      }

      if (compactAppearance === "character" && shouldCloseCharacterReplyPanel(target)) {
        setIsCompactQueryOpen(false);
        setCompactReply(null);
      }

      if (compactAppearance === "character") {
        return;
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
    suppressCompactBlur,
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
      suppressCompactBlur();
      clearPendingDragTimer(characterDragTimerRef.current);
      characterDragTimerRef.current = null;
      isCharacterDraggingRef.current = false;
      clearPendingDragTimer(compactMenuCloseTimerRef.current);
      compactMenuCloseTimerRef.current = null;

      const nextCharacterPanelSide = await resolveCharacterPanelSide();
      setCharacterPanelSide(nextCharacterPanelSide);

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
      setIsCharacterModelOpen(false);
      setIsCharacterMenuPinned(true);
      setIsCompactQueryOpen(false);
    },
    [
      resolveCharacterPanelSide,
      resolveCompactMenuSides,
      suppressCompactBlur,
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
    handleCompactQuerySubmit,
    handleCompactScaleReset,
    handleCompactWheel,
    handleOpenCompactQuery,
    handleOpenExternalChat,
    handleOpenSettingsFromCompact,
    isCharacterDragging: isCharacterDraggingRef.current,
    openCompactMenu,
  };
}
