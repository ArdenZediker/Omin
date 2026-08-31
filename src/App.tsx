import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, Dispatch, SetStateAction } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Message } from "./adapters/types";
import type { ChatSession } from "./chat/types";
import { createDesktopActions } from "./app/desktopActions";
import { modelRegistry } from "./adapters/registry";
import { resolveCurrentModelId, resolveExecutionModelId } from "./chat/modelSelection";
import TitleBar from "./components/TitleBar";
import SettingsWindow from "./components/SettingsWindow";
import MainChatView from "./components/MainChatView";
import CompactWindow from "./components/CompactWindow";
import PetThoughtWindow from "./components/PetThoughtWindow";
import { usePromptDialog } from "./components/PromptDialog";
import { loadCodexPetPackages } from "./app/pets/codexPetStore";
import { getCodexPetViewportSize } from "./app/pets/codexPetSizing";
import type { CodexPetPackage } from "./app/pets/codexPetTypes";
import {
  CHARACTER_SCALE_BASELINE,
  BASIC_SETTINGS_STORAGE_KEY,
  CODEX_PET_LIBRARY_STATE_STORAGE_KEY,
  CURRENT_MODEL_STORAGE_KEY,
  EMPTY_CHAT_PROMPTS,
  PET_THOUGHT_WINDOW_LABEL,
  omniIconSrc,
  omniSmallIconSrc,
} from "./app/constants";
import type { BasicSettings } from "./app/types";
import { saveBasicSettings } from "./app/settingsStore";
import { saveSqliteBackedValue } from "./app/sqliteStorage";
import { getPetWindowScale } from "./app/compactPetScale";
import {
  getBasicSettings,
  getCompactWindowSize,
  getExpandedCompactViewportSizeForAppearance,
  getPetCompactViewportSize,
  getStoredMainView,
  isCharacterPointerInHitArea,
} from "./app/window";
import { useChatSessions } from "./hooks/useChatSessions";
import { useChatRuntime } from "./hooks/useChatRuntime";
import { useScheduledTasks } from "./hooks/useScheduledTasks";
import { useMainWindowController } from "./hooks/useMainWindowController";
import { useCompactWindowController } from "./hooks/useCompactWindowController";
import ErrorBoundary from "./components/ErrorBoundary";
import {
  type CompactAppearance,
  useCompactWindowState,
} from "./hooks/useCompactWindowState";
import { initializePluginRegistry } from "./plugins/registry";
import { useThemeSync } from "./hooks/useThemeSync";
import "./App.css";

const KnowledgeBaseView = lazy(() => import("./components/KnowledgeBaseView"));

type ComposerDraft = {
  text: string;
  images: string[];
};

const EMPTY_COMPOSER_DRAFT: ComposerDraft = {
  text: "",
  images: [],
};

function formatShareRole(role: Message["role"]) {
  switch (role) {
    case "project":
      return "项目";
    case "system":
      return "系统";
    case "user":
    default:
      return "用户";
  }
}

function formatSharedChatMarkdown(session: ChatSession) {
  const title = session.title?.trim() || "Omni 会话";
  const exportedAt = new Date().toLocaleString("zh-CN");
  const sections = session.messages.map((message, index) => {
    const roleLabel = formatShareRole(message.role);
    const content = message.content.trim() || "（空消息）";
    const imageLines = (message.images ?? []).map((_, imageIndex) => `[图片 ${imageIndex + 1}]`);
    const sourceLines =
      message.knowledgeContext?.sources?.map((source, sourceIndex) => {
        const title = source.chunkTitle || source.sourceName;
        return `${sourceIndex + 1}. ${title}（${source.collectionName}，score ${source.score.toFixed(2)}）`;
      }) ?? [];
    const sourceBlock = sourceLines.length > 0 ? ["### 知识来源", ...sourceLines].join("\n") : "";
    return [`## ${index + 1}. ${roleLabel}`, content, ...imageLines, sourceBlock].filter(Boolean).join("\n\n");
  });

  return [`# ${title}`, `导出时间：${exportedAt}`, ...sections].join("\n\n");
}

