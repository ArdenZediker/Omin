import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Message } from "./adapters/types";
import { createDesktopActions } from "./app/desktopActions";
import { modelRegistry } from "./adapters/registry";
import TitleBar from "./components/TitleBar";
import SettingsWindow from "./components/SettingsWindow";
import MainChatView from "./components/MainChatView";
import KnowledgeBaseView from "./components/KnowledgeBaseView";
import CompactWindow from "./components/CompactWindow";
import { usePromptDialog } from "./components/PromptDialog";
import { loadCodexPetPackages } from "./app/pets/codexPetStore";
import { getCodexPetViewportHeight } from "./app/pets/codexPetSizing";
import type { CodexPetPackage } from "./app/pets/codexPetTypes";
import {
  CHARACTER_SCALE_BASELINE,
  BASIC_SETTINGS_STORAGE_KEY,
  CODEX_PET_LIBRARY_STATE_STORAGE_KEY,
  CURRENT_MODEL_STORAGE_KEY,
  EMPTY_CHAT_PROMPTS,
  omniIconSrc,
  omniSmallIconSrc,
} from "./app/constants";
import type { BasicSettings } from "./app/types";
import { saveBasicSettings } from "./app/settingsStore";
import { saveSqliteBackedValue } from "./app/sqliteStorage";
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
import {
  type CompactAppearance,
  useCompactWindowState,
} from "./hooks/useCompactWindowState";
import "./App.css";

