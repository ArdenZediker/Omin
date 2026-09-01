import { useEffect, useRef, useState } from "react";
import type * as React from "react";
import { listen } from "@tauri-apps/api/event";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import type { Monitor } from "@tauri-apps/api/window";
import { loadProviderConfigs, modelRegistry } from "../adapters/registry";
import type { Message } from "../adapters/types";
import {
  CHARACTER_SCALE_BASELINE,
  COMPACT_APPEARANCE_OPTIONS,
  CURRENT_MODEL_STORAGE_KEY,
  EXTERNAL_CHAT_ENTRIES,
} from "../app/constants";
import type { BasicSettings, CompactReply, PetThoughtState } from "../app/types";
import {
  getCompactWindowSize,
  getMonitorForCursor,
  getPetThoughtAnchorOffset,
  getStoredCompactPosition,
  moveCompactWindowToMonitor,
  persistCompactPosition,
  type PetThoughtPlacement,
} from "../app/window";
import { bootstrapSqliteStorage, readSqliteBackedValue } from "../app/sqliteStorage";
import { resolveCurrentModelId } from "../chat/modelSelection";
import { USAGE_PREFERENCES_STORAGE_KEY } from "../chat/storage";
import type { ChatSession } from "../chat/types";
import {
  resolvePetMenuViewportOffset,
} from "./compactMenuGeometry";
import {
  toNativePetWindowY,
  toVisualPetWindowY,
  type CharacterDragPosition,
} from "./compactWindowGeometry";
import { appWindow, COMPACT_FOLLOW_CURSOR_SCREEN_INTERVAL_MS } from "./compactWindowRuntime";
import type { CompactAppearance } from "./useCompactWindowState";
import { useCompactPrimitives } from "./useCompactPrimitives";
import { useCompactPetThoughtWindows } from "./useCompactPetThoughtWindows";
import { useCompactCharacterDrag } from "./useCompactCharacterDrag";
import { useCompactMenus } from "./useCompactMenus";

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
  petThoughtQueue: PetThoughtState[];
  petThoughtCount: number;
  petThoughtPlacement: PetThoughtPlacement;
  arePetThoughtsCollapsed: boolean;
  currentModel: string;
  isCompactAppearanceOpen: boolean;
  isCompactMenuOpen: boolean;
  isCompactModelOpen: boolean;
  isCompactQueryOpen: boolean;
  isCompactReplyLoading: boolean;
  isCompactWindow: boolean;
  onRestoreMain: (focusInput?: boolean, options?: { restoreGeometry?: boolean }) => Promise<void>;
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
  setPetThoughtPlacement: React.Dispatch<React.SetStateAction<PetThoughtPlacement>>;
  // 宠物窗口对话接入共享的持久化会话 store（useChatSessions），使宠物对话重启后不丢失、
  // 并出现在工作台的话题列表中。
  chatSessions: ChatSession[];
  activeProjectId: string;
  createSessionFromMessages: (messages: Message[], projectId?: string) => ChatSession;
  updateChatSessionMessages: (
    sessionId: string,
    nextMessages: Message[] | ((current: Message[]) => Message[])
  ) => void;
};

