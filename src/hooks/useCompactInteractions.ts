import { useCallback } from "react";
import { currentMonitor, type Window } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { readSqliteBackedValue, saveSqliteBackedValue } from "../app/sqliteStorage";
import type { Message } from "../adapters/types";
import { loadProviderConfigs, modelRegistry } from "../adapters/registry";
import { executeChatTurn } from "../chat/engine";
import {
  clampCharacterScale,
  type CharacterModel,
  type CompactAppearance,
} from "./useCompactWindowState";

type ExternalChatEntry = {
  id: string;
  title: string;
  description: string;
  kind: "main" | "external";
  url?: string;
};

type UseCompactInteractionsArgs = {
  appWindow: Window;
  compactAppearance: CompactAppearance;
  compactQuery: string;
  compactSize: { width: number; height: number };
  currentModel: string;
  currentModelStorageKey: string;
  effectiveCompactScale: number;
  handleRestoreMain: (focusInput?: boolean) => Promise<void>;
  isCharacterAppearance: boolean;
  isCompactWindow: boolean;
  mainWindowLabel: string;
  openInternalChatWindow: (entry: ExternalChatEntry & { kind: "external"; url: string }) => Promise<void>;
  resolveCharacterPanelSideFallback: () => Promise<"left" | "right">;
  restoreMainWindow: (focusInput?: boolean) => Promise<void>;
  setCharacterModel: React.Dispatch<React.SetStateAction<CharacterModel>>;
  setCharacterPanelSide: React.Dispatch<React.SetStateAction<"left" | "right">>;
  setCharacterScale: React.Dispatch<React.SetStateAction<number>>;
  setCompactAppearance: React.Dispatch<React.SetStateAction<CompactAppearance>>;
  setCompactQuery: React.Dispatch<React.SetStateAction<string>>;
  setCompactReply: React.Dispatch<React.SetStateAction<{ question: string; answer: string } | null>>;
  setCurrentModel: React.Dispatch<React.SetStateAction<string>>;
  setIsCharacterMenuPinned: React.Dispatch<React.SetStateAction<boolean>>;
  setIsCharacterModelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsCompactAppearanceOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsCompactMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsCompactModelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsCompactQueryOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsCompactReplyLoading: React.Dispatch<React.SetStateAction<boolean>>;
  getExpandedCompactViewportSizeForAppearance: (
    appearance: CompactAppearance,
    scale: number,
    options?: { includeReply?: boolean; includeHorizontalPanel?: boolean }
  ) => { width: number; height: number };
};

