import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "../app/storageApi";
import type {
  CSSProperties,
  Dispatch,
  ReactNode,
  RefObject,
  SetStateAction,
} from "react";
import { useLayoutEffect } from "react";
import {
  ArrowDown,
  ArrowRight,
  Bot,
  Cable,
  Clock,
  Compass,
  FolderOpen,
  GitBranch,
  LayoutTemplate,
  MessageSquare,
  MoreHorizontal,
  Package,
  PanelRightClose,
  Pencil,
  PanelRightOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Puzzle,
  ChevronDown,
  ChevronRight,
  Search,
  Settings,
  Share2,
  Sparkles,
  Trash2,
  Wand2,
} from "lucide-react";
import type { Message, ChatAttachment } from "../adapters/types";
import type { ModelConfig } from "../adapters/types";
import { formatUsageLabel, DEFAULT_PROJECT_ID } from "../chat/storage";
import type { KnowledgeCollection } from "../chat/knowledgeTypes";
import type {
  ProjectDraft,
  ProjectMemoryRecord,
  ProjectMemorySourceType,
  Project,
  ChatSendOptions,
  ChatSession,
} from "../chat/types";
import ArtifactsPanel from "./ArtifactsPanel";
import ChangesPanel from "./ChangesPanel";
import {
  ARTIFACTS_CHANGED_EVENT,
  artifactsForProject,
  appendArtifact,
  notifyArtifactsChanged,
  NO_PROJECT_ARTIFACT_KEY,
  OPEN_ARTIFACT_EVENT,
  openWorkspaceFileInArtifacts,
} from "../chat/artifacts";
import { RECOMMENDED_PROJECT_PRESETS } from "../config/manifests/projects";

import {
  ALWAYS_ALLOWED_LOCAL_TOOL_IDS,
} from "../config/manifests/tools";
import {
  readSqliteBackedValue,
  saveSqliteBackedValue,
} from "../app/sqliteStorage";
import ChatInput from "./ChatInput";
import ChatMessage from "./ChatMessage";
import CreateProjectDialog from "./CreateProjectDialog";
import ProjectGroupManagerDialog from "./chat/ProjectGroupManagerDialog";
import ModelSelector from "./ModelSelector";
import PluginMarketplace from "./plugins/PluginMarketplace";
import type { MarketplaceSource } from "./plugins/PluginMarketplace";
import type { PluginKind } from "../plugins/types";
import { useCallback } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  PROJECT_GROUPS_STORAGE_KEY,
  readProjectGroupsStorageValue,
  DEFAULT_TOPIC_PANEL_WIDTH,
  EMPTY_CHAT_GUIDE_COMPACT_STORAGE_KEY,
  MAIN_LAYOUT_TOPIC_WIDTH_STORAGE_KEY,
  MAX_TOPIC_PANEL_WIDTH,
  MIN_MAIN_CHAT_AREA_WIDTH,
  MIN_TOPIC_PANEL_WIDTH,
  MIN_COMPOSER_RESIZE_HEIGHT,
  MIN_MESSAGE_AREA_HEIGHT,
  clampPanelWidth,
  getSessionAvatarStyle,
  NewSessionInSpaceIcon,
  normalizeSearchText,
  readStoredPanelWidth,
  renderProjectAvatar,
  SessionAvatarIcon,
  truncateQuestionPreview,
} from "./mainChatViewUtils";

type SessionGroup = {
  label: string;
  sessions: ChatSession[];
};

type SidePanelTab = "history" | "artifacts" | "changes";

type ProjectDeleteConfirmState = {
  projectId: string;
  title: string;
  message: string;
} | null;

type ProjectNoticeState = {
  tone: "success" | "error";
  message: string;
} | null;

/** 顶部 toolbar 的「数据源」tabs：与 <PluginMarketplace> 内部的 source-tabs
 *  形状一致，但放在 main-chat-toolbar 顶部 chrome（替代 Marketplace 内嵌的版本）。
 *  仅 skill / connector / expert 三类有二级切换；tool / template 只走 local，
 *  直接返回 null 即可，避免无意义的「local」单按钮占位。 */
function MarketplaceSourceTabs({
  kind,
  source,
  onSourceChange,
}: {
  kind: PluginKind;
  source: MarketplaceSource;
  onSourceChange: (next: MarketplaceSource) => void;
}) {
  const items: {
    value: MarketplaceSource;
    label: string;
    Icon: typeof Package;
  }[] = useMemo(() => {
    if (kind === "skill") {
      return [
        { value: "local", label: "我的技能", Icon: LayoutTemplate },
        { value: "skillhub", label: "SkillHub 实时", Icon: Bot },
        { value: "suites", label: "专家团", Icon: Package },
      ];
    }
    if (kind === "connector") {
      return [
        { value: "local", label: "本地连接器", Icon: Settings },
        { value: "connectors", label: "远程接入", Icon: Cable },
      ];
    }
    if (kind === "expert") {
      return [
        { value: "my", label: "我的专家", Icon: Bot },
        { value: "local", label: "本地内置", Icon: LayoutTemplate },
      ];
    }
    return [];
  }, [kind]);
  if (items.length === 0) return null;
  return (
    <div
      className="main-chat-toolbar__marketplace-tabs plugin-marketplace__source-tabs"
      role="tablist"
      aria-label="数据源"
    >
      {items.map((it) => {
        const active = source === it.value;
        return (
          <button
            key={it.value}
            type="button"
            role="tab"
            aria-selected={active}
            className={`plugin-marketplace__source-tab ${active ? "plugin-marketplace__source-tab--active" : ""}`}
            onClick={() => onSourceChange(it.value)}
          >
            <it.Icon size={14} strokeWidth={1.8} />
            <span>{it.label}</span>
          </button>
        );
      })}
    </div>
  );
}

type MainChatViewProps = {
  activeProject: Project | null;
  activeProjectId: string;
  activeChatId: string | null;
  activeSession: ChatSession | null;
  projects: Project[];
  availableModels: ModelConfig[];
  currentModel: string;
  editingMessageIndex: number | null;
  emptyChatPrompts: string[];
  error: string | null;
  groupedChatSessions: SessionGroup[];
  chatSessions: ChatSession[];
  hasModels: boolean;
  inputDraft: string;
  inputDraftImages: string[];
  inputDraftAttachments: ChatAttachment[];
  inputDraftKey: number;
  inputFocusKey: number;
  inputDraftScopeKey: string;
  executionModel: string;
  isLoading: boolean;
  isSendBlocked?: boolean;
  isStreaming: boolean;
  relatedContext: {
    summaries: Array<{ sessionId: string; title: string; summary: string }>;
    memories: Array<{
      id: string;
      content: string;
      sourceSessionId?: string | null;
    }>;
  };
  projectMemories: ProjectMemoryRecord[];
  messages: Message[];
  messagesScrollRef: RefObject<HTMLDivElement | null>;
  omniIconSrc: string;
  openChatMenu: { id: string; x: number; y: number } | null;
  windowControls?: ReactNode;
  onCancelEditUserMessage: () => void;
  onClearChat: () => void;
  onCopyMessage: (message: Message) => void | Promise<void>;
  onCreateCustomProject: (input?: {
    title?: string;
    description?: string;
    systemPrompt?: string;
    avatarType?: "emoji" | "image";
    avatarValue?: string;
    defaultModelId?: string | null;
    allowedToolIds?: string[];
    allowedSkillIds?: string[];
    workspacePath?: string;
  }) => Project | null;
  onAddProjectMemory: (
    projectId: string,
    content: string,
    sourceSessionId?: string | null,
    sourceType?: ProjectMemorySourceType,
  ) => boolean;
  onClearProjectMemories: (projectId: string) => number;
  onDeleteProject: (projectId: string) => boolean | Promise<boolean>;
  onDeleteProjectMemory: (memoryId: string) => boolean;
  onUpdateProjectMemory: (memoryId: string, content: string) => boolean;
  onDeleteChat: (session: ChatSession) => void;
  onDraftChange: (
    text: string,
    images: string[],
    attachments: ChatAttachment[],
  ) => void;
  onEditUserMessage: (messageIndex: number) => void;
  onModelChange: (modelId: string) => void;
  onNewChat: () => void;
  onNewChatInProject: (projectId: string) => void;
  onRegenerateMessage: (messageIndex: number) => void | Promise<void>;
  onRenameChat: (session: ChatSession) => void;
  onSelectProject: (projectId: string) => void;
  onSelectChat: (sessionId: string) => void;
  onUpdateProject: (
    projectId: string,
    patch: Partial<Project>,
  ) => Project | null;
  onSend: (
    content: string,
    images?: string[],
    options?: ChatSendOptions,
  ) => void | Promise<void>;
  onSetOpenChatMenu: Dispatch<
    SetStateAction<{ id: string; x: number; y: number } | null>
  >;
  onSettingsOpen: () => void;
  onShareChat: (session: ChatSession) => void | Promise<void>;
  onStop: () => void;
  onSubmitEditedUserMessage: (
    messageIndex: number,
    content: string,
  ) => void | Promise<void>;
  onToggleFavoriteChat: (session: ChatSession) => void;
  onTogglePinChat: (session: ChatSession) => void;
  onUseEmptyPrompt: (prompt: string) => void;
  onOpenKnowledge: () => void;
  openMarketplace?: boolean;
  onMarketplaceChange?: (open: boolean) => void;
  /** 跳转到对话框并预填草稿（如「创建专家」入口）。 */
  onJumpToChat?: (text: string) => void;
};