/**
 * 紧凑窗口总控制器。回调逻辑已按子系统拆到独立子钩子：
 *  - useCompactPrimitives —— 原子基础回调（交互标记/失焦抑制/窗口提升/菜单关闭）
 *  - useCompactPetThoughtWindows —— 宠物想法气泡窗口（回调 + E5–E10）
 *  - useCompactCharacterDrag —— 角色/宠物拖拽子系统
 *  - useCompactMenus —— 菜单/缩放/操作子系统
 * 本文件保留全部 useState/useRef 与剩余 effect（E1–E4、E11–E25），
 * effect 注册顺序与拆分前完全一致，行为不变。
 */
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
  petThoughtQueue,
  petThoughtCount,
  petThoughtPlacement,
  arePetThoughtsCollapsed,
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
  setPetThoughtPlacement,
  chatSessions,
  activeProjectId,
  createSessionFromMessages,
  updateChatSessionMessages,
}: UseCompactWindowControllerArgs) {
  const [isCharacterDragging, setIsCharacterDragging] = useState(false);
  const [characterDragMotion, setCharacterDragMotion] = useState<"running-left" | "running-right" | "running" | null>(null);
  const [previewCharacterScale, setPreviewCharacterScale] = useState<number | null>(null);
  const [scaleGestureVersion, setScaleGestureVersion] = useState(0);
  // 已提交的宠物视口偏移。它只在窗口几何（位置/大小）更新完成后才追上目标值，
  // 避免 "CSS offset 已同步应用、但 Tauri setPosition 还是异步" 导致的那一帧跳变
  // （菜单展开/收起时宠物闪烁移动的根因）。
  const [committedPetOffset, setCommittedPetOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const hasPetThought = Boolean(petThought);
  const compactMenuCloseTimerRef = useRef<number | null>(null);
  const compactMenuOpeningRef = useRef(false);
  const isCharacterDraggingRef = useRef(false);
  const characterPointerDownRef = useRef<{ screenX: number; screenY: number } | null>(null);
  const characterDragOriginRef = useRef<{
    screenX: number;
    screenY: number;
    windowX: number;
    windowY: number;
    petViewportOffsetY: number;
  } | null>(null);
  const characterDragRafRef = useRef<number | null>(null);
  const characterDragPendingRef = useRef<CharacterDragPosition | null>(null);
  const characterDragMoveDrainRef = useRef<Promise<void> | null>(null);
  const characterDragWindowMoveActiveRef = useRef(false);
  const characterDragLastTargetRef = useRef<CharacterDragPosition | null>(null);
  const characterDragLastPersistedRef = useRef<CharacterDragPosition | null>(null);
  const characterPointerMovedRef = useRef(false);
  const lastCharacterDragPointerRef = useRef<{ screenX: number; screenY: number } | null>(null);
  const characterDragLastHandledPointerRef = useRef<{ screenX: number; screenY: number } | null>(null);
  const characterDragMotionAccumRef = useRef({ x: 0, y: 0 });
  const characterDragMotionRef = useRef<"running-left" | "running-right" | "running" | null>(null);
  const scaleWheelTimerRef = useRef<number | null>(null);
  const scaleGestureScaleRef = useRef<number | null>(null);
  const scaleGestureSequenceRef = useRef(0);
  const isScaleGestureActiveRef = useRef(false);
  const petThoughtPlacementRef = useRef<PetThoughtPlacement>(petThoughtPlacement);
  const petThoughtStateRef = useRef<PetThoughtState | null>(petThought);
  const petThoughtQueueRef = useRef<PetThoughtState[]>(petThoughtQueue);
  const petThoughtCountRef = useRef<number>(petThoughtCount);
  // 宠物窗口当前正在使用的持久化会话（与工作台共享 useChatSessions store）。
  const activePetSessionIdRef = useRef<string | null>(null);
  const petSessionMessagesRef = useRef<Message[]>([]);
  const petThoughtLayoutRequestRef = useRef(0);
  const lastPetThoughtWindowLayoutRef = useRef<{
    x: number;
    y: number;
    height: number;
    anchorX: number;
    anchorY: number;
    badgeAnchorX: number;
    badgeAnchorY: number;
    placement: PetThoughtPlacement;
  } | null>(null);
  const wasCompactMenuOpenRef = useRef(isCompactMenuOpen);
  const suppressPetClickUntilRef = useRef(0);
  const compactFollowMonitorRef = useRef<string | null>(null);
  const compactFollowMonitorSnapshotRef = useRef<Monitor | null>(null);
  const compactFollowSyncRunningRef = useRef(false);
  const compactInternalMoveRef = useRef(false);
  const compactInteractionUntilRef = useRef(0);
  const compactSuppressBlurUntilRef = useRef(0);
  const lastAppliedCompactSizeRef = useRef<{ width: number; height: number } | null>(null);
  const lastAppliedPetViewportOffsetRef = useRef({ x: 0, y: 0 });
  // 上一次真正应用的「宠物本体尺寸」（不含气泡预留空间）。
  // 以宠物中心为锚点调整窗口位置时，必须用宠物尺寸而不是窗口尺寸：
  // 想法气泡存在时窗口被撑大、宠物被 offset 推离窗口中心，两者并不相等。
  const lastAppliedPetSizeRef = useRef<{ width: number; height: number } | null>(null);
  const petThoughtCollapseHideTimerRef = useRef<number | null>(null);
  const petThoughtCollapseHideVersionRef = useRef(0);

  useEffect(() => {
    petThoughtPlacementRef.current = petThoughtPlacement;
  }, [petThoughtPlacement]);

  useEffect(() => {
    petThoughtStateRef.current = petThought;
  }, [petThought]);

  useEffect(() => {
    petThoughtQueueRef.current = petThoughtQueue;
  }, [petThoughtQueue]);

  useEffect(() => {
    petThoughtCountRef.current = petThoughtCount;
  }, [petThoughtCount]);

  const primitives = useCompactPrimitives({
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
  });

  const pet = useCompactPetThoughtWindows({
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
  });

  const drag = useCompactCharacterDrag({
    compactSize,
    onRestoreMain,
    resetCompactFloatingUi,
    setIsCharacterDragging,
    setCharacterDragMotion,
    markCompactInteraction: primitives.markCompactInteraction,
    suppressCompactBlur: primitives.suppressCompactBlur,
    raiseCompactWindow: primitives.raiseCompactWindow,
    releaseCharacterDragWindowMove: primitives.releaseCharacterDragWindowMove,
    hidePetThoughtWindowForDrag: pet.hidePetThoughtWindowForDrag,
    updatePetThoughtWindowForRect: pet.updatePetThoughtWindowForRect,
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
  });

  const menus = useCompactMenus({
    characterScale,
    compactAppearance,
    compactSize,
    compactViewportSize,
    compactQuery,
    currentModel,
    isCompactWindow,
    isCompactMenuOpen,
    isCompactQueryOpen,
    onRestoreMain,
    closeCompactMenus,
    activeProjectId,
    createSessionFromMessages,
    updateChatSessionMessages,
    setCharacterMenuPosition,
    setCharacterScale,
    setCompactAppearance,
    setCompactMenuSide,
    setCompactSubmenuSide,
    setCompactQuery,
    setCompactReply,
    setCurrentModel,
    setIsCompactAppearanceOpen,
    setIsCompactMenuOpen,
    setIsCompactModelOpen,
    setIsCompactQueryOpen,
    setIsCompactReplyLoading,
    setPreviewCharacterScale,
    setScaleGestureVersion,
    markCompactInteraction: primitives.markCompactInteraction,
    suppressCompactBlur: primitives.suppressCompactBlur,
    raiseCompactWindow: primitives.raiseCompactWindow,
    updatePetThoughtWindowForCurrentPositionAndSize: pet.updatePetThoughtWindowForCurrentPositionAndSize,
    compactMenuCloseTimerRef,
    compactMenuOpeningRef,
    scaleWheelTimerRef,
    scaleGestureScaleRef,
    scaleGestureSequenceRef,
    isScaleGestureActiveRef,
    lastAppliedCompactSizeRef,
    lastAppliedPetSizeRef,
    lastAppliedPetViewportOffsetRef,
    activePetSessionIdRef,
    petSessionMessagesRef,
    isCharacterDraggingRef,
    lastCharacterDragPointerRef,
    characterDragLastHandledPointerRef,
    characterDragMotionAccumRef,
    characterDragMotionRef,
    setCharacterDragMotion,
    setIsCharacterDragging,
  });

  const {
    suppressCompactBlur,
    raiseCompactWindow,
    cancelCompactMenuClose,
    closeCompactMenu,
    closeCompactMenuNow,
  } = primitives;
  const {
    updatePetThoughtWindowForRect,
    updatePetThoughtWindowForCurrentPositionAndSize,
  } = pet;
  const {
    continueCharacterDrag,
    handleCharacterPointerDown,
    handleCharacterPointerMove,
    handleCharacterPointerUp,
    handlePetPointerDown,
    handlePetPointerMove,
    handlePetPointerUp,
    handlePetPrimaryClick,
  } = drag;
  const {
    handleOpenSettingsFromCompact,
    handleOpenCompactQuery,
    handleOpenExternalChat,
    handleCompactQuerySubmit,
    handleCompactWheel,
    handleCompactAppearanceChange,
    handleCompactScaleReset,
    handleCompactDrag,
    openCompactMenu,
    handleCharacterContextMenu,
  } = menus;

  useEffect(() => {
    const previousMenuOpen = wasCompactMenuOpenRef.current;
    wasCompactMenuOpenRef.current = isCompactMenuOpen;

    if (
      compactAppearance !== "pet" ||
      !hasPetThought ||
      isCompactMenuOpen ||
      isCompactQueryOpen ||
      isCompactReplyLoading ||
      compactReply
    ) {
      return;
    }

    void (async () => {
      if (previousMenuOpen !== isCompactMenuOpen) {
        return;
      }
      const scaleFactor = await appWindow.scaleFactor();
      const position = (await appWindow.outerPosition()).toLogical(scaleFactor);
      await updatePetThoughtWindowForRect({
        left: Math.round(position.x),
        top: toVisualPetWindowY(position.y),
        width: compactSize.width,
        height: compactSize.height,
      });
    })();
  }, [
    compactAppearance,
    compactReply,
    compactSize.height,
    compactSize.width,
    isCompactMenuOpen,
    isCompactQueryOpen,
    isCompactReplyLoading,
    hasPetThought,
    updatePetThoughtWindowForRect,
  ]);

  useEffect(() => {
    if (!isCompactWindow) {
      return;
    }

    let unlisten: (() => void) | undefined;
    void listen<{ modelId?: string }>("omni-model-changed", (event) => {
      void (async () => {
        await loadProviderConfigs();
        const resolvedModel = resolveCurrentModelId({
          savedModelId: event.payload?.modelId ?? readSqliteBackedValue(CURRENT_MODEL_STORAGE_KEY),
          registryModelId: modelRegistry.getCurrentModel(),
          availableModels: modelRegistry.getAvailableModels(),
        });
        setCurrentModel(resolvedModel);
      })();
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
    void listen("omni-usage-preferences-changed", () => {
      void bootstrapSqliteStorage([USAGE_PREFERENCES_STORAGE_KEY]);
    }).then((cleanup) => {
      unlisten = cleanup;
    });

    return () => {
      unlisten?.();
    };
  }, [isCompactWindow]);

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

  useEffect(() => {
    if (!isCompactWindow || basicSettings.showCompactBall) {
      return;
    }

    void appWindow.hide();
  }, [basicSettings.showCompactBall, isCompactWindow]);

  useEffect(() => {
    if (!isCompactWindow || !basicSettings.showCompactBall) {
      return;
    }

    let cancelled = false;
    void (async () => {
      const storedPosition = getStoredCompactPosition();
      if (!storedPosition) {
        return;
      }
      const scaleFactor = await appWindow.scaleFactor();
      const currentPosition = (await appWindow.outerPosition()).toLogical(scaleFactor);
      if (cancelled) {
        return;
      }

      const shouldRestorePosition =
        Math.abs(Math.round(currentPosition.x) - storedPosition.x) > 4 ||
        Math.abs(toVisualPetWindowY(currentPosition.y) - storedPosition.y) > 4;
      if (!shouldRestorePosition) {
        return;
      }

      compactInternalMoveRef.current = true;
      await appWindow.setPosition(new LogicalPosition(storedPosition.x, toNativePetWindowY(storedPosition.y)));
      window.setTimeout(() => {
        compactInternalMoveRef.current = false;
      }, 120);
    })().catch(() => undefined);

    return () => {
      cancelled = true;
    };
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
        compactFollowMonitorSnapshotRef.current = null;
      }
      return;
    }

    let cancelled = false;
    const syncCompactMonitor = async () => {
      try {
        if (compactFollowSyncRunningRef.current) {
          return;
        }
        compactFollowSyncRunningRef.current = true;

        if (isCharacterDraggingRef.current || characterPointerDownRef.current) {
          return;
        }

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
          compactFollowMonitorSnapshotRef.current = monitor;
          return;
        }

        const scaleFactor = await appWindow.scaleFactor();
        const currentPosition = (await appWindow.outerPosition()).toLogical(scaleFactor);
        // 二次检查拖拽守卫：syncCompactMonitor 入口检查过守卫，但这里已经
        // await 过 isVisible/monitor/outerPosition，期间用户可能已开始拖拽。
        // 若此时仍 setPosition 会把宠物从拖动位置抢回光标屏锚点，造成闪烁。
        if (isCharacterDraggingRef.current || characterPointerDownRef.current) {
          return;
        }
        const currentLogicalPosition = {
          x: Math.round(currentPosition.x),
          y: Math.round(currentPosition.y),
        };
        const previousMonitor = compactFollowMonitorSnapshotRef.current;
        compactInternalMoveRef.current = true;
        try {
          await moveCompactWindowToMonitor(appWindow, monitor, compactSize, {
            sourceMonitor: previousMonitor,
            currentPosition: previousMonitor ? currentLogicalPosition : null,
            persistPosition: false,
          });
          compactFollowMonitorRef.current = nextMonitorKey;
          compactFollowMonitorSnapshotRef.current = monitor;
        } finally {
          window.setTimeout(() => {
            compactInternalMoveRef.current = false;
          }, 120);
        }
      } catch {
        // Ignore monitor sync failures and keep the current compact position.
      } finally {
        compactFollowSyncRunningRef.current = false;
      }
    };

    void syncCompactMonitor();
    const timer = window.setInterval(() => {
      void syncCompactMonitor();
    }, COMPACT_FOLLOW_CURSOR_SCREEN_INTERVAL_MS);

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
    const shouldReservePetThoughtSpace =
      compactAppearance === "pet" &&
      !previewCharacterScale &&
      (petThoughtCount > 0 || petThoughtQueue.length > 0 || Boolean(petThought)) &&
      !arePetThoughtsCollapsed &&
      !isCompactMenuOpen &&
      !isCompactQueryOpen &&
      !isCompactReplyLoading &&
      !compactReply &&
      Boolean(compactViewportSize);
    const targetPetViewportOffset =
      compactAppearance === "pet" && compactViewportSize
        ? isCompactMenuOpen
          ? resolvePetMenuViewportOffset(compactSize, compactViewportSize, {
              menuSide: compactMenuSide,
              submenuSide: compactSubmenuSide,
            })
          : shouldReservePetThoughtSpace
            ? getPetThoughtAnchorOffset(compactViewportSize, compactSize)
            : { x: 0, y: 0 }
        : { x: 0, y: 0 };
    void (async () => {
      const scaleFactor = await appWindow.scaleFactor();
      const currentPosition = (await appWindow.outerPosition()).toLogical(scaleFactor);
      const currentSize = (await appWindow.outerSize()).toLogical(scaleFactor);
      suppressCompactBlur();
      if (compactAppearance === "pet") {
        const hasSizeChanged =
          !lastAppliedCompactSizeRef.current ||
          Math.round(lastAppliedCompactSizeRef.current.width) !== Math.round(targetSize.width) ||
          Math.round(lastAppliedCompactSizeRef.current.height) !== Math.round(targetSize.height);
        const currentSizeChanged =
          Math.round(currentSize.width) !== Math.round(targetSize.width) ||
          Math.round(currentSize.height) !== Math.round(targetSize.height);
        const previousPetViewportOffset = lastAppliedPetViewportOffsetRef.current;
        const hasPetViewportOffsetChanged =
          previousPetViewportOffset.x !== targetPetViewportOffset.x ||
          previousPetViewportOffset.y !== targetPetViewportOffset.y;
        if (hasSizeChanged || currentSizeChanged || hasPetViewportOffsetChanged) {
          // 以「宠物中心」为锚点：宠物中心在窗口内 = viewportOffset + 宠物本体尺寸/2。
          // 注意必须用宠物尺寸，不能用窗口尺寸——想法气泡存在时窗口被撑大、
          // 宠物被 offset 推离窗口中心，两者不相等，用窗口尺寸会让宠物上下乱跳。
          const previousPetSize = lastAppliedPetSizeRef.current ?? compactSize;
          const prevCenterX = previousPetViewportOffset.x + previousPetSize.width / 2;
          const prevCenterY = previousPetViewportOffset.y + previousPetSize.height / 2;
          const nextCenterX = targetPetViewportOffset.x + previewCompactSize.width / 2;
          const nextCenterY = targetPetViewportOffset.y + previewCompactSize.height / 2;
          const nextX = Math.round(currentPosition.x + prevCenterX - nextCenterX);
          const nextVisualY = toVisualPetWindowY(currentPosition.y) + prevCenterY - nextCenterY;
          compactInternalMoveRef.current = true;
          await Promise.all([
            appWindow.setPosition(new LogicalPosition(nextX, toNativePetWindowY(nextVisualY))),
            appWindow.setSize(new LogicalSize(targetSize.width, targetSize.height)),
            updatePetThoughtWindowForCurrentPositionAndSize(targetSize),
          ]);
          window.setTimeout(() => {
            compactInternalMoveRef.current = false;
          }, 120);
          lastAppliedCompactSizeRef.current = { ...targetSize };
          lastAppliedPetSizeRef.current = { ...previewCompactSize };
          lastAppliedPetViewportOffsetRef.current = targetPetViewportOffset;
          setCommittedPetOffset(targetPetViewportOffset);
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
    arePetThoughtsCollapsed,
    petThought,
    petThoughtCount,
    petThoughtQueue.length,
    petThoughtPlacement,
    scaleGestureVersion,
    suppressCompactBlur,
    updatePetThoughtWindowForCurrentPositionAndSize,
  ]);

  useEffect(() => {
    if (!isCompactWindow) {
      return;
    }

    let unlisten: (() => void) | undefined;
    void appWindow
      .onMoved(async (event) => {
        if (isCharacterDraggingRef.current) {
          return;
        }
        if (characterDragWindowMoveActiveRef.current) {
          return;
        }
        const scaleFactor = await appWindow.scaleFactor();
        const pos = event.payload.toLogical(scaleFactor);
        const petOffset = lastAppliedPetViewportOffsetRef.current;
        const isPetAppearance = compactAppearance === "pet";
        // 记录「宠物本体」的视觉位置而不是窗口位置：想法气泡/菜单展开时宠物会被
        // --pet-viewport-offset-* 推离窗口左上角，直接记窗口坐标的话，
        // 气泡消失/重启后宠物会整体跑偏。想法气泡窗口同样锚在宠物本体上。
        const visualPos = {
          x: Math.round(pos.x) + (isPetAppearance ? petOffset.x : 0),
          y: isPetAppearance ? toVisualPetWindowY(pos.y) + petOffset.y : Math.round(pos.y),
        };
        if (!compactInternalMoveRef.current) {
          persistCompactPosition(visualPos);
          characterDragLastPersistedRef.current = visualPos;
        }
        await updatePetThoughtWindowForRect({
          left: visualPos.x,
          top: visualPos.y,
          width: compactSize.width,
          height: compactSize.height,
        });
      })
      .then((fn) => {
        unlisten = fn;
      });

    return () => {
      unlisten?.();
    };
  }, [compactAppearance, compactSize.height, compactSize.width, isCompactWindow, updatePetThoughtWindowForRect]);

  useEffect(() => {
    return () => {
      if (compactMenuCloseTimerRef.current !== null) {
        window.clearTimeout(compactMenuCloseTimerRef.current);
      }
      if (characterDragRafRef.current !== null) {
        window.cancelAnimationFrame(characterDragRafRef.current);
        characterDragRafRef.current = null;
      }
      characterDragMoveDrainRef.current = null;
      characterDragWindowMoveActiveRef.current = false;
      characterDragLastTargetRef.current = null;
      if (scaleWheelTimerRef.current !== null) {
        window.clearTimeout(scaleWheelTimerRef.current);
        scaleWheelTimerRef.current = null;
      }
      scaleGestureScaleRef.current = null;
      scaleGestureSequenceRef.current += 1;
      setPreviewCharacterScale(null);
      isScaleGestureActiveRef.current = false;
      lastCharacterDragPointerRef.current = null;
      characterDragLastHandledPointerRef.current = null;
      characterDragMotionAccumRef.current = { x: 0, y: 0 };
      characterDragMotionRef.current = null;
      setCharacterDragMotion(null);
    };
  }, []);

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

  useEffect(() => {
    if (!isCompactWindow) {
      return;
    }

    // Drop any drag state that survived without a matching mouseup (e.g. the
    // release happened outside the webview while dragging the floating pet).
    // Without this, a stuck `characterPointerDownRef` makes every later
    // mousemove silently drag the pet to follow the cursor — it looks like the
    // pet jumps to other positions on its own.
    const resetStaleDragState = () => {
      if (
        !characterPointerDownRef.current &&
        !isCharacterDraggingRef.current &&
        !characterDragPendingRef.current &&
        !characterPointerMovedRef.current
      ) {
        return;
      }
      characterPointerDownRef.current = null;
      characterDragOriginRef.current = null;
      characterDragLastTargetRef.current = null;
      characterPointerMovedRef.current = false;
      isCharacterDraggingRef.current = false;
      characterDragMotionAccumRef.current = { x: 0, y: 0 };
      characterDragMotionRef.current = null;
      lastCharacterDragPointerRef.current = null;
      characterDragLastHandledPointerRef.current = null;
      if (characterDragRafRef.current !== null) {
        window.cancelAnimationFrame(characterDragRafRef.current);
        characterDragRafRef.current = null;
      }
      characterDragPendingRef.current = null;
      characterDragMoveDrainRef.current = null;
      characterDragWindowMoveActiveRef.current = false;
      compactInternalMoveRef.current = false;
      setCharacterDragMotion(null);
    };

    const onWindowMouseMove = (event: MouseEvent) => {
      // Only a real drag (primary button held) may move the pet. If the button
      // is already up, any armed drag is stale — clear it instead of following
      // the cursor.
      if (!(event.buttons & 1)) {
        resetStaleDragState();
        return;
      }
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

    const onWindowBlur = () => {
      resetStaleDragState();
    };

    window.addEventListener("mousemove", onWindowMouseMove, { capture: true });
    window.addEventListener("mouseup", onWindowMouseUp, { capture: true });
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("mousemove", onWindowMouseMove, { capture: true });
      window.removeEventListener("mouseup", onWindowMouseUp, { capture: true });
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [continueCharacterDrag, handleCharacterPointerUp, isCompactWindow]);

  // 启动后把宠物窗口绑定到上一次的持久化会话：之后在宠物窗口的提问会继续追加到
  // 这个会话（出现在工作台话题列表里），但**不再把上一轮问答回填进回答气泡**——
  // 那样每次启动都会莫名其妙冒出上次的回答。
  useEffect(() => {
    if (activePetSessionIdRef.current !== null) return;
    const target = [...chatSessions]
      .filter((session) => session.projectId === activeProjectId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!target) return;
    const messages = target.messages ?? [];
    petSessionMessagesRef.current = messages;
    activePetSessionIdRef.current = target.id;
  }, [chatSessions, activeProjectId]);

  return {
    appearanceOptions: COMPACT_APPEARANCE_OPTIONS,
    cancelCompactMenuClose,
    closeCompactMenu,
    closeCompactMenuNow,
    entries: EXTERNAL_CHAT_ENTRIES,
    handleCharacterContextMenu,
    handleCharacterPointerDown,
    handleCharacterPointerMove,
    handleCharacterPointerUp,
    handlePetPointerDown,
    handlePetPointerMove,
    handlePetPointerUp,
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
    committedPetOffset,
  };
}