function getSafeCurrentWindow() {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

const appWindow = getSafeCurrentWindow();
const isCompactWindow = appWindow?.label === "compact";
const isPetThoughtWindow = appWindow?.label === PET_THOUGHT_WINDOW_LABEL;
const isSettingsWindow = appWindow?.label === "settings";

function App() {
  if (isSettingsWindow) {
    return (
      <ErrorBoundary>
        <SettingsWindow />
      </ErrorBoundary>
    );
  }

  if (isPetThoughtWindow) {
    return (
      <ErrorBoundary>
        <PetThoughtWindow petSize={getCompactWindowSize("pet", getPetWindowScale())} />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <MainApp />
    </ErrorBoundary>
  );
}

function MainApp() {
  useThemeSync(false);
  const { openPrompt } = usePromptDialog();
  const {
    activeProject,
    activeProjectId,
    activeChatId,
    activeSession,
    addProjectMemory,
    applyUsageToSession,
    projects,
    chatSessions,
    clearProjectMemories,
    commitProjectMemory,
    createCustomProjectProfile,
    createSessionFromMessages,
    deleteProjectProfile,
    deleteProjectMemory,
    deleteChatSession,
    getChatSessionById,
    getProjectMemories,
    getRelatedContextForProject,
    groupedChatSessions,
    messages,
    renameChatSession,
    selectProject,
    selectChatSession,
    searchChatSessions,
    setActiveProjectId,
    setActiveChatId,
    setScheduledTasks,
    setMessages,
    scheduledTasks,
    toggleFavoriteChatSession,
    togglePinnedChatSession,
    updateChatSessionMessages,
    updateProjectMemory,
    updateProjectProfile,
  } = useChatSessions({ persist: true });

  const {
    characterMenuPosition,
    characterScale,
    closeCompactMenuPanels,
    closeCompactMenus,
    compactAppearance,
    compactMenuSide,
    compactSubmenuSide,
    compactQuery,
    compactReply,
    isCompactAppearanceOpen,
    isCompactMenuOpen,
    isCompactModelOpen,
    isCompactQueryOpen,
    isCompactReplyLoading,
    resetCompactFloatingUi,
    petThoughtPlacement,
    petThoughtCount,
    arePetThoughtsCollapsed,
    setCharacterMenuPosition,
    setCharacterScale,
    setCompactAppearance,
    setCompactQuery,
    setCompactReply,
    setCompactMenuSide,
    setCompactSubmenuSide,
    setIsCompactAppearanceOpen,
    setIsCompactMenuOpen,
    setIsCompactModelOpen,
    setIsCompactQueryOpen,
    setIsCompactReplyLoading,
    petThought,
    petThoughtQueue,
    setPetThoughtPlacement,
    setArePetThoughtsCollapsed,
  } = useCompactWindowState({ isCompactWindow });

  const [currentModel, setCurrentModel] = useState("");
  const [view, setView] = useState<"chat" | "knowledge">(getStoredMainView);
  const [openMarketplace, setOpenMarketplace] = useState(false);
  const [inputFocusKey, setInputFocusKey] = useState(0);
  const [projectDrafts, setProjectDrafts] = useState<Record<string, ComposerDraft>>({});
  const [inputDraftKey, setInputDraftKey] = useState(0);
  const [basicSettings, setBasicSettings] = useState<BasicSettings>(getBasicSettings);
  const [previousModel, setPreviousModel] = useState<string | null>(null);
  const [openChatMenu, setOpenChatMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [codexPetPackage, setCodexPetPackage] = useState<CodexPetPackage | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);

  const isAnimatedCompactAppearance = compactAppearance === "pet";
  const effectiveCompactScale = compactAppearance === "pet" ? characterScale * CHARACTER_SCALE_BASELINE : 1;
  const compactSize = useMemo(
    () => getCompactWindowSize(compactAppearance, effectiveCompactScale),
    [compactAppearance, effectiveCompactScale]
  );
  const shouldReservePetThoughtSpace =
    compactAppearance === "pet" &&
    (petThoughtCount > 0 || petThoughtQueue.length > 0 || Boolean(petThought)) &&
    !arePetThoughtsCollapsed &&
    !isCompactMenuOpen &&
    !isCompactQueryOpen &&
    !isCompactReplyLoading &&
    !compactReply;
  const compactViewportSize = useMemo(() => {
    if (compactAppearance === "pet") {
      return getPetCompactViewportSize({
        compactSize,
        isCompactMenuOpen,
        isCompactQueryOpen,
        isCompactReplyLoading,
        hasCompactReply: Boolean(compactReply),
        thoughtPlacement: petThoughtPlacement,
        reservePetThoughtSpace: shouldReservePetThoughtSpace,
      });
    }
    if (isCompactMenuOpen || isCompactQueryOpen || isCompactReplyLoading || compactReply) {
      return getExpandedCompactViewportSizeForAppearance(compactAppearance, effectiveCompactScale, {
        includeReply: Boolean(isCompactReplyLoading || compactReply),
        includeHorizontalPanel: false,
      });
    }
    return null;
  }, [
    compactAppearance,
    compactReply,
    compactSize.height,
    compactSize.width,
    effectiveCompactScale,
    isCompactMenuOpen,
    isCompactQueryOpen,
    isCompactReplyLoading,
    petThought,
    petThoughtCount,
    petThoughtQueue.length,
    petThoughtPlacement,
    shouldReservePetThoughtSpace,
  ]);

  // 宠物视口偏移由 useCompactWindowController 内部在窗口几何（位置/大小）更新完成后
  // 才提交（committedPetOffset），避免菜单展开/收起时的那一帧跳变。

  const availableModels = modelRegistry.getAvailableModels();
  const availableModelIdsKey = availableModels.map((model) => model.id).join("\n");
  const hasModels = availableModels.length > 0;
  const visibleMessages = messages;
  const activeComposerDraft = projectDrafts[activeProjectId] ?? EMPTY_COMPOSER_DRAFT;
  const relatedContextQuery = useMemo(() => {
    const latestUserMessage = [...visibleMessages].reverse().find((message) => message.role === "user")?.content ?? "";
    return latestUserMessage.trim();
  }, [visibleMessages]);

  const updateProjectDraft = useCallback((projectId: string, updater: (draft: ComposerDraft) => ComposerDraft) => {
    setProjectDrafts((current) => {
      const previousDraft = current[projectId] ?? EMPTY_COMPOSER_DRAFT;
      const nextDraft = updater(previousDraft);
      const hasSameText = previousDraft.text === nextDraft.text;
      const hasSameImages =
        previousDraft.images.length === nextDraft.images.length &&
        previousDraft.images.every((image, index) => image === nextDraft.images[index]);

      if (hasSameText && hasSameImages) {
        return current;
      }

      if (!nextDraft.text && nextDraft.images.length === 0) {
        if (!(projectId in current)) {
          return current;
        }
        const { [projectId]: _removed, ...rest } = current;
        return rest;
      }

      return {
        ...current,
        [projectId]: {
          text: nextDraft.text,
          images: [...nextDraft.images],
        },
      };
    });
  }, []);

  const setInputDraft = useCallback<Dispatch<SetStateAction<string>>>(
    (value) => {
      updateProjectDraft(activeProjectId, (draft) => ({
        ...draft,
        text: typeof value === "function" ? value(draft.text) : value,
      }));
    },
    [activeProjectId, updateProjectDraft]
  );

  const setInputDraftImages = useCallback<Dispatch<SetStateAction<string[]>>>(
    (value) => {
      updateProjectDraft(activeProjectId, (draft) => ({
        ...draft,
        images: typeof value === "function" ? value(draft.images) : value,
      }));
    },
    [activeProjectId, updateProjectDraft]
  );

  const handleComposerDraftChange = useCallback(
    (text: string, images: string[]) => {
      updateProjectDraft(activeProjectId, () => ({
        text,
        images,
      }));
    },
    [activeProjectId, updateProjectDraft]
  );

  const handleModelChange = useCallback((modelId: string) => {
    setCurrentModel((current) => {
      if (current && current !== modelId) {
        setPreviousModel(current);
      }
      return modelId;
    });
    modelRegistry.setCurrentModel(modelId);
    saveSqliteBackedValue(CURRENT_MODEL_STORAGE_KEY, modelId);
  }, []);

  useEffect(() => {
    const resolvedModel = resolveCurrentModelId({
      savedModelId: currentModel,
      registryModelId: modelRegistry.getCurrentModel(),
      availableModels,
    });

    if (resolvedModel === currentModel) {
      return;
    }

    setCurrentModel(resolvedModel);
    modelRegistry.setCurrentModel(resolvedModel);
    if (resolvedModel) {
      saveSqliteBackedValue(CURRENT_MODEL_STORAGE_KEY, resolvedModel);
    }
  }, [availableModelIdsKey, currentModel]);

  const updateBasicSettings = useCallback((patch: Partial<BasicSettings>) => {
    setBasicSettings((current) => {
      const next = { ...current, ...patch };
      saveBasicSettings(BASIC_SETTINGS_STORAGE_KEY, next);
      return next;
    });
  }, []);

  const getProjectById = useCallback(
    (projectId: string) => projects.find((project) => project.id === projectId) ?? null,
    [projects]
  );

  const {
    editingMessageIndex,
    error,
    handleCancelEditUserMessage,
    handleClearChat,
    handleEditUserMessage,
    handleNewChat,
    handleRegenerateMessage,
    handleSend,
    handleStop,
    handleSubmitEditedUserMessage,
    handleUseEmptyPrompt,
    loadingSessionIds,
    latestTaskResult,
    taskRuntimeState,
    setEditingMessageIndex,
    setError,
  } = useChatRuntime({
    activeChatId,
    activeProject,
    availableModels,
    messages,
    addProjectMemory,
    applyUsageToSession,
    commitProjectMemory,
    createSessionFromMessages,
    currentModel,
    getProjectById,
    handleModelChange,
    getRelatedContextForProject,
    renameChatSession,
    getChatSessionById,
    searchChatSessions,
    setActiveProjectId,
    setActiveChatId,
    setInputDraft,
    setInputDraftImages,
    setInputDraftKey,
    setMessages,
    setOpenChatMenu,
    togglePinnedChatSession,
    updateProjectProfile,
    updateChatSessionMessages,
    isCompactWindow,
    view,
  });

  const relatedContext = useMemo(
    () => getRelatedContextForProject(relatedContextQuery),
    [getRelatedContextForProject, relatedContextQuery]
  );
  const activeExecutionModel = resolveExecutionModelId({
    projectModelId: activeProject?.defaultModelId,
    currentModelId: currentModel,
    availableModels,
  });

  const { handleOpenCompact, handleRestoreMain } = useMainWindowController({
    basicSettings,
    compactAppearance,
    effectiveCompactScale,
    isCompactWindow,
    messages,
    messagesScrollRef,
    previousModel,
    setBasicSettings,
    setCurrentModel,
    setInputDraft,
    setInputDraftImages,
    setInputDraftKey,
    setInputFocusKey,
    setView,
    view,
    onModelChange: handleModelChange,
  });

  const compactController = useCompactWindowController({
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
    onRestoreMain: handleRestoreMain,
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
  });

  const displayCompactSize =
    compactAppearance === "pet" && typeof compactController.previewCharacterScale === "number"
      ? getCompactWindowSize(compactAppearance, compactController.previewCharacterScale * CHARACTER_SCALE_BASELINE)
      : compactSize;
  const compactStyle = useMemo<CSSProperties>(() => {
    const buttonSize =
      isAnimatedCompactAppearance ? Math.max(26, Math.round(displayCompactSize.width * 0.36)) : Math.max(30, displayCompactSize.height - 24);
    const iconSize =
      isAnimatedCompactAppearance ? Math.max(14, Math.round(buttonSize * 0.48)) : Math.max(14, Math.round(buttonSize * 0.5));
    const characterReplyGap = Math.min(108, Math.max(40, Math.round(displayCompactSize.width * 0.3)));
    const compactGap = isAnimatedCompactAppearance ? Math.max(4, Math.round(displayCompactSize.width * 0.04)) : 8;
    const compactPadding =
      isAnimatedCompactAppearance
        ? Math.max(3, Math.round(displayCompactSize.width * 0.03))
        : 8;
    const inlineBarWidth = isAnimatedCompactAppearance ? displayCompactSize.width : buttonSize * 2 + compactGap + compactPadding * 2;
    const minCompactBarWidth = compactAppearance === "compact" ? 96 : 104;
    const minCompactBarHeight = compactAppearance === "compact" ? 48 : 54;
    const compactPetViewportSize = getCodexPetViewportSize(displayCompactSize);
    const compactCharacterSize = compactPetViewportSize.height;
    return {
      "--compact-bar-width": `${Math.max(minCompactBarWidth, inlineBarWidth)}px`,
      "--compact-bar-height": `${Math.max(minCompactBarHeight, buttonSize + compactPadding * 2)}px`,
      "--compact-button-size": `${buttonSize}px`,
      "--compact-button-icon-size": `${iconSize}px`,
      "--compact-gap": `${compactGap}px`,
      "--compact-padding": `${compactPadding}px`,
      "--compact-character-size": `${compactCharacterSize}px`,
      "--compact-character-reply-gap": `${characterReplyGap}px`,
      "--pet-viewport-offset-x": `${compactController.committedPetOffset.x}px`,
      "--pet-viewport-offset-y": `${compactController.committedPetOffset.y}px`,
    } as CSSProperties;
  }, [
    compactViewportSize,
    displayCompactSize.height,
    displayCompactSize.width,
    isAnimatedCompactAppearance,
    compactAppearance,
    compactController.committedPetOffset.x,
    compactController.committedPetOffset.y,
    petThoughtPlacement,
  ]);

  const lastMessage = visibleMessages[visibleMessages.length - 1];
  const hasPendingProjectPlaceholder = lastMessage?.role === "project" && !lastMessage.content.trim();
  const isActiveSessionLoading = Boolean((activeChatId && loadingSessionIds.includes(activeChatId)) || hasPendingProjectPlaceholder);
  const isSendBlockedByOtherSession = false;
  const isStreaming = Boolean(isActiveSessionLoading && lastMessage?.role === "project");

  const handleCopyMessage = useCallback(async (message: Message) => {
    await navigator.clipboard.writeText(message.content);
  }, []);

  useEffect(() => {
    initializePluginRegistry();
    // 拉起已启用且已配置的连接器 MCP 服务器（静默失败，不阻塞启动）
    void import("./plugins/mcp").then((module) => module.syncMcpConnectors());

    let cancelled = false;

    const syncActivePet = async () => {
      try {
        const payload = await loadCodexPetPackages();
        if (cancelled) return;
        const rawState = typeof window === "undefined" ? null : localStorage.getItem(CODEX_PET_LIBRARY_STATE_STORAGE_KEY);
        const persistedActivePetId = rawState ? (JSON.parse(rawState) as { activePetId?: string | null }).activePetId ?? null : null;
        const active =
          payload.packages.find((pet) => pet.id === persistedActivePetId) ??
          payload.packages.find((pet) => pet.id === payload.activePetId) ??
          payload.packages[0] ??
          null;
        setCodexPetPackage(active);
      } catch {
        if (!cancelled) {
          setCodexPetPackage(null);
        }
      }
    };

    void syncActivePet();

    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key === CODEX_PET_LIBRARY_STATE_STORAGE_KEY) {
        void syncActivePet();
      }
    };

    window.addEventListener("storage", onStorage);

    return () => {
      cancelled = true;
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const handleSelectChat = useCallback(
    (sessionId: string) => {
      if (sessionId === activeChatId) {
        return;
      }
      const session = selectChatSession(sessionId);
      if (!session) {
        return;
      }
      setError(null);
      setEditingMessageIndex(null);
    },
    [activeChatId, selectChatSession, setEditingMessageIndex, setError]
  );

  const handleRenameChat = useCallback(
    async (session: { id: string; title: string }) => {
      const values = await openPrompt({
        title: "\u91cd\u547d\u540d\u4f1a\u8bdd",
        description: "\u4fee\u6539\u5f53\u524d\u4f1a\u8bdd\u540d\u79f0\u540e\u4f1a\u7acb\u5373\u4fdd\u5b58\u3002",
        confirmLabel: "\u4fdd\u5b58",
        fields: [
          {
            label: "\u4f1a\u8bdd\u540d\u79f0",
            defaultValue: session.title,
            placeholder: "\u8bf7\u8f93\u5165\u4f1a\u8bdd\u540d\u79f0",
            autoFocus: true,
          },
        ],
      });
      const nextTitle = values?.[0]?.trim();
      if (!nextTitle) {
        return;
      }
      renameChatSession(session.id, nextTitle);
      setOpenChatMenu(null);
    },
    [openPrompt, renameChatSession]
  );

  const handleToggleFavoriteChat = useCallback((session: { id: string }) => {
    toggleFavoriteChatSession(session.id);
  }, [toggleFavoriteChatSession]);

  const handleTogglePinChat = useCallback((session: { id: string }) => {
    togglePinnedChatSession(session.id);
  }, [togglePinnedChatSession]);

  const handleShareChat = useCallback(async (session: ChatSession) => {
    const text = formatSharedChatMarkdown(session);
    await navigator.clipboard.writeText(text);
    setOpenChatMenu(null);
  }, []);

  const handleDeleteChat = useCallback(
    (session: { id: string }) => {
      deleteChatSession(session.id);
      if (session.id === activeChatId) {
        setError(null);
        setEditingMessageIndex(null);
      }
      setOpenChatMenu(null);
    },
    [activeChatId, deleteChatSession, setEditingMessageIndex, setError]
  );

  const desktopActions = useMemo(
    () =>
      createDesktopActions({
        onNewChat: handleNewChat,
        onRestoreMain: handleRestoreMain,
        onNotify: async (title, body) => {
          console.info("[scheduled-notify]", title, body);
        },
      }),
    [handleNewChat, handleRestoreMain]
  );

  useScheduledTasks({
    scheduledTasks,
    setScheduledTasks,
    desktopActions,
  });

  if (isCompactWindow) {
    return (
      <CompactWindow
        appearanceOptions={compactController.appearanceOptions}
        basicSettings={basicSettings}
        menuPosition={characterMenuPosition}
        codexPetPackage={codexPetPackage}
        characterScale={characterScale}
        compactAppearance={compactAppearance as CompactAppearance}
        compactQuery={compactQuery}
        compactReply={compactReply}
        petThought={petThought}
        petThoughtQueue={petThoughtQueue}
        petThoughtCount={petThoughtCount}
        petThoughtPlacement={petThoughtPlacement}
        arePetThoughtsCollapsed={arePetThoughtsCollapsed}
        compactSize={displayCompactSize}
        compactStyle={compactStyle}
        entries={compactController.entries}
        isCompactAppearanceOpen={isCompactAppearanceOpen}
        isCompactMenuOpen={isCompactMenuOpen}
        isCompactModelOpen={isCompactModelOpen}
        compactMenuSide={compactMenuSide}
        compactSubmenuSide={compactSubmenuSide}
        isCompactQueryOpen={isCompactQueryOpen}
        isCompactReplyLoading={isCompactReplyLoading}
        isCharacterDragging={compactController.isCharacterDragging}
        previewCharacterScale={compactController.previewCharacterScale}
        characterDragMotion={compactController.characterDragMotion}
        omniSmallIconSrc={omniSmallIconSrc}
        onCharacterContextMenu={compactController.handleCharacterContextMenu}
        onCharacterPointerDown={compactController.handleCharacterPointerDown}
        onCharacterPointerMove={compactController.handleCharacterPointerMove}
        onCharacterPointerUp={compactController.handleCharacterPointerUp}
        onPetPointerDown={compactController.handlePetPointerDown}
        onPetPointerMove={compactController.handlePetPointerMove}
        onPetPointerUp={compactController.handlePetPointerUp}
        onCancelCompactMenuClose={compactController.cancelCompactMenuClose}
        onCloseCompactMenu={compactController.closeCompactMenu}
        onCloseCompactMenuNow={compactController.closeCompactMenuNow}
        onCompactAppearanceChange={compactController.handleCompactAppearanceChange}
        onCompactDrag={compactController.handleCompactDrag}
        onCompactQuerySubmit={compactController.handleCompactQuerySubmit}
        onCompactScaleReset={compactController.handleCompactScaleReset}
        onCompactWheel={compactController.handleCompactWheel}
        onOpenCompactMenu={compactController.openCompactMenu}
        onOpenCompactQuery={compactController.handleOpenCompactQuery}
        onOpenExternalChat={compactController.handleOpenExternalChat}
        onPetPrimaryClick={compactController.handlePetPrimaryClick}
        onOpenSettingsFromCompact={desktopActions.openSettings}
        onPointerHitTest={isCharacterPointerInHitArea}
        onSetCompactQuery={setCompactQuery}
        onSetCompactReply={setCompactReply}
        onSetArePetThoughtsCollapsed={setArePetThoughtsCollapsed}
        onUpdateBasicSettings={updateBasicSettings}
        onSetIsCompactAppearanceOpen={setIsCompactAppearanceOpen}
        onSetIsCompactModelOpen={setIsCompactModelOpen}
        onSetIsCompactQueryOpen={setIsCompactQueryOpen}
        onSetIsCompactReplyLoading={setIsCompactReplyLoading}
      />
    );
  }

  return (
    <div className="app-shell glass flex flex-col h-screen w-screen overflow-hidden">
      {view === "chat" ? (
        <MainChatView
          activeProject={activeProject}
          activeProjectId={activeProjectId}
          activeChatId={activeChatId}
          activeSession={activeSession}
          projects={projects}
          availableModels={availableModels}
          currentModel={currentModel}
          editingMessageIndex={editingMessageIndex}
          emptyChatPrompts={EMPTY_CHAT_PROMPTS}
          error={error}
          groupedChatSessions={groupedChatSessions}
          hasModels={hasModels}
          executionModel={activeExecutionModel}
          inputDraft={activeComposerDraft.text}
          inputDraftImages={activeComposerDraft.images}
          inputDraftKey={inputDraftKey}
          inputDraftScopeKey={activeProjectId}
          inputFocusKey={inputFocusKey}
          isLoading={isActiveSessionLoading}
          isSendBlocked={isSendBlockedByOtherSession || !hasModels}
          isStreaming={isStreaming}
          relatedContext={relatedContext}
          projectMemories={activeProject ? getProjectMemories(activeProject.id) : []}
          latestTaskResult={latestTaskResult}
          taskRuntimeState={taskRuntimeState}
          messages={visibleMessages}
          messagesScrollRef={messagesScrollRef}
          omniIconSrc={omniIconSrc}
          openChatMenu={openChatMenu}
          windowControls={<TitleBar inline onMinimizeToCompact={handleOpenCompact} minimizeBehavior={basicSettings.minimizeBehavior} />}
          onCancelEditUserMessage={handleCancelEditUserMessage}
          onClearChat={handleClearChat}
          onCopyMessage={handleCopyMessage}
          onDeleteChat={handleDeleteChat}
          onEditUserMessage={handleEditUserMessage}
          onModelChange={handleModelChange}
          onNewChat={handleNewChat}
          onCreateCustomProject={createCustomProjectProfile}
          onAddProjectMemory={addProjectMemory}
          onClearProjectMemories={clearProjectMemories}
          onDeleteProject={deleteProjectProfile}
          onDeleteProjectMemory={deleteProjectMemory}
          onUpdateProjectMemory={updateProjectMemory}
          onRegenerateMessage={handleRegenerateMessage}
          onRenameChat={handleRenameChat}
          onSelectProject={selectProject}
          onSelectChat={handleSelectChat}
          onUpdateProject={updateProjectProfile}
          onSend={handleSend}
          onSetOpenChatMenu={setOpenChatMenu}
          onSettingsOpen={desktopActions.openSettings}
          onShareChat={handleShareChat}
          onStop={handleStop}
          onSubmitEditedUserMessage={handleSubmitEditedUserMessage}
          onToggleFavoriteChat={handleToggleFavoriteChat}
          onTogglePinChat={handleTogglePinChat}
          onUseEmptyPrompt={handleUseEmptyPrompt}
          onDraftChange={handleComposerDraftChange}
          onOpenKnowledge={() => setView("knowledge")}
          openMarketplace={openMarketplace}
          onMarketplaceChange={setOpenMarketplace}
        />
      ) : (
        <Suspense
          fallback={
            <div className="omni-view-loading">
              <span>正在打开知识库...</span>
            </div>
          }
        >
          <KnowledgeBaseView
            onBackToChat={() => setView("chat")}
            onOpenMarketplace={() => {
              setOpenMarketplace(true);
              setView("chat");
            }}
            onSettingsOpen={desktopActions.openSettings}
            windowControls={<TitleBar inline onMinimizeToCompact={handleOpenCompact} minimizeBehavior={basicSettings.minimizeBehavior} />}
          />
        </Suspense>
      )}
    </div>
  );
}

export default App;
