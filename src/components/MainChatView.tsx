import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import {
  ArrowRight,
  Check,
  Compass,
  FolderOpen,
  Hash,
  History,
  MessageSquare,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Pin,
  Search,
  Settings,
  Share2,
  Sparkles,
  Star,
  Trash2,
  UserRoundPlus,
} from "lucide-react";
import type { Message } from "../adapters/types";
import { formatUsageLabel } from "../chat/storage";
import type { AssistantProfile, ChatSession } from "../chat/types";
import type { TaskExecutionResult } from "../chat/taskTypes";
import ChatInput from "./ChatInput";
import ChatMessage from "./ChatMessage";
import ModelSelector from "./ModelSelector";

type SessionGroup = {
  label: string;
  sessions: ChatSession[];
};

type TopicGroupingMode = "time" | "flat";

type TopicDeleteConfirmState = {
  title: string;
  message: string;
  sessions: ChatSession[];
} | null;

type MainChatViewProps = {
  activeAssistant: AssistantProfile | null;
  activeAssistantId: string;
  activeChatId: string | null;
  activeSession: ChatSession | null;
  assistants: AssistantProfile[];
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
  latestTaskResult: TaskExecutionResult | null;
  messages: Message[];
  messagesScrollRef: RefObject<HTMLDivElement | null>;
  omniIconSrc: string;
  openChatMenu: { id: string; x: number; y: number } | null;
  windowControls?: ReactNode;
  onCancelEditUserMessage: () => void;
  onClearChat: () => void;
  onCopyMessage: (message: Message) => void | Promise<void>;
  onCreateCustomAssistant: () => void;
  onDeleteChat: (session: ChatSession) => void;
  onEditUserMessage: (messageIndex: number) => void;
  onModelChange: (modelId: string) => void;
  onNewChat: () => void;
  onRegenerateMessage: (messageIndex: number) => void | Promise<void>;
  onRenameChat: (session: ChatSession) => void;
  onSelectAssistant: (assistantId: string) => void;
  onSelectChat: (sessionId: string) => void;
  onUpdateAssistantProfile: (assistantId: string, patch: Partial<AssistantProfile>) => AssistantProfile | null;
  onSend: (content: string, images?: string[]) => void | Promise<void>;
  onSetOpenChatMenu: Dispatch<SetStateAction<{ id: string; x: number; y: number } | null>>;
  onSettingsOpen: () => void;
  onShareChat: (session: ChatSession) => void | Promise<void>;
  onStop: () => void;
  onSubmitEditedUserMessage: (messageIndex: number, content: string) => void | Promise<void>;
  onToggleFavoriteChat: (session: ChatSession) => void;
  onTogglePinChat: (session: ChatSession) => void;
  onUseEmptyPrompt: (prompt: string) => void;
};

const RECOMMENDED_ASSISTANTS = [
  { title: "方案梳理助手", description: "帮你拆解需求、整理方案并规划执行步骤。" },
  { title: "代码排查助手", description: "适合定位报错、梳理链路和修复方向。" },
  { title: "文案润色助手", description: "用于改写说明文档、PR 描述和提示词。" },
  { title: "效率命令助手", description: "快速生成常用命令、脚本和操作建议。" },
];

const ASSISTANT_TOOL_OPTIONS = [
  { id: "search_sessions", label: "搜索会话" },
  { id: "read_session", label: "读取会话" },
  { id: "list_files", label: "列出文件" },
  { id: "read_file", label: "读取文件" },
  { id: "search_files", label: "搜索文件" },
  { id: "analyze_files", label: "分析文件" },
];

const ASSISTANT_SKILL_OPTIONS = [
  { id: "summarize", label: "总结" },
  { id: "translate", label: "翻译" },
  { id: "rewrite", label: "改写" },
  { id: "explain", label: "解释" },
  { id: "compare", label: "对比" },
];

const TOPIC_PANEL_WIDTH = 272;
const TOPIC_PANEL_AUTO_COLLAPSE_RATIO = 2 / 3;

function normalizeSearchText(value: string) {
  return value.toLocaleLowerCase().replace(/\s+/g, "");
}

function renderTopicGroupLabel(label: string) {
  if (label === "置顶") {
    return (
      <>
        <Pin size={11} strokeWidth={2} />
        <span>置顶话题</span>
      </>
    );
  }

  return <span>{label}</span>;
}

