import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import {
  ArrowRight,
  Bot,
  Check,
  GripVertical,
  Compass,
  Cpu,
  FolderOpen,
  Hash,
  History,
  MessageSquare,
  MoreHorizontal,
  PawPrint,
  Pencil,
  PanelRightClose,
  PanelRightOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  Plus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Search,
  Settings,
  Share2,
  Sparkles,
  Star,
  TimerReset,
  Trash2,
} from "lucide-react";
import type { Message } from "../adapters/types";
import type { ModelConfig } from "../adapters/types";
import { formatUsageLabel } from "../chat/storage";
import type { AssistantProfile, ChatSession } from "../chat/types";
import type { AssistantMemoryScope } from "../chat/types";
import type { TaskExecutionResult } from "../chat/taskTypes";
import type { TaskRuntimeState } from "../chat/taskTypes";
import { RECOMMENDED_ASSISTANT_PRESETS } from "../config/manifests/assistants";
import { AVATAR_CATEGORIES, AVATAR_PRESETS } from "../config/manifests/avatars";
import { filterAvatarPresets, getEmojiAssetSrc, resolveAssistantAvatarImageSrc, resolveAssistantAvatarSeed, resolveEmojiAvatarCode } from "../config/manifests/avatarHelpers";
import { ASSISTANT_SKILL_OPTIONS, SKILL_MANIFESTS } from "../config/manifests/skills";
import { ASSISTANT_TOOL_OPTIONS, TOOLSET_MANIFESTS } from "../config/manifests/tools";
import type { AvatarCategoryManifest } from "../config/manifests/types";
import { readSqliteBackedValue, saveSqliteBackedValue } from "../app/sqliteStorage";
import ChatInput from "./ChatInput";
import ChatMessage from "./ChatMessage";
import ModelSelector from "./ModelSelector";
import { useCallback } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

const MAIN_LAYOUT_TOPIC_WIDTH_STORAGE_KEY = "main_layout_topic_width";
const DEFAULT_TOPIC_PANEL_WIDTH = 240;
const MIN_TOPIC_PANEL_WIDTH = 220;
const MAX_TOPIC_PANEL_WIDTH = 360;

