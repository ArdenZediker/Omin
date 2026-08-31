import { useCallback, type MutableRefObject } from "react";
import type * as React from "react";
import { currentMonitor, cursorPosition, monitorFromPoint } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { loadProviderConfigs, modelRegistry } from "../adapters/registry";
import type { Message } from "../adapters/types";
import {
  CHARACTER_SCALE_BASELINE,
  CURRENT_MODEL_STORAGE_KEY,
  EXTERNAL_CHAT_ENTRIES,
  MAIN_WINDOW_LABEL,
} from "../app/constants";
import type { CompactReply } from "../app/types";
import type { ChatSession } from "../chat/types";
import {
  getCompactWindowSize,
  getPetCompactMenuViewport,
  openInternalChatWindow,
  showSettingsWindow,
} from "../app/window";
import { readSqliteBackedValue } from "../app/sqliteStorage";
import { executeChatTurn } from "../chat/engine";
import { resolveCurrentModelId } from "../chat/modelSelection";
import {
  resolveCompactMenuPositionFromViewport,
  resolveCompactMenuSidesFromSpace,
  resolvePetMenuAnchorX,
  resolvePetMenuAnchorY,
} from "./compactMenuGeometry";
import {
  toNativePetWindowY,
  toVisualPetWindowY,
} from "./compactWindowGeometry";
import {
  clearPendingDragTimer,
  isNoDragTarget,
  shouldCloseCharacterReplyPanel,
} from "./compactInteractionGuards";
import { appWindow } from "./compactWindowRuntime";
import type { CompactAppearance } from "./useCompactWindowState";
import { clampCharacterScale } from "./useCompactWindowState";

type UseCompactMenusArgs = {
  characterScale: number;
  compactAppearance: CompactAppearance;
  compactSize: { width: number; height: number };
  compactViewportSize: { width: number; height: number } | null;
  compactQuery: string;
  currentModel: string;
  isCompactWindow: boolean;
  isCompactMenuOpen: boolean;
  isCompactQueryOpen: boolean;
  onRestoreMain: (focusInput?: boolean, options?: { restoreGeometry?: boolean }) => Promise<void>;
  closeCompactMenus: () => void;
  activeProjectId: string;
  createSessionFromMessages: (messages: Message[], projectId?: string) => ChatSession;
  updateChatSessionMessages: (
    sessionId: string,
    nextMessages: Message[] | ((current: Message[]) => Message[])
  ) => void;
  setCharacterMenuPosition: React.Dispatch<React.SetStateAction<{ x: number; y: number } | null>>;
  setCharacterScale: React.Dispatch<React.SetStateAction<number>>;
  setCompactAppearance: React.Dispatch<React.SetStateAction<CompactAppearance>>;
  setCompactMenuSide: React.Dispatch<React.SetStateAction<"left" | "right">>;
  setCompactSubmenuSide: React.Dispatch<React.SetStateAction<"left" | "right">>;
  setCompactQuery: React.Dispatch<React.SetStateAction<string>>;
  setCompactReply: React.Dispatch<React.SetStateAction<CompactReply | null>>;
  setCurrentModel: React.Dispatch<React.SetStateAction<string>>;
  setIsCompactAppearanceOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsCompactMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsCompactModelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsCompactQueryOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsCompactReplyLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setPreviewCharacterScale: React.Dispatch<React.SetStateAction<number | null>>;
  setScaleGestureVersion: React.Dispatch<React.SetStateAction<number>>;
  // 交叉依赖：由主控制器注入其它子系统的回调/ref。
  markCompactInteraction: () => void;
  suppressCompactBlur: (durationMs?: number) => void;
  raiseCompactWindow: () => Promise<void>;
  updatePetThoughtWindowForCurrentPositionAndSize: (size: { width: number; height: number }) => Promise<void>;
  compactMenuCloseTimerRef: MutableRefObject<number | null>;
  compactMenuOpeningRef: MutableRefObject<boolean>;
  scaleWheelTimerRef: MutableRefObject<number | null>;
  scaleGestureScaleRef: MutableRefObject<number | null>;
  scaleGestureSequenceRef: MutableRefObject<number>;
  isScaleGestureActiveRef: MutableRefObject<boolean>;
  lastAppliedCompactSizeRef: MutableRefObject<{ width: number; height: number } | null>;
  lastAppliedPetSizeRef: MutableRefObject<{ width: number; height: number } | null>;
  lastAppliedPetViewportOffsetRef: MutableRefObject<{ x: number; y: number }>;
  activePetSessionIdRef: MutableRefObject<string | null>;
  petSessionMessagesRef: MutableRefObject<Message[]>;
  isCharacterDraggingRef: MutableRefObject<boolean>;
  lastCharacterDragPointerRef: MutableRefObject<{ screenX: number; screenY: number } | null>;
  characterDragLastHandledPointerRef: MutableRefObject<{ screenX: number; screenY: number } | null>;
  characterDragMotionAccumRef: MutableRefObject<{ x: number; y: number }>;
  characterDragMotionRef: MutableRefObject<"running-left" | "running-right" | "running" | null>;
  setCharacterDragMotion: React.Dispatch<
    React.SetStateAction<"running-left" | "running-right" | "running" | null>
  >;
  setIsCharacterDragging: React.Dispatch<React.SetStateAction<boolean>>;
};

