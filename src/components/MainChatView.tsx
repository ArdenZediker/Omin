import { useEffect, useMemo, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  ArrowRight,
  CirclePlus,
  Compass,
  FolderOpen,
  MessageSquare,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Pin,
  Search,
  Settings,
  Share2,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { Message } from "../adapters/types";
import { formatUsageLabel } from "../chat/storage";
import type { ChatSession } from "../chat/types";
import ChatInput from "./ChatInput";
import ChatMessage from "./ChatMessage";
import ModelSelector from "./ModelSelector";

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

const RECOMMENDED_ASSISTANTS = [
  { title: "方案梳理助手", description: "帮你拆解需求、整理方案并规划执行步骤。" },
  { title: "代码排查助手", description: "适合定位报错、梳理链路和修复方向。" },
  { title: "文案润色助手", description: "用于改写说明文档、PR 描述和提示词。" },
  { title: "效率命令助手", description: "快速生成常用命令、脚本和操作建议。" },
];

const TOPIC_PANEL_WIDTH = 272;
const TOPIC_PANEL_AUTO_COLLAPSE_RATIO = 2 / 3;

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
  const [workspaceElement, setWorkspaceElement] = useState<HTMLElement | null>(null);
  const [isTopicPanelAutoCollapsed, setIsTopicPanelAutoCollapsed] = useState(false);
  const [topicPanelManualVisible, setTopicPanelManualVisible] = useState<boolean | null>(null);
  const recommendedPrompts = emptyChatPrompts.slice(0, 4);
  const latestSessions = groupedChatSessions.flatMap((group) => group.sessions).slice(0, 6);
  const currentTopicTitle = activeSession?.title || "随便聊聊";
  const defaultTopicPanelVisible = !isTopicPanelAutoCollapsed;
  const isTopicPanelVisible = topicPanelManualVisible ?? defaultTopicPanelVisible;
  const layoutClassName = useMemo(() => {
    const classNames = ["main-chat-layout"];

    if (topicPanelManualVisible === true) {
      classNames.push("main-chat-layout--topic-forced-open");
    }

    if (!isTopicPanelVisible) {
      classNames.push("main-chat-layout--topic-collapsed");
    }

    return classNames.join(" ");
  }, [isTopicPanelVisible, topicPanelManualVisible]);

  useEffect(() => {
    if (!workspaceElement) {
      return;
    }

    const updateAutoCollapsed = () => {
      const nextWorkspaceWidth = workspaceElement.getBoundingClientRect().width || 0;
      const nextEstimatedPaneWidth = Math.max(0, nextWorkspaceWidth - TOPIC_PANEL_WIDTH);
      const nextEstimatedPaneRatio = nextWorkspaceWidth > 0 ? nextEstimatedPaneWidth / nextWorkspaceWidth : 1;

      setIsTopicPanelAutoCollapsed(nextEstimatedPaneRatio < TOPIC_PANEL_AUTO_COLLAPSE_RATIO);
    };

    updateAutoCollapsed();

    let frameId = 0;
    const scheduleUpdate = () => {
      if (frameId) {
        cancelAnimationFrame(frameId);
      }

      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        updateAutoCollapsed();
      });
    };

    const observer = new ResizeObserver(() => {
      scheduleUpdate();
    });

    observer.observe(workspaceElement);
    window.addEventListener("resize", scheduleUpdate);

    return () => {
      if (frameId) {
        cancelAnimationFrame(frameId);
      }

      observer.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [workspaceElement]);

  return (
    <div className={layoutClassName}>
      <aside className="main-chat-nav">
        <button type="button" className="main-chat-nav__brand" title="Omni">
          <img src={omniIconSrc} alt="Omni" />
        </button>
        <div className="main-chat-nav__items">
          <button type="button" className="main-chat-nav__item main-chat-nav__item--active" title="聊天">
            <MessageSquare size={18} strokeWidth={1.9} />
          </button>
          <button type="button" className="main-chat-nav__item" title="助手">
            <Sparkles size={18} strokeWidth={1.9} />
          </button>
          <button type="button" className="main-chat-nav__item" title="资源">
            <FolderOpen size={18} strokeWidth={1.9} />
          </button>
        </div>
        <button type="button" className="main-chat-nav__item main-chat-nav__item--bottom" title="设置" onClick={onSettingsOpen}>
          <Settings size={18} strokeWidth={1.9} />
        </button>
      </aside>

      <aside className="chat-history-panel">
        <div className="chat-history-panel__brand">
          <div className="chat-history-panel__brand-mark">
            <img src={omniIconSrc} alt="Omni" />
          </div>
          <div className="chat-history-panel__brand-copy">
            <strong>Omni</strong>
            <span>工作助手</span>
          </div>
        </div>

        <button type="button" className="chat-history-panel__search">
          <Search size={14} strokeWidth={1.9} />
          <span>搜索助手 / 会话</span>
          <kbd>Ctrl K</kbd>
        </button>

        <button
          type="button"
          className={`chat-history-panel__new ${!activeChatId && messages.length === 0 ? "chat-history-panel__new--active" : ""}`}
          onClick={onNewChat}
        >
          <CirclePlus size={16} strokeWidth={1.8} />
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
                        value?.id === session.id ? null : { id: session.id, x: rect.right + 8, y: rect.top - 6 },
                      );
                    }}
                    aria-label="会话操作"
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

      <section ref={setWorkspaceElement} className="main-chat-workspace">
        <header className="main-chat-header">
          <div className="main-chat-toolbar">
            <div className="main-chat-toolbar__session main-chat-toolbar__session--hero">
              <div className="main-chat-toolbar__assistant">
                <div className="main-chat-toolbar__assistant-mark">
                  <img src={omniIconSrc} alt="Omni" />
                </div>
                <div className="main-chat-toolbar__assistant-copy">
                  <strong>{currentTopicTitle}</strong>
                  <span>开始新一轮思考、问答或执行任务</span>
                </div>
              </div>

              <ModelSelector currentModel={currentModel} onModelChange={onModelChange} />

              {activeSession && (
                <div className="main-chat-toolbar__usage">
                  <span>{formatUsageLabel(activeSession.usage)}</span>
                </div>
              )}
            </div>

            <div className="main-chat-toolbar__actions">
              {messages.length > 0 && (
                <button onClick={onClearChat} className="main-chat-toolbar__icon-button" title="清空对话" type="button">
                  <Trash2 className="main-chat-toolbar__icon" strokeWidth={1.7} />
                </button>
              )}
              <button
                className="main-chat-toolbar__icon-button"
                title="分享会话"
                type="button"
                onClick={() => {
                  if (activeSession) {
                    void onShareChat(activeSession);
                  }
                }}
                disabled={!activeSession}
              >
                <Share2 className="main-chat-toolbar__icon" strokeWidth={1.7} />
              </button>
              <button
                type="button"
                className="main-chat-toolbar__icon-button main-chat-toolbar__collapse-button"
                aria-label={isTopicPanelVisible ? "收起话题栏" : "展开话题栏"}
                title={isTopicPanelVisible ? "收起话题栏" : "展开话题栏"}
                onClick={() =>
                  setTopicPanelManualVisible((currentValue) => {
                    const currentVisible = currentValue ?? defaultTopicPanelVisible;
                    const nextVisible = !currentVisible;

                    return nextVisible === defaultTopicPanelVisible ? null : nextVisible;
                  })
                }
              >
                {isTopicPanelVisible ? <PanelRightClose className="main-chat-toolbar__icon" strokeWidth={1.7} /> : <PanelRightOpen className="main-chat-toolbar__icon" strokeWidth={1.7} />}
              </button>
              <button onClick={onSettingsOpen} className="main-chat-toolbar__icon-button" title="设置" type="button">
                <Settings className="main-chat-toolbar__icon" strokeWidth={1.7} />
              </button>
            </div>
          </div>

          <div className="chat-topic-panel__header">
            <div className="chat-topic-panel__title">
              <span>话题 {latestSessions.length}</span>
            </div>
            <div className="chat-topic-panel__header-actions">
              <button type="button" className="chat-topic-panel__icon-button" title="搜索话题">
                <Search size={16} strokeWidth={1.8} />
              </button>
              <button type="button" className="chat-topic-panel__icon-button" title="更多操作">
                <MoreHorizontal size={16} strokeWidth={1.8} />
              </button>
            </div>
          </div>
        </header>

        <main className="main-chat-pane">
          <div ref={messagesScrollRef} className="main-chat-scroll hide-scrollbar">
            {!hasModels && messages.length === 0 && (
              <div className="empty-chat-state">
                <div className="empty-chat-state__hero">
                  <div className="empty-chat-state__icon">
                    <img src={omniIconSrc} alt="Omni" />
                  </div>
                  <h2>欢迎使用 Omni</h2>
                  <p>请先配置一个可用模型，再开始对话、搜索或执行工作流。</p>
                </div>
                <button onClick={onSettingsOpen} className="empty-chat-state__primary" type="button">
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
                  <h2>下午好</h2>
                  <p>可以直接输入问题，也可以从下方选择一个起点。支持命令、图片和多轮对话。</p>
                </div>

                <div className="empty-chat-state__subhead">
                  <Sparkles size={14} strokeWidth={1.9} />
                  <span>推荐起步方式</span>
                </div>

                <div className="empty-chat-state__cards">
                  {recommendedPrompts.map((prompt, index) => (
                    <button key={prompt} type="button" className="empty-chat-state__card" onClick={() => onUseEmptyPrompt(prompt)}>
                      <div className="empty-chat-state__card-icon">
                        {index % 2 === 0 ? <Compass size={18} strokeWidth={1.8} /> : <Sparkles size={18} strokeWidth={1.8} />}
                      </div>
                      <div className="empty-chat-state__card-copy">
                        <strong>{RECOMMENDED_ASSISTANTS[index]?.title || "快速开始"}</strong>
                        <span>{RECOMMENDED_ASSISTANTS[index]?.description || prompt}</span>
                      </div>
                      <ArrowRight size={16} strokeWidth={1.8} />
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

            {error && <div className="main-chat-error animate-fade-in">{error}</div>}
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

        <aside className="chat-topic-panel">
          <div className="chat-topic-panel__body">
            <div className="chat-topic-panel__section">
              <div className="chat-topic-panel__section-title">当前会话</div>
              <div className="chat-topic-panel__active">
                <span className="chat-topic-panel__active-dot" />
                <span>{currentTopicTitle}</span>
              </div>
            </div>

            <div className="chat-topic-panel__section">
              <div className="chat-topic-panel__section-title">最近话题</div>
              <div className="chat-topic-panel__list">
                {latestSessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    className={`chat-topic-panel__item ${session.id === activeChatId ? "chat-topic-panel__item--active" : ""}`}
                    onClick={() => onSelectChat(session.id)}
                  >
                    <span>{session.title}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </aside>
      </section>
    </div>
  );
}