function clampPanelWidth(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function readStoredPanelWidth(storageKey: string, fallback: number, min: number, max: number) {
  const saved = readSqliteBackedValue(storageKey);
  if (!saved) return fallback;
  const parsed = Number.parseInt(saved, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return clampPanelWidth(parsed, min, max);
}

type SessionGroup = {
  label: string;
  sessions: ChatSession[];
};

type TopicGroupingMode = "time" | "flat";
type SidePanelTab = "topics" | "memory" | "automation" | "tasks";

type TopicDeleteConfirmState = {
  title: string;
  message: string;
  sessions: ChatSession[];
} | null;

type AssistantDeleteConfirmState = {
  assistantId: string;
  title: string;
  message: string;
} | null;

type AssistantDisplayGroup = {
  label: string;
  assistants: AssistantProfile[];
};

type MainChatViewProps = {
  activeAssistant: AssistantProfile | null;
  activeAssistantId: string;
  activeChatId: string | null;
  activeSession: ChatSession | null;
  assistants: AssistantProfile[];
  availableModels: ModelConfig[];
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
  relatedContext: {
    summaries: Array<{ sessionId: string; title: string; summary: string }>;
    memories: Array<{ id: string; content: string; sourceSessionId?: string | null }>;
  };
  scheduledTasks: Array<{
    id: string;
    title: string;
    prompt: string;
    cron: string;
    target: "desktop" | "notification" | "session";
    enabled: boolean;
    lastRunAt?: number | null;
  }>;
  latestTaskResult: TaskExecutionResult | null;
  taskRuntimeState: TaskRuntimeState;
  messages: Message[];
  messagesScrollRef: RefObject<HTMLDivElement | null>;
  omniIconSrc: string;
  openChatMenu: { id: string; x: number; y: number } | null;
  windowControls?: ReactNode;
  onCancelEditUserMessage: () => void;
  onClearChat: () => void;
  onCopyMessage: (message: Message) => void | Promise<void>;
  onCreateCustomAssistant: (input?: {
    sourcePresetId?: string | null;
    title?: string;
    description?: string;
    systemPrompt?: string;
    avatarType?: "emoji" | "image";
    avatarValue?: string;
    defaultModelId?: string | null;
    allowedToolIds?: string[];
    allowedSkillIds?: string[];
  }) => void;
  onDeleteAssistant: (assistantId: string) => boolean;
  onDeleteChat: (session: ChatSession) => void;
  onEditUserMessage: (messageIndex: number) => void;
  onModelChange: (modelId: string) => void;
  onNewChat: () => void;
  onRegenerateMessage: (messageIndex: number) => void | Promise<void>;
  onRenameChat: (session: ChatSession) => void;
  onSelectAssistant: (assistantId: string) => void;
  onSelectChat: (sessionId: string) => void;
  onUpdateAssistantProfile: (assistantId: string, patch: Partial<AssistantProfile>) => AssistantProfile | null;
  onSend: (content: string, images?: string[], hiddenContext?: string) => void | Promise<void>;
  onSetOpenChatMenu: Dispatch<SetStateAction<{ id: string; x: number; y: number } | null>>;
  onSettingsOpen: () => void;
  onShareChat: (session: ChatSession) => void | Promise<void>;
  onStop: () => void;
  onSubmitEditedUserMessage: (messageIndex: number, content: string) => void | Promise<void>;
  onToggleFavoriteChat: (session: ChatSession) => void;
  onTogglePinChat: (session: ChatSession) => void;
  onToggleScheduledTask: (taskId: string) => void;
  onCreateScheduledTask: (input: { title: string; prompt: string; cron: string; target: "desktop" | "notification" | "session" }) => void;
  onUpdateScheduledTask: (taskId: string, patch: { title: string; prompt: string; cron: string; target: "desktop" | "notification" | "session" }) => void;
  onDeleteScheduledTask: (taskId: string) => void;
  onUseEmptyPrompt: (prompt: string) => void;
  onOpenKnowledge: () => void;
};

const ASSISTANT_GROUPS_STORAGE_KEY = "assistant_groups";
const DEFAULT_ASSISTANT_GROUP_LABEL = "默认列表";

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

function findPresetMetaByAssistant(assistant: AssistantProfile | null) {
  if (!assistant?.sourcePresetId) return null;
  return AVATAR_PRESETS.find((preset) => preset.code === assistant.sourcePresetId) ?? null;
}

function formatTaskRunTime(timestamp?: number | null) {
  if (!timestamp) return "未执行";
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildTaskAggregateSummary(task: TaskExecutionResult) {
  const childCount = task.plan.childTaskIds?.length ?? 0;
  const lastTrace = task.trace.slice(-2).map((entry) => entry.message).join(" · ");
  if (childCount <= 0 && !lastTrace) return null;
  return {
    childCount,
    text: lastTrace || "已拆分并执行子任务",
  };
}

function formatChildTaskLabel(childTaskId: string) {
  const kind = childTaskId.split(":").slice(-2, -1)[0] ?? "task";
  switch (kind) {
    case "search":
      return "搜索整理";
    case "file_analysis":
      return "文件分析";
    case "content_draft":
      return "内容草拟";
    case "read":
      return "读取文件";
    case "summarize":
      return "总结结果";
    default:
      return kind;
  }
}

function formatMemoryScopeLabel(scope: AssistantMemoryScope) {
  switch (scope) {
    case "off":
      return "不启用记忆";
    case "session":
      return "仅当前话题";
    case "assistant":
    default:
      return "当前助手全局";
  }
}

function enhancePresetPromptIfNeeded(presetCode: string, prompt: string) {
  if (presetCode !== "2728") {
    return prompt;
  }

  return `## 角色定位
你是通用顾问型 AI 助手，适合处理日常问答、资料整理、轻咨询和方向建议。

## 核心职责
- 帮用户把问题说明白、理清楚、做顺。
- 提供平衡、稳健、易理解的建议。
- 在信息不足时先补关键信息，不仓促下结论。

## 行为要求
- 优先理解用户真实目标，而不是只回答字面问题。
- 多方案场景下，给出简短比较和推荐，不并列堆砌。
- 如果用户只想快速拿结果，先给结论，再补说明。
- 如果任务存在明显风险、前提不足或信息冲突，要主动指出。

## 边界与禁忌
- 不要为了显得聪明而过度延展问题。
- 不要在不确定时装懂或编造事实。
- 不要输出空泛安慰、套话或无执行价值的建议。
- 不要把简单问题复杂化。

## 澄清策略
- 只有当缺少关键信息会影响结论时，才提出澄清问题。
- 澄清问题尽量少，一次只问最关键的 1 到 2 个。

## 输出风格
- 使用中文。
- 表达自然、克制、清楚。
- 少空话，少套话。
- 尽量给出用户下一步可以直接执行的建议。`;
}

function renderAssistantAvatar(assistant: AssistantProfile | null, seed = 0) {
  return <img src={resolveAssistantAvatarImageSrc(assistant, seed)} alt="" className="chat-history-panel__assistant-image" />;
}

export default function MainChatView({
  activeAssistant,
  activeAssistantId,
  activeChatId,
  activeSession,
  assistants,
  availableModels,
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
  relatedContext,
  scheduledTasks,
  latestTaskResult,
  taskRuntimeState,
  messages,
  messagesScrollRef,
  omniIconSrc,
  windowControls,
  onCancelEditUserMessage,
  onClearChat,
  onCopyMessage,
  onCreateCustomAssistant,
  onDeleteAssistant,
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
  onToggleScheduledTask,
  onCreateScheduledTask,
  onUpdateScheduledTask,
  onDeleteScheduledTask,
  onUseEmptyPrompt,
  onOpenKnowledge,
}: MainChatViewProps) {
  const [workspaceElement, setWorkspaceElement] = useState<HTMLElement | null>(null);
  const [composerElement, setComposerElement] = useState<HTMLDivElement | null>(null);
  const [isTopicPanelAutoCollapsed, setIsTopicPanelAutoCollapsed] = useState(false);
  const [topicPanelManualVisible, setTopicPanelManualVisible] = useState<boolean | null>(null);
  const [isAssistantPanelAutoCollapsed, setIsAssistantPanelAutoCollapsed] = useState(false);
  const [assistantPanelManualVisible, setAssistantPanelManualVisible] = useState<boolean | null>(null);
  const [composerHeight, setComposerHeight] = useState(0);
  const [topicSearchOpen, setTopicSearchOpen] = useState(false);
  const [topicSearchQuery, setTopicSearchQuery] = useState("");
  const [topicMenuOpen, setTopicMenuOpen] = useState(false);
  const [topicGroupingMode, setTopicGroupingMode] = useState<TopicGroupingMode>("flat");
  const [sidePanelTab, setSidePanelTab] = useState<SidePanelTab>("topics");
  const [topicDeleteConfirm, setTopicDeleteConfirm] = useState<TopicDeleteConfirmState>(null);
  const [assistantDeleteConfirm, setAssistantDeleteConfirm] = useState<AssistantDeleteConfirmState>(null);
  const [assistantSearchQuery, setAssistantSearchQuery] = useState("");
  const [assistantMenuOpen, setAssistantMenuOpen] = useState(false);
  const [assistantGroupManagerOpen, setAssistantGroupManagerOpen] = useState(false);
  const [assistantGroupCreateMode, setAssistantGroupCreateMode] = useState(false);
  const [assistantGroupDraft, setAssistantGroupDraft] = useState("");
  const [assistantMoveGroupMenuId, setAssistantMoveGroupMenuId] = useState<string | null>(null);
  const [assistantMoveGroupMenuPosition, setAssistantMoveGroupMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [topicPanelWidth, setTopicPanelWidth] = useState(() =>
    readStoredPanelWidth(MAIN_LAYOUT_TOPIC_WIDTH_STORAGE_KEY, DEFAULT_TOPIC_PANEL_WIDTH, MIN_TOPIC_PANEL_WIDTH, MAX_TOPIC_PANEL_WIDTH)
  );
  const [assistantGroups, setAssistantGroups] = useState<string[]>(() => {
    const saved = readSqliteBackedValue(ASSISTANT_GROUPS_STORAGE_KEY);
    if (!saved) return [];
    try {
      const parsed = JSON.parse(saved);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
        : [];
    } catch {
      return [];
    }
  });
  const [assistantSettingsId, setAssistantSettingsId] = useState<string | null>(null);
  const [editingAssistantGroupName, setEditingAssistantGroupName] = useState<string | null>(null);
  const [editingAssistantGroupDraft, setEditingAssistantGroupDraft] = useState("");
  const [assistantAvatarPanelOpen, setAssistantAvatarPanelOpen] = useState(false);
  const [assistantAvatarSearchQuery, setAssistantAvatarSearchQuery] = useState("");
  const [assistantAvatarCategory, setAssistantAvatarCategory] = useState("recent");
  const [customAssistantsCollapsed, setCustomAssistantsCollapsed] = useState(false);
  const [openAssistantCardMenuId, setOpenAssistantCardMenuId] = useState<string | null>(null);
  const [expandedMemoryIds, setExpandedMemoryIds] = useState<string[]>([]);
  const [expandedSummaryIds, setExpandedSummaryIds] = useState<string[]>([]);
  const [isTaskTraceExpanded, setIsTaskTraceExpanded] = useState(false);
  const [showScheduledTaskForm, setShowScheduledTaskForm] = useState(false);
  const [showAssistantCapabilityDetails, setShowAssistantCapabilityDetails] = useState(false);
  const [scheduledTaskTitleDraft, setScheduledTaskTitleDraft] = useState("");
  const [scheduledTaskPromptDraft, setScheduledTaskPromptDraft] = useState("");
  const [scheduledTaskCronDraft, setScheduledTaskCronDraft] = useState("0 9 * * *");
  const [scheduledTaskTargetDraft, setScheduledTaskTargetDraft] = useState<"desktop" | "notification" | "session">("desktop");
  const [editingScheduledTaskId, setEditingScheduledTaskId] = useState<string | null>(null);
  const topicSearchInputRef = useRef<HTMLInputElement | null>(null);
  const topicMenuRef = useRef<HTMLDivElement | null>(null);
  const topicMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const assistantMenuRef = useRef<HTMLDivElement | null>(null);
  const assistantCardMenuRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const assistantMoveGroupMenuRef = useRef<HTMLDivElement | null>(null);
  const assistantAvatarInputRef = useRef<HTMLInputElement | null>(null);
  const assistantAvatarPanelRef = useRef<HTMLDivElement | null>(null);
  const assistantAvatarTriggerRef = useRef<HTMLButtonElement | null>(null);
  const layoutDragRef = useRef<{
    startX: number;
    startWidth: number;
  } | null>(null);

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
  const currentTopicTitle = activeSession?.title || (activeAssistant?.kind === "basic" ? "Omni" : activeAssistant?.title) || "Omni";
  const defaultTopicPanelVisible = !isTopicPanelAutoCollapsed;
  const isTopicPanelVisible = topicPanelManualVisible ?? defaultTopicPanelVisible;
  const defaultAssistantPanelVisible = !isAssistantPanelAutoCollapsed;
  const isAssistantPanelVisible = assistantPanelManualVisible ?? defaultAssistantPanelVisible;
  const basicAssistant = assistants.find((assistant) => assistant.kind === "basic") ?? null;
  const customAssistants = assistants.filter((assistant) => assistant.kind === "custom");
  const assistantGroupNames = useMemo(
    () =>
      Array.from(
        new Set([
          ...assistantGroups,
          ...customAssistants
            .map((assistant) => assistant.groupName?.trim())
            .filter((groupName): groupName is string => Boolean(groupName)),
        ])
      ).sort((a, b) => a.localeCompare(b, "zh-CN")),
    [assistantGroups, customAssistants]
  );
  const activeAssistantAvatarSeed = resolveAssistantAvatarSeed(assistants, activeAssistant?.id ?? null);
  const activeAssistantPresetMeta = findPresetMetaByAssistant(activeAssistant);
  const handleLayoutDragPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    layoutDragRef.current = {
      startX: event.clientX,
      startWidth: topicPanelWidth,
    };
  }, [topicPanelWidth]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const state = layoutDragRef.current;
      if (!state) return;
      const delta = event.clientX - state.startX;
      setTopicPanelWidth(clampPanelWidth(state.startWidth - delta, MIN_TOPIC_PANEL_WIDTH, MAX_TOPIC_PANEL_WIDTH));
    };

    const handlePointerUp = () => {
      const state = layoutDragRef.current;
      if (!state) return;
      layoutDragRef.current = null;
      saveSqliteBackedValue(MAIN_LAYOUT_TOPIC_WIDTH_STORAGE_KEY, String(topicPanelWidth));
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [topicPanelWidth]);
  const activeSkillCount = activeAssistant?.allowedSkillIds.length ?? 0;
  const activeToolCount = activeAssistant?.allowedToolIds.length ?? 0;
  const activeMemoryScopeLabel = formatMemoryScopeLabel(activeAssistant?.memoryScope ?? "assistant");
  const showAssistantTopTags = false;
  const showContextRecallBanner = messages.length === 0 && (relatedContext.memories.length > 0 || relatedContext.summaries.length > 0);
  const [isContextRecallBannerDismissed, setIsContextRecallBannerDismissed] = useState(false);
  const taskAggregateSummary = latestTaskResult ? buildTaskAggregateSummary(latestTaskResult) : null;
  const composerContextPresetText = useMemo(() => {
    const sections: string[] = [];

    if (activeSession?.title) {
      sections.push(`当前话题：${activeSession.title}`);
    }

    if (relatedContext.memories.length > 0) {
      sections.push(
        `助手记忆：\n${relatedContext.memories
          .slice(0, 3)
          .map((memory, index) => `${index + 1}. ${memory.content}`)
          .join("\n")}`
      );
    }

    if (relatedContext.summaries.length > 0) {
      sections.push(
        `相关话题摘要：\n${relatedContext.summaries
          .slice(0, 3)
          .map((summary, index) => `${index + 1}. ${summary.title}：${summary.summary}`)
          .join("\n")}`
      );
    }

    return sections.join("\n\n");
  }, [activeSession?.title, relatedContext.memories, relatedContext.summaries]);
  const normalizedAssistantSearchQuery = normalizeSearchText(assistantSearchQuery);
  const isBasicAssistantVisible = Boolean(
    basicAssistant &&
      (!normalizedAssistantSearchQuery ||
        normalizeSearchText(`${basicAssistant.title} ${basicAssistant.description}`).includes(normalizedAssistantSearchQuery))
  );
  const filteredCustomAssistants = customAssistants.filter((assistant) => {
    if (!normalizedAssistantSearchQuery) return true;
    return normalizeSearchText(`${assistant.title} ${assistant.description}`).includes(normalizedAssistantSearchQuery);
  });
  const groupedCustomAssistants = useMemo<AssistantDisplayGroup[]>(() => {
    const grouped = new Map<string, AssistantProfile[]>();
    filteredCustomAssistants.forEach((assistant) => {
      const label = assistant.groupName?.trim() || DEFAULT_ASSISTANT_GROUP_LABEL;
      const list = grouped.get(label) ?? [];
      list.push(assistant);
      grouped.set(label, list);
    });

    return Array.from(grouped.entries())
      .sort(([labelA], [labelB]) => {
        if (labelA === DEFAULT_ASSISTANT_GROUP_LABEL) return -1;
        if (labelB === DEFAULT_ASSISTANT_GROUP_LABEL) return 1;
        return labelA.localeCompare(labelB, "zh-CN");
      })
      .map(([label, nextAssistants]) => ({ label, assistants: nextAssistants }));
  }, [filteredCustomAssistants]);
  const defaultAssistantGroup = useMemo(
    () => groupedCustomAssistants.find((group) => group.label === DEFAULT_ASSISTANT_GROUP_LABEL) ?? { label: DEFAULT_ASSISTANT_GROUP_LABEL, assistants: [] },
    [groupedCustomAssistants]
  );
  const namedAssistantGroups = useMemo(
    () => groupedCustomAssistants.filter((group) => group.label !== DEFAULT_ASSISTANT_GROUP_LABEL),
    [groupedCustomAssistants]
  );
  const filteredAssistantAvatars = filterAvatarPresets(AVATAR_PRESETS, assistantAvatarCategory, assistantAvatarSearchQuery);
  const isAssistantSettingsMode = Boolean(assistantSettingsId && activeAssistant?.kind === "custom");
  const [assistantTitleDraft, setAssistantTitleDraft] = useState(activeAssistant?.title ?? "");
  const [assistantDescriptionDraft, setAssistantDescriptionDraft] = useState(activeAssistant?.description ?? "");
  const [assistantPromptDraft, setAssistantPromptDraft] = useState(activeAssistant?.systemPrompt ?? "");
  const [assistantModelDraft, setAssistantModelDraft] = useState(activeAssistant?.defaultModelId ?? "");
  const selectedAssistantModel = availableModels.find((model) => model.id === assistantModelDraft) ?? null;
  const layoutClassName = useMemo(() => {
    const classNames = ["main-chat-layout"];
    if (assistantPanelManualVisible === true) classNames.push("main-chat-layout--assistant-forced-open");
    if (!isAssistantPanelVisible) classNames.push("main-chat-layout--assistant-collapsed");
    if (topicPanelManualVisible === true) classNames.push("main-chat-layout--topic-forced-open");
    if (!isTopicPanelVisible) classNames.push("main-chat-layout--topic-collapsed");
    if (isAssistantSettingsMode) classNames.push("main-chat-layout--assistant-settings");
    return classNames.join(" ");
  }, [assistantPanelManualVisible, isAssistantPanelVisible, isAssistantSettingsMode, isTopicPanelVisible, topicPanelManualVisible]);
  const layoutStyle = useMemo<CSSProperties>(
    () =>
      ({
        "--topic-panel-width": `${topicPanelWidth}px`,
      }) as CSSProperties,
    [topicPanelWidth]
  );

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
    saveSqliteBackedValue(ASSISTANT_GROUPS_STORAGE_KEY, JSON.stringify(assistantGroups));
  }, [assistantGroups]);

  useEffect(() => {
    if (!workspaceElement) return;

    const topicCollapseThreshold = 1080;
    const topicExpandThreshold = 1160;
    const assistantCollapseThreshold = 980;
    const assistantExpandThreshold = 1040;

    const updateAutoCollapsed = () => {
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || workspaceElement.getBoundingClientRect().width || 0;

      setIsTopicPanelAutoCollapsed((current) => {
        const next = current ? viewportWidth < topicExpandThreshold : viewportWidth < topicCollapseThreshold;
        return next;
      });

      setIsAssistantPanelAutoCollapsed((current) => {
        const next = current ? viewportWidth < assistantExpandThreshold : viewportWidth < assistantCollapseThreshold;
        return next;
      });
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
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      if (frameId) cancelAnimationFrame(frameId);
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
      setTopicDeleteConfirm(null);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [topicMenuOpen]);
  useEffect(() => {
    if (!assistantMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (assistantMenuRef.current?.contains(target)) return;
      setAssistantMenuOpen(false);
      setAssistantGroupDraft("");
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [assistantMenuOpen]);

  useEffect(() => {
    if (!openAssistantCardMenuId) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      const activeMenu = assistantCardMenuRefs.current[openAssistantCardMenuId];
      if (activeMenu?.contains(target)) return;
      if (assistantMoveGroupMenuRef.current?.contains(target)) return;
      setOpenAssistantCardMenuId(null);
      setAssistantDeleteConfirm(null);
      setAssistantMoveGroupMenuId(null);
      setAssistantMoveGroupMenuPosition(null);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [openAssistantCardMenuId]);

  useEffect(() => {
    if (!assistantAvatarPanelOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (assistantAvatarPanelRef.current?.contains(target)) return;
      if (assistantAvatarTriggerRef.current?.contains(target)) return;
      setAssistantAvatarPanelOpen(false);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [assistantAvatarPanelOpen]);

  useEffect(() => {
    if (latestTaskResult) {
      setSidePanelTab("tasks");
    }
  }, [latestTaskResult?.taskId]);

  const resolveAvatarCategoryIcon = (category: AvatarCategoryManifest["icon"]) => {
    switch (category) {
      case "history":
        return History;
      case "sparkles":
        return Sparkles;
      case "cpu":
        return Cpu;
      case "paw":
        return PawPrint;
      default:
        return Sparkles;
    }
  };

  const handleDeleteSessions = (sessions: ChatSession[], title: string, message: string) => {
    if (sessions.length === 0) {
      setTopicMenuOpen(false);
      return;
    }
    setTopicDeleteConfirm({ title, message, sessions });
  };

  const handleConfirmDeleteSessions = () => {
    if (!topicDeleteConfirm) return;
    topicDeleteConfirm.sessions.forEach((session) => onDeleteChat(session));
    setTopicDeleteConfirm(null);
    setTopicMenuOpen(false);
  };

  const handleCreateAssistantGroup = () => {
    const nextGroupName = assistantGroupDraft.trim();
    if (!nextGroupName) {
      return;
    }
    const exists = assistantGroupNames.some((groupName) => groupName === nextGroupName);
    if (!exists) {
      setAssistantGroups((current) => [...current, nextGroupName]);
    }
    setAssistantGroupDraft("");
  };

  const handleDeleteAssistantGroup = (groupName: string) => {
    setAssistantGroups((current) => current.filter((item) => item !== groupName));
    customAssistants
      .filter((assistant) => (assistant.groupName?.trim() || "") === groupName)
      .forEach((assistant) => {
        onUpdateAssistantProfile(assistant.id, { groupName: null });
      });
  };

  const handleRenameAssistantGroup = (groupName: string) => {
    const nextGroupName = editingAssistantGroupDraft.trim();
    if (!nextGroupName || nextGroupName === groupName) {
      setEditingAssistantGroupName(null);
      setEditingAssistantGroupDraft("");
      return;
    }
    setAssistantGroups((current) => current.map((item) => (item === groupName ? nextGroupName : item)));
    customAssistants
      .filter((assistant) => (assistant.groupName?.trim() || "") === groupName)
      .forEach((assistant) => {
        onUpdateAssistantProfile(assistant.id, { groupName: nextGroupName });
      });
    setEditingAssistantGroupName(null);
    setEditingAssistantGroupDraft("");
  };

  const handleConfirmDeleteAssistant = () => {
    if (!assistantDeleteConfirm) return;
    const deleted = onDeleteAssistant(assistantDeleteConfirm.assistantId);
    if (!deleted) return;
    if (assistantSettingsId === assistantDeleteConfirm.assistantId) {
      setAssistantSettingsId(null);
      setAssistantAvatarPanelOpen(false);
    }
    setAssistantDeleteConfirm(null);
    setOpenAssistantCardMenuId(null);
  };


  return (
    <div className={layoutClassName} style={layoutStyle}>
      <aside className="main-chat-nav drag-region">
        <button type="button" className="main-chat-nav__brand no-drag" title="Omni">
          <Bot size={20} strokeWidth={1.9} />
        </button>
        <div className="main-chat-nav__items">
          <button type="button" className="main-chat-nav__item main-chat-nav__item--active no-drag" title="聊天">
            <MessageSquare size={18} strokeWidth={1.9} />
          </button>
          <button type="button" className="main-chat-nav__item no-drag" title="助手">
            <Sparkles size={18} strokeWidth={1.9} />
          </button>
          <button type="button" className="main-chat-nav__item no-drag" title="知识" onClick={onOpenKnowledge}>
            <FolderOpen size={18} strokeWidth={1.9} />
          </button>
        </div>
        <button type="button" className="main-chat-nav__item main-chat-nav__item--bottom no-drag" title="设置" onClick={onSettingsOpen}>
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

        <div className="chat-history-panel__assistant-search">
          <Search size={14} strokeWidth={1.9} />
          <input
            value={assistantSearchQuery}
            onChange={(event) => setAssistantSearchQuery(event.target.value)}
            placeholder="搜索助手..."
          />
        </div>

        <div className="chat-history-panel__assistants">
          {isBasicAssistantVisible && basicAssistant && (
            <div className="chat-history-panel__assistant-section">
              <button
                type="button"
                className={`chat-history-panel__assistant ${activeAssistantId === basicAssistant.id ? "chat-history-panel__assistant--active" : ""}`}
                onClick={() => {
                  setAssistantSettingsId(null);
                  setAssistantAvatarPanelOpen(false);
                  onSelectAssistant(basicAssistant.id);
                }}
              >
                <span className="chat-history-panel__assistant-icon">
                  {renderAssistantAvatar(basicAssistant)}
                </span>
                <span className="chat-history-panel__assistant-copy">
                  <strong>{basicAssistant.title}</strong>
                </span>
                <span className="chat-history-panel__assistant-action chat-history-panel__assistant-action--placeholder" aria-hidden="true" />
              </button>
            </div>
          )}

            <div className="chat-history-panel__assistant-section">
              <div className="chat-history-panel__assistant-group-header">
                <div className="chat-history-panel__assistant-group-label">{DEFAULT_ASSISTANT_GROUP_LABEL}</div>
                <div className="chat-history-panel__section-actions">
                  <div ref={assistantMenuRef} className="chat-history-panel__section-menu">
                    <button
                      type="button"
                      className={`chat-history-panel__section-action ${assistantMenuOpen ? "chat-history-panel__section-action--active" : ""}`}
                      onClick={() => setAssistantMenuOpen((current) => !current)}
                      title="助手菜单"
                    >
                      <MoreHorizontal size={14} strokeWidth={1.8} />
                    </button>
                    {assistantMenuOpen && (
                      <div className="chat-history-panel__section-dropdown">
                        <button
                          type="button"
                          onClick={() => {
                            setAssistantMenuOpen(false);
                            onCreateCustomAssistant();
                          }}
                        >
                          <Plus size={14} strokeWidth={1.9} />
                          <span>新建助手</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setAssistantMenuOpen(false);
                            setAssistantGroupManagerOpen(true);
                          }}
                        >
                          <FolderOpen size={14} strokeWidth={1.9} />
                          <span>分组管理</span>
                        </button>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    className={`chat-history-panel__section-action ${customAssistantsCollapsed ? "" : "chat-history-panel__section-action--active"}`}
                    onClick={() => setCustomAssistantsCollapsed((current) => !current)}
                    title={customAssistantsCollapsed ? "展开列表" : "收起列表"}
                  >
                    {customAssistantsCollapsed ? <ChevronRight size={14} strokeWidth={1.8} /> : <ChevronDown size={14} strokeWidth={1.8} />}
                  </button>
                </div>
              </div>
              {!customAssistantsCollapsed && <div className="chat-history-panel__assistant-list">
                <div className="chat-history-panel__assistant-group">
                  {defaultAssistantGroup.assistants.length === 0 ? (
                    <button
                      type="button"
                      className="chat-history-panel__assistant-create"
                      onClick={() => onCreateCustomAssistant()}
                    >
                      <Plus size={14} strokeWidth={1.9} />
                      <span>新建助手</span>
                    </button>
                  ) : (
                    defaultAssistantGroup.assistants.map((assistant, index) => (
                      <button
                        key={assistant.id}
                        type="button"
                        className={`chat-history-panel__assistant ${activeAssistantId === assistant.id ? "chat-history-panel__assistant--active" : ""} ${openAssistantCardMenuId === assistant.id ? "chat-history-panel__assistant--menu-open" : ""}`}
                        onClick={() => {
                          setAssistantSettingsId(null);
                          setAssistantAvatarPanelOpen(false);
                          onSelectAssistant(assistant.id);
                        }}
                      >
                        <span className="chat-history-panel__assistant-icon chat-history-panel__assistant-icon--custom">
                          {renderAssistantAvatar(assistant, index)}
                        </span>
                        <span className="chat-history-panel__assistant-copy">
                          <strong>{assistant.title}</strong>
                        </span>
                        <span
                          ref={(node) => {
                            assistantCardMenuRefs.current[assistant.id] = node;
                          }}
                          className="chat-history-panel__assistant-menu"
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => event.stopPropagation()}
                        >
                          <button
                            type="button"
                            className={`chat-history-panel__assistant-action ${openAssistantCardMenuId === assistant.id ? "chat-history-panel__assistant-action--active" : ""}`}
                            title="更多操作"
                            aria-label="更多操作"
                            onClick={(event) => {
                              event.stopPropagation();
                              setOpenAssistantCardMenuId((current) => (current === assistant.id ? null : assistant.id));
                            }}
                          >
                            <MoreHorizontal size={13} strokeWidth={1.9} />
                          </button>
                          {openAssistantCardMenuId === assistant.id && (
                            <div className="chat-history-panel__assistant-dropdown">
                              {assistantDeleteConfirm?.assistantId === assistant.id ? (
                                <div className="chat-topic-panel__menu-confirm chat-history-panel__assistant-dropdown-confirm">
                                  <div className="chat-topic-panel__menu-confirm-title">{assistantDeleteConfirm.title}</div>
                                  <div className="chat-topic-panel__menu-confirm-message">{assistantDeleteConfirm.message}</div>
                                  <div className="chat-topic-panel__menu-confirm-actions">
                                    <button
                                      type="button"
                                      className="chat-topic-panel__menu-button"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        setAssistantDeleteConfirm(null);
                                      }}
                                    >
                                      取消
                                    </button>
                                    <button
                                      type="button"
                                      className="chat-topic-panel__menu-button chat-topic-panel__menu-button--danger"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        handleConfirmDeleteAssistant();
                                      }}
                                    >
                                      确认删除
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setOpenAssistantCardMenuId(null);
                                      onSelectAssistant(assistant.id);
                                      setAssistantSettingsId(assistant.id);
                                    }}
                                  >
                                    <Settings size={13} strokeWidth={1.9} />
                                    <span>助手设置</span>
                                  </button>
                                  <div className="chat-history-panel__assistant-dropdown-divider" />
                                  <button
                                    type="button"
                                    className="chat-history-panel__assistant-dropdown-branch"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      const triggerRect = (event.currentTarget as HTMLButtonElement).getBoundingClientRect();
                                      const estimatedSubmenuWidth = 172;
                                      const estimatedSubmenuHeight = Math.min(window.innerHeight - 24, 220);
                                      const rightSpace = window.innerWidth - triggerRect.right;
                                      const nextLeft =
                                        rightSpace >= estimatedSubmenuWidth
                                          ? triggerRect.right + 8
                                          : Math.max(12, triggerRect.left - estimatedSubmenuWidth - 8);
                                      const nextTop = Math.min(
                                        Math.max(12, triggerRect.top - 8),
                                        Math.max(12, window.innerHeight - estimatedSubmenuHeight - 12)
                                      );
                                      setAssistantMoveGroupMenuPosition({ top: nextTop, left: nextLeft });
                                      setAssistantMoveGroupMenuId((current) => (current === assistant.id ? null : assistant.id));
                                    }}
                                  >
                                    <span className="chat-history-panel__assistant-dropdown-main">
                                      <FolderOpen size={13} strokeWidth={1.9} />
                                      <span>移动到分组</span>
                                    </span>
                                    <ChevronRight size={13} strokeWidth={1.9} />
                                  </button>
                                  <div className="chat-history-panel__assistant-dropdown-divider" />
                                  <button
                                    type="button"
                                    className="chat-history-panel__assistant-dropdown-danger"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setAssistantDeleteConfirm({
                                        assistantId: assistant.id,
                                        title: "删除助手",
                                        message: `确认删除“${assistant.title}”吗？相关话题和记忆会一并删除。`,
                                      });
                                    }}
                                  >
                                    <Trash2 size={13} strokeWidth={1.9} />
                                    <span>删除助手</span>
                                  </button>
                                </>
                              )}
                            </div>
                          )}
                        </span>
                      </button>
                    ))
                  )}
                </div>
                {namedAssistantGroups.length === 0 ? null : namedAssistantGroups.map((group) => (
                  <div key={group.label} className="chat-history-panel__assistant-group">
                    <div className="chat-history-panel__assistant-group-label">{group.label}</div>
                    {group.assistants.map((assistant, index) => (
                      <button
                        key={assistant.id}
                        type="button"
                        className={`chat-history-panel__assistant ${activeAssistantId === assistant.id ? "chat-history-panel__assistant--active" : ""} ${openAssistantCardMenuId === assistant.id ? "chat-history-panel__assistant--menu-open" : ""}`}
                        onClick={() => {
                          setAssistantSettingsId(null);
                          setAssistantAvatarPanelOpen(false);
                          onSelectAssistant(assistant.id);
                        }}
                      >
                        <span className="chat-history-panel__assistant-icon chat-history-panel__assistant-icon--custom">
                          {renderAssistantAvatar(assistant, index)}
                        </span>
                        <span className="chat-history-panel__assistant-copy">
                          <strong>{assistant.title}</strong>
                        </span>
                        <span
                          ref={(node) => {
                            assistantCardMenuRefs.current[assistant.id] = node;
                          }}
                          className="chat-history-panel__assistant-menu"
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => event.stopPropagation()}
                        >
                          <button
                            type="button"
                            className={`chat-history-panel__assistant-action ${openAssistantCardMenuId === assistant.id ? "chat-history-panel__assistant-action--active" : ""}`}
                            title="更多操作"
                            aria-label="更多操作"
                            onClick={(event) => {
                              event.stopPropagation();
                              setOpenAssistantCardMenuId((current) => (current === assistant.id ? null : assistant.id));
                            }}
                          >
                            <MoreHorizontal size={13} strokeWidth={1.9} />
                          </button>
                          {openAssistantCardMenuId === assistant.id && (
                            <div className="chat-history-panel__assistant-dropdown">
                              {assistantDeleteConfirm?.assistantId === assistant.id ? (
                                <div className="chat-topic-panel__menu-confirm chat-history-panel__assistant-dropdown-confirm">
                                  <div className="chat-topic-panel__menu-confirm-title">{assistantDeleteConfirm.title}</div>
                                  <div className="chat-topic-panel__menu-confirm-message">{assistantDeleteConfirm.message}</div>
                                  <div className="chat-topic-panel__menu-confirm-actions">
                                    <button
                                      type="button"
                                      className="chat-topic-panel__menu-button"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        setAssistantDeleteConfirm(null);
                                      }}
                                    >
                                      取消
                                    </button>
                                    <button
                                      type="button"
                                      className="chat-topic-panel__menu-button chat-topic-panel__menu-button--danger"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        handleConfirmDeleteAssistant();
                                      }}
                                    >
                                      确认删除
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setOpenAssistantCardMenuId(null);
                                      onSelectAssistant(assistant.id);
                                      setAssistantSettingsId(assistant.id);
                                    }}
                                  >
                                    <Settings size={13} strokeWidth={1.9} />
                                    <span>助手设置</span>
                                  </button>
                                  <div className="chat-history-panel__assistant-dropdown-divider" />
                                  <button
                                    type="button"
                                    className="chat-history-panel__assistant-dropdown-branch"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      const triggerRect = (event.currentTarget as HTMLButtonElement).getBoundingClientRect();
                                      const estimatedSubmenuWidth = 172;
                                      const estimatedSubmenuHeight = Math.min(window.innerHeight - 24, 220);
                                      const rightSpace = window.innerWidth - triggerRect.right;
                                      const nextLeft =
                                        rightSpace >= estimatedSubmenuWidth
                                          ? triggerRect.right + 8
                                          : Math.max(12, triggerRect.left - estimatedSubmenuWidth - 8);
                                      const nextTop = Math.min(
                                        Math.max(12, triggerRect.top - 8),
                                        Math.max(12, window.innerHeight - estimatedSubmenuHeight - 12)
                                      );
                                      setAssistantMoveGroupMenuPosition({ top: nextTop, left: nextLeft });
                                      setAssistantMoveGroupMenuId((current) => (current === assistant.id ? null : assistant.id));
                                    }}
                                  >
                                    <span className="chat-history-panel__assistant-dropdown-main">
                                      <FolderOpen size={13} strokeWidth={1.9} />
                                      <span>移动到分组</span>
                                    </span>
                                    <ChevronRight size={13} strokeWidth={1.9} />
                                  </button>
                                  <div className="chat-history-panel__assistant-dropdown-divider" />
                                  <button
                                    type="button"
                                    className="chat-history-panel__assistant-dropdown-danger"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setAssistantDeleteConfirm({
                                        assistantId: assistant.id,
                                        title: "删除助手",
                                        message: `确认删除“${assistant.title}”吗？相关话题和记忆会一并删除。`,
                                      });
                                    }}
                                  >
                                    <Trash2 size={13} strokeWidth={1.9} />
                                    <span>删除助手</span>
                                  </button>
                                </>
                              )}
                            </div>
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>}
            </div>

        </div>
      </aside>

      {assistantGroupManagerOpen && (
        <div
          className="omni-confirm-overlay"
          onClick={() => {
            setAssistantGroupManagerOpen(false);
            setAssistantGroupDraft("");
          }}
        >
          <div
            className="omni-confirm-dialog chat-history-panel__group-dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="chat-history-panel__group-dialog-header">
              <div className="chat-history-panel__group-dialog-title">分组管理</div>
              <button
                type="button"
                className="chat-history-panel__group-dialog-close"
                onClick={() => {
                  setAssistantGroupManagerOpen(false);
                  setAssistantGroupDraft("");
                }}
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
            <div className="chat-history-panel__group-dialog-body">
              <div className="chat-history-panel__group-manager-list">
                <div className="chat-history-panel__group-manager-item chat-history-panel__group-manager-item--default">
                  <div className="chat-history-panel__group-manager-row">
                    <span className="chat-history-panel__group-manager-handle" aria-hidden="true">
                      <GripVertical size={14} strokeWidth={1.9} />
                    </span>
                    <span>{DEFAULT_ASSISTANT_GROUP_LABEL}</span>
                  </div>
                  <span className="chat-history-panel__group-manager-badge">系统</span>
                </div>
                {assistantGroupNames.length === 0 ? (
                  <div className="chat-history-panel__group-manager-empty">还没有自定义分组</div>
                ) : (
                  assistantGroupNames.map((groupName) => (
                    <div key={groupName} className="chat-history-panel__group-manager-item">
                      {editingAssistantGroupName === groupName ? (
                        <>
                          <div className="chat-history-panel__group-manager-row">
                            <span className="chat-history-panel__group-manager-handle" aria-hidden="true">
                              <GripVertical size={14} strokeWidth={1.9} />
                            </span>
                            <input
                              className="chat-history-panel__group-manager-inline-input"
                              value={editingAssistantGroupDraft}
                              onChange={(event) => setEditingAssistantGroupDraft(event.target.value)}
                              onBlur={() => handleRenameAssistantGroup(groupName)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  handleRenameAssistantGroup(groupName);
                                }
                              }}
                              autoFocus
                            />
                          </div>
                          <div className="chat-history-panel__group-manager-actions">
                            <button type="button" onClick={() => handleRenameAssistantGroup(groupName)}>
                              <Check size={14} strokeWidth={2} />
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="chat-history-panel__group-manager-row">
                            <span className="chat-history-panel__group-manager-handle" aria-hidden="true">
                              <GripVertical size={14} strokeWidth={1.9} />
                            </span>
                            <span>{groupName}</span>
                          </div>
                          <div className="chat-history-panel__group-manager-actions">
                            <button
                              type="button"
                              onClick={() => {
                                setEditingAssistantGroupName(groupName);
                                setEditingAssistantGroupDraft(groupName);
                              }}
                            >
                              <Pencil size={14} strokeWidth={1.9} />
                            </button>
                            <button type="button" onClick={() => handleDeleteAssistantGroup(groupName)}>
                              <Trash2 size={14} strokeWidth={1.9} />
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="chat-history-panel__group-dialog-footer">
              {assistantGroupCreateMode ? (
                <div className="chat-history-panel__group-create chat-history-panel__group-create--dialog">
                  <input
                    value={assistantGroupDraft}
                    onChange={(event) => setAssistantGroupDraft(event.target.value)}
                    placeholder="添加新分组"
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        handleCreateAssistantGroup();
                        setAssistantGroupCreateMode(false);
                      }
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      handleCreateAssistantGroup();
                      setAssistantGroupCreateMode(false);
                    }}
                  >
                    <Check size={14} strokeWidth={2} />
                    <span>确认添加</span>
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="chat-history-panel__group-add-button"
                  onClick={() => setAssistantGroupCreateMode(true)}
                >
                  <Plus size={14} strokeWidth={1.9} />
                  <span>添加新分组</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {assistantMoveGroupMenuId && assistantMoveGroupMenuPosition && (
        <div
          ref={assistantMoveGroupMenuRef}
          className="chat-history-panel__assistant-submenu chat-history-panel__assistant-submenu--floating"
          style={{
            top: assistantMoveGroupMenuPosition.top,
            left: assistantMoveGroupMenuPosition.left,
          }}
          onClick={(event) => event.stopPropagation()}
        >
          {[DEFAULT_ASSISTANT_GROUP_LABEL, ...assistantGroupNames].map((groupName) => {
            const currentAssistant = customAssistants.find((assistant) => assistant.id === assistantMoveGroupMenuId);
            const currentGroupName = currentAssistant?.groupName?.trim() || DEFAULT_ASSISTANT_GROUP_LABEL;
            const isActive = currentGroupName === groupName;
            return (
            <button
              key={`${assistantMoveGroupMenuId}-${groupName}-choice`}
              type="button"
              className={isActive ? "chat-history-panel__assistant-group-choice--active" : ""}
              onClick={(event) => {
                event.stopPropagation();
                onUpdateAssistantProfile(assistantMoveGroupMenuId, {
                  groupName: groupName === DEFAULT_ASSISTANT_GROUP_LABEL ? null : groupName,
                });
                setAssistantMoveGroupMenuId(null);
                setAssistantMoveGroupMenuPosition(null);
                setOpenAssistantCardMenuId(null);
              }}
            >
              {isActive ? <Check size={13} strokeWidth={2.2} /> : <span className="chat-history-panel__assistant-group-choice-spacer" aria-hidden="true" />}
              <span>{groupName}</span>
              <span className="chat-history-panel__assistant-group-choice-tail" aria-hidden="true" />
            </button>
            );
          })}
          <div className="chat-history-panel__assistant-dropdown-divider" />
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setAssistantMoveGroupMenuId(null);
              setAssistantMoveGroupMenuPosition(null);
              setOpenAssistantCardMenuId(null);
              setAssistantGroupManagerOpen(true);
            }}
          >
            <span className="chat-history-panel__assistant-dropdown-main">
              <Plus size={13} strokeWidth={1.9} />
              <span>添加新分组</span>
            </span>
          </button>
        </div>
      )}

      <section ref={setWorkspaceElement} className="main-chat-workspace" style={{ "--composer-height": `${composerHeight}px` } as CSSProperties}>
        <header className="main-chat-header drag-region">
          <div className="main-chat-toolbar">
            <div className="main-chat-toolbar__session main-chat-toolbar__session--hero">
              <div className="main-chat-toolbar__assistant main-chat-toolbar__assistant--single-line">
                {!isAssistantSettingsMode && (
                  <button
                    type="button"
                    className="main-chat-toolbar__icon-button main-chat-toolbar__back-button"
                    aria-label={isAssistantPanelVisible ? "收起助手栏" : "展开助手栏"}
                    title={isAssistantPanelVisible ? "收起助手栏" : "展开助手栏"}
                    onClick={() =>
                      setAssistantPanelManualVisible((currentValue) => {
                        const currentVisible = currentValue ?? defaultAssistantPanelVisible;
                        const nextVisible = !currentVisible;
                        return nextVisible === defaultAssistantPanelVisible ? null : nextVisible;
                      })
                    }
                  >
                    {isAssistantPanelVisible ? (
                      <PanelLeftClose className="main-chat-toolbar__icon" strokeWidth={1.7} />
                    ) : (
                      <PanelLeftOpen className="main-chat-toolbar__icon" strokeWidth={1.7} />
                    )}
                  </button>
                )}
                {isAssistantSettingsMode && (
                  <button
                    type="button"
                    className="main-chat-toolbar__icon-button main-chat-toolbar__back-button"
                    title="返回聊天"
                    onClick={() => {
                      setAssistantSettingsId(null);
                      setAssistantAvatarPanelOpen(false);
                    }}
                  >
                    <ChevronLeft className="main-chat-toolbar__icon" strokeWidth={1.8} />
                  </button>
                )}
                <div className="main-chat-toolbar__assistant-mark">
                  {renderAssistantAvatar(activeAssistant, activeAssistantAvatarSeed)}
                </div>
                <div className="main-chat-toolbar__assistant-copy main-chat-toolbar__assistant-copy--single-line">
                  <strong>{isAssistantSettingsMode ? "助手设置" : currentTopicTitle}</strong>
                  {!isAssistantSettingsMode && showAssistantTopTags && (
                    <div className="main-chat-toolbar__assistant-tags">
                      {activeAssistantPresetMeta && (
                        <button type="button" className="main-chat-toolbar__assistant-tag" onClick={() => setShowAssistantCapabilityDetails((current) => !current)}>
                          {activeAssistantPresetMeta.label}
                        </button>
                      )}
                      <button type="button" className="main-chat-toolbar__assistant-tag" onClick={() => setShowAssistantCapabilityDetails((current) => !current)}>
                        {activeToolCount} 个工具
                      </button>
                      <button type="button" className="main-chat-toolbar__assistant-tag" onClick={() => setShowAssistantCapabilityDetails((current) => !current)}>
                        {activeSkillCount} 个技能
                      </button>
                      <button type="button" className="main-chat-toolbar__assistant-tag" onClick={() => setShowAssistantCapabilityDetails((current) => !current)}>
                        {activeMemoryScopeLabel}
                      </button>
                    </div>
                  )}
                  {!isAssistantSettingsMode && showAssistantCapabilityDetails && (
                    <div className="main-chat-toolbar__assistant-panel">
                      {activeAssistantPresetMeta ? (
                        <div className="main-chat-toolbar__assistant-panel-row">
                          <strong>来源预设</strong>
                          <span>{activeAssistantPresetMeta.label} · {activeAssistantPresetMeta.hint}</span>
                        </div>
                      ) : null}
                      <div className="main-chat-toolbar__assistant-panel-row">
                        <strong>工具能力</strong>
                        <span>{activeToolCount} 项已启用</span>
                      </div>
                      <div className="main-chat-toolbar__assistant-panel-row">
                        <strong>技能能力</strong>
                        <span>{activeSkillCount} 项已启用</span>
                      </div>
                      <div className="main-chat-toolbar__assistant-panel-row">
                        <strong>记忆范围</strong>
                        <span>{activeMemoryScopeLabel}</span>
                      </div>
                    </div>
                  )}
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
          {isAssistantSettingsMode && activeAssistant?.kind === "custom" ? (
            <div className="main-chat-scroll hide-scrollbar">
              <div className="omni-settings-dialog__sections omni-settings-dialog__sections--page">
                <div className="omni-settings-dialog__section">
                  <div className="omni-settings-dialog__section-title">助手信息</div>
                  <div className="omni-settings-dialog__assistant-overview">
                    <div className="omni-settings-dialog__assistant-form">
                      <div className="omni-settings-dialog__assistant-copy">
                        <div className="omni-settings-dialog__setting-label">基础信息</div>
                        <div className="omni-settings-dialog__setting-hint">名称、描述和角色设定会决定这个助手在聊天中的定位与表现。</div>
                      </div>
                      {activeAssistantPresetMeta && (
                        <div className="omni-settings-dialog__preset-badge">
                          <span>来源预设</span>
                          <strong>{activeAssistantPresetMeta.label}</strong>
                          <small>{activeAssistantPresetMeta.hint}</small>
                        </div>
                      )}
                      <div className="omni-settings-dialog__assistant-side">
                        <div className="omni-settings-dialog__assistant-copy">
                          <div className="omni-settings-dialog__setting-label">助手头像</div>
                          <div className="omni-settings-dialog__setting-hint">头像会同步影响助手列表、当前助手头部和相关卡片展示。</div>
                        </div>
                        <div className="omni-settings-dialog__setting-control omni-settings-dialog__setting-control--avatar">
                          <button
                            ref={assistantAvatarTriggerRef}
                            type="button"
                            className="omni-settings-dialog__avatar-hero"
                            onClick={() => setAssistantAvatarPanelOpen((current) => !current)}
                            title="选择头像"
                          >
                            <span className="omni-settings-dialog__avatar-hero-preview">
                              {renderAssistantAvatar(activeAssistant, activeAssistantAvatarSeed)}
                            </span>
                            <span className="omni-settings-dialog__avatar-hero-copy">
                              <strong>点击更换头像</strong>
                              <span>{activeAssistant.avatarType === "image" ? "当前使用自定义图片" : "当前使用头像包图标"}</span>
                            </span>
                          </button>
                          {assistantAvatarPanelOpen && (
                            <div ref={assistantAvatarPanelRef} className="omni-settings-dialog__avatar-panel">
                              <div className="omni-settings-dialog__avatar-categories">
                                {AVATAR_CATEGORIES.map((category) => {
                                  const CategoryIcon = resolveAvatarCategoryIcon(category.icon);
                                  return (
                                  <button
                                    key={category.id}
                                    type="button"
                                    className={`omni-settings-dialog__avatar-category ${assistantAvatarCategory === category.id ? "omni-settings-dialog__avatar-category--active" : ""}`}
                                    title={category.label}
                                    onClick={() => setAssistantAvatarCategory(category.id)}
                                  >
                                    <CategoryIcon size={14} strokeWidth={1.8} />
                                    <span>{category.label}</span>
                                  </button>
                                  );
                                })}
                              </div>
                              <div className="omni-settings-dialog__avatar-search">
                                <Search size={14} strokeWidth={1.8} />
                                <input
                                  value={assistantAvatarSearchQuery}
                                  onChange={(event) => setAssistantAvatarSearchQuery(event.target.value)}
                                  placeholder="搜索头像"
                                />
                              </div>
                              <div className="chat-history-panel__avatar-grid chat-history-panel__avatar-grid--detailed">
                              {filteredAssistantAvatars.length > 0 ? (
                                filteredAssistantAvatars.map((avatar) => (
                                    <button
                                      key={avatar.code}
                                      type="button"
                                      className={`chat-history-panel__avatar-option chat-history-panel__avatar-option--detailed chat-history-panel__avatar-option--tone-${avatar.tone} ${activeAssistant.avatarType !== "image" && resolveEmojiAvatarCode(activeAssistant.avatarValue) === avatar.code ? "chat-history-panel__avatar-option--active" : ""}`}
                                      onClick={() => {
                                      onUpdateAssistantProfile(activeAssistant.id, {
                                        sourcePresetId: avatar.code,
                                        avatarType: "emoji",
                                        avatarValue: `emoji:${avatar.code}`,
                                        systemPrompt: enhancePresetPromptIfNeeded(avatar.code, avatar.prompt),
                                        allowedToolIds: avatar.allowedToolIds ?? activeAssistant.allowedToolIds,
                                        allowedSkillIds: avatar.allowedSkillIds ?? activeAssistant.allowedSkillIds,
                                        defaultModelId: avatar.defaultModelId ?? activeAssistant.defaultModelId ?? null,
                                      });
                                      setAssistantPromptDraft(enhancePresetPromptIfNeeded(avatar.code, avatar.prompt));
                                        setAssistantModelDraft(avatar.defaultModelId ?? activeAssistant.defaultModelId ?? "");
                                        setAssistantAvatarPanelOpen(false);
                                      }}
                                      title={avatar.label}
                                    >
                                      <span className="chat-history-panel__avatar-option-badge">
                                        <img src={getEmojiAssetSrc(avatar.code)} alt={avatar.label} className="chat-history-panel__avatar-option-image" />
                                      </span>
                                        <span className="chat-history-panel__avatar-option-copy">
                                          <span className="chat-history-panel__avatar-option-label">{avatar.label}</span>
                                          <span className="chat-history-panel__avatar-option-meta">{avatar.hint}</span>
                                        </span>
                                      </button>
                                  ))
                                ) : (
                                  <div className="omni-settings-dialog__avatar-empty">没有匹配的头像</div>
                                )}
                              </div>
                              <button
                                type="button"
                                className="chat-history-panel__avatar-upload"
                                onClick={() => assistantAvatarInputRef.current?.click()}
                              >
                                上传图片
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="omni-settings-dialog__form-grid">
                        <label className="chat-topic-panel__field">
                          <span>名称</span>
                          <input
                            value={assistantTitleDraft}
                            onChange={(event) => setAssistantTitleDraft(event.target.value)}
                            onBlur={() => onUpdateAssistantProfile(activeAssistant.id, { title: assistantTitleDraft })}
                          />
                        </label>
                        <label className="chat-topic-panel__field">
                          <span>默认模型</span>
                          <div className="omni-settings-dialog__model-select">
                            <select
                              value={assistantModelDraft}
                              onChange={(event) => {
                                const nextValue = event.target.value;
                                setAssistantModelDraft(nextValue);
                                onUpdateAssistantProfile(activeAssistant.id, { defaultModelId: nextValue });
                              }}
                            >
                              {availableModels.map((model) => (
                                <option key={model.id} value={model.id}>
                                  {model.name}
                                </option>
                              ))}
                            </select>
                            {selectedAssistantModel && (
                              <div className="omni-settings-dialog__model-select-meta">
                                {selectedAssistantModel.provider} / {selectedAssistantModel.id}
                              </div>
                            )}
                          </div>
                        </label>
                        <label className="chat-topic-panel__field">
                          <span>所属分组</span>
                          <select
                            value={activeAssistant.groupName ?? ""}
                            onChange={(event) => {
                              const nextValue = event.target.value;
                              onUpdateAssistantProfile(activeAssistant.id, { groupName: nextValue || null });
                            }}
                          >
                            <option value="">{DEFAULT_ASSISTANT_GROUP_LABEL}</option>
                            {assistantGroupNames.map((groupName) => (
                              <option key={groupName} value={groupName}>
                                {groupName}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="chat-topic-panel__field omni-settings-dialog__field--full">
                          <span>描述</span>
                          <input
                            value={assistantDescriptionDraft}
                            onChange={(event) => setAssistantDescriptionDraft(event.target.value)}
                            onBlur={() => onUpdateAssistantProfile(activeAssistant.id, { description: assistantDescriptionDraft })}
                          />
                        </label>
                        <label className="chat-topic-panel__field omni-settings-dialog__field--full">
                          <span>角色设定</span>
                          <textarea
                            value={assistantPromptDraft}
                            onChange={(event) => setAssistantPromptDraft(event.target.value)}
                            onBlur={() => onUpdateAssistantProfile(activeAssistant.id, { systemPrompt: assistantPromptDraft })}
                            rows={5}
                          />
                        </label>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="omni-settings-dialog__section">
                  <div className="omni-settings-dialog__section-title">工具集模板</div>
                  <div className="omni-settings-dialog__toggle-list">
                    {TOOLSET_MANIFESTS.map((toolset) => (
                      <button
                        key={toolset.id}
                        type="button"
                        className="omni-settings-dialog__preset-card"
                        onClick={() => {
                          onUpdateAssistantProfile(activeAssistant.id, { allowedToolIds: toolset.toolIds });
                        }}
                      >
                        <div className="omni-settings-dialog__toggle-copy">
                          <strong>{toolset.title}</strong>
                          <span>{toolset.description}</span>
                        </div>
                        <span className="omni-settings-dialog__preset-card-meta">{toolset.toolIds.length} 项工具</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="omni-settings-dialog__section">
                  <div className="omni-settings-dialog__section-title">记忆策略</div>
                  <div className="omni-settings-dialog__toggle-list">
                    <label className="omni-settings-dialog__toggle-row">
                      <div className="omni-settings-dialog__toggle-copy">
                        <strong>记忆范围</strong>
                        <span>控制这个助手能否读取历史记忆，以及召回的边界。</span>
                      </div>
                      <select
                        className="omni-settings-dialog__select"
                        value={activeAssistant.memoryScope}
                        onChange={(event) =>
                          onUpdateAssistantProfile(activeAssistant.id, {
                            memoryScope: event.target.value as AssistantMemoryScope,
                          })
                        }
                      >
                        <option value="off">关闭记忆</option>
                        <option value="session">仅当前话题</option>
                        <option value="assistant">当前助手全局</option>
                      </select>
                    </label>

                    <label className="omni-settings-dialog__toggle-row">
                      <div className="omni-settings-dialog__toggle-copy">
                        <strong>自动沉淀记忆</strong>
                        <span>将稳定偏好、约束或长期信息保存到该助手的记忆库。</span>
                      </div>
                      <input
                        type="checkbox"
                        checked={activeAssistant.autoSaveMemories}
                        onChange={(event) =>
                          onUpdateAssistantProfile(activeAssistant.id, {
                            autoSaveMemories: event.target.checked,
                          })
                        }
                      />
                    </label>

                    <label className="omni-settings-dialog__toggle-row">
                      <div className="omni-settings-dialog__toggle-copy">
                        <strong>自动沉淀摘要</strong>
                        <span>把当前话题的阶段结论保存为摘要，供后续继续接力。</span>
                      </div>
                      <input
                        type="checkbox"
                        checked={activeAssistant.autoSaveSummaries}
                        onChange={(event) =>
                          onUpdateAssistantProfile(activeAssistant.id, {
                            autoSaveSummaries: event.target.checked,
                          })
                        }
                      />
                    </label>
                  </div>
                </div>

                <div className="omni-settings-dialog__section">
                  <div className="omni-settings-dialog__section-title">工具权限</div>
                  <div className="omni-settings-dialog__toggle-list">
                    {ASSISTANT_TOOL_OPTIONS.map((tool) => {
                      const checked = activeAssistant.allowedToolIds.includes(tool.id);
                      return (
                        <label key={tool.id} className="omni-settings-dialog__toggle-row">
                          <div className="omni-settings-dialog__toggle-copy">
                            <strong>{tool.label}</strong>
                            <span>{tool.description}</span>
                          </div>
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
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div className="omni-settings-dialog__section">
                  <div className="omni-settings-dialog__section-title">技能权限</div>
                  <div className="omni-settings-dialog__toggle-list">
                    {ASSISTANT_SKILL_OPTIONS.map((skill) => {
                      const checked = activeAssistant.allowedSkillIds.includes(skill.id);
                      const supportedKinds = SKILL_MANIFESTS.find((item) => item.id === skill.id)?.supportedAssistantKinds ?? ["basic", "custom"];
                      const supportLabel = supportedKinds.includes("basic") && supportedKinds.includes("custom")
                        ? "基础 / 自定义助手"
                        : supportedKinds.includes("basic")
                          ? "Omni"
                          : "自定义助手";
                      return (
                        <label key={skill.id} className="omni-settings-dialog__toggle-row">
                          <div className="omni-settings-dialog__toggle-copy">
                            <strong>{skill.label}</strong>
                            <span>{skill.description} · 适用：{supportLabel}</span>
                          </div>
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
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>
              <input
                ref={assistantAvatarInputRef}
                type="file"
                accept="image/*"
                className="chat-history-panel__avatar-file"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = () => {
                    const result = reader.result;
                    if (typeof result === "string") {
                      onUpdateAssistantProfile(activeAssistant.id, { avatarType: "image", avatarValue: result });
                      setAssistantAvatarPanelOpen(false);
                    }
                  };
                  reader.readAsDataURL(file);
                  event.currentTarget.value = "";
                }}
              />
            </div>
          ) : (
            <>
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
                    {showContextRecallBanner && !isContextRecallBannerDismissed && (
                      <div className="chat-recall-banner">
                        <div className="chat-recall-banner__copy">
                          <strong>已为当前会话准备相关上下文</strong>
                          <span>
                            {relatedContext.memories.length > 0 ? `召回 ${relatedContext.memories.length} 条记忆` : ""}
                            {relatedContext.memories.length > 0 && relatedContext.summaries.length > 0 ? " · " : ""}
                            {relatedContext.summaries.length > 0 ? `关联 ${relatedContext.summaries.length} 条摘要` : ""}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="chat-recall-banner__action"
                          onClick={() => {
                            setSidePanelTab("memory");
                            setTopicPanelManualVisible(true);
                            setExpandedMemoryIds(relatedContext.memories.map((memory) => memory.id));
                            setExpandedSummaryIds(relatedContext.summaries.map((summary) => summary.sessionId));
                          }}
                        >
                          查看内容
                        </button>
                        <button
                          type="button"
                          className="chat-recall-banner__action"
                          onClick={() => setIsContextRecallBannerDismissed(true)}
                        >
                          关闭
                        </button>
                      </div>
                    )}
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
                            <strong>{RECOMMENDED_ASSISTANT_PRESETS[index]?.title || "快速开始"}</strong>
                            <span>{RECOMMENDED_ASSISTANT_PRESETS[index]?.description || prompt}</span>
                          </div>
                          <ArrowRight size={16} strokeWidth={1.8} />
                        </button>
                      ))}
                    </div>
                    <div className="empty-chat-state__subhead">
                      <Sparkles size={14} strokeWidth={1.9} />
                      <span>快速创建助手</span>
                    </div>
                    <div className="empty-chat-state__cards">
                      {AVATAR_PRESETS.slice(0, 4).map((preset) => (
                        <button
                          key={preset.code}
                          type="button"
                          className="empty-chat-state__card"
                          onClick={() =>
                          onCreateCustomAssistant({
                              sourcePresetId: preset.code,
                              title: preset.label,
                              description: preset.hint,
                              systemPrompt: enhancePresetPromptIfNeeded(preset.code, preset.prompt),
                              avatarType: "emoji",
                              avatarValue: `emoji:${preset.code}`,
                              defaultModelId: preset.defaultModelId ?? null,
                              allowedToolIds: preset.allowedToolIds,
                              allowedSkillIds: preset.allowedSkillIds,
                            })
                          }
                        >
                          <div className="empty-chat-state__card-icon">
                            <img src={getEmojiAssetSrc(preset.code)} alt={preset.label} className="chat-history-panel__avatar-option-image" />
                          </div>
                          <div className="empty-chat-state__card-copy">
                            <strong>{preset.label}</strong>
                            <span>{preset.hint}</span>
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
                  contextPresetText={composerContextPresetText}
                  onCreateScheduledTask={onCreateScheduledTask}
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
            </>
          )}

        </main>
      </section>

      <div
        className="main-chat-layout__splitter main-chat-layout__splitter--topic no-drag"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整工作台宽度"
        onPointerDown={handleLayoutDragPointerDown}
      />

      {!isAssistantSettingsMode && <aside className="chat-topic-panel">
          <div className="chat-topic-panel__body">
            <div className="chat-topic-panel__toolbar">
              <div className="chat-topic-panel__title">
                <Hash size={14} strokeWidth={2} />
                <span>工作台</span>
              </div>
              <div className="chat-topic-panel__header-actions">
                <button
                  ref={topicMenuButtonRef}
                  type="button"
                  className={`chat-topic-panel__icon-button ${topicMenuOpen ? "chat-topic-panel__icon-button--active" : ""}`}
                  title="更多操作"
                  onClick={() => {
                    setTopicSearchOpen(false);
                    setTopicDeleteConfirm(null);
                    setTopicMenuOpen((current) => !current);
                  }}
                >
                  <MoreHorizontal size={16} strokeWidth={1.8} />
                </button>
                {sidePanelTab === "topics" && topicMenuOpen && (
                  <div ref={topicMenuRef} className="chat-topic-panel__menu">
                    {topicDeleteConfirm ? (
                      <div className="chat-topic-panel__menu-confirm">
                        <div className="chat-topic-panel__menu-confirm-title">{topicDeleteConfirm.title}</div>
                        <div className="chat-topic-panel__menu-confirm-message">{topicDeleteConfirm.message}</div>
                        <div className="chat-topic-panel__menu-confirm-actions">
                          <button
                            type="button"
                            className="chat-topic-panel__menu-button"
                            onClick={() => setTopicDeleteConfirm(null)}
                          >
                            取消
                          </button>
                          <button
                            type="button"
                            className="chat-topic-panel__menu-button chat-topic-panel__menu-button--danger"
                            onClick={handleConfirmDeleteSessions}
                          >
                            确定删除
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
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
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="chat-topic-panel__tabs">
              <button type="button" className={`chat-topic-panel__tab ${sidePanelTab === "topics" ? "chat-topic-panel__tab--active" : ""}`} onClick={() => setSidePanelTab("topics")}>话题</button>
              <button type="button" className={`chat-topic-panel__tab ${sidePanelTab === "tasks" ? "chat-topic-panel__tab--active" : ""}`} onClick={() => setSidePanelTab("tasks")}>任务</button>
              <button type="button" className={`chat-topic-panel__tab ${sidePanelTab === "automation" ? "chat-topic-panel__tab--active" : ""}`} onClick={() => setSidePanelTab("automation")}>自动化</button>
              <button type="button" className={`chat-topic-panel__tab ${sidePanelTab === "memory" ? "chat-topic-panel__tab--active" : ""}`} onClick={() => setSidePanelTab("memory")}>记忆</button>
            </div>

            {sidePanelTab === "topics" && topicSearchOpen && (
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

            {sidePanelTab === "memory" && <div className="chat-topic-panel__section">
              <div className="chat-topic-panel__section-title">
                <Star size={13} strokeWidth={2} />
                <span>记忆与摘要</span>
              </div>
              {relatedContext.memories.length === 0 && relatedContext.summaries.length === 0 ? (
                <div className="chat-topic-panel__empty">还没有相关记忆与摘要</div>
              ) : (
                <div className="chat-topic-panel__group-list">
                  {relatedContext.memories.map((memory) => (
                    <div key={memory.id} className="chat-topic-panel__task">
                      <div className="chat-topic-panel__task-head">
                        <strong>相关记忆</strong>
                      </div>
                      <div className="chat-topic-panel__task-meta">
                        <span>{expandedMemoryIds.includes(memory.id) ? memory.content : `${memory.content.slice(0, 42)}${memory.content.length > 42 ? "..." : ""}`}</span>
                      </div>
                      {memory.content.length > 42 && (
                        <button
                          type="button"
                          className="chat-topic-panel__inline-action"
                          onClick={() =>
                            setExpandedMemoryIds((current) =>
                              current.includes(memory.id) ? current.filter((id) => id !== memory.id) : [...current, memory.id]
                            )
                          }
                        >
                          {expandedMemoryIds.includes(memory.id) ? "收起" : "展开"}
                        </button>
                      )}
                      {memory.sourceSessionId && (
                        <button
                          type="button"
                          className="chat-topic-panel__inline-action"
                          onClick={() => onSelectChat(memory.sourceSessionId as string)}
                        >
                          查看话题
                        </button>
                      )}
                    </div>
                  ))}
                  {relatedContext.summaries.map((summary) => (
                    <div key={summary.sessionId} className="chat-topic-panel__task">
                      <div className="chat-topic-panel__task-head">
                        <strong>{summary.title}</strong>
                      </div>
                      <div className="chat-topic-panel__task-meta">
                        <span>{expandedSummaryIds.includes(summary.sessionId) ? summary.summary : `${summary.summary.slice(0, 48)}${summary.summary.length > 48 ? "..." : ""}`}</span>
                      </div>
                      {summary.summary.length > 48 && (
                        <button
                          type="button"
                          className="chat-topic-panel__inline-action"
                          onClick={() =>
                            setExpandedSummaryIds((current) =>
                              current.includes(summary.sessionId)
                                ? current.filter((id) => id !== summary.sessionId)
                                : [...current, summary.sessionId]
                            )
                          }
                        >
                          {expandedSummaryIds.includes(summary.sessionId) ? "收起" : "展开"}
                        </button>
                      )}
                      <button
                        type="button"
                        className="chat-topic-panel__inline-action"
                        onClick={() => onSelectChat(summary.sessionId)}
                      >
                        查看话题
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>}

            {sidePanelTab === "automation" && <div className="chat-topic-panel__section">
              <div className="chat-topic-panel__section-title">
                <TimerReset size={13} strokeWidth={2} />
                <span>自动化任务</span>
              </div>
              <button
                type="button"
                className="chat-topic-panel__inline-action"
                onClick={() => {
                  setEditingScheduledTaskId(null);
                  setShowScheduledTaskForm((current) => !current);
                }}
              >
                {showScheduledTaskForm ? "收起表单" : "新建任务"}
              </button>
              {showScheduledTaskForm && (
                <div className="chat-topic-panel__task chat-topic-panel__task--form">
                  <input
                    className="chat-topic-panel__form-input"
                    value={scheduledTaskTitleDraft}
                    onChange={(event) => setScheduledTaskTitleDraft(event.target.value)}
                    placeholder="任务名"
                  />
                  <textarea
                    className="chat-topic-panel__form-textarea"
                    value={scheduledTaskPromptDraft}
                    onChange={(event) => setScheduledTaskPromptDraft(event.target.value)}
                    placeholder="任务 prompt"
                    rows={3}
                  />
                  <input
                    className="chat-topic-panel__form-input"
                    value={scheduledTaskCronDraft}
                    onChange={(event) => setScheduledTaskCronDraft(event.target.value)}
                    placeholder="cron 表达式"
                  />
                  <select
                    className="chat-topic-panel__form-input"
                    value={scheduledTaskTargetDraft}
                    onChange={(event) => setScheduledTaskTargetDraft(event.target.value as "desktop" | "notification" | "session")}
                  >
                    <option value="desktop">桌面</option>
                    <option value="notification">通知</option>
                    <option value="session">会话</option>
                  </select>
                  <button
                    type="button"
                    className="chat-topic-panel__inline-action"
                    onClick={() => {
                      if (!scheduledTaskTitleDraft.trim() || !scheduledTaskPromptDraft.trim() || !scheduledTaskCronDraft.trim()) {
                        return;
                      }
                      if (editingScheduledTaskId) {
                        onUpdateScheduledTask(editingScheduledTaskId, {
                          title: scheduledTaskTitleDraft.trim(),
                          prompt: scheduledTaskPromptDraft.trim(),
                          cron: scheduledTaskCronDraft.trim(),
                          target: scheduledTaskTargetDraft,
                        });
                      } else {
                        onCreateScheduledTask({
                          title: scheduledTaskTitleDraft.trim(),
                          prompt: scheduledTaskPromptDraft.trim(),
                          cron: scheduledTaskCronDraft.trim(),
                          target: scheduledTaskTargetDraft,
                        });
                      }
                      setScheduledTaskTitleDraft("");
                      setScheduledTaskPromptDraft("");
                      setScheduledTaskCronDraft("0 9 * * *");
                      setScheduledTaskTargetDraft("desktop");
                      setEditingScheduledTaskId(null);
                      setShowScheduledTaskForm(false);
                    }}
                  >
                    {editingScheduledTaskId ? "保存修改" : "保存任务"}
                  </button>
                </div>
              )}
              {scheduledTasks.length === 0 ? (
                <div className="chat-topic-panel__empty">还没有自动化任务</div>
              ) : (
                <div className="chat-topic-panel__group-list">
                  {scheduledTasks.slice(0, 5).map((task) => (
                    <div key={task.id} className="chat-topic-panel__task">
                      <div className="chat-topic-panel__task-head">
                        <strong>{task.title}</strong>
                        <span className={`chat-topic-panel__task-status ${task.enabled ? "chat-topic-panel__task-status--completed" : "chat-topic-panel__task-status--aborted"}`}>
                          {task.enabled ? "enabled" : "disabled"}
                        </span>
                      </div>
                      <div className="chat-topic-panel__task-meta">
                        <span>{task.target}</span>
                        <span>{formatTaskRunTime(task.lastRunAt)}</span>
                      </div>
                      <button
                        type="button"
                        className="chat-topic-panel__inline-action"
                        onClick={() => onToggleScheduledTask(task.id)}
                      >
                        {task.enabled ? "停用" : "启用"}
                      </button>
                      <button
                        type="button"
                        className="chat-topic-panel__inline-action"
                        onClick={() => {
                          setEditingScheduledTaskId(task.id);
                          setScheduledTaskTitleDraft(task.title);
                          setScheduledTaskPromptDraft(task.prompt);
                          setScheduledTaskCronDraft(task.cron);
                          setScheduledTaskTargetDraft(task.target);
                          setShowScheduledTaskForm(true);
                        }}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="chat-topic-panel__inline-action"
                        onClick={() => onDeleteScheduledTask(task.id)}
                      >
                        删除
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>}

            {sidePanelTab === "topics" && <div className="chat-topic-panel__section">
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
            </div>}

            {sidePanelTab === "topics" && <div className="chat-topic-panel__section">
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
                            onClick={() => {
                              setAssistantSettingsId(null);
                              setAssistantAvatarPanelOpen(false);
                              onSelectChat(session.id);
                            }}
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
                            <span
                              className="chat-topic-panel__pin chat-topic-panel__pin--danger"
                              title="删除话题"
                              aria-label="删除话题"
                              role="button"
                              tabIndex={0}
                              onClick={(event) => {
                                event.stopPropagation();
                                onDeleteChat(session);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  onDeleteChat(session);
                                }
                              }}
                            >
                              <Trash2 size={12} strokeWidth={2} />
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
                      onClick={() => {
                        setAssistantSettingsId(null);
                        setAssistantAvatarPanelOpen(false);
                        onSelectChat(session.id);
                      }}
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
                      <span
                        className="chat-topic-panel__pin chat-topic-panel__pin--danger"
                        title="删除话题"
                        aria-label="删除话题"
                        role="button"
                        tabIndex={0}
                        onClick={(event) => {
                          event.stopPropagation();
                          onDeleteChat(session);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            event.stopPropagation();
                            onDeleteChat(session);
                          }
                        }}
                      >
                        <Trash2 size={12} strokeWidth={2} />
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>}

            {sidePanelTab === "tasks" && (
              <>
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
                      {taskAggregateSummary && (
                        <div className="chat-topic-panel__task-aggregate">
                          <strong>聚合结果</strong>
                          <span>
                            {taskAggregateSummary.childCount > 0 ? `共 ${taskAggregateSummary.childCount} 个子任务 · ` : ""}
                            {taskAggregateSummary.text}
                          </span>
                        </div>
                      )}
                      {latestTaskResult.plan.childTaskIds?.length ? (
                        <div className="chat-topic-panel__task-subtasks">
                          <div className="chat-topic-panel__task-subtasks-title">子任务</div>
                          {latestTaskResult.plan.childTaskIds.map((childTaskId) => {
                            const isActive = latestTaskResult.plan.metadata?.activeChildTaskId === childTaskId;
                            const childTitle = formatChildTaskLabel(childTaskId);
                            return (
                              <div key={childTaskId} className="chat-topic-panel__task-step">
                                <span className="chat-topic-panel__task-step-title">
                                  <span className="chat-topic-panel__task-step-badge">{childTitle}</span>
                                  <span className="chat-topic-panel__task-step-id">{childTaskId}</span>
                                </span>
                                <span className={`chat-topic-panel__task-step-status ${isActive ? "chat-topic-panel__task-step-status--completed" : ""}`}>
                                  {isActive ? "running" : "queued"}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                      {latestTaskResult.trace.length > 0 && (
                        <button
                          type="button"
                          className="chat-topic-panel__inline-action"
                          onClick={() => setIsTaskTraceExpanded((current) => !current)}
                        >
                          {isTaskTraceExpanded ? "收起过程" : "展开过程"}
                        </button>
                      )}
                      {latestTaskResult.trace.length > 0 && isTaskTraceExpanded && (
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

                {taskRuntimeState.history.length > 1 && (
                  <div className="chat-topic-panel__section">
                    <div className="chat-topic-panel__section-title">
                      <History size={13} strokeWidth={2} />
                      <span>任务历史</span>
                    </div>
                    <div className="chat-topic-panel__group-list">
                      {taskRuntimeState.history.slice(1, 6).map((task) => (
                        <div key={task.taskId} className="chat-topic-panel__task">
                          <div className="chat-topic-panel__task-head">
                            <strong>{task.plan.goal}</strong>
                            <span className={`chat-topic-panel__task-status chat-topic-panel__task-status--${task.status}`}>{task.status}</span>
                          </div>
                          <div className="chat-topic-panel__task-meta">
                            <span>{task.intent}</span>
                            <span>{task.plan.model}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </aside>}

    </div>
  );
}