/**
 * 紧凑窗口菜单/缩放/操作子系统：菜单定位、右键菜单、缩放手势、查询提交、外部操作入口。
 */
export function useCompactMenus(args: UseCompactMenusArgs) {
  const {
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
    markCompactInteraction,
    suppressCompactBlur,
    raiseCompactWindow,
    updatePetThoughtWindowForCurrentPositionAndSize,
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
  } = args;

  const resolveCompactMenuSides = useCallback(async (
    anchorX?: number,
    anchorY?: number,
    viewportOverride?: { width: number; height: number },
    anchorXOverride?: number,
    petCompactSize?: { width: number; height: number }
  ) => {
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
    const viewportWidth = viewportOverride?.width ?? compactViewportSize?.width ?? currentSize.width / scaleFactor;
    const viewportAnchorX = typeof anchorXOverride === "number" ? anchorXOverride : Number(anchorX);
    const viewportLeftSpace = Number.isFinite(viewportAnchorX) ? Math.max(0, viewportAnchorX) : undefined;
    const viewportRightSpace = Number.isFinite(viewportAnchorX)
      ? Math.max(0, viewportWidth - viewportAnchorX)
      : undefined;
    return resolveCompactMenuSidesFromSpace(leftSpace, rightSpace, {
      viewportLeftSpace,
      viewportRightSpace,
      petCompactSize,
      petViewportSize: viewportOverride,
    });
  }, [compactViewportSize, isCompactWindow]);

  const resolveCompactMenuPosition = useCallback(
    async (
      anchorX: number,
      anchorY: number,
      side: "left" | "right",
      submenuSide: "left" | "right",
      viewportOverride?: { width: number; height: number }
    ) => {
      const scaleFactor = await appWindow.scaleFactor();
      const windowSize = (await appWindow.outerSize()).toLogical(scaleFactor);
      const viewportWidth = viewportOverride?.width ?? compactViewportSize?.width ?? windowSize.width;
      const viewportHeight = viewportOverride?.height ?? compactViewportSize?.height ?? windowSize.height;
      return resolveCompactMenuPositionFromViewport(anchorX, anchorY, side, submenuSide, viewportWidth, viewportHeight);
    },
    [compactViewportSize]
  );

  const handleOpenSettingsFromCompact = useCallback(async () => {
    closeCompactMenus();
    await showSettingsWindow();
  }, [closeCompactMenus]);

  const handleOpenCompactQuery = useCallback(async () => {
    suppressCompactBlur();
    closeCompactMenus();
    setIsCompactQueryOpen(true);
  }, [closeCompactMenus, setIsCompactQueryOpen, suppressCompactBlur]);

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

  const handleCompactQuerySubmit = useCallback(
    async (openMain = false) => {
      const draft = compactQuery.trim();
      if (!draft) {
        return;
      }

      await loadProviderConfigs();
      const savedModel = readSqliteBackedValue(CURRENT_MODEL_STORAGE_KEY);
      const resolvedModel = resolveCurrentModelId({
        savedModelId: savedModel,
        registryModelId: modelRegistry.getCurrentModel(),
        availableModels: modelRegistry.getAvailableModels(),
      });
      if (!resolvedModel) {
        return;
      }
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

        let streamedAnswer = "";
        const response = await executeChatTurn({
          model: resolvedModel,
          messages: [{ role: "user", content: draft }],
          onChunk: (chunk) => {
            streamedAnswer += chunk;
          },
        });
        const finalAnswer = response.content || streamedAnswer;

        // 把这一轮问答写入共享持久化 store，使宠物对话重启后不丢失，
        // 并出现在工作台的话题列表中。
        const nextMessages: Message[] = [
          ...petSessionMessagesRef.current,
          { role: "user", content: draft },
          { role: "project", content: finalAnswer },
        ];
        petSessionMessagesRef.current = nextMessages;
        if (activePetSessionIdRef.current) {
          updateChatSessionMessages(activePetSessionIdRef.current, nextMessages);
        } else {
          const session = createSessionFromMessages(nextMessages, activeProjectId);
          activePetSessionIdRef.current = session.id;
        }

        setIsCompactQueryOpen(false);
        setCompactQuery("");
        setIsCompactQueryOpen(false);
        setCompactQuery("");
      } catch (error) {
        // 回答气泡已移除，错误不再显示在宠物窗口；需要时可在工作台查看。
      } finally {
        setIsCompactReplyLoading(false);
      }
    },
    [compactQuery, currentModel, onRestoreMain, setCompactQuery, setCurrentModel, setIsCompactQueryOpen, setIsCompactReplyLoading, activeProjectId, createSessionFromMessages, updateChatSessionMessages]
  );

  const handleCompactWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (compactAppearance !== "pet") {
        return;
      }
      // 鼠标在可滚动面板上滚动时，让面板自己处理滚动，不要缩放宠物。
      const target = event.target;
      if (
        target instanceof Element &&
        (target.closest(".compact-reply") ||
          target.closest(".pet-thought-bubble") ||
          target.closest(".compact-query"))
      ) {
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
      setPreviewCharacterScale(nextScale);
      void updatePetThoughtWindowForCurrentPositionAndSize(previewSize).catch(() => undefined);
      void (async () => {
        try {
          const scaleFactor = await appWindow.scaleFactor();
          const currentPosition = (await appWindow.outerPosition()).toLogical(scaleFactor);
          // 以「宠物中心」为锚点：想法气泡存在时窗口被撑大、宠物被 offset 推开，
          // 所以要用 offset + 宠物本体尺寸/2 算中心，而不是用窗口尺寸。
          const previousPetSize = lastAppliedPetSizeRef.current ?? compactSize;
          const previousPetViewportOffset = lastAppliedPetViewportOffsetRef.current;
          const prevCenterX = previousPetViewportOffset.x + previousPetSize.width / 2;
          const prevCenterY = previousPetViewportOffset.y + previousPetSize.height / 2;
          const nextX = Math.round(currentPosition.x + prevCenterX - previewSize.width / 2);
          const nextVisualY = toVisualPetWindowY(currentPosition.y) + prevCenterY - previewSize.height / 2;
          await appWindow.setPosition(new LogicalPosition(nextX, toNativePetWindowY(nextVisualY)));
          await appWindow.setSize(new LogicalSize(previewSize.width, previewSize.height));
          lastAppliedCompactSizeRef.current = { ...previewSize };
          lastAppliedPetSizeRef.current = { ...previewSize };
          // 预览缩放期间不预留气泡空间，窗口就是宠物本体，offset 归零。
          lastAppliedPetViewportOffsetRef.current = { x: 0, y: 0 };
        } catch {
          // Fall back to React-driven resizing if the immediate native resize fails.
        }
        if (scaleGestureSequenceRef.current !== gestureSequence || scaleGestureScaleRef.current !== nextScale) {
          return;
        }
        void updatePetThoughtWindowForCurrentPositionAndSize(previewSize).catch(() => undefined);
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
    [characterScale, compactAppearance, compactSize, markCompactInteraction, setCharacterScale, updatePetThoughtWindowForCurrentPositionAndSize]
  );

  const handleCompactAppearanceChange = useCallback(
    (appearance: CompactAppearance) => {
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
    if (compactMenuCloseTimerRef.current !== null) {
      window.clearTimeout(compactMenuCloseTimerRef.current);
      compactMenuCloseTimerRef.current = null;
    }
    await raiseCompactWindow();
    if (compactMenuOpeningRef.current || isCompactMenuOpen) {
      return;
    }

    compactMenuOpeningRef.current = true;
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
      const petMenuViewport =
        compactAppearance === "pet"
          ? getPetCompactMenuViewport(compactSize)
          : null;
      const { menuSide, submenuSide } = await resolveCompactMenuSides(anchorX, anchorY, petMenuViewport ?? undefined, undefined, compactSize);
      const menuAnchorX = petMenuViewport
        ? resolvePetMenuAnchorX(compactSize, petMenuViewport, { menuSide, submenuSide })
        : anchorX;
      const menuAnchorY = petMenuViewport
        ? resolvePetMenuAnchorY(compactSize, petMenuViewport, anchorY, { menuSide, submenuSide })
        : anchorY;
      setCompactMenuSide(menuSide);
      setCompactSubmenuSide(submenuSide);
      setCharacterMenuPosition(await resolveCompactMenuPosition(menuAnchorX, menuAnchorY, menuSide, submenuSide, petMenuViewport ?? undefined));
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
      characterDragLastHandledPointerRef.current = null;
      characterDragMotionAccumRef.current = { x: 0, y: 0 };
      characterDragMotionRef.current = null;
      setCharacterDragMotion(null);
      clearPendingDragTimer(compactMenuCloseTimerRef.current);
      compactMenuCloseTimerRef.current = null;

      const petMenuViewport =
        compactAppearance === "pet"
          ? getPetCompactMenuViewport(compactSize)
          : null;
      const { menuSide, submenuSide } = await resolveCompactMenuSides(
        event.clientX,
        event.clientY,
        petMenuViewport ?? undefined,
        undefined,
        compactSize
      );
      const menuAnchorX = petMenuViewport
        ? resolvePetMenuAnchorX(compactSize, petMenuViewport, { menuSide, submenuSide })
        : event.clientX;
      const menuAnchorY = petMenuViewport
        ? resolvePetMenuAnchorY(compactSize, petMenuViewport, event.clientY, { menuSide, submenuSide })
        : event.clientY;
      const menuPosition = await resolveCompactMenuPosition(
        menuAnchorX,
        menuAnchorY,
        menuSide,
        submenuSide,
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
      // 修复：原实现漏掉这三个依赖，存在 stale closure 风险。
      resolveCompactMenuPosition,
      compactAppearance,
      compactSize,
    ]
  );

  return {
    resolveCompactMenuSides,
    resolveCompactMenuPosition,
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
  };
}