export function useCompactInteractions(args: UseCompactInteractionsArgs) {
  const {
    appWindow,
    compactAppearance,
    compactQuery,
    compactSize,
    currentModel,
    currentModelStorageKey,
    effectiveCompactScale,
    getExpandedCompactViewportSizeForAppearance,
    handleRestoreMain,
    isCharacterAppearance,
    isCompactWindow,
    mainWindowLabel,
    openInternalChatWindow,
    resolveCharacterPanelSideFallback,
    restoreMainWindow,
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
  } = args;

  const closeCompactMenus = useCallback(() => {
    setIsCharacterMenuPinned(false);
    setIsCompactMenuOpen(false);
    setIsCompactModelOpen(false);
    setIsCompactAppearanceOpen(false);
    setIsCharacterModelOpen(false);
  }, [setIsCharacterMenuPinned, setIsCharacterModelOpen, setIsCompactAppearanceOpen, setIsCompactMenuOpen, setIsCompactModelOpen]);

  const closeCompactMenuPanels = useCallback(() => {
    setIsCompactMenuOpen(false);
    setIsCompactModelOpen(false);
    setIsCompactAppearanceOpen(false);
    setIsCharacterModelOpen(false);
  }, [setIsCharacterModelOpen, setIsCompactAppearanceOpen, setIsCompactMenuOpen, setIsCompactModelOpen]);

  const handleOpenSettingsFromCompact = useCallback(async () => {
    closeCompactMenus();
    saveSqliteBackedValue("omni_main_view", "settings");
    await restoreMainWindow(false);
    const mainWindow = await WebviewWindow.getByLabel(mainWindowLabel);
    await mainWindow?.emit("omni-open-settings");
  }, [closeCompactMenus, mainWindowLabel, restoreMainWindow]);

  const handleToggleMainFromCompact = useCallback(async () => {
    await appWindow.setAlwaysOnTop(true);
    closeCompactMenus();
    setIsCompactQueryOpen(false);
    setCompactReply(null);

    const mainWindow = await WebviewWindow.getByLabel(mainWindowLabel);
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
      // 忽略不受支持的状态检查。
    }

    await restoreMainWindow(false);
  }, [appWindow, closeCompactMenus, mainWindowLabel, restoreMainWindow, setCompactReply, setIsCompactQueryOpen]);

  const resolveCharacterPanelSide = useCallback(async () => {
    if (!isCompactWindow || !isCharacterAppearance) return "left" as const;

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

    if (!canOpenLeft && canOpenRight) return "right" as const;
    if (canOpenLeft && !canOpenRight) return "left" as const;
    return leftSpace >= rightSpace ? "left" as const : "right" as const;
  }, [
    appWindow,
    compactAppearance,
    compactSize.width,
    effectiveCompactScale,
    getExpandedCompactViewportSizeForAppearance,
    isCharacterAppearance,
    isCompactWindow,
  ]);

  const handleOpenCompactQuery = useCallback(async () => {
    closeCompactMenus();
    if (isCompactWindow && isCharacterAppearance) {
      setCharacterPanelSide(await resolveCharacterPanelSideFallback());
    }
    setIsCompactQueryOpen(true);
  }, [
    closeCompactMenus,
    isCharacterAppearance,
    isCompactWindow,
    resolveCharacterPanelSideFallback,
    setCharacterPanelSide,
    setIsCompactQueryOpen,
  ]);

  const handleOpenExternalChat = useCallback(async (entry: ExternalChatEntry) => {
    closeCompactMenus();

    if (entry.kind === "main") {
      await handleRestoreMain(true);
      return;
    }

    await openInternalChatWindow(entry as ExternalChatEntry & { kind: "external"; url: string });
  }, [closeCompactMenus, handleRestoreMain, openInternalChatWindow]);

  const handleCompactQuerySubmit = useCallback(async (openMain = false) => {
    const draft = compactQuery.trim();
    if (!draft) return;

    loadProviderConfigs();
    const savedModel = readSqliteBackedValue(currentModelStorageKey);
    const resolvedModel =
      savedModel && modelRegistry.getModelConfig(savedModel) ? savedModel : modelRegistry.getCurrentModel();
    modelRegistry.setCurrentModel(resolvedModel);
    if (resolvedModel !== currentModel) {
      setCurrentModel(resolvedModel);
    }

    if (openMain) {
      await restoreMainWindow(true);
      const mainWindow = await WebviewWindow.getByLabel(mainWindowLabel);
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
        messages: [{ role: "user", content: draft } satisfies Message],
      });

      setCompactReply({
        question: draft,
        answer: response.content,
      });
      setIsCompactQueryOpen(false);
      setCompactQuery("");
    } catch (err) {
      setCompactReply({
        question: draft,
        answer: err instanceof Error ? err.message : "查询失败",
      });
    } finally {
      setIsCompactReplyLoading(false);
    }
  }, [
    compactQuery,
    currentModel,
    currentModelStorageKey,
    mainWindowLabel,
    restoreMainWindow,
    setCompactQuery,
    setCompactReply,
    setCurrentModel,
    setIsCompactQueryOpen,
    setIsCompactReplyLoading,
  ]);

  const handleCompactWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (compactAppearance !== "character") {
      return;
    }
    e.preventDefault();
    setCharacterScale((value) => clampCharacterScale(value + (e.deltaY < 0 ? 0.08 : -0.08)));
  }, [compactAppearance, setCharacterScale]);

  const handleCompactAppearanceChange = useCallback((appearance: CompactAppearance) => {
    setCompactAppearance(appearance);
    closeCompactMenus();
  }, [closeCompactMenus, setCompactAppearance]);

  const handleCharacterModelChange = useCallback((model: CharacterModel) => {
    setCharacterModel(model);
    closeCompactMenus();
  }, [closeCompactMenus, setCharacterModel]);

  const handleCompactScaleReset = useCallback(() => {
    setCharacterScale(1);
    closeCompactMenus();
  }, [closeCompactMenus, setCharacterScale]);

  return {
    closeCompactMenuPanels,
    closeCompactMenus,
    handleCharacterModelChange,
    handleCompactAppearanceChange,
    handleCompactQuerySubmit,
    handleCompactScaleReset,
    handleCompactWheel,
    handleOpenCompactQuery,
    handleOpenExternalChat,
    handleOpenSettingsFromCompact,
    handleToggleMainFromCompact,
    resolveCharacterPanelSide,
  };
}
