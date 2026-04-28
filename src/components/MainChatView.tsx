import type { Dispatch, RefObject, SetStateAction } from "react";
import { ArrowRight, CirclePlus, MoreHorizontal, Pencil, Pin, Settings, Share2, Trash2 } from "lucide-react";
import type { Message } from "../adapters/types";
import type { ChatSession } from "../chat/types";
import { formatUsageLabel } from "../chat/storage";
import ModelSelector from "./ModelSelector";
import ChatMessage from "./ChatMessage";
import ChatInput from "./ChatInput";

type SessionGroup = {
  label: string;
  sessions: ChatSession[];
};

type MainChatViewProps = {
  activeChatId: string | null;
  activeSession: ChatSession | null;
  currentModel: string;
  editingMessageIndex: number | null;
  emptyChatPrompts: string[];
  error: string | null;
  groupedChatSessions: SessionGroup[];
  hasModels: boolean;
  inputDraft: string;
  inputDraftImages: string[];
  inputDraftKey: number;
  inputFocusKey: number;
  isLoading: boolean;
  isStreaming: boolean;
  messages: Message[];
  messagesScrollRef: RefObject<HTMLDivElement | null>;
  omniIconSrc: string;
  openChatMenu: { id: string; x: number; y: number } | null;
  onCancelEditUserMessage: () => void;
  onClearChat: () => void;
  onCopyMessage: (message: Message) => void | Promise<void>;
  onDeleteChat: (session: ChatSession) => void;
  onEditUserMessage: (messageIndex: number) => void;
  onModelChange: (modelId: string) => void;
  onNewChat: () => void;
  onRegenerateMessage: (messageIndex: number) => void | Promise<void>;
  onRenameChat: (session: ChatSession) => void;
  onSelectChat: (sessionId: string) => void;
  onSend: (content: string, images?: string[]) => void | Promise<void>;
  onSetOpenChatMenu: Dispatch<SetStateAction<{ id: string; x: number; y: number } | null>>;
  onSettingsOpen: () => void;
  onShareChat: (session: ChatSession) => void | Promise<void>;
  onStop: () => void;
  onSubmitEditedUserMessage: (messageIndex: number, content: string) => void | Promise<void>;
  onTogglePinChat: (session: ChatSession) => void;
  onUseEmptyPrompt: (prompt: string) => void;
};