function getSafeCurrentWindow() {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

const appWindow = getSafeCurrentWindow();
const isCompactWindow = appWindow?.label === "compact";
const isSettingsWindow = appWindow?.label === "settings";

function App() {
  if (isSettingsWindow) {
    return <SettingsWindow />;
  }

  return <MainApp />;
}

function MainApp() {
  const { openPrompt } = usePromptDialog();
  const {
    activeAssistant,
    activeAssistantId,
    activeChatId,
    activeSession,
    applyUsageToSession,
    assistants,
    commitAssistantMemory,
    createCustomAssistantProfile,
    createSessionFromMessages,
    deleteAssistantProfile,
    deleteChatSession,
    getChatSessionById,
    getRelatedContextForAssistant,
    groupedChatSessions,
    messages,
    renameChatSession,
    selectAssistant,
    selectChatSession,
    searchChatSessions,
    setActiveChatId,
    setScheduledTasks,
    setMessages,
    scheduledTasks,
    toggleFavoriteChatSession,
    togglePinnedChatSession,
    updateAssistantProfile,
  } = useChatSessions({ persist: !isCompactWindow });

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
    setPetThoughtPlacement,
  } = useCompactWindowState({ isCompactWindow });

  const [currentModel, setCurrentModel] = useState("gpt-4o");
  const [view, setView] = useState<"chat" | "knowledge">(getStoredMainView);
  const [inputFocusKey, setInputFocusKey] = useState(0);
  const [inputDraft, setInputDraft] = useState("");
  const [inputDraftImages, setInputDraftImages] = useState<string[]>([]);
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
  const compactViewportSize = useMemo(() => {
    if (compactAppearance === "pet") {
      return getPetCompactViewportSize({
        compactSize,
        isCompactMenuOpen,
        isCompactQueryOpen,
        isCompactReplyLoading,
        hasCompactReply: Boolean(compactReply),
        thoughtPlacement: petThoughtPlacement,
        reservePetThoughtSpace: Boolean(petThought),
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
    petThoughtPlacement,
  ]);
  const compactStyle = useMemo<CSSProperties>(() => {
    const buttonSize =
      isAnimatedCompactAppearance ? Math.max(26, Math.round(compactSize.width * 0.36)) : Math.max(30, compactSize.height - 24);
    const iconSize =
      isAnimatedCompactAppearance ? Math.max(14, Math.round(buttonSize * 0.48)) : Math.max(14, Math.round(buttonSize * 0.5));
    const characterReplyGap = Math.min(108, Math.max(40, Math.round(compactSize.width * 0.3)));
    const compactGap = isAnimatedCompactAppearance ? Math.max(4, Math.round(compactSize.width * 0.04)) : 8;
    const compactPadding =
      isAnimatedCompactAppearance
        ? Math.max(3, Math.round(compactSize.width * 0.03))
        : 8;
    const inlineBarWidth = isAnimatedCompactAppearance ? compactSize.width : buttonSize * 2 + compactGap + compactPadding * 2;
    const compactCharacterSize = getCodexPetViewportHeight(compactSize.width);

    return {
      "--compact-bar-width": `${Math.max(104, inlineBarWidth)}px`,
      "--compact-bar-height": `${Math.max(54, buttonSize + compactPadding * 2)}px`,
      "--compact-button-size": `${buttonSize}px`,
      "--compact-button-icon-size": `${iconSize}px`,
      "--compact-gap": `${compactGap}px`,
      "--compact-padding": `${compactPadding}px`,
      "--compact-character-size": `${compactCharacterSize}px`,
      "--compact-character-reply-gap": `${characterReplyGap}px`,
    } as CSSProperties;
  }, [compactSize.height, compactSize.width, isAnimatedCompactAppearance]);

  const availableModels = modelRegistry.getAvailableModels();
  const hasModels = availableModels.length > 0;

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

  const updateBasicSettings = useCallback((patch: Partial<BasicSettings>) => {
    setBasicSettings((current) => {
      const next = { ...current, ...patch };
      saveBasicSettings(BASIC_SETTINGS_STORAGE_KEY, next);
      return next;
    });
  }, []);

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
    isLoading,
    latestTaskResult,
    taskRuntimeState,
    setEditingMessageIndex,
    setError,
  } = useChatRuntime({
    activeChatId,
    activeAssistant,
    availableModels,
    applyUsageToSession,
    commitAssistantMemory,
    createSessionFromMessages,
    currentModel,
    handleModelChange,
    messages,
    renameChatSession,
    getChatSessionById,
    searchChatSessions,
    setActiveChatId,
    setInputDraft,
    setInputDraftImages,
    setInputDraftKey,
    setMessages,
    setOpenChatMenu,
    togglePinnedChatSession,
    isCompactWindow,
  });

  const relatedContext = useMemo(
    () => getRelatedContextForAssistant(activeSession?.title ?? ""),
    [activeSession?.title, getRelatedContextForAssistant]
  );

  useEffect(() => {
    if (!activeAssistant.defaultModelId) {
      return;
    }
    if (!availableModels.some((model) => model.id === activeAssistant.defaultModelId)) {
      return;
    }
    if (currentModel === activeAssistant.defaultModelId) {
      return;
    }
    handleModelChange(activeAssistant.defaultModelId);
  }, [activeAssistant.defaultModelId, availableModels, currentModel, handleModelChange]);

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
  });

  const lastMessage = messages[messages.length - 1];
  const isStreaming = isLoading && lastMessage.role === "assistant";

  const handleCopyMessage = useCallback(async (message: Message) => {
    await navigator.clipboard.writeText(message.content);
  }, []);

  useEffect(() => {
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
      if (sessionId === activeChatId || isLoading) {
        return;
      }
      const session = selectChatSession(sessionId);
      if (!session) {
        return;
      }
      setError(null);
      setEditingMessageIndex(null);
    },
    [activeChatId, isLoading, selectChatSession, setEditingMessageIndex, setError]
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

  const handleShareChat = useCallback(async (session: { messages: Message[] }) => {
    const text = session.messages.map((message) => `${message.role}: ${message.content}`).join("\n\n");
    if (text) {
      await navigator.clipboard.writeText(text);
    }
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
        compactSize={compactSize}
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
        petThought={petThought}
        petThoughtPlacement={petThoughtPlacement}
        omniSmallIconSrc={omniSmallIconSrc}
        onCharacterContextMenu={compactController.handleCharacterContextMenu}
        onCharacterPointerDown={compactController.handleCharacterPointerDown}
        onCharacterPointerMove={compactController.handleCharacterPointerMove}
        onCharacterPointerUp={compactController.handleCharacterPointerUp}
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
        onUpdateBasicSettings={updateBasicSettings}
        onSetIsCompactAppearanceOpen={setIsCompactAppearanceOpen}
        onSetIsCompactModelOpen={setIsCompactModelOpen}
        onSetIsCompactQueryOpen={setIsCompactQueryOpen}
        onSetIsCompactReplyLoading={setIsCompactReplyLoading}
        onSetPetThoughtPlacement={setPetThoughtPlacement}
      />
    );
  }

  return (
    <div className="app-shell glass flex flex-col h-screen w-screen overflow-hidden">
      {view === "chat" ? (
        <MainChatView
          activeAssistant={activeAssistant}
          activeAssistantId={activeAssistantId}
          activeChatId={activeChatId}
          activeSession={activeSession}
          assistants={assistants}
          availableModels={availableModels}
          currentModel={currentModel}
          editingMessageIndex={editingMessageIndex}
          emptyChatPrompts={EMPTY_CHAT_PROMPTS}
          error={error}
          groupedChatSessions={groupedChatSessions}
          hasModels={hasModels}
          inputDraft={inputDraft}
          inputDraftImages={inputDraftImages}
          inputDraftKey={inputDraftKey}
          inputFocusKey={inputFocusKey}
          isLoading={isLoading}
          isStreaming={isStreaming}
          relatedContext={relatedContext}
          latestTaskResult={latestTaskResult}
          taskRuntimeState={taskRuntimeState}
          messages={messages}
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
          onCreateCustomAssistant={createCustomAssistantProfile}
          onDeleteAssistant={deleteAssistantProfile}
          onRegenerateMessage={handleRegenerateMessage}
          onRenameChat={handleRenameChat}
          onSelectAssistant={selectAssistant}
          onSelectChat={handleSelectChat}
          onUpdateAssistantProfile={updateAssistantProfile}
          onSend={handleSend}
          onSetOpenChatMenu={setOpenChatMenu}
          onSettingsOpen={desktopActions.openSettings}
          onShareChat={handleShareChat}
          onStop={handleStop}
          onSubmitEditedUserMessage={handleSubmitEditedUserMessage}
          onToggleFavoriteChat={handleToggleFavoriteChat}
          onTogglePinChat={handleTogglePinChat}
          onUseEmptyPrompt={handleUseEmptyPrompt}
          onOpenKnowledge={() => setView("knowledge")}
        />
      ) : (
        <KnowledgeBaseView
          onBackToChat={() => setView("chat")}
          onSettingsOpen={desktopActions.openSettings}
          windowControls={<TitleBar inline onMinimizeToCompact={handleOpenCompact} minimizeBehavior={basicSettings.minimizeBehavior} />}
        />
      )}
    </div>
  );
}

export default App;







