import { useCallback, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Message } from "./adapters/types";
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
import { getBasicSettings, getCompactWindowSize, getExpandedCompactViewportSizeForAppearance, getStoredMainView, isCharacterPointerInHitArea } from "./app/window";
import { useChatSessions } from "./hooks/useChatSessions";
import { useChatRuntime } from "./hooks/useChatRuntime";
import { useMainWindowController } from "./hooks/useMainWindowController";
import { useCompactWindowController } from "./hooks/useCompactWindowController";
import {
  type CharacterModel,
  type CompactAppearance,
  useCompactWindowState,
} from "./hooks/useCompactWindowState";
import "./App.css";

const appWindow = getCurrentWindow();
const isCompactWindow = appWindow.label === "compact";

function App() {
  const {
    activeChatId,
    activeSession,
    applyUsageToSession,
    createSessionFromMessages,
    deleteChatSession,
    groupedChatSessions,
    messages,
    renameChatSession,
    selectChatSession,
    setActiveChatId,
    setMessages,
    togglePinnedChatSession,
  } = useChatSessions({ persist: !isCompactWindow });

  const {
    characterMenuPosition,
    characterModel,
    characterPanelSide,
    characterScale,
    clearCompactReply,
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

  const effectiveCompactScale = compactAppearance === "character" ? characterScale * CHARACTER_SCALE_BASELINE : 1;
  const isCharacterAppearance = compactAppearance === "character";
  const compactSize = useMemo(
    () => getCompactWindowSize(compactAppearance, effectiveCompactScale),
    [compactAppearance, effectiveCompactScale]
  );
  const compactViewportSize = useMemo(() => {
    if (isCharacterAppearance && isCompactQueryOpen && !isCompactMenuOpen && !isCompactReplyLoading && !compactReply) {
      return { width: compactSize.width, height: compactSize.height + 96 };
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
    isCharacterAppearance,
    isCompactMenuOpen,
    isCompactQueryOpen,
    isCompactReplyLoading,
  ]);
  const isCharacterHorizontalPanelOpen = isCharacterAppearance && Boolean(isCompactMenuOpen || isCompactReplyLoading || compactReply);
  const compactStyle = useMemo<CSSProperties>(() => {
    const buttonSize =
      compactAppearance === "character" ? Math.max(26, Math.round(compactSize.width * 0.36)) : Math.max(28, compactSize.height - 30);
    const iconSize =
      compactAppearance === "character" ? Math.max(14, Math.round(buttonSize * 0.48)) : Math.max(14, Math.round(buttonSize * 0.5));
    const characterReplyGap = Math.min(108, Math.max(40, Math.round(compactSize.width * 0.3)));

    return {
      "--compact-bar-width": `${Math.max(42, compactSize.width - 20)}px`,
      "--compact-bar-height": `${Math.max(42, compactSize.height - 24)}px`,
      "--compact-button-size": `${buttonSize}px`,
      "--compact-button-icon-size": `${iconSize}px`,
      "--compact-gap":
        compactAppearance === "character"
          ? `${Math.max(4, Math.round(compactSize.width * 0.04))}px`
          : `${Math.max(8, Math.round(compactSize.width * 0.08))}px`,
      "--compact-padding":
        compactAppearance === "character"
          ? `${Math.max(3, Math.round(compactSize.width * 0.03))}px`
          : `${Math.max(6, Math.round(compactSize.height * 0.13))}px`,
      "--compact-character-size": `${Math.max(48, compactSize.width - 18)}px`,
      "--compact-character-reply-gap": `${characterReplyGap}px`,
    } as CSSProperties;
  }, [compactAppearance, compactSize.height, compactSize.width]);

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
    localStorage.setItem(CURRENT_MODEL_STORAGE_KEY, modelId);
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
    setEditingMessageIndex,
    setError,
  } = useChatRuntime({
    activeChatId,
    availableModels,
    applyUsageToSession,
    createSessionFromMessages,
    currentModel,
    handleModelChange,
    messages,
    renameChatSession,
    setActiveChatId,
    setInputDraft,
    setInputDraftImages,
    setInputDraftKey,
    setMessages,
    setOpenChatMenu,
    setView,
    togglePinnedChatSession,
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
    isCompactMenuOpen,
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

  const handleTogglePinChat = useCallback(
    (session: { id: string }) => {
      togglePinnedChatSession(session.id);
      setOpenChatMenu(null);
    },
    [togglePinnedChatSession]
  );

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
        isCharacterAppearance={isCharacterAppearance}
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
        onOpenSettingsFromCompact={compactController.handleOpenSettingsFromCompact}
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
        onToggleMainFromCompact={compactController.handleToggleMainFromCompact}
      />
    );
  }

  return (
    <div className="app-shell glass flex flex-col h-screen w-screen overflow-hidden">
      <TitleBar onMinimizeToCompact={handleOpenCompact} minimizeBehavior={basicSettings.minimizeBehavior} />
      {view === "chat" ? (
        <MainChatView
          activeChatId={activeChatId}
          activeSession={activeSession}
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
          messages={messages}
          messagesScrollRef={messagesScrollRef}
          omniIconSrc={omniIconSrc}
          openChatMenu={openChatMenu}
          onCancelEditUserMessage={handleCancelEditUserMessage}
          onClearChat={handleClearChat}
          onCopyMessage={handleCopyMessage}
          onDeleteChat={handleDeleteChat}
          onEditUserMessage={handleEditUserMessage}
          onModelChange={handleModelChange}
          onNewChat={handleNewChat}
          onRegenerateMessage={handleRegenerateMessage}
          onRenameChat={handleRenameChat}
          onSelectChat={handleSelectChat}
          onSend={handleSend}
          onSetOpenChatMenu={setOpenChatMenu}
          onSettingsOpen={() => setView("settings")}
          onShareChat={handleShareChat}
          onStop={handleStop}
          onSubmitEditedUserMessage={handleSubmitEditedUserMessage}
          onTogglePinChat={handleTogglePinChat}
          onUseEmptyPrompt={handleUseEmptyPrompt}
        />
      ) : (
        <SettingsPanel onClose={() => setView("chat")} onModelChange={handleModelChange} />
      )}
    </div>
  );
}

export default App;
