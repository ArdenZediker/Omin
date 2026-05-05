import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Message } from "./adapters/types";
import { createDesktopActions } from "./app/desktopActions";
import { modelRegistry } from "./adapters/registry";
import TitleBar from "./components/TitleBar";
import SettingsPanel from "./components/SettingsPanel";
import MainChatView from "./components/MainChatView";
import CompactWindow from "./components/CompactWindow";
import {
  CHARACTER_SCALE_BASELINE,
  BASIC_SETTINGS_STORAGE_KEY,
  CURRENT_MODEL_STORAGE_KEY,
  EMPTY_CHAT_PROMPTS,
  omniIconSrc,
  omniSmallIconSrc,
} from "./app/constants";
import type { BasicSettings, ViewMode } from "./app/types";
import { saveBasicSettings } from "./app/settingsStore";
import { saveSqliteBackedValue } from "./app/sqliteStorage";
import { getBasicSettings, getCompactWindowSize, getExpandedCompactViewportSizeForAppearance, getStoredMainView, isCharacterPointerInHitArea } from "./app/window";
import { useChatSessions } from "./hooks/useChatSessions";
import { useChatRuntime } from "./hooks/useChatRuntime";
import { useScheduledTasks } from "./hooks/useScheduledTasks";
import { useMainWindowController } from "./hooks/useMainWindowController";
import { useCompactWindowController } from "./hooks/useCompactWindowController";
import {
  type CharacterModel,
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

function App() {
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
    characterModel,
    characterPanelSide,
    characterScale,
    closeCompactMenuPanels,
    closeCompactMenus,
    compactAppearance,
    compactMenuSide,
    compactSubmenuSide,
    compactQuery,
    compactReply,
    isCharacterMenuPinned,
    isCharacterModelOpen,
    isCompactAppearanceOpen,
    isCompactMenuOpen,
    isCompactModelOpen,
    isCompactQueryOpen,
    isCompactReplyLoading,
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
    setIsCharacterMenuPinned,
    setIsCharacterModelOpen,
    setIsCompactAppearanceOpen,
    setIsCompactMenuOpen,
    setIsCompactModelOpen,
    setIsCompactQueryOpen,
    setIsCompactReplyLoading,
  } = useCompactWindowState();

  const [currentModel, setCurrentModel] = useState("gpt-4o");
  const [view, setView] = useState<ViewMode>(getStoredMainView);
  const [inputFocusKey, setInputFocusKey] = useState(0);
  const [inputDraft, setInputDraft] = useState("");
  const [inputDraftImages, setInputDraftImages] = useState<string[]>([]);
  const [inputDraftKey, setInputDraftKey] = useState(0);
  const [basicSettings, setBasicSettings] = useState<BasicSettings>(getBasicSettings);
  const [previousModel, setPreviousModel] = useState<string | null>(null);
  const [openChatMenu, setOpenChatMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);

  const isLive2DAppearance = compactAppearance === "character";
  const isAnimatedCompactAppearance = compactAppearance === "character" || compactAppearance === "pet";
  const effectiveCompactScale = isAnimatedCompactAppearance ? characterScale * CHARACTER_SCALE_BASELINE : 1;
  const compactSize = useMemo(
    () => getCompactWindowSize(compactAppearance, effectiveCompactScale),
    [compactAppearance, effectiveCompactScale]
  );
  const compactViewportSize = useMemo(() => {
    if (
      compactAppearance === "pet" &&
      isCompactQueryOpen &&
      !isCompactMenuOpen &&
      !isCompactReplyLoading &&
      !compactReply
    ) {
      return {
        width: Math.max(compactSize.width, 286),
        height: compactSize.height + 54,
      };
    }
    if (
      compactAppearance === "character" &&
      isCompactQueryOpen &&
      !isCompactMenuOpen &&
      !isCompactReplyLoading &&
      !compactReply
    ) {
      return {
        width: compactSize.width,
        height: compactSize.height + 96,
      };
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
    isAnimatedCompactAppearance,
    isCompactMenuOpen,
    isCompactQueryOpen,
    isCompactReplyLoading,
  ]);
  const isCharacterHorizontalPanelOpen = isAnimatedCompactAppearance && Boolean(isCompactMenuOpen || isCompactReplyLoading || compactReply);
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

    return {
      "--compact-bar-width": `${Math.max(104, inlineBarWidth)}px`,
      "--compact-bar-height": `${Math.max(54, buttonSize + compactPadding * 2)}px`,
      "--compact-button-size": `${buttonSize}px`,
      "--compact-button-icon-size": `${iconSize}px`,
      "--compact-gap": `${compactGap}px`,
      "--compact-padding": `${compactPadding}px`,
      "--compact-character-size": `${Math.max(48, compactSize.width - 18)}px`,
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
    setView,
    togglePinnedChatSession,
  });

  const relatedContext = useMemo(
    () => getRelatedContextForAssistant(activeSession?.title ?? ""),
    [activeSession?.title, getRelatedContextForAssistant]
  );

  useEffect(() => {
    if (!activeAssistant?.defaultModelId) {
      return;
    }
    if (!availableModels.some((model) => model.id === activeAssistant.defaultModelId)) {
      return;
    }
    if (currentModel === activeAssistant.defaultModelId) {
      return;
    }
    handleModelChange(activeAssistant.defaultModelId);
  }, [activeAssistant?.defaultModelId, availableModels, currentModel, handleModelChange]);

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
    effectiveCompactScale,
    isCharacterAppearance: isLive2DAppearance,
    isCharacterMenuPinned,
    isCharacterModelOpen,
    isCompactAppearanceOpen,
    isCompactMenuOpen,
    isCompactModelOpen,
    isCompactQueryOpen,
    isCompactReplyLoading,
    isCompactWindow,
    onRestoreMain: handleRestoreMain,
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
  });

  const lastMessage = messages[messages.length - 1];
  const isStreaming = isLoading && lastMessage?.role === "assistant";

  const handleCopyMessage = useCallback(async (message: Message) => {
    await navigator.clipboard?.writeText(message.content);
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
    (session: { id: string; title: string }) => {
      const nextTitle = window.prompt("重命名会话", session.title)?.trim();
      if (!nextTitle) {
        return;
      }
      renameChatSession(session.id, nextTitle);
      setOpenChatMenu(null);
    },
    [renameChatSession]
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
      await navigator.clipboard?.writeText(text);
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

  const handleToggleScheduledTask = useCallback((taskId: string) => {
    setScheduledTasks((current) =>
      current.map((task) =>
        task.id === taskId
          ? {
              ...task,
              enabled: !task.enabled,
              updatedAt: Date.now(),
            }
          : task
      )
    );
  }, [setScheduledTasks]);

  const handleCreateScheduledTask = useCallback(
    (input: { title: string; prompt: string; cron: string; target: "desktop" | "notification" | "session" }) => {
      setScheduledTasks((current) => [
        {
          id: `scheduled_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          title: input.title,
          prompt: input.prompt,
          cron: input.cron,
          target: input.target,
          enabled: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          lastRunAt: null,
        },
        ...current,
      ]);
    },
    [setScheduledTasks]
  );

  const handleUpdateScheduledTask = useCallback(
    (taskId: string, patch: { title: string; prompt: string; cron: string; target: "desktop" | "notification" | "session" }) => {
      setScheduledTasks((current) =>
        current.map((task) =>
          task.id === taskId
            ? {
                ...task,
                ...patch,
                updatedAt: Date.now(),
              }
            : task
        )
      );
    },
    [setScheduledTasks]
  );

  const handleDeleteScheduledTask = useCallback((taskId: string) => {
    setScheduledTasks((current) => current.filter((task) => task.id !== taskId));
  }, [setScheduledTasks]);

  if (isCompactWindow) {
    return (
      <CompactWindow
        appearanceOptions={compactController.appearanceOptions}
        basicSettings={basicSettings}
        characterMenuPosition={characterMenuPosition}
        characterModel={characterModel as CharacterModel}
        characterModelOptions={compactController.characterModelOptions}
        characterPanelSide={characterPanelSide}
        characterScale={characterScale}
        compactAppearance={compactAppearance as CompactAppearance}
        compactQuery={compactQuery}
        compactReply={compactReply}
        compactSize={compactSize}
        compactStyle={compactStyle}
        entries={compactController.entries}
        isCharacterAppearance={isAnimatedCompactAppearance}
        isCharacterDragging={compactController.isCharacterDragging}
        isCharacterHorizontalPanelOpen={isCharacterHorizontalPanelOpen}
        isCharacterMenuPinned={isCharacterMenuPinned}
        isCharacterModelOpen={isCharacterModelOpen}
        isCompactAppearanceOpen={isCompactAppearanceOpen}
        isCompactMenuOpen={isCompactMenuOpen}
        isCompactModelOpen={isCompactModelOpen}
        compactMenuSide={compactMenuSide}
        compactSubmenuSide={compactSubmenuSide}
        isCompactQueryOpen={isCompactQueryOpen}
        isCompactReplyLoading={isCompactReplyLoading}
        omniSmallIconSrc={omniSmallIconSrc}
        onCharacterContextMenu={compactController.handleCharacterContextMenu}
        onCharacterModelChange={compactController.handleCharacterModelChange}
        onCharacterPointerDown={compactController.handleCharacterPointerDown}
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
        onOpenSettingsFromCompact={desktopActions.openSettings}
        onPointerHitTest={isCharacterPointerInHitArea}
        onSetCharacterMenuPinned={setIsCharacterMenuPinned}
        onSetCompactQuery={setCompactQuery}
        onSetCompactReply={setCompactReply}
        onUpdateBasicSettings={updateBasicSettings}
        onSetIsCharacterModelOpen={setIsCharacterModelOpen}
        onSetIsCompactAppearanceOpen={setIsCompactAppearanceOpen}
        onSetIsCompactMenuOpen={setIsCompactMenuOpen}
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
          scheduledTasks={scheduledTasks}
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
          onSettingsOpen={() => setView("settings")}
          onShareChat={handleShareChat}
          onStop={handleStop}
          onSubmitEditedUserMessage={handleSubmitEditedUserMessage}
          onToggleFavoriteChat={handleToggleFavoriteChat}
          onTogglePinChat={handleTogglePinChat}
          onToggleScheduledTask={handleToggleScheduledTask}
          onCreateScheduledTask={handleCreateScheduledTask}
          onUpdateScheduledTask={handleUpdateScheduledTask}
          onDeleteScheduledTask={handleDeleteScheduledTask}
          onUseEmptyPrompt={handleUseEmptyPrompt}
        />
      ) : (
        <>
          <TitleBar onMinimizeToCompact={handleOpenCompact} minimizeBehavior={basicSettings.minimizeBehavior} />
          <SettingsPanel onClose={() => setView("chat")} onModelChange={handleModelChange} />
        </>
      )}
    </div>
  );
}

export default App;