export default function MainChatView({
  activeChatId,
  activeSession,
  currentModel,
  editingMessageIndex,
  emptyChatPrompts,
  error,
  groupedChatSessions,
  hasModels,
  inputDraft,
  inputDraftImages,
  inputDraftKey,
  inputFocusKey,
  isLoading,
  isStreaming,
  messages,
  messagesScrollRef,
  omniIconSrc,
  openChatMenu,
  onCancelEditUserMessage,
  onClearChat,
  onCopyMessage,
  onDeleteChat,
  onEditUserMessage,
  onModelChange,
  onNewChat,
  onRegenerateMessage,
  onRenameChat,
  onSelectChat,
  onSend,
  onSetOpenChatMenu,
  onSettingsOpen,
  onShareChat,
  onStop,
  onSubmitEditedUserMessage,
  onTogglePinChat,
  onUseEmptyPrompt,
}: MainChatViewProps) {
  return (
    <div className="main-chat-layout">
      <aside className="chat-history-panel">
        <button
          type="button"
          className={`chat-history-panel__new ${!activeChatId && messages.length === 0 ? "chat-history-panel__new--active" : ""}`}
          onClick={onNewChat}
        >
          <CirclePlus size={18} strokeWidth={1.7} />
          <span>新建对话</span>
        </button>
        <div className="chat-history-panel__list hide-scrollbar">
          {groupedChatSessions.map((group) => (
            <section key={group.label} className="chat-history-panel__group">
              <div className="chat-history-panel__group-label">{group.label}</div>
              {group.sessions.map((session) => (
                <div key={session.id} className="chat-history-panel__item-wrap">
                  <button
                    type="button"
                    className={`chat-history-panel__item ${session.id === activeChatId ? "chat-history-panel__item--active" : ""}`}
                    onClick={() => {
                      onSetOpenChatMenu(null);
                      onSelectChat(session.id);
                    }}
                  >
                    <span className="chat-history-panel__title">{session.title}</span>
                    <span className="chat-history-panel__meta">{formatUsageLabel(session.usage)}</span>
                  </button>
                  <button
                    type="button"
                    className="chat-history-panel__more"
                    onClick={(event) => {
                      event.stopPropagation();
                      const rect = event.currentTarget.getBoundingClientRect();
                      onSetOpenChatMenu((value) =>
                        value?.id === session.id ? null : { id: session.id, x: rect.right + 8, y: rect.top - 6 }
                      );
                    }}
                    aria-label="对话操作"
                  >
                    <MoreHorizontal size={16} strokeWidth={1.8} />
                  </button>
                  {openChatMenu?.id === session.id && (
                    <div className="chat-history-panel__menu" style={{ left: openChatMenu.x, top: openChatMenu.y }}>
                      <button type="button" onClick={() => onRenameChat(session)}>
                        <Pencil size={14} strokeWidth={1.8} />
                        <span>重命名</span>
                      </button>
                      <button type="button" onClick={() => onTogglePinChat(session)}>
                        <Pin size={14} strokeWidth={1.8} />
                        <span>{session.pinned ? "取消置顶" : "置顶"}</span>
                      </button>
                      <button type="button" onClick={() => void onShareChat(session)}>
                        <Share2 size={14} strokeWidth={1.8} />
                        <span>分享</span>
                      </button>
                      <button type="button" className="chat-history-panel__menu-danger" onClick={() => onDeleteChat(session)}>
                        <Trash2 size={14} strokeWidth={1.8} />
                        <span>删除</span>
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </section>
          ))}
        </div>
      </aside>
      <main className="main-chat-pane">
        <div className="main-chat-toolbar">
          <div className="main-chat-toolbar__session">
            <ModelSelector currentModel={currentModel} onModelChange={onModelChange} />
            {activeSession && (
              <div className="main-chat-toolbar__usage">
                <span>{formatUsageLabel(activeSession.usage)}</span>
              </div>
            )}
          </div>
          <div className="main-chat-toolbar__actions">
            {messages.length > 0 && (
              <button
                onClick={onClearChat}
                className="p-1.5 rounded-md hover:bg-white/10 transition-colors"
                title="清空对话"
                type="button"
              >
                <Trash2 className="w-3.5 h-3.5 text-white/30" strokeWidth={1.5} />
              </button>
            )}
            <button
              onClick={onSettingsOpen}
              className="p-1.5 rounded-md hover:bg-white/10 transition-colors"
              title="设置"
              type="button"
            >
              <Settings className="w-3.5 h-3.5 text-white/30" strokeWidth={1.5} />
            </button>
          </div>
        </div>

        <div ref={messagesScrollRef} className="main-chat-scroll hide-scrollbar">
          {!hasModels && messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center px-6">
              <div className="w-12 h-12 rounded-full bg-gradient-to-br from-violet-400 to-indigo-600 flex items-center justify-center mb-4 shadow-lg shadow-violet-500/30">
                <img src={omniIconSrc} alt="Omni" className="w-7 h-7" />
              </div>
              <h3 className="text-sm font-medium text-white/70 mb-1">欢迎使用 Omni</h3>
              <p className="text-xs text-white/30 mb-4">请先配置一个模型提供方，再开始对话。</p>
              <button
                onClick={onSettingsOpen}
                className="px-4 py-2 text-xs font-medium rounded-lg bg-gradient-to-r from-violet-500 to-indigo-600 text-white hover:from-violet-400 hover:to-indigo-500 transition-all shadow-lg shadow-violet-500/20"
                type="button"
              >
                打开设置
              </button>
            </div>
          )}

          {hasModels && messages.length === 0 && (
            <div className="empty-chat-state">
              <div className="empty-chat-state__hero">
                <div className="empty-chat-state__icon">
                  <img src={omniIconSrc} alt="Omni" />
                </div>
                <h2>今天想处理什么？</h2>
                <p>可以直接输入问题，也可以从下面选择一个起点。支持粘贴图片到输入框。</p>
              </div>
              <div className="empty-chat-state__prompts">
                {emptyChatPrompts.map((prompt) => (
                  <button key={prompt} type="button" onClick={() => onUseEmptyPrompt(prompt)}>
                    <span>{prompt}</span>
                    <ArrowRight size={16} strokeWidth={1.7} />
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, index) => (
            <ChatMessage
              key={index}
              message={msg}
              index={index}
              isStreaming={isStreaming && index === messages.length - 1}
              isEditing={editingMessageIndex === index}
              onCopy={onCopyMessage}
              onEdit={onEditUserMessage}
              onCancelEdit={onCancelEditUserMessage}
              onSubmitEdit={onSubmitEditedUserMessage}
              onRegenerate={onRegenerateMessage}
            />
          ))}

          {error && (
            <div className="animate-fade-in px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-400/80">
              {error}
            </div>
          )}
        </div>

        <ChatInput
          onSend={onSend}
          isLoading={isLoading}
          onStop={onStop}
          focusSignal={inputFocusKey}
          draftValue={inputDraft}
          draftImages={inputDraftImages}
          draftSignal={inputDraftKey}
        />
      </main>
    </div>
  );
}