export default function MainChatView({
  activeProject,
  activeProjectId,
  activeChatId,
  activeSession,
  projects,
  availableModels,
  currentModel,
  editingMessageIndex,
  emptyChatPrompts,
  error,
  chatSessions,
  hasModels,
  inputDraft,
  inputDraftImages,
  inputDraftAttachments,
  inputDraftKey,
  inputFocusKey,
  inputDraftScopeKey,
  executionModel,
  isLoading,
  isSendBlocked = false,
  isStreaming,
  relatedContext,
  messages,
  messagesScrollRef,
  omniIconSrc,
  windowControls,
  onCancelEditUserMessage,
  onClearChat,
  onDeleteChat,
  onCopyMessage,
  onCreateCustomProject,
  onDeleteProject,
  onDraftChange,
  onEditUserMessage,
  onModelChange,
  onNewChat,
  onNewChatInProject,
  onRegenerateMessage,
  onSelectProject,
  onSelectChat,
  onUpdateProject,
  onSend,
  onSettingsOpen,
  onShareChat,
  onStop,
  onSubmitEditedUserMessage,
  onUseEmptyPrompt,
  onOpenKnowledge,
  openMarketplace,
  onMarketplaceChange,
  onJumpToChat,
}: MainChatViewProps) {
  const [workspaceElement, setWorkspaceElement] = useState<HTMLElement | null>(
    null,
  );
  const [composerElement, setComposerElement] = useState<HTMLDivElement | null>(
    null,
  );
  const [isTopicPanelAutoCollapsed, setIsTopicPanelAutoCollapsed] =
    useState(false);
  const [topicPanelManualVisible, setTopicPanelManualVisible] = useState<
    boolean | null
  >(null);
  const [isProjectPanelAutoCollapsed, setIsProjectPanelAutoCollapsed] =
    useState(false);
  const [projectPanelManualVisible, setProjectPanelManualVisible] = useState<
    boolean | null
  >(null);
  const [composerHeight, setComposerHeight] = useState(0);
  const [composerResizeHeight, setComposerResizeHeight] = useState<
    number | null
  >(null);
  const composerSplitterDraggingRef = useRef(false);
  const composerSplitterStartYRef = useRef(0);
  const composerSplitterStartHeightRef = useRef(0);
  const [sidePanelTab, setSidePanelTab] = useState<SidePanelTab>(() => {
    // 有产物的项目打开后默认展示产物面板，否则展示历史提问
    if (activeProject) {
      const initialCount = artifactsForProject(activeProject.id).length;
      return initialCount > 0 ? "artifacts" : "history";
    }
    return "history";
  });
  const [showPluginMarketplace, setShowPluginMarketplace] = useState(
    openMarketplace ?? false,
  );
  const [artifactCount, setArtifactCount] = useState(0);
  const prevArtifactCountRef = useRef(0);
  const [marketplaceFilter, setMarketplaceFilter] = useState<{
    kind: PluginKind;
    category: string;
  }>({ kind: "skill", category: "全部" });
  // Marketplace 二级数据源（local/skillhub/suites/connectors/my）。由本层
  // main-chat-toolbar 顶部的「我的技能 / SkillHub 实时 / 套件…」tabs 控制，
  // 受控传给 <PluginMarketplace>，与 Marketplace 内部 useEffect 联动互斥以避免
  // 双 state 不同步。一级 kind 切换会强制 Marketplace 重挂（key 含 kind），
  // 同 kind 内用户对 source tabs 的选择持久保留，跨 kind 时自动落到合理默认。
  const [marketplaceSource, setMarketplaceSource] = useState<MarketplaceSource>(
    () =>
      marketplaceFilter.kind === "skill"
        ? "skillhub"
        : marketplaceFilter.kind === "connector"
          ? "connectors"
          : marketplaceFilter.kind === "expert"
            ? "my"
            : "local",
  );

  useEffect(() => {
    if (openMarketplace !== undefined) {
      setShowPluginMarketplace(openMarketplace);
    }
  }, [openMarketplace]);

  // 产物数量角标 + 新产物产出时自动切换到产物 tab（让效果即时可见）。
  // 初始加载只同步数量与默认 tab，不主动切换；仅运行时「事件触发且数量增加」才切到产物 tab，
  // 避免打开应用时历史产物把视图抢走。
  useEffect(() => {
    if (!activeProject) return;
    const onArtifactsChanged = () => {
      const count = artifactsForProject(activeProject.id).length;
      setArtifactCount(count);
      if (count > prevArtifactCountRef.current && count > 0) {
        setSidePanelTab("artifacts");
      }
      prevArtifactCountRef.current = count;
    };
    prevArtifactCountRef.current = artifactsForProject(activeProject.id).length;
    setArtifactCount(prevArtifactCountRef.current);
    window.addEventListener(ARTIFACTS_CHANGED_EVENT, onArtifactsChanged);
    return () =>
      window.removeEventListener(ARTIFACTS_CHANGED_EVENT, onArtifactsChanged);
  }, [activeProject]);

  // 点击消息中的产物卡片时：展开右侧边栏并切换到产物 tab，让产物在面板中打开。
  // ArtifactsPanel 自己监听同事件；这里同时保证面板可见。
  useEffect(() => {
    const onOpenArtifact = (event: Event) => {
      const detail = (event as CustomEvent<{ artifactId: string }>).detail;
      if (!detail?.artifactId) return;
      setTopicPanelManualVisible(true);
      setSidePanelTab("artifacts");
    };
    window.addEventListener(OPEN_ARTIFACT_EVENT, onOpenArtifact);
    return () =>
      window.removeEventListener(OPEN_ARTIFACT_EVENT, onOpenArtifact);
  }, []);

  // 点击 /search_files 命中行：相对路径落工作区根解析为绝对路径，
  // 登记/复用「文件」产物并在右侧产物面板打开、滚动定位到行号。
  const handleOpenFileLocation = useCallback(
    (rawPath: string, line: number) => {
      const isAbsolute =
        /^[a-zA-Z]:[\\/]/.test(rawPath) ||
        rawPath.startsWith("/") ||
        rawPath.startsWith("\\\\");
      const workspace = (activeProject?.workspacePath ?? "").replace(
        /[\\/]+$/,
        "",
      );
      const absolute = isAbsolute
        ? rawPath
        : workspace
          ? `${workspace}/${rawPath.replace(/^[\\/]+/, "")}`
          : rawPath;
      openWorkspaceFileInArtifacts({
        path: absolute,
        line,
        projectId: activeProject?.id ?? NO_PROJECT_ARTIFACT_KEY,
        sessionId: activeChatId,
      });
    },
    [activeProject, activeChatId],
  );

  // 点击消息中的文件附件：登记/复用「文件」产物并在右侧产物面板打开。
  const handleOpenAttachment = useCallback(
    (path: string) => {
      openWorkspaceFileInArtifacts({
        path,
        projectId: activeProject?.id ?? NO_PROJECT_ARTIFACT_KEY,
        sessionId: activeChatId,
      });
    },
    [activeProject, activeChatId],
  );

  // 一级 kind 切换时把 source 重置到该 kind 的默认视图（与 Marketplace 内部
  // 受控分支的「不再自动同步 kind→source」配对，保证切回 skill 仍先看到 SkillHub）。
  useEffect(() => {
    setMarketplaceSource(
      marketplaceFilter.kind === "skill"
        ? "skillhub"
        : marketplaceFilter.kind === "connector"
          ? "connectors"
          : marketplaceFilter.kind === "expert"
            ? "my"
            : "local",
    );
  }, [marketplaceFilter.kind]);

  const closeMarketplace = useCallback(() => {
    setShowPluginMarketplace(false);
    onMarketplaceChange?.(false);
  }, [onMarketplaceChange]);

  /** 「创建专家」：关闭扩展中心，跳回对话框并预填 /expert-manager 创建指令。 */
  const handleCreateExpert = useCallback(() => {
    setShowPluginMarketplace(false);
    onMarketplaceChange?.(false);
    onJumpToChat?.("/expert-manager ");
  }, [onMarketplaceChange, onJumpToChat]);
  const [projectDeleteConfirm, setProjectDeleteConfirm] =
    useState<ProjectDeleteConfirmState>(null);
  const [projectSearchQuery, setProjectSearchQuery] = useState("");
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [taskSectionCollapsed, setTaskSectionCollapsed] = useState(false);
  const [spaceSectionCollapsed, setSpaceSectionCollapsed] = useState(false);
  const [expandedSpaces, setExpandedSpaces] = useState<Set<string>>(new Set());
  const [createProjectDialogOpen, setCreateProjectDialogOpen] = useState(false);
  const [projectGroupManagerOpen, setProjectGroupManagerOpen] = useState(false);
  const [projectGroupCreateMode, setProjectGroupCreateMode] = useState(false);
  const [projectGroupDraft, setProjectGroupDraft] = useState("");
  const [topicPanelWidth, setTopicPanelWidth] = useState(() =>
    readStoredPanelWidth(
      MAIN_LAYOUT_TOPIC_WIDTH_STORAGE_KEY,
      DEFAULT_TOPIC_PANEL_WIDTH,
      MIN_TOPIC_PANEL_WIDTH,
      MAX_TOPIC_PANEL_WIDTH,
    ),
  );
  const [projectGroups, setProjectGroups] = useState<string[]>(() => {
    const saved = readProjectGroupsStorageValue();
    if (!saved) return [];
    try {
      const parsed = JSON.parse(saved);
      return Array.isArray(parsed)
        ? parsed
            .filter(
              (item): item is string =>
                typeof item === "string" && item.trim().length > 0,
            )
            .map((item) => item.trim())
        : [];
    } catch {
      return [];
    }
  });
  const [editingProjectGroupName, setEditingProjectGroupName] = useState<
    string | null
  >(null);
  const [editingProjectGroupDraft, setEditingProjectGroupDraft] = useState("");
  const [projectNotice, setProjectNotice] = useState<ProjectNoticeState>(null);
  const [openProjectCardMenuId, setOpenProjectCardMenuId] = useState<
    string | null
  >(null);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editingProjectTitle, setEditingProjectTitle] = useState("");
  const projectMenuRef = useRef<HTMLDivElement | null>(null);
  const projectCardMenuRefs = useRef<Record<string, HTMLSpanElement | null>>(
    {},
  );
  const layoutDragRef = useRef<{
    startX: number;
    startWidth: number;
  } | null>(null);

  const recommendedPrompts = emptyChatPrompts.slice(0, 4);
  const [isEmptyGuideCompact, setIsEmptyGuideCompact] = useState(
    () => readSqliteBackedValue(EMPTY_CHAT_GUIDE_COMPACT_STORAGE_KEY) === "1",
  );
  const updateEmptyGuideCompact = useCallback((nextCompact: boolean) => {
    setIsEmptyGuideCompact(nextCompact);
    saveSqliteBackedValue(
      EMPTY_CHAT_GUIDE_COMPACT_STORAGE_KEY,
      nextCompact ? "1" : "0",
    );
  }, []);
  const currentTopicTitle =
    activeSession?.title ||
    (activeProject?.kind === "basic" ? "Omni" : activeProject?.title) ||
    "Omni";
  const defaultTopicPanelVisible = !isTopicPanelAutoCollapsed;
  const isTopicPanelVisible =
    topicPanelManualVisible ?? defaultTopicPanelVisible;
  const defaultProjectPanelVisible = !isProjectPanelAutoCollapsed;
  const isProjectPanelVisible =
    projectPanelManualVisible ?? defaultProjectPanelVisible;
  const customProjects = projects.filter(
    (project) => project.kind === "custom",
  );
  const projectGroupNames = useMemo(
    () =>
      Array.from(
        new Set([
          ...projectGroups,
          ...customProjects
            .map((project) => project.groupName?.trim())
            .filter((groupName): groupName is string => Boolean(groupName)),
        ]),
      ).sort((a, b) => a.localeCompare(b, "zh-CN")),
    [projectGroups, customProjects],
  );
  const handleLayoutDragPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      layoutDragRef.current = {
        startX: event.clientX,
        startWidth: topicPanelWidth,
      };
    },
    [topicPanelWidth],
  );

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const state = layoutDragRef.current;
      if (!state) return;
      const delta = event.clientX - state.startX;
      // 不人为限制宽度：最宽可拖到「窗口宽 - 聊天区保底」，仅防止把聊天区完全盖住。
      const effectiveMax = Math.max(
        MIN_TOPIC_PANEL_WIDTH,
        window.innerWidth - MIN_MAIN_CHAT_AREA_WIDTH,
      );
      setTopicPanelWidth(
        clampPanelWidth(
          state.startWidth - delta,
          MIN_TOPIC_PANEL_WIDTH,
          effectiveMax,
        ),
      );
    };

    const handlePointerUp = () => {
      const state = layoutDragRef.current;
      if (!state) return;
      layoutDragRef.current = null;
      saveSqliteBackedValue(
        MAIN_LAYOUT_TOPIC_WIDTH_STORAGE_KEY,
        String(topicPanelWidth),
      );
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

  const handleComposerSplitterPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = composerElement?.getBoundingClientRect();
      composerSplitterDraggingRef.current = true;
      composerSplitterStartYRef.current = event.clientY;
      composerSplitterStartHeightRef.current = rect?.height ?? composerHeight;
    },
    [composerElement, composerHeight],
  );

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (!composerSplitterDraggingRef.current) return;
      // 向上拖动（clientY 减小）输入框变高，向下拖动变矮，与窗口边缘拖拽直觉一致。
      const delta = composerSplitterStartYRef.current - event.clientY;
      // 不人为限制高度：最高可拖到「窗口高 - 消息区保底」，仅防止把消息区完全盖住。
      const effectiveMax = Math.max(
        MIN_COMPOSER_RESIZE_HEIGHT,
        window.innerHeight - MIN_MESSAGE_AREA_HEIGHT,
      );
      const nextHeight = clampPanelWidth(
        composerSplitterStartHeightRef.current + delta,
        MIN_COMPOSER_RESIZE_HEIGHT,
        effectiveMax,
      );
      setComposerResizeHeight(nextHeight);
    };

    const handlePointerUp = () => {
      if (!composerSplitterDraggingRef.current) return;
      composerSplitterDraggingRef.current = false;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, []);

  const allowedComposerToolIds = useMemo(
    () => [
      ...ALWAYS_ALLOWED_LOCAL_TOOL_IDS,
      ...(activeProject?.allowedToolIds ?? []),
    ],
    [activeProject?.allowedToolIds],
  );
  const allowedComposerSkillIds = activeProject?.allowedSkillIds ?? [];
  const showContextRecallBanner =
    messages.length === 0 &&
    (relatedContext.memories.length > 0 || relatedContext.summaries.length > 0);
  const [isContextRecallBannerDismissed, setIsContextRecallBannerDismissed] =
    useState(false);
  const hasVisibleContextRecallBanner =
    showContextRecallBanner && !isContextRecallBannerDismissed;
  const useCompactEmptyGuideLayout =
    isEmptyGuideCompact && !hasVisibleContextRecallBanner;
  const composerContextPresetText = useMemo(() => "", []);
  const normalizedProjectSearchQuery = normalizeSearchText(projectSearchQuery);
  const filteredCustomProjects = customProjects.filter((project) => {
    if (!normalizedProjectSearchQuery) return true;
    return normalizeSearchText(
      `${project.title} ${project.description}`,
    ).includes(normalizedProjectSearchQuery);
  });
  const basicProject =
    projects.find((project) => project.kind === "basic") ?? null;
  const standaloneSessions = useMemo(
    () =>
      [...chatSessions]
        .filter((session) => session.projectId === DEFAULT_PROJECT_ID)
        .sort(
          (a, b) =>
            Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
            b.updatedAt - a.updatedAt,
        ),
    [chatSessions],
  );
  const sessionsByProject = useMemo(() => {
    const map = new Map<string, ChatSession[]>();
    for (const session of chatSessions) {
      if (session.projectId === DEFAULT_PROJECT_ID) continue;
      const list = map.get(session.projectId) ?? [];
      list.push(session);
      map.set(session.projectId, list);
    }
    for (const list of map.values()) {
      list.sort(
        (a, b) =>
          Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
          b.updatedAt - a.updatedAt,
      );
    }
    return map;
  }, [chatSessions]);
  const formatSessionTime = (updatedAt: number): string => {
    const diff = Date.now() - updatedAt;
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diff < minute) return "刚刚";
    if (diff < hour) return `${Math.floor(diff / minute)}分钟前`;
    if (diff < day) return `${Math.floor(diff / hour)}小时前`;
    if (diff < 2 * day) return "昨天";
    if (diff < 7 * day) return `${Math.floor(diff / day)}天前`;
    const date = new Date(updatedAt);
    return `${date.getMonth() + 1}/${date.getDate()}`;
  };
  const [knowledgeCollections, setKnowledgeCollections] = useState<
    KnowledgeCollection[]
  >([]);
  const [isMessagesAtBottom, setIsMessagesAtBottom] = useState(true);
  const isMessagesAtBottomRef = useRef(true);
  const lastAutoScrolledSessionRef = useRef<string | null>(null);
  const selectedExecutionModel =
    availableModels.find((model) => model.id === executionModel) ?? null;
  const showProjectNotice = useCallback(
    (message: string, tone: "success" | "error" = "success") => {
      setProjectNotice({ tone, message });
    },
    [],
  );
  const handleCreateProject = useCallback(() => {
    setCreateProjectDialogOpen(true);
  }, []);

  const handleCreateProjectFromDialog = useCallback(
    (draft: ProjectDraft) => {
      const created = onCreateCustomProject(draft);
      if (created && created.id) {
        showProjectNotice("项目已创建");
      }
    },
    [onCreateCustomProject, showProjectNotice],
  );
  const handleShareActiveSession = useCallback(async () => {
    if (!activeSession) {
      showProjectNotice("当前没有可分享的会话", "error");
      return;
    }

    try {
      await onShareChat(activeSession);
      showProjectNotice("会话 Markdown 已复制");
    } catch {
      showProjectNotice("复制失败，请检查剪贴板权限", "error");
    }
  }, [activeSession, onShareChat, showProjectNotice]);
  const handleCopyMessageWithNotice = useCallback(
    async (message: Message) => {
      try {
        await onCopyMessage(message);
        showProjectNotice("消息已复制");
      } catch {
        showProjectNotice("复制失败，请检查剪贴板权限", "error");
      }
    },
    [onCopyMessage, showProjectNotice],
  );
  const handleSaveAsMarkdown = useCallback(
    async (message: Message) => {
      const content = message.content ?? "";
      if (!content.trim()) {
        showProjectNotice("这条消息没有可保存的内容", "error");
        return;
      }
      try {
        const ws = activeProject?.workspacePath ?? "";
        const baseDir =
          ws || (await invoke<string>("default_artifact_dir")).trim();
        const dir = ws ? ws : baseDir ? `${baseDir}/Omni` : "";
        if (!dir) {
          showProjectNotice("无法确定保存目录", "error");
          return;
        }
        // 从首行（去 #/标记）取文件名，清洗非法字符
        const firstLine =
          content
            .split(/\r?\n/)
            .map((l) => l.trim())
            .find((l) => l.length > 0) ?? "";
        const rawName =
          firstLine
            .replace(/^#+\s*/, "")
            .replace(/[*_`#]/g, "")
            .trim()
            .slice(0, 60) || "对话导出";
        const name =
          rawName
            .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80) || "对话导出";
        // 避免覆盖已有文件：追加 -1、-2……
        let path = `${dir}/${name}.md`;
        let n = 1;
        while (await invoke<boolean>("path_exists", { path })) {
          path = `${dir}/${name}-${n}.md`;
          n += 1;
        }
        const outcome = await invoke<{ path: string; size: number }>(
          "write_text_file",
          {
            path,
            content,
            overwrite: false,
            workspacePath: ws || null,
          },
        );
        appendArtifact({
          type: "file",
          title: outcome.path.split(/[\\/]/).pop() || "文档.md",
          path: outcome.path,
          size: outcome.size,
          content,
          projectId: activeProject?.id ?? NO_PROJECT_ARTIFACT_KEY,
          sessionId: activeChatId,
        });
        notifyArtifactsChanged();
        showProjectNotice(
          `已存为 Markdown：${outcome.path.split(/[\\/]/).pop()}`,
        );
      } catch (error) {
        showProjectNotice(
          `保存失败：${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
    [activeProject, activeChatId, showProjectNotice],
  );
  const layoutClassName = useMemo(() => {
    const classNames = ["main-chat-layout"];
    if (projectPanelManualVisible === true)
      classNames.push("main-chat-layout--project-forced-open");
    if (!isProjectPanelVisible)
      classNames.push("main-chat-layout--project-collapsed");
    if (topicPanelManualVisible === true)
      classNames.push("main-chat-layout--topic-forced-open");
    if (!isTopicPanelVisible || showPluginMarketplace)
      classNames.push("main-chat-layout--topic-collapsed");
    return classNames.join(" ");
  }, [
    projectPanelManualVisible,
    isProjectPanelVisible,
    isTopicPanelVisible,
    topicPanelManualVisible,
    showPluginMarketplace,
  ]);
  const layoutStyle = useMemo<CSSProperties>(
    () =>
      ({
        "--topic-panel-width": `${topicPanelWidth}px`,
      }) as CSSProperties,
    [topicPanelWidth],
  );

  useEffect(() => {
    isMessagesAtBottomRef.current = isMessagesAtBottom;
  }, [isMessagesAtBottom]);

  useEffect(() => {
    if (!projectNotice) {
      return;
    }
    const timeoutId = window.setTimeout(() => setProjectNotice(null), 2600);
    return () => window.clearTimeout(timeoutId);
  }, [projectNotice]);

  useEffect(() => {
    if (messages.length === 0 || isEmptyGuideCompact) {
      return;
    }
    updateEmptyGuideCompact(true);
  }, [isEmptyGuideCompact, messages.length, updateEmptyGuideCompact]);

  useEffect(() => {
    let cancelled = false;

    void invoke<{ collections: KnowledgeCollection[] }>(
      "load_knowledge_library_command",
    )
      .then((payload) => {
        if (!cancelled) {
          setKnowledgeCollections(
            Array.isArray(payload.collections) ? payload.collections : [],
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setKnowledgeCollections([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!composerElement) return;
    let frameId = 0;
    const updateComposerHeight = () => {
      const nextHeight = Math.max(
        0,
        Math.round(composerElement.getBoundingClientRect().height || 0),
      );
      setComposerHeight((current) =>
        current === nextHeight ? current : nextHeight,
      );

      const scrollElement = messagesScrollRef.current;
      if (scrollElement && isMessagesAtBottomRef.current) {
        scrollElement.scrollTop = scrollElement.scrollHeight;
      }
    };
    const scheduleComposerHeightUpdate = () => {
      if (frameId) {
        cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        updateComposerHeight();
      });
    };
    scheduleComposerHeightUpdate();
    const observer = new ResizeObserver(scheduleComposerHeightUpdate);
    observer.observe(composerElement);
    return () => {
      if (frameId) {
        cancelAnimationFrame(frameId);
      }
      observer.disconnect();
    };
  }, [composerElement, messagesScrollRef]);

  useLayoutEffect(() => {
    const scrollElement = messagesScrollRef.current;
    if (!scrollElement) {
      return;
    }

    const sessionKey = activeChatId ?? "__empty__";
    if (lastAutoScrolledSessionRef.current !== sessionKey) {
      lastAutoScrolledSessionRef.current = sessionKey;
      scrollElement.scrollTop = scrollElement.scrollHeight;
      setIsMessagesAtBottom(true);
      isMessagesAtBottomRef.current = true;
      return;
    }

    if (messages.length > 0 && scrollElement.scrollTop <= 0) {
      scrollElement.scrollTop = scrollElement.scrollHeight;
      setIsMessagesAtBottom(true);
      isMessagesAtBottomRef.current = true;
    }
  }, [activeChatId, messages.length, messagesScrollRef]);

  useEffect(() => {
    const scrollElement = messagesScrollRef.current;
    if (!scrollElement) return;

    const updateAtBottom = () => {
      const distanceToBottom =
        scrollElement.scrollHeight -
        scrollElement.scrollTop -
        scrollElement.clientHeight;
      setIsMessagesAtBottom(distanceToBottom < 36);
    };

    updateAtBottom();
    scrollElement.addEventListener("scroll", updateAtBottom, { passive: true });
    const resizeObserver = new ResizeObserver(updateAtBottom);
    resizeObserver.observe(scrollElement);
    return () => {
      scrollElement.removeEventListener("scroll", updateAtBottom);
      resizeObserver.disconnect();
    };
  }, [messagesScrollRef]);

  useEffect(() => {
    const scrollElement = messagesScrollRef.current;
    if (!scrollElement || !isStreaming || !isMessagesAtBottom) {
      return;
    }
    scrollElement.scrollTo({
      top: scrollElement.scrollHeight,
      behavior: "smooth",
    });
  }, [isMessagesAtBottom, isStreaming, messages, messagesScrollRef]);

  const scrollMessagesToBottom = useCallback(() => {
    const scrollElement = messagesScrollRef.current;
    scrollElement?.scrollTo({
      top: scrollElement.scrollHeight,
      behavior: "smooth",
    });
  }, [messagesScrollRef]);

  useEffect(() => {
    saveSqliteBackedValue(
      PROJECT_GROUPS_STORAGE_KEY,
      JSON.stringify(projectGroups),
    );
  }, [projectGroups]);

  useEffect(() => {
    if (!workspaceElement) return;

    const topicCollapseThreshold = 1080;
    const topicExpandThreshold = 1160;
    const projectCollapseThreshold = 980;
    const projectExpandThreshold = 1040;

    const updateAutoCollapsed = () => {
      const viewportWidth =
        window.innerWidth ||
        document.documentElement.clientWidth ||
        workspaceElement.getBoundingClientRect().width ||
        0;

      setIsTopicPanelAutoCollapsed((current) => {
        const next = current
          ? viewportWidth < topicExpandThreshold
          : viewportWidth < topicCollapseThreshold;
        return next;
      });

      setIsProjectPanelAutoCollapsed((current) => {
        const next = current
          ? viewportWidth < projectExpandThreshold
          : viewportWidth < projectCollapseThreshold;
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
    if (!projectMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (projectMenuRef.current?.contains(target)) return;
      setProjectMenuOpen(false);
      setProjectGroupDraft("");
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [projectMenuOpen]);

  useEffect(() => {
    if (!openProjectCardMenuId) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      const activeMenu = projectCardMenuRefs.current[openProjectCardMenuId];
      if (activeMenu?.contains(target)) return;
      setOpenProjectCardMenuId(null);
      setProjectDeleteConfirm(null);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [openProjectCardMenuId]);

  const handleCreateProjectGroup = () => {
    const nextGroupName = projectGroupDraft.trim();
    if (!nextGroupName) {
      return;
    }
    const exists = projectGroupNames.some(
      (groupName) => groupName === nextGroupName,
    );
    if (!exists) {
      setProjectGroups((current) => [...current, nextGroupName]);
    }
    setProjectGroupDraft("");
  };

  const handleDeleteProjectGroup = (groupName: string) => {
    setProjectGroups((current) => current.filter((item) => item !== groupName));
    customProjects
      .filter((project) => (project.groupName?.trim() || "") === groupName)
      .forEach((project) => {
        onUpdateProject(project.id, { groupName: null });
      });
  };

  const handleRenameProjectGroup = (groupName: string) => {
    const nextGroupName = editingProjectGroupDraft.trim();
    if (!nextGroupName || nextGroupName === groupName) {
      setEditingProjectGroupName(null);
      setEditingProjectGroupDraft("");
      return;
    }
    setProjectGroups((current) =>
      current.map((item) => (item === groupName ? nextGroupName : item)),
    );
    customProjects
      .filter((project) => (project.groupName?.trim() || "") === groupName)
      .forEach((project) => {
        onUpdateProject(project.id, { groupName: nextGroupName });
      });
    setEditingProjectGroupName(null);
    setEditingProjectGroupDraft("");
  };

  const handleConfirmDeleteProject = async () => {
    if (!projectDeleteConfirm) return;
    const deleted = await onDeleteProject(projectDeleteConfirm.projectId);
    if (!deleted) return;
    setProjectDeleteConfirm(null);
    setOpenProjectCardMenuId(null);
  };

  return (
    <div className={layoutClassName} style={layoutStyle}>
      <aside className="main-chat-nav">
        <button
          type="button"
          className="main-chat-nav__brand no-drag"
          title="Omni"
        >
          <Bot size={20} strokeWidth={1.9} />
        </button>
        <div className="main-chat-nav__items">
          <button
            type="button"
            className={`main-chat-nav__item no-drag ${!showPluginMarketplace ? "main-chat-nav__item--active" : ""}`}
            title="聊天"
            onClick={closeMarketplace}
          >
            <MessageSquare size={18} strokeWidth={1.9} />
          </button>
          <button
            type="button"
            className={`main-chat-nav__item no-drag ${showPluginMarketplace ? "main-chat-nav__item--active" : ""}`}
            title="扩展中心"
            onClick={() => {
              setShowPluginMarketplace((current) => {
                const next = !current;
                if (next) setProjectPanelManualVisible(true);
                return next;
              });
            }}
          >
            <Sparkles size={18} strokeWidth={1.9} />
          </button>
          <button
            type="button"
            className="main-chat-nav__item no-drag"
            title="知识"
            onClick={onOpenKnowledge}
          >
            <FolderOpen size={18} strokeWidth={1.9} />
          </button>
        </div>
        <button
          type="button"
          className="main-chat-nav__item main-chat-nav__item--bottom no-drag"
          title="设置"
          onClick={onSettingsOpen}
        >
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

        {showPluginMarketplace ? (
          <div className="chat-history-panel__marketplace-nav">
            <div className="chat-history-panel__marketplace-nav-header">
              <span>扩展中心</span>
            </div>
            <div className="chat-history-panel__marketplace-kind-list">
              {[
                { kind: "skill" as const, label: "技能", icon: Wand2 },
                { kind: "tool" as const, label: "工具", icon: Puzzle },
                { kind: "connector" as const, label: "连接器", icon: Cable },
                { kind: "expert" as const, label: "专家", icon: Bot },
                {
                  kind: "template" as const,
                  label: "模板",
                  icon: LayoutTemplate,
                },
              ].map((item) => (
                <button
                  key={item.kind}
                  type="button"
                  className={`chat-history-panel__marketplace-kind ${marketplaceFilter.kind === item.kind ? "chat-history-panel__marketplace-kind--active" : ""}`}
                  onClick={() =>
                    setMarketplaceFilter((current) => ({
                      ...current,
                      kind: item.kind,
                      category: "全部",
                    }))
                  }
                >
                  <item.icon size={16} strokeWidth={1.8} />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div className="chat-history-panel__project-search">
              <Search size={14} strokeWidth={1.9} />
              <input
                value={projectSearchQuery}
                onChange={(event) => setProjectSearchQuery(event.target.value)}
                placeholder="搜索项目..."
              />
            </div>

            <div className="chat-history-panel__projects">
              <div className="chat-history-panel__section task-section">
                <div className="chat-history-panel__section-head">
                  <span className="chat-history-panel__section-label">
                    任务
                  </span>
                  <button
                    type="button"
                    className="chat-history-panel__section-toggle"
                    onClick={() =>
                      setTaskSectionCollapsed((current) => !current)
                    }
                    aria-label={taskSectionCollapsed ? "展开任务" : "收起任务"}
                  >
                    {taskSectionCollapsed ? (
                      <ChevronRight size={14} strokeWidth={1.8} />
                    ) : (
                      <ChevronDown size={14} strokeWidth={1.8} />
                    )}
                  </button>
                  <span className="chat-history-panel__section-count">
                    {standaloneSessions.length}
                  </span>
                  <button
                    type="button"
                    className="chat-history-panel__section-add"
                    onClick={() => onNewChatInProject(DEFAULT_PROJECT_ID)}
                    title="新建任务"
                    aria-label="新建任务"
                  >
                    <Plus size={14} strokeWidth={1.9} />
                  </button>
                </div>
                {!taskSectionCollapsed && (
                  <div className="chat-history-panel__session-list">
                    {basicProject && (
                      <div
                        role="button"
                        tabIndex={0}
                        className={`chat-history-panel__session chat-history-panel__session--main ${activeProjectId === basicProject.id ? "chat-history-panel__session--active" : ""}`}
                        onClick={() => {
                          onSelectProject(basicProject.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            onSelectProject(basicProject.id);
                          }
                        }}
                      >
                        <span
                          className="chat-history-panel__session-avatar"
                          style={{
                            backgroundColor: "#e0f2fe",
                            color: "#0ea5e9",
                          }}
                        >
                          <Bot size={14} strokeWidth={1.9} />
                        </span>
                        <span className="chat-history-panel__session-title">
                          {basicProject.title}
                        </span>
                      </div>
                    )}
                    {standaloneSessions.length === 0 ? (
                      <div className="chat-history-panel__empty">
                        暂无任务，点击 + 新建
                      </div>
                    ) : (
                      standaloneSessions.map((session) => (
                        <div
                          key={session.id}
                          role="button"
                          tabIndex={0}
                          className={`chat-history-panel__session ${activeChatId === session.id ? "chat-history-panel__session--active" : ""}`}
                          onClick={() => onSelectChat(session.id)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              onSelectChat(session.id);
                            }
                          }}
                        >
                          <span
                            className="chat-history-panel__session-avatar"
                            style={getSessionAvatarStyle(session.id)}
                          >
                            <SessionAvatarIcon size={12} />
                          </span>
                          <span className="chat-history-panel__session-title">
                            {session.title || "未命名会话"}
                          </span>
                          <span className="chat-history-panel__session-time">
                            {formatSessionTime(session.updatedAt)}
                          </span>
                          <button
                            type="button"
                            className="chat-history-panel__session-delete"
                            title="删除任务"
                            aria-label="删除任务"
                            onClick={(event) => {
                              event.stopPropagation();
                              onDeleteChat(session);
                            }}
                          >
                            <Trash2 size={12} strokeWidth={1.9} />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>

              <div className="chat-history-panel__section space-section">
                <div className="chat-history-panel__section-head">
                  <span className="chat-history-panel__section-label">
                    空间
                  </span>
                  <span className="chat-history-panel__section-count">
                    {filteredCustomProjects.length}
                  </span>
                  <button
                    type="button"
                    className="chat-history-panel__section-toggle"
                    onClick={() =>
                      setSpaceSectionCollapsed((current) => !current)
                    }
                    aria-label={spaceSectionCollapsed ? "展开空间" : "收起空间"}
                  >
                    {spaceSectionCollapsed ? (
                      <ChevronRight size={14} strokeWidth={1.8} />
                    ) : (
                      <ChevronDown size={14} strokeWidth={1.8} />
                    )}
                  </button>

                  <div className="chat-history-panel__section-actions">
                    <div
                      ref={projectMenuRef}
                      className="chat-history-panel__section-menu"
                    >
                      <button
                        type="button"
                        className={`chat-history-panel__section-action ${projectMenuOpen ? "chat-history-panel__section-action--active" : ""}`}
                        onClick={() =>
                          setProjectMenuOpen((current) => !current)
                        }
                        title="空间菜单"
                      >
                        <MoreHorizontal size={14} strokeWidth={1.8} />
                      </button>
                      {projectMenuOpen && (
                        <div className="chat-history-panel__section-dropdown">
                          <button
                            type="button"
                            onClick={() => {
                              setProjectMenuOpen(false);
                              void handleCreateProject();
                            }}
                          >
                            <Plus size={14} strokeWidth={1.9} />
                            <span>新建空间</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setProjectMenuOpen(false);
                              setProjectGroupManagerOpen(true);
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
                      className="chat-history-panel__section-add"
                      onClick={() => void handleCreateProject()}
                      title="新建空间"
                      aria-label="新建空间"
                    >
                      <Plus size={14} strokeWidth={1.9} />
                    </button>
                  </div>
                </div>
                {!spaceSectionCollapsed && (
                  <div className="chat-history-panel__space-list">
                    {filteredCustomProjects.length === 0 ? (
                      <div className="chat-history-panel__empty">
                        暂无空间，点击 + 新建
                      </div>
                    ) : (
                      filteredCustomProjects.map((project) => {
                        const isExpanded = expandedSpaces.has(project.id);
                        const projectSessions =
                          sessionsByProject.get(project.id) ?? [];
                        const isActiveSpace = activeProjectId === project.id;
                        return (
                          <div
                            key={project.id}
                            className={`chat-history-panel__space ${isActiveSpace ? "chat-history-panel__space--active" : ""}`}
                          >
                            <div
                              role="button"
                              tabIndex={0}
                              className="chat-history-panel__space-head"
                              onClick={() => {
                                onSelectProject(project.id);
                                setExpandedSpaces((current) => {
                                  const next = new Set(current);
                                  if (next.has(project.id))
                                    next.delete(project.id);
                                  else next.add(project.id);
                                  return next;
                                });
                              }}
                              onKeyDown={(event) => {
                                if (
                                  event.key === "Enter" ||
                                  event.key === " "
                                ) {
                                  event.preventDefault();
                                  onSelectProject(project.id);
                                  setExpandedSpaces((current) => {
                                    const next = new Set(current);
                                    next.add(project.id);
                                    return next;
                                  });
                                }
                              }}
                            >
                              {project.avatarType === "image" &&
                              project.avatarValue ? (
                                <span className="chat-history-panel__project-icon chat-history-panel__project-icon--custom">
                                  {renderProjectAvatar(project)}
                                </span>
                              ) : (
                                <span className="chat-history-panel__project-folder-icon-wrapper">
                                  {renderProjectAvatar(project)}
                                </span>
                              )}
                              {editingProjectId === project.id ? (
                                <input
                                  type="text"
                                  className="chat-history-panel__space-title-input"
                                  value={editingProjectTitle}
                                  onChange={(event) =>
                                    setEditingProjectTitle(event.target.value)
                                  }
                                  onClick={(event) => event.stopPropagation()}
                                  onBlur={() => {
                                    const trimmed = editingProjectTitle.trim();
                                    if (trimmed && trimmed !== project.title) {
                                      onUpdateProject(project.id, {
                                        title: trimmed,
                                      });
                                    }
                                    setEditingProjectId(null);
                                    setEditingProjectTitle("");
                                  }}
                                  onKeyDown={(event) => {
                                    event.stopPropagation();
                                    if (event.key === "Enter") {
                                      event.currentTarget.blur();
                                    } else if (event.key === "Escape") {
                                      setEditingProjectId(null);
                                      setEditingProjectTitle("");
                                    }
                                  }}
                                  ref={(el) => {
                                    if (el) {
                                      el.focus();
                                      el.select();
                                    }
                                  }}
                                />
                              ) : (
                                <span className="chat-history-panel__space-title">
                                  {project.title}
                                </span>
                              )}
                              <span
                                className="chat-history-panel__space-chevron"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setExpandedSpaces((current) => {
                                    const next = new Set(current);
                                    if (next.has(project.id))
                                      next.delete(project.id);
                                    else next.add(project.id);
                                    return next;
                                  });
                                }}
                              >
                                {isExpanded ? (
                                  <ChevronDown size={13} strokeWidth={1.8} />
                                ) : (
                                  <ChevronRight size={13} strokeWidth={1.8} />
                                )}
                              </span>
                              <span
                                className="chat-history-panel__space-spacer"
                                aria-hidden="true"
                              />
                              <span
                                className="chat-history-panel__project-menu"
                                ref={(el) => {
                                  projectCardMenuRefs.current[project.id] = el;
                                }}
                                onClick={(event) => event.stopPropagation()}
                                onKeyDown={(event) => event.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  className={`chat-history-panel__project-action ${openProjectCardMenuId === project.id ? "chat-history-panel__project-action--active" : ""}`}
                                  title="更多操作"
                                  aria-label="更多操作"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setOpenProjectCardMenuId((current) =>
                                      current === project.id
                                        ? null
                                        : project.id,
                                    );
                                  }}
                                >
                                  <MoreHorizontal size={13} strokeWidth={1.9} />
                                </button>
                                {openProjectCardMenuId === project.id && (
                                  <div className="chat-history-panel__project-dropdown">
                                    {projectDeleteConfirm?.projectId ===
                                    project.id ? (
                                      <div className="chat-topic-panel__menu-confirm chat-history-panel__project-dropdown-confirm">
                                        <div className="chat-topic-panel__menu-confirm-title">
                                          {projectDeleteConfirm.title}
                                        </div>
                                        <div className="chat-topic-panel__menu-confirm-message">
                                          {projectDeleteConfirm.message}
                                        </div>
                                        <div className="chat-topic-panel__menu-confirm-actions">
                                          <button
                                            type="button"
                                            className="chat-topic-panel__menu-button"
                                            onClick={(event) => {
                                              event.stopPropagation();
                                              setProjectDeleteConfirm(null);
                                            }}
                                          >
                                            取消
                                          </button>
                                          <button
                                            type="button"
                                            className="chat-topic-panel__menu-button chat-topic-panel__menu-button--danger"
                                            onClick={(event) => {
                                              event.stopPropagation();
                                              handleConfirmDeleteProject();
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
                                          disabled={!project.workspacePath}
                                          onClick={async (event) => {
                                            event.stopPropagation();
                                            setOpenProjectCardMenuId(null);
                                            if (!project.workspacePath) return;
                                            try {
                                              await openPath(
                                                project.workspacePath,
                                              );
                                            } catch (error) {
                                              showProjectNotice(
                                                `无法打开文件夹：${
                                                  (error as Error)?.message ??
                                                  String(error)
                                                }`,
                                                "error",
                                              );
                                            }
                                          }}
                                        >
                                          <FolderOpen
                                            size={13}
                                            strokeWidth={1.9}
                                          />
                                          <span>打开文件夹</span>
                                        </button>
                                        <button
                                          type="button"
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            setOpenProjectCardMenuId(null);
                                            setExpandedSpaces((current) => {
                                              const next = new Set(current);
                                              next.add(project.id);
                                              return next;
                                            });
                                            setEditingProjectId(project.id);
                                            setEditingProjectTitle(
                                              project.title,
                                            );
                                          }}
                                        >
                                          <Pencil size={13} strokeWidth={1.9} />
                                          <span>重命名</span>
                                        </button>
                                        {project.id !== DEFAULT_PROJECT_ID && (
                                          <>
                                            <div className="chat-history-panel__project-dropdown-divider" />
                                            <button
                                              type="button"
                                              className="chat-history-panel__project-dropdown-danger"
                                              onClick={(event) => {
                                                event.stopPropagation();
                                                setProjectDeleteConfirm({
                                                  projectId: project.id,
                                                  title: "从列表中移除",
                                                  message: `确认将“${project.title}”从列表中移除吗？相关会话和记忆会一并删除。`,
                                                });
                                              }}
                                            >
                                              <Trash2
                                                size={13}
                                                strokeWidth={1.9}
                                              />
                                              <span>从列表中移除</span>
                                            </button>
                                          </>
                                        )}
                                      </>
                                    )}
                                  </div>
                                )}
                              </span>
                              <button
                                type="button"
                                className="chat-history-panel__space-add"
                                title="在空间内新建会话"
                                aria-label="在空间内新建会话"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onNewChatInProject(project.id);
                                }}
                              >
                                <NewSessionInSpaceIcon size={16} />
                              </button>
                            </div>
                            {isExpanded && (
                              <div className="chat-history-panel__session-list chat-history-panel__session-list--nested">
                                {projectSessions.length === 0 ? (
                                  <div className="chat-history-panel__empty">
                                    该空间暂无会话
                                  </div>
                                ) : (
                                  projectSessions.map((session) => (
                                    <div
                                      key={session.id}
                                      role="button"
                                      tabIndex={0}
                                      className={`chat-history-panel__session ${activeChatId === session.id ? "chat-history-panel__session--active" : ""}`}
                                      onClick={() => onSelectChat(session.id)}
                                      onKeyDown={(event) => {
                                        if (
                                          event.key === "Enter" ||
                                          event.key === " "
                                        ) {
                                          event.preventDefault();
                                          onSelectChat(session.id);
                                        }
                                      }}
                                    >
                                      <span className="chat-history-panel__session-title">
                                        {session.title || "未命名会话"}
                                      </span>
                                      <span className="chat-history-panel__session-time">
                                        {formatSessionTime(session.updatedAt)}
                                      </span>
                                      <button
                                        type="button"
                                        className="chat-history-panel__session-delete"
                                        title="删除会话"
                                        aria-label="删除会话"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          onDeleteChat(session);
                                        }}
                                      >
                                        <Trash2 size={12} strokeWidth={1.9} />
                                      </button>
                                    </div>
                                  ))
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </aside>

      {projectGroupManagerOpen && (
        <ProjectGroupManagerDialog
          groupNames={projectGroupNames}
          draft={projectGroupDraft}
          onDraftChange={setProjectGroupDraft}
          createMode={projectGroupCreateMode}
          onCreateModeChange={setProjectGroupCreateMode}
          editingGroupName={editingProjectGroupName}
          onEditingGroupNameChange={setEditingProjectGroupName}
          editingDraft={editingProjectGroupDraft}
          onEditingDraftChange={setEditingProjectGroupDraft}
          onCreateGroup={handleCreateProjectGroup}
          onRenameGroup={handleRenameProjectGroup}
          onDeleteGroup={handleDeleteProjectGroup}
          onClose={() => {
            setProjectGroupManagerOpen(false);
            setProjectGroupDraft("");
          }}
        />
      )}

      <section className="main-chat-stage">
        {showPluginMarketplace && (
          <PluginMarketplace
            key={`marketplace-${marketplaceFilter.kind}-${marketplaceFilter.category}`}
            mainView
            initialFilter={marketplaceFilter}
            onClose={closeMarketplace}
            onCreateExpert={handleCreateExpert}
            source={marketplaceSource}
            onSourceChange={setMarketplaceSource}
            omitTopTabs
          />
        )}
        {projectNotice && (
          <div
            className={`main-chat-notice main-chat-notice--${projectNotice.tone}`}
            role={projectNotice.tone === "error" ? "alert" : "status"}
            aria-live="polite"
          >
            {projectNotice.message}
          </div>
        )}
        <header className="main-chat-header drag-region">
          <div className="main-chat-toolbar">
            <div className="main-chat-toolbar__session main-chat-toolbar__session--hero">
              <div className="main-chat-toolbar__project main-chat-toolbar__project--single-line">
                <button
                  type="button"
                  className="main-chat-toolbar__icon-button main-chat-toolbar__back-button no-drag"
                  aria-label={
                    isProjectPanelVisible ? "收起项目栏" : "展开项目栏"
                  }
                  title={isProjectPanelVisible ? "收起项目栏" : "展开项目栏"}
                  onClick={() =>
                    setProjectPanelManualVisible((currentValue) => {
                      const currentVisible =
                        currentValue ?? defaultProjectPanelVisible;
                      const nextVisible = !currentVisible;
                      return nextVisible === defaultProjectPanelVisible
                        ? null
                        : nextVisible;
                    })
                  }
                >
                  {isProjectPanelVisible ? (
                    <PanelLeftClose
                      className="main-chat-toolbar__icon"
                      strokeWidth={1.7}
                    />
                  ) : (
                    <PanelLeftOpen
                      className="main-chat-toolbar__icon"
                      strokeWidth={1.7}
                    />
                  )}
                </button>
                {!showPluginMarketplace && (
                  <>
                    <div className="main-chat-toolbar__project-mark">
                      {renderProjectAvatar(activeProject)}
                    </div>
                    <div className="main-chat-toolbar__project-copy main-chat-toolbar__project-copy--single-line">
                      <strong>
                        {currentTopicTitle}
                      </strong>
                    </div>
                  </>
                )}
                {showPluginMarketplace && (
                  <MarketplaceSourceTabs
                    kind={marketplaceFilter.kind}
                    source={marketplaceSource}
                    onSourceChange={setMarketplaceSource}
                  />
                )}
              </div>

              {!showPluginMarketplace && (
                <div className="no-drag">
                  <div className="main-chat-toolbar__model-stack">
                    <ModelSelector
                      currentModel={currentModel}
                      onModelChange={onModelChange}
                      label="主模型"
                      title={
                        selectedExecutionModel &&
                        executionModel !== currentModel
                          ? `当前项目会优先使用：${selectedExecutionModel.name}`
                          : undefined
                      }
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="main-chat-toolbar__actions no-drag">
              {!showPluginMarketplace && messages.length > 0 && (
                <button
                  onClick={onClearChat}
                  className="main-chat-toolbar__icon-button"
                  title="清空对话"
                  type="button"
                >
                  <Trash2
                    className="main-chat-toolbar__icon"
                    strokeWidth={1.7}
                  />
                </button>
              )}
              {!showPluginMarketplace && (
                <button
                  className="main-chat-toolbar__icon-button"
                  title="分享会话"
                  type="button"
                  onClick={() => void handleShareActiveSession()}
                  disabled={!activeSession}
                >
                  <Share2
                    className="main-chat-toolbar__icon"
                    strokeWidth={1.7}
                  />
                </button>
              )}
              {!showPluginMarketplace && (
                <button
                  type="button"
                  className="main-chat-toolbar__icon-button main-chat-toolbar__collapse-button"
                  aria-label={isTopicPanelVisible ? "收起话题栏" : "展开话题栏"}
                  title={isTopicPanelVisible ? "收起话题栏" : "展开话题栏"}
                  onClick={() =>
                    setTopicPanelManualVisible((currentValue) => {
                      const currentVisible =
                        currentValue ?? defaultTopicPanelVisible;
                      const nextVisible = !currentVisible;
                      return nextVisible === defaultTopicPanelVisible
                        ? null
                        : nextVisible;
                    })
                  }
                >
                  {isTopicPanelVisible ? (
                    <PanelRightClose
                      className="main-chat-toolbar__icon"
                      strokeWidth={1.7}
                    />
                  ) : (
                    <PanelRightOpen
                      className="main-chat-toolbar__icon"
                      strokeWidth={1.7}
                    />
                  )}
                </button>
              )}
              <div className="omni-window-control-slot">{windowControls}</div>
            </div>
          </div>
        </header>

        <div className="main-chat-body">
          <section
            ref={setWorkspaceElement}
            className="main-chat-workspace"
            style={
              { "--composer-height": `${composerHeight}px` } as CSSProperties
            }
          >
            <main className="main-chat-pane">
                <>
                  <div
                    ref={messagesScrollRef}
                    className="main-chat-scroll hide-scrollbar"
                  >
                    {!hasModels && messages.length === 0 && (
                      <div className="empty-chat-state">
                        <div className="empty-chat-state__hero">
                          <div className="empty-chat-state__icon">
                            <img src={omniIconSrc} alt="Omni" />
                          </div>
                          <h2>欢迎使用 Omni</h2>
                          <p>
                            请先配置一个可用模型，再开始对话、搜索或执行工作流。
                          </p>
                        </div>
                        <button
                          onClick={onSettingsOpen}
                          className="empty-chat-state__primary"
                          type="button"
                        >
                          打开设置
                        </button>
                      </div>
                    )}

                    {hasModels && messages.length === 0 && (
                      <div
                        className={`empty-chat-state${useCompactEmptyGuideLayout ? " empty-chat-state--compact" : ""}`}
                      >
                        {showContextRecallBanner &&
                          !isContextRecallBannerDismissed && (
                            <div className="chat-recall-banner">
                              <div className="chat-recall-banner__copy">
                                <strong>已为当前会话准备相关上下文</strong>
                                <span>
                                  {relatedContext.memories.length > 0
                                    ? `召回 ${relatedContext.memories.length} 条记忆`
                                    : ""}
                                  {relatedContext.memories.length > 0 &&
                                  relatedContext.summaries.length > 0
                                    ? " · "
                                    : ""}
                                  {relatedContext.summaries.length > 0
                                    ? `关联 ${relatedContext.summaries.length} 条摘要`
                                    : ""}
                                </span>
                              </div>
                              <button
                                type="button"
                                className="chat-recall-banner__action"
                                onClick={() => {
                                  setTopicPanelManualVisible(true);
                                }}
                              >
                                查看内容
                              </button>
                              <button
                                type="button"
                                className="chat-recall-banner__action"
                                onClick={() =>
                                  setIsContextRecallBannerDismissed(true)
                                }
                              >
                                关闭
                              </button>
                            </div>
                          )}
                        <div className="empty-chat-state__hero">
                          <div className="empty-chat-state__icon">
                            <img src={omniIconSrc} alt="Omni" />
                          </div>
                          <h2>从当前项目开始</h2>
                          <p>
                            {isEmptyGuideCompact
                              ? "直接输入问题开始对话。需要推荐模板时可展开引导。"
                              : "你可以直接输入问题，也可以从下方选择一个起点。后续任务、工具和技能会默认归属当前项目。"}
                          </p>
                        </div>
                        <div className="empty-chat-state__actions">
                          <button
                            type="button"
                            className="empty-chat-state__secondary"
                            onClick={() =>
                              updateEmptyGuideCompact(!isEmptyGuideCompact)
                            }
                          >
                            {isEmptyGuideCompact ? "展开推荐" : "收起推荐"}
                          </button>
                        </div>
                        {!isEmptyGuideCompact && (
                          <>
                            <div className="empty-chat-state__subhead">
                              <Sparkles size={14} strokeWidth={1.9} />
                              <span>推荐起步方式</span>
                            </div>
                            <div className="empty-chat-state__cards">
                              {recommendedPrompts.map((prompt, index) => (
                                <button
                                  key={prompt}
                                  type="button"
                                  className="empty-chat-state__card"
                                  onClick={() => onUseEmptyPrompt(prompt)}
                                >
                                  <div className="empty-chat-state__card-icon">
                                    {index % 2 === 0 ? (
                                      <Compass size={18} strokeWidth={1.8} />
                                    ) : (
                                      <Sparkles size={18} strokeWidth={1.8} />
                                    )}
                                  </div>
                                  <div className="empty-chat-state__card-copy">
                                    <strong>
                                      {RECOMMENDED_PROJECT_PRESETS[index]
                                        ?.title || "快速开始"}
                                    </strong>
                                    <span>
                                      {RECOMMENDED_PROJECT_PRESETS[index]
                                        ?.description || prompt}
                                    </span>
                                  </div>
                                  <ArrowRight size={16} strokeWidth={1.8} />
                                </button>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    )}

                    {messages.map((msg, index) => {
                      const isCurrentStreamingMessage =
                        isStreaming && index === messages.length - 1;
                      if (
                        msg.role === "project" &&
                        !msg.content.trim() &&
                        !isCurrentStreamingMessage
                      ) {
                        return null;
                      }

                      return (
                        <ChatMessage
                          key={index}
                          message={msg}
                          index={index}
                          isStreaming={isCurrentStreamingMessage}
                          isEditing={editingMessageIndex === index}
                          onCopy={handleCopyMessageWithNotice}
                          onEdit={onEditUserMessage}
                          onCancelEdit={onCancelEditUserMessage}
                          onSubmitEdit={onSubmitEditedUserMessage}
                          onRegenerate={onRegenerateMessage}
                          onSaveAsMarkdown={handleSaveAsMarkdown}
                          onOpenChangesPanel={() => setSidePanelTab("changes")}
                          onOpenFileLocation={handleOpenFileLocation}
                          onOpenAttachment={handleOpenAttachment}
                        />
                      );
                    })}

                    {error && (
                      <div className="main-chat-error animate-fade-in">
                        {error}
                      </div>
                    )}
                  </div>

                  {messages.length > 0 && !isMessagesAtBottom && (
                    <button
                      type="button"
                      className="main-chat-scroll-bottom no-drag"
                      aria-label="滚动到底部"
                      title="滚动到底部"
                      onClick={scrollMessagesToBottom}
                    >
                      <ArrowDown size={17} strokeWidth={2.2} />
                    </button>
                  )}

                  <div
                    className="main-chat-composer-splitter"
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label="调整对话台高度"
                    onPointerDown={handleComposerSplitterPointerDown}
                  />

                  <div
                    ref={setComposerElement}
                    className="main-chat-composer-outer"
                    style={
                      composerResizeHeight
                        ? { height: `${composerResizeHeight}px` }
                        : undefined
                    }
                  >
                    <ChatInput
                      allowedToolIds={allowedComposerToolIds}
                      allowedSkillIds={allowedComposerSkillIds}
                      canStartNewTopic={Boolean(activeProject)}
                      contextPresetText={composerContextPresetText}
                      knowledgeCollections={knowledgeCollections}
                      onSend={onSend}
                      hasConversation={messages.some(
                        (message) => message.role === "user",
                      )}
                      usageLabel={
                        activeSession
                          ? formatUsageLabel(activeSession.usage)
                          : null
                      }
                      isLoading={isLoading}
                      isSendBlocked={isSendBlocked}
                      onStop={onStop}
                      onStartNewTopic={onNewChat}
                      focusSignal={inputFocusKey}
                      fixedHeight={composerResizeHeight}
                      onSubmit={() => setComposerResizeHeight(null)}
                      draftScopeKey={inputDraftScopeKey}
                      draftValue={inputDraft}
                      draftImages={inputDraftImages}
                      draftAttachments={inputDraftAttachments}
                      draftSignal={inputDraftKey}
                      onDraftChange={onDraftChange}
                    />
                  </div>
                </>
            </main>
          </section>

          <div
            className="main-chat-layout__splitter main-chat-layout__splitter--topic no-drag"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整工作台宽度"
            onPointerDown={handleLayoutDragPointerDown}
          />

          <aside className="chat-topic-panel">
            <div className="chat-topic-panel__body">
                <div className="chat-topic-panel__toolbar">
                  <div className="chat-topic-panel__title">
                    {(() => {
                      if (sidePanelTab === "history")
                        return <Clock size={14} strokeWidth={2} />;
                      if (sidePanelTab === "changes")
                        return <GitBranch size={14} strokeWidth={2} />;
                      return <Package size={14} strokeWidth={2} />;
                    })()}
                    <span>
                      {sidePanelTab === "history"
                        ? "历史提问"
                        : sidePanelTab === "changes"
                          ? "变更"
                          : "产物"}
                    </span>
                  </div>
                </div>

                <div className="chat-topic-panel__tabs">
                  <button
                    type="button"
                    className={`chat-topic-panel__tab ${sidePanelTab === "artifacts" ? "chat-topic-panel__tab--active" : ""}`}
                    onClick={() => setSidePanelTab("artifacts")}
                  >
                    产物
                    {artifactCount > 0 ? (
                      <span className="chat-topic-panel__tab-badge">
                        {artifactCount > 99 ? "99+" : artifactCount}
                      </span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    className={`chat-topic-panel__tab ${sidePanelTab === "changes" ? "chat-topic-panel__tab--active" : ""} ${activeProject?.workspacePath ? "" : "chat-topic-panel__tab--disabled"}`}
                    onClick={() =>
                      activeProject?.workspacePath && setSidePanelTab("changes")
                    }
                  >
                    <GitBranch size={11} strokeWidth={2} />
                    <span>变更</span>
                  </button>
                  <button
                    type="button"
                    className={`chat-topic-panel__tab ${sidePanelTab === "history" ? "chat-topic-panel__tab--active" : ""}`}
                    onClick={() => setSidePanelTab("history")}
                  >
                    <Clock size={11} strokeWidth={2} />
                    <span>历史提问</span>
                  </button>
                </div>

                {sidePanelTab === "history" &&
                  (() => {
                    const userQuestions = messages
                      .map((message, index) => ({ message, index }))
                      .filter(({ message }) => message.role === "user");
                    const handleJumpToQuestion = (messageIndex: number) => {
                      const target = document.querySelector(
                        `[data-message-index="${messageIndex}"]`,
                      );
                      if (!(target instanceof HTMLElement)) return;
                      target.scrollIntoView({
                        behavior: "smooth",
                        block: "center",
                      });
                      target.classList.add("chat-message--pulse-highlight");
                      window.setTimeout(() => {
                        target.classList.remove(
                          "chat-message--pulse-highlight",
                        );
                      }, 1600);
                    };
                    return (
                      <>
                        <div className="chat-topic-panel__section">
                          <div className="chat-topic-panel__section-title">
                            <Clock size={13} strokeWidth={2} />
                            <span>本次会话提问</span>
                            <span className="chat-topic-panel__section-count">
                              {userQuestions.length}
                            </span>
                          </div>
                          {userQuestions.length === 0 ? (
                            <div className="chat-topic-panel__empty">
                              {activeChatId
                                ? "本次会话还没有提问"
                                : "请先选择或新建会话"}
                            </div>
                          ) : (
                            <div className="chat-topic-panel__list">
                              {userQuestions.map(
                                ({ message, index }, order) => (
                                  <button
                                    key={`${index}-${order}`}
                                    type="button"
                                    className="chat-topic-panel__item chat-topic-panel__item--question"
                                    onClick={() => handleJumpToQuestion(index)}
                                    title={message.content}
                                  >
                                    <MessageSquare
                                      size={13}
                                      strokeWidth={1.9}
                                      className="chat-topic-panel__item-icon"
                                    />
                                    <span className="chat-topic-panel__item-copy">
                                      <span className="chat-topic-panel__item-title">
                                        {truncateQuestionPreview(
                                          message.content,
                                        )}
                                      </span>
                                    </span>
                                  </button>
                                ),
                              )}
                            </div>
                          )}
                        </div>
                      </>
                    );
                  })()}

                {sidePanelTab === "artifacts" ? (
                  <ArtifactsPanel
                    projectId={activeProject?.id ?? null}
                    sessionId={activeProject ? null : activeChatId}
                    onJumpToSession={onSelectChat}
                  />
                ) : null}

                {sidePanelTab === "changes" && activeProject?.workspacePath ? (
                  <ChangesPanel workspacePath={activeProject.workspacePath} />
                ) : null}

              </div>
            </aside>
        </div>
      </section>

      <CreateProjectDialog
        open={createProjectDialogOpen}
        onClose={() => setCreateProjectDialogOpen(false)}
        onCreate={handleCreateProjectFromDialog}
      />
    </div>
  );
}