export default function MainChatView({
  activeAssistant,
  activeAssistantId,
  activeChatId,
  activeSession,
  assistants,
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
  latestTaskResult,
  messages,
  messagesScrollRef,
  omniIconSrc,
  windowControls,
  onCancelEditUserMessage,
  onClearChat,
  onCopyMessage,
  onCreateCustomAssistant,
  onDeleteChat,
  onEditUserMessage,
  onModelChange,
  onNewChat,
  onRegenerateMessage,
  onSelectAssistant,
  onSelectChat,
  onUpdateAssistantProfile,
  onSend,
  onSettingsOpen,
  onShareChat,
  onStop,
  onSubmitEditedUserMessage,
  onToggleFavoriteChat,
  onTogglePinChat,
  onUseEmptyPrompt,
}: MainChatViewProps) {
  const [workspaceElement, setWorkspaceElement] = useState<HTMLElement | null>(null);
  const [composerElement, setComposerElement] = useState<HTMLDivElement | null>(null);
  const [isTopicPanelAutoCollapsed, setIsTopicPanelAutoCollapsed] = useState(false);
  const [topicPanelManualVisible, setTopicPanelManualVisible] = useState<boolean | null>(null);
  const [composerHeight, setComposerHeight] = useState(0);
  const [topicSearchOpen, setTopicSearchOpen] = useState(false);
  const [topicSearchQuery, setTopicSearchQuery] = useState("");
  const [topicMenuOpen, setTopicMenuOpen] = useState(false);
  const [topicGroupingMode, setTopicGroupingMode] = useState<TopicGroupingMode>("flat");
  const [topicDeleteConfirm, setTopicDeleteConfirm] = useState<TopicDeleteConfirmState>(null);
  const topicSearchInputRef = useRef<HTMLInputElement | null>(null);
  const topicMenuRef = useRef<HTMLDivElement | null>(null);
  const topicMenuButtonRef = useRef<HTMLButtonElement | null>(null);

  const recommendedPrompts = emptyChatPrompts.slice(0, 4);
  const normalizedTopicSearchQuery = normalizeSearchText(topicSearchQuery);
  const filteredTopicGroups = useMemo(
    () =>
      groupedChatSessions
        .map((group) => ({
          ...group,
          sessions: group.sessions.filter((session) => normalizeSearchText(session.title).includes(normalizedTopicSearchQuery)),
        }))
        .filter((group) => group.sessions.length > 0),
    [groupedChatSessions, normalizedTopicSearchQuery]
  );
  const allTopicSessions = useMemo(() => groupedChatSessions.flatMap((group) => group.sessions), [groupedChatSessions]);
  const filteredTopicSessions = useMemo(() => filteredTopicGroups.flatMap((group) => group.sessions), [filteredTopicGroups]);
  const currentTopicTitle = activeSession?.title || (activeAssistant?.kind === "basic" ? "默认聊天" : activeAssistant?.title) || "默认聊天";
  const defaultTopicPanelVisible = !isTopicPanelAutoCollapsed;
  const isTopicPanelVisible = topicPanelManualVisible ?? defaultTopicPanelVisible;
  const basicAssistant = assistants.find((assistant) => assistant.kind === "basic") ?? null;
  const customAssistants = assistants.filter((assistant) => assistant.kind === "custom");
  const [assistantTitleDraft, setAssistantTitleDraft] = useState(activeAssistant?.title ?? "");
  const [assistantDescriptionDraft, setAssistantDescriptionDraft] = useState(activeAssistant?.description ?? "");
  const [assistantPromptDraft, setAssistantPromptDraft] = useState(activeAssistant?.systemPrompt ?? "");
  const [assistantModelDraft, setAssistantModelDraft] = useState(activeAssistant?.defaultModelId ?? "");

  const layoutClassName = useMemo(() => {
    const classNames = ["main-chat-layout"];
    if (topicPanelManualVisible === true) classNames.push("main-chat-layout--topic-forced-open");
    if (!isTopicPanelVisible) classNames.push("main-chat-layout--topic-collapsed");
    return classNames.join(" ");
  }, [isTopicPanelVisible, topicPanelManualVisible]);

  useEffect(() => {
    if (!composerElement) return;
    const updateComposerHeight = () => setComposerHeight(composerElement.getBoundingClientRect().height || 0);
    updateComposerHeight();
    const observer = new ResizeObserver(updateComposerHeight);
    observer.observe(composerElement);
    return () => observer.disconnect();
  }, [composerElement]);

  useEffect(() => {
    setAssistantTitleDraft(activeAssistant?.title ?? "");
    setAssistantDescriptionDraft(activeAssistant?.description ?? "");
    setAssistantPromptDraft(activeAssistant?.systemPrompt ?? "");
    setAssistantModelDraft(activeAssistant?.defaultModelId ?? "");
  }, [activeAssistant]);

  useEffect(() => {
    if (!workspaceElement) return;
    const updateAutoCollapsed = () => {
      const nextWorkspaceWidth = workspaceElement.getBoundingClientRect().width || 0;
      const nextEstimatedPaneWidth = Math.max(0, nextWorkspaceWidth - TOPIC_PANEL_WIDTH);
      const nextEstimatedPaneRatio = nextWorkspaceWidth > 0 ? nextEstimatedPaneWidth / nextWorkspaceWidth : 1;
      setIsTopicPanelAutoCollapsed(nextEstimatedPaneRatio < TOPIC_PANEL_AUTO_COLLAPSE_RATIO);
    };
    updateAutoCollapsed();
    let frameId = 0;
    const scheduleUpdate = () => {
      if (frameId) cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        updateAutoCollapsed();
      });
    };
    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(workspaceElement);
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      if (frameId) cancelAnimationFrame(frameId);
      observer.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [workspaceElement]);

  useEffect(() => {
    if (topicSearchOpen) {
      topicSearchInputRef.current?.focus();
    } else if (topicSearchQuery) {
      setTopicSearchQuery("");
    }
  }, [topicSearchOpen, topicSearchQuery]);

  useEffect(() => {
    if (!topicMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (topicMenuRef.current?.contains(target)) return;
      if (topicMenuButtonRef.current?.contains(target)) return;
      setTopicMenuOpen(false);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [topicMenuOpen]);

  const handleDeleteSessions = (sessions: ChatSession[], title: string, message: string) => {
    if (sessions.length === 0) {
      setTopicMenuOpen(false);
      return;
    }
    setTopicDeleteConfirm({ title, message, sessions });
    setTopicMenuOpen(false);
  };

  const handleConfirmDeleteSessions = () => {
    if (!topicDeleteConfirm) return;
    topicDeleteConfirm.sessions.forEach((session) => onDeleteChat(session));
    setTopicDeleteConfirm(null);
  };

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
            <span>桌面 AI 工作台</span>
          </div>
        </div>

        <div className="chat-history-panel__assistants">
          {basicAssistant && (
            <div className="chat-history-panel__assistant-section">
              <div className="chat-history-panel__section-head">基础聊天</div>
              <button
                type="button"
                className={`chat-history-panel__assistant ${activeAssistantId === basicAssistant.id ? "chat-history-panel__assistant--active" : ""}`}
                onClick={() => onSelectAssistant(basicAssistant.id)}
              >
                <span className="chat-history-panel__assistant-icon">
                  <img src={omniIconSrc} alt="" />
                </span>
                <span className="chat-history-panel__assistant-copy">
                  <strong>{basicAssistant.title}</strong>
                  <span>{basicAssistant.description}</span>
                </span>
              </button>
            </div>
          )}

          <div className="chat-history-panel__assistant-section">
            <div className="chat-history-panel__section-head">
              <span>自定义助手</span>
              <button type="button" className="chat-history-panel__section-action" onClick={onCreateCustomAssistant} title="新增助手">
                <UserRoundPlus size={14} strokeWidth={1.8} />
              </button>
            </div>
            <div className="chat-history-panel__assistant-list">
              {customAssistants.length === 0 ? (
                <div className="chat-history-panel__assistant-empty">还没有自定义助手</div>
              ) : (
                customAssistants.map((assistant) => (
                  <button
                    key={assistant.id}
                    type="button"
                    className={`chat-history-panel__assistant ${activeAssistantId === assistant.id ? "chat-history-panel__assistant--active" : ""}`}
                    onClick={() => onSelectAssistant(assistant.id)}
                  >
                    <span className="chat-history-panel__assistant-icon chat-history-panel__assistant-icon--custom">
                      <Sparkles size={15} strokeWidth={1.8} />
                    </span>
                    <span className="chat-history-panel__assistant-copy">
                      <strong>{assistant.title}</strong>
                      <span>{assistant.description}</span>
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>

          {activeAssistant?.kind === "custom" && (
            <div className="chat-history-panel__assistant-section">
              <div className="chat-history-panel__section-head">
                <span>助手配置</span>
              </div>
              <div className="chat-history-panel__assistant-form">
                <label className="chat-history-panel__assistant-field">
                  <span>鍚嶇О</span>
                  <input
                    value={assistantTitleDraft}
                    onChange={(event) => setAssistantTitleDraft(event.target.value)}
                    onBlur={() => onUpdateAssistantProfile(activeAssistant.id, { title: assistantTitleDraft })}
                  />
                </label>
                <label className="chat-history-panel__assistant-field">
                  <span>鎻忚堪</span>
                  <input
                    value={assistantDescriptionDraft}
                    onChange={(event) => setAssistantDescriptionDraft(event.target.value)}
                    onBlur={() => onUpdateAssistantProfile(activeAssistant.id, { description: assistantDescriptionDraft })}
                  />
                </label>
                <label className="chat-history-panel__assistant-field">
                  <span>默认模型</span>
                  <input
                    value={assistantModelDraft}
                    onChange={(event) => setAssistantModelDraft(event.target.value)}
                    onBlur={() => onUpdateAssistantProfile(activeAssistant.id, { defaultModelId: assistantModelDraft || null })}
                    placeholder="渚嬪 gpt-4o"
                  />
                </label>
                <label className="chat-history-panel__assistant-field">
                  <span>系统提示词</span>
                  <textarea
                    value={assistantPromptDraft}
                    onChange={(event) => setAssistantPromptDraft(event.target.value)}
                    onBlur={() => onUpdateAssistantProfile(activeAssistant.id, { systemPrompt: assistantPromptDraft })}
                    rows={4}
                  />
                </label>
                <div className="chat-history-panel__assistant-field">
                  <span>工具权限</span>
                  <div className="chat-history-panel__tool-permissions">
                    {ASSISTANT_TOOL_OPTIONS.map((tool) => {
                      const checked = activeAssistant.allowedToolIds.includes(tool.id);
                      return (
                        <label key={tool.id} className="chat-history-panel__tool-option">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) => {
                              const nextAllowedToolIds = event.target.checked
                                ? [...activeAssistant.allowedToolIds, tool.id]
                                : activeAssistant.allowedToolIds.filter((item) => item !== tool.id);
                              onUpdateAssistantProfile(activeAssistant.id, { allowedToolIds: nextAllowedToolIds });
                            }}
                          />
                          <span>{tool.label}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
                <div className="chat-history-panel__assistant-field">
                  <span>技能权限</span>
                  <div className="chat-history-panel__tool-permissions">
                    {ASSISTANT_SKILL_OPTIONS.map((skill) => {
                      const checked = activeAssistant.allowedSkillIds.includes(skill.id);
                      return (
                        <label key={skill.id} className="chat-history-panel__tool-option">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) => {
                              const nextAllowedSkillIds = event.target.checked
                                ? [...activeAssistant.allowedSkillIds, skill.id]
                                : activeAssistant.allowedSkillIds.filter((item) => item !== skill.id);
                              onUpdateAssistantProfile(activeAssistant.id, { allowedSkillIds: nextAllowedSkillIds });
                            }}
                          />
                          <span>{skill.label}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </aside>

      <section ref={setWorkspaceElement} className="main-chat-workspace" style={{ "--composer-height": `${composerHeight}px` } as CSSProperties}>
        <header className="main-chat-header drag-region">
          <div className="main-chat-toolbar">
            <div className="main-chat-toolbar__session main-chat-toolbar__session--hero">
              <div className="main-chat-toolbar__assistant">
                <div className="main-chat-toolbar__assistant-mark">
                  <img src={omniIconSrc} alt="Omni" />
                </div>
                <div className="main-chat-toolbar__assistant-copy">
                  <strong>{currentTopicTitle}</strong>
                  <span>{activeAssistant?.description || "开始新一轮思考、问答或执行任务"}</span>
                </div>
              </div>

              <div className="no-drag">
                <ModelSelector currentModel={currentModel} onModelChange={onModelChange} />
              </div>
            </div>

            <div className="main-chat-toolbar__actions no-drag">
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
              {windowControls}
            </div>
          </div>
          <div className="chat-topic-panel__header" />
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
                  <h2>从当前助手开始</h2>
                  <p>你可以直接输入问题，也可以从下方选择一个起点。后续任务、工具和技能会默认归属当前助手。</p>
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

          <div ref={setComposerElement}>
            <ChatInput
              canStartNewTopic={activeAssistant?.kind === "basic"}
              onSend={onSend}
              hasConversation={messages.some((message) => message.role === "user")}
              usageLabel={activeSession ? formatUsageLabel(activeSession.usage) : null}
              isLoading={isLoading}
              onStop={onStop}
              onStartNewTopic={onNewChat}
              focusSignal={inputFocusKey}
              draftValue={inputDraft}
              draftImages={inputDraftImages}
              draftSignal={inputDraftKey}
            />
          </div>
        </main>

        <aside className="chat-topic-panel">
          <div className="chat-topic-panel__body">
            {latestTaskResult && (
              <div className="chat-topic-panel__section chat-topic-panel__section--task">
                <div className="chat-topic-panel__section-title">当前任务</div>
                <div className="chat-topic-panel__task">
                  <div className="chat-topic-panel__task-head">
                    <strong>{latestTaskResult.plan.goal}</strong>
                    <span className={`chat-topic-panel__task-status chat-topic-panel__task-status--${latestTaskResult.status}`}>
                      {latestTaskResult.status}
                    </span>
                  </div>
                  <div className="chat-topic-panel__task-meta">
                    <span>{latestTaskResult.intent}</span>
                    <span>{latestTaskResult.plan.model}</span>
                  </div>
                  {(latestTaskResult.plan.parentTaskId || latestTaskResult.plan.childTaskIds?.length || latestTaskResult.plan.delegatedTo) && (
                    <div className="chat-topic-panel__task-links">
                      {latestTaskResult.plan.parentTaskId && (
                        <div className="chat-topic-panel__task-link-row">
                          <span className="chat-topic-panel__task-link-label">parent</span>
                          <span className="chat-topic-panel__task-link-value">{latestTaskResult.plan.parentTaskId}</span>
                        </div>
                      )}
                      {latestTaskResult.plan.delegatedTo && (
                        <div className="chat-topic-panel__task-link-row">
                          <span className="chat-topic-panel__task-link-label">delegate</span>
                          <span className="chat-topic-panel__task-link-value">{latestTaskResult.plan.delegatedTo}</span>
                        </div>
                      )}
                      {latestTaskResult.plan.childTaskIds?.length ? (
                        <div className="chat-topic-panel__task-children">
                          {latestTaskResult.plan.childTaskIds.map((childTaskId) => {
                            const isActive = latestTaskResult.plan.metadata?.activeChildTaskId === childTaskId;
                            return (
                              <span key={childTaskId} className={`chat-topic-panel__task-child ${isActive ? "chat-topic-panel__task-child--active" : ""}`}>
                                {childTaskId}
                              </span>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  )}
                  <div className="chat-topic-panel__task-steps">
                    {latestTaskResult.plan.steps.map((step) => (
                      <div key={step.id} className="chat-topic-panel__task-step">
                        <span className="chat-topic-panel__task-step-title">{step.title}</span>
                        <span className={`chat-topic-panel__task-step-status chat-topic-panel__task-step-status--${step.status}`}>{step.status}</span>
                      </div>
                    ))}
                  </div>
                  {latestTaskResult.trace.length > 0 && (
                    <div className="chat-topic-panel__task-trace">
                      {latestTaskResult.trace.map((entry, index) => (
                        <div key={`${entry.at}-${index}`} className="chat-topic-panel__task-trace-item">
                          <span className="chat-topic-panel__task-trace-stage">{entry.stage}</span>
                          <span className="chat-topic-panel__task-trace-message">{entry.message}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="chat-topic-panel__toolbar">
              <div className="chat-topic-panel__title">
                <Hash size={14} strokeWidth={2} />
                <span>话题 {allTopicSessions.length}</span>
              </div>
              <div className="chat-topic-panel__header-actions">
                <button
                  type="button"
                  className={`chat-topic-panel__icon-button ${topicSearchOpen ? "chat-topic-panel__icon-button--active" : ""}`}
                  title="搜索话题"
                  onClick={() => {
                    setTopicMenuOpen(false);
                    setTopicSearchOpen((current) => !current);
                  }}
                >
                  <Search size={16} strokeWidth={1.8} />
                </button>
                <button
                  ref={topicMenuButtonRef}
                  type="button"
                  className={`chat-topic-panel__icon-button ${topicMenuOpen ? "chat-topic-panel__icon-button--active" : ""}`}
                  title="更多操作"
                  onClick={() => {
                    setTopicSearchOpen(false);
                    setTopicMenuOpen((current) => !current);
                  }}
                >
                  <MoreHorizontal size={16} strokeWidth={1.8} />
                </button>
              </div>
            </div>

            {topicSearchOpen && (
              <div className="chat-topic-panel__search">
                <Search size={14} strokeWidth={1.8} />
                <input
                  ref={topicSearchInputRef}
                  value={topicSearchQuery}
                  onChange={(event) => setTopicSearchQuery(event.target.value)}
                  placeholder="搜索话题标题"
                />
              </div>
            )}

            {topicMenuOpen && (
              <div ref={topicMenuRef} className="chat-topic-panel__menu">
                <button
                  type="button"
                  className="chat-topic-panel__menu-button"
                  onClick={() => {
                    setTopicGroupingMode("time");
                    setTopicMenuOpen(false);
                  }}
                >
                  <span className="chat-topic-panel__menu-check">{topicGroupingMode === "time" ? <Check size={14} strokeWidth={2.2} /> : null}</span>
                  <span>按时间分组</span>
                </button>
                <button
                  type="button"
                  className="chat-topic-panel__menu-button"
                  onClick={() => {
                    setTopicGroupingMode("flat");
                    setTopicMenuOpen(false);
                  }}
                >
                  <span className="chat-topic-panel__menu-check">{topicGroupingMode === "flat" ? <Check size={14} strokeWidth={2.2} /> : null}</span>
                  <span>不分组</span>
                </button>
                <div className="chat-topic-panel__menu-divider" />
                <button
                  type="button"
                  className="chat-topic-panel__menu-button"
                  onClick={() => handleDeleteSessions(allTopicSessions.filter((session) => !session.favorite), "删除未收藏话题", "确定删除未收藏的话题吗？")}
                >
                  <Trash2 size={14} strokeWidth={1.9} />
                  <span>删除未收藏话题</span>
                </button>
                <button
                  type="button"
                  className="chat-topic-panel__menu-button chat-topic-panel__menu-button--danger"
                  onClick={() => handleDeleteSessions(allTopicSessions, "删除全部话题", "确定删除当前助手下的全部话题吗？")}
                >
                  <Trash2 size={14} strokeWidth={1.9} />
                  <span>删除全部话题</span>
                </button>
              </div>
            )}

            <div className="chat-topic-panel__section">
              <div className="chat-topic-panel__section-title">
                <MessageSquare size={13} strokeWidth={2} />
                <span>当前话题</span>
              </div>
              <div className="chat-topic-panel__active">
                <span className="chat-topic-panel__active-dot" />
                <div className="chat-topic-panel__active-copy">
                  <span>{currentTopicTitle}</span>
                </div>
              </div>
            </div>

            <div className="chat-topic-panel__section">
              <div className="chat-topic-panel__section-title">
                <History size={13} strokeWidth={2} />
                <span>最近话题</span>
              </div>
              {filteredTopicSessions.length === 0 ? (
                <div className="chat-topic-panel__empty">没有匹配的话题</div>
              ) : topicGroupingMode === "time" ? (
                <div className="chat-topic-panel__group-list">
                  {filteredTopicGroups.map((group) => (
                    <div key={group.label} className="chat-topic-panel__group">
                      <div className="chat-topic-panel__group-title">{renderTopicGroupLabel(group.label)}</div>
                      <div className="chat-topic-panel__list">
                        {group.sessions.map((session) => (
                          <button
                            key={session.id}
                            type="button"
                            className={`chat-topic-panel__item ${session.id === activeChatId ? "chat-topic-panel__item--active" : ""}`}
                            onClick={() => onSelectChat(session.id)}
                          >
                            <MessageSquare size={13} strokeWidth={1.9} className="chat-topic-panel__item-icon" />
                            <span className="chat-topic-panel__item-copy">
                              <span className="chat-topic-panel__item-title">{session.title}</span>
                            </span>
                            <span
                              className={`chat-topic-panel__badge ${session.pinned ? "chat-topic-panel__badge--active" : ""}`}
                              title={session.pinned ? "取消置顶" : "置顶话题"}
                              aria-label={session.pinned ? "取消置顶" : "置顶话题"}
                              role="button"
                              tabIndex={0}
                              onClick={(event) => {
                                event.stopPropagation();
                                onTogglePinChat(session);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  onTogglePinChat(session);
                                }
                              }}
                            >
                              <Pin size={11} strokeWidth={2} />
                            </span>
                            <span
                              className={`chat-topic-panel__pin ${session.favorite ? "chat-topic-panel__pin--active" : ""}`}
                              title={session.favorite ? "取消收藏" : "收藏话题"}
                              aria-label={session.favorite ? "取消收藏" : "收藏话题"}
                              role="button"
                              tabIndex={0}
                              onClick={(event) => {
                                event.stopPropagation();
                                onToggleFavoriteChat(session);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  onToggleFavoriteChat(session);
                                }
                              }}
                            >
                              <Star size={12} strokeWidth={2} fill={session.favorite ? "currentColor" : "none"} />
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="chat-topic-panel__list">
                  {filteredTopicSessions.map((session) => (
                    <button
                      key={session.id}
                      type="button"
                      className={`chat-topic-panel__item ${session.id === activeChatId ? "chat-topic-panel__item--active" : ""}`}
                      onClick={() => onSelectChat(session.id)}
                    >
                      <MessageSquare size={13} strokeWidth={1.9} className="chat-topic-panel__item-icon" />
                      <span className="chat-topic-panel__item-copy">
                        <span className="chat-topic-panel__item-title">{session.title}</span>
                      </span>
                      <span
                        className={`chat-topic-panel__badge ${session.pinned ? "chat-topic-panel__badge--active" : ""}`}
                        title={session.pinned ? "取消置顶" : "置顶话题"}
                        aria-label={session.pinned ? "取消置顶" : "置顶话题"}
                        role="button"
                        tabIndex={0}
                        onClick={(event) => {
                          event.stopPropagation();
                          onTogglePinChat(session);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            event.stopPropagation();
                            onTogglePinChat(session);
                          }
                        }}
                      >
                        <Pin size={11} strokeWidth={2} />
                      </span>
                      <span
                        className={`chat-topic-panel__pin ${session.favorite ? "chat-topic-panel__pin--active" : ""}`}
                        title={session.favorite ? "取消收藏" : "收藏话题"}
                        aria-label={session.favorite ? "取消收藏" : "收藏话题"}
                        role="button"
                        tabIndex={0}
                        onClick={(event) => {
                          event.stopPropagation();
                          onToggleFavoriteChat(session);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            event.stopPropagation();
                            onToggleFavoriteChat(session);
                          }
                        }}
                      >
                        <Star size={12} strokeWidth={2} fill={session.favorite ? "currentColor" : "none"} />
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </aside>
      </section>

      {topicDeleteConfirm && (
        <div className="omni-confirm-overlay" onClick={() => setTopicDeleteConfirm(null)}>
          <div className="omni-confirm-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="omni-confirm-dialog__title">{topicDeleteConfirm.title}</div>
            <div className="omni-confirm-dialog__message">{topicDeleteConfirm.message}</div>
            <div className="omni-confirm-dialog__actions">
              <button type="button" className="omni-confirm-dialog__button" onClick={() => setTopicDeleteConfirm(null)}>
                取消
              </button>
              <button
                type="button"
                className="omni-confirm-dialog__button omni-confirm-dialog__button--danger"
                onClick={handleConfirmDeleteSessions}
              >
                确定删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
