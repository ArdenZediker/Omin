import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { CSSProperties, Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import { useLayoutEffect } from "react";
import {
  ArrowDown,
  ArrowRight,
  Bot,
  Cable,
  Check,
  GripVertical,
  Compass,
  Cpu,
  FolderOpen,
  History,
  LayoutDashboard,
  LayoutTemplate,
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
  Puzzle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Search,
  Settings,
  Share2,
  Sparkles,
  Star,
  Trash2,
  Wand2,
} from "lucide-react";
import type { Message } from "../adapters/types";
import type { ModelConfig } from "../adapters/types";
import { formatUsageLabel } from "../chat/storage";
import type { KnowledgeCollection } from "../chat/knowledgeTypes";
import type { ProjectDraft, ProjectMemoryRecord, ProjectMemorySourceType, Project, ChatSendOptions, ChatSession } from "../chat/types";
import type { ProjectMemoryScope } from "../chat/types";
import type { TaskExecutionResult } from "../chat/taskTypes";
import type { TaskRuntimeState } from "../chat/taskTypes";
import { RECOMMENDED_PROJECT_PRESETS } from "../config/manifests/projects";
import { AVATAR_CATEGORIES, AVATAR_PRESETS } from "../config/manifests/avatars";
import { filterAvatarPresets, getEmojiAssetSrc, resolveProjectAvatarSeed, resolveEmojiAvatarCode } from "../config/manifests/avatarHelpers";
import { ALWAYS_ALLOWED_LOCAL_TOOL_IDS, PROJECT_TOOL_OPTIONS, TOOLSET_MANIFESTS } from "../config/manifests/tools";
import { pluginRegistry } from "../plugins/registry";
import type { AvatarCategoryManifest } from "../config/manifests/types";
import { readSqliteBackedValue, saveSqliteBackedValue } from "../app/sqliteStorage";
import ChatInput from "./ChatInput";
import ChatMessage from "./ChatMessage";
import CreateProjectDialog from "./CreateProjectDialog";
import ModelSelector from "./ModelSelector";
import OmniSelect from "./ui/OmniSelect";
import OmniSwitch from "./ui/OmniSwitch";
import PluginMarketplace from "./plugins/PluginMarketplace";
import type { PluginKind } from "../plugins/types";
import { useCallback } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  PROJECT_GROUPS_STORAGE_KEY,
  readProjectGroupsStorageValue,
  DEFAULT_PROJECT_GROUP_LABEL,
  DEFAULT_TOPIC_PANEL_WIDTH,
  EMPTY_CHAT_GUIDE_COMPACT_STORAGE_KEY,
  MAIN_LAYOUT_TOPIC_WIDTH_STORAGE_KEY,
  MAX_TOPIC_PANEL_WIDTH,
  MIN_TOPIC_PANEL_WIDTH,
  buildTaskAggregateSummary,
  clampPanelWidth,
  enhancePresetPromptIfNeeded,
  findPresetMetaByProject,
  formatMemoryScopeLabel,
  getMemorySourceTypeLabel,
  normalizeSearchText,
  readStoredPanelWidth,
  renderProjectAvatar,
  renderTopicGroupLabel,
} from "./mainChatViewUtils";

type SessionGroup = {
  label: string;
  sessions: ChatSession[];
};

type TopicGroupingMode = "time" | "flat";
type SidePanelTab = "topics" | "tasks";

type TopicDeleteConfirmState = {
  title: string;
  message: string;
  sessions: ChatSession[];
} | null;

type ProjectDeleteConfirmState = {
  projectId: string;
  title: string;
  message: string;
} | null;

type ProjectNoticeState = {
  tone: "success" | "error";
  message: string;
} | null;

type ProjectDisplayGroup = {
  label: string;
  projects: Project[];
};

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
  hasModels: boolean;
  inputDraft: string;
  inputDraftImages: string[];
  inputDraftKey: number;
  inputFocusKey: number;
  inputDraftScopeKey: string;
  executionModel: string;
  isLoading: boolean;
  isSendBlocked?: boolean;
  isStreaming: boolean;
  relatedContext: {
    summaries: Array<{ sessionId: string; title: string; summary: string }>;
    memories: Array<{ id: string; content: string; sourceSessionId?: string | null }>;
  };
  projectMemories: ProjectMemoryRecord[];
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
  onCreateCustomProject: (input?: {
    sourcePresetId?: string | null;
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
  onAddProjectMemory: (projectId: string, content: string, sourceSessionId?: string | null, sourceType?: ProjectMemorySourceType) => boolean;
  onClearProjectMemories: (projectId: string) => number;
  onDeleteProject: (projectId: string) => boolean | Promise<boolean>;
  onDeleteProjectMemory: (memoryId: string) => boolean;
  onUpdateProjectMemory: (memoryId: string, content: string) => boolean;
  onDeleteChat: (session: ChatSession) => void;
  onDraftChange: (text: string, images: string[]) => void;
  onEditUserMessage: (messageIndex: number) => void;
  onModelChange: (modelId: string) => void;
  onNewChat: () => void;
  onRegenerateMessage: (messageIndex: number) => void | Promise<void>;
  onRenameChat: (session: ChatSession) => void;
  onSelectProject: (projectId: string) => void;
  onSelectChat: (sessionId: string) => void;
  onUpdateProject: (projectId: string, patch: Partial<Project>) => Project | null;
  onSend: (content: string, images?: string[], options?: ChatSendOptions) => void | Promise<void>;
  onSetOpenChatMenu: Dispatch<SetStateAction<{ id: string; x: number; y: number } | null>>;
  onSettingsOpen: () => void;
  onShareChat: (session: ChatSession) => void | Promise<void>;
  onStop: () => void;
  onSubmitEditedUserMessage: (messageIndex: number, content: string) => void | Promise<void>;
  onToggleFavoriteChat: (session: ChatSession) => void;
  onTogglePinChat: (session: ChatSession) => void;
  onUseEmptyPrompt: (prompt: string) => void;
  onOpenKnowledge: () => void;
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
  groupedChatSessions,
  hasModels,
  inputDraft,
  inputDraftImages,
  inputDraftKey,
  inputFocusKey,
  inputDraftScopeKey,
  executionModel,
  isLoading,
  isSendBlocked = false,
  isStreaming,
  relatedContext,
  projectMemories,
  latestTaskResult,
  taskRuntimeState,
  messages,
  messagesScrollRef,
  omniIconSrc,
  windowControls,
  onCancelEditUserMessage,
  onClearChat,
  onCopyMessage,
  onCreateCustomProject,
  onAddProjectMemory,
  onClearProjectMemories,
  onDeleteProject,
  onDeleteProjectMemory,
  onUpdateProjectMemory,
  onDeleteChat,
  onDraftChange,
  onEditUserMessage,
  onModelChange,
  onNewChat,
  onRenameChat,
  onRegenerateMessage,
  onSelectProject,
  onSelectChat,
  onUpdateProject,
  onSend,
  onSettingsOpen,
  onShareChat,
  onStop,
  onSubmitEditedUserMessage,
  onToggleFavoriteChat,
  onTogglePinChat,
  onUseEmptyPrompt,
  onOpenKnowledge,
}: MainChatViewProps) {
  const [workspaceElement, setWorkspaceElement] = useState<HTMLElement | null>(null);
  const [composerElement, setComposerElement] = useState<HTMLDivElement | null>(null);
  const [isTopicPanelAutoCollapsed, setIsTopicPanelAutoCollapsed] = useState(false);
  const [topicPanelManualVisible, setTopicPanelManualVisible] = useState<boolean | null>(null);
  const [isProjectPanelAutoCollapsed, setIsProjectPanelAutoCollapsed] = useState(false);
  const [projectPanelManualVisible, setProjectPanelManualVisible] = useState<boolean | null>(null);
  const [composerHeight, setComposerHeight] = useState(0);
  const [composerResizeHeight, setComposerResizeHeight] = useState<number | null>(null);
  const composerSplitterDraggingRef = useRef(false);
  const composerSplitterStartYRef = useRef(0);
  const composerSplitterStartHeightRef = useRef(0);
  const [topicSearchOpen, setTopicSearchOpen] = useState(false);
  const [topicSearchQuery, setTopicSearchQuery] = useState("");
  const [topicMenuOpen, setTopicMenuOpen] = useState(false);
  const [topicGroupingMode, setTopicGroupingMode] = useState<TopicGroupingMode>("flat");
  const [sidePanelTab, setSidePanelTab] = useState<SidePanelTab>("topics");
  const [showPluginMarketplace, setShowPluginMarketplace] = useState(false);
  const [marketplaceFilter, setMarketplaceFilter] = useState<{ kind: PluginKind | "all"; category: string }>({ kind: "all", category: "全部" });
  const [topicDeleteConfirm, setTopicDeleteConfirm] = useState<TopicDeleteConfirmState>(null);
  const [projectDeleteConfirm, setProjectDeleteConfirm] = useState<ProjectDeleteConfirmState>(null);
  const [projectSearchQuery, setProjectSearchQuery] = useState("");
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [createProjectDialogOpen, setCreateProjectDialogOpen] = useState(false);
  const [projectGroupManagerOpen, setProjectGroupManagerOpen] = useState(false);
  const [projectGroupCreateMode, setProjectGroupCreateMode] = useState(false);
  const [projectGroupDraft, setProjectGroupDraft] = useState("");
  const [projectMoveGroupMenuId, setProjectMoveGroupMenuId] = useState<string | null>(null);
  const [projectMoveGroupMenuPosition, setProjectMoveGroupMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [topicPanelWidth, setTopicPanelWidth] = useState(() =>
    readStoredPanelWidth(MAIN_LAYOUT_TOPIC_WIDTH_STORAGE_KEY, DEFAULT_TOPIC_PANEL_WIDTH, MIN_TOPIC_PANEL_WIDTH, MAX_TOPIC_PANEL_WIDTH)
  );
  const [projectGroups, setProjectGroups] = useState<string[]>(() => {
    const saved = readProjectGroupsStorageValue();
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
  const [projectSettingsId, setProjectSettingsId] = useState<string | null>(null);
  const [editingProjectGroupName, setEditingProjectGroupName] = useState<string | null>(null);
  const [editingProjectGroupDraft, setEditingProjectGroupDraft] = useState("");
  const [projectAvatarPanelOpen, setProjectAvatarPanelOpen] = useState(false);
  const [projectAvatarSearchQuery, setProjectAvatarSearchQuery] = useState("");
  const [projectAvatarCategory, setProjectAvatarCategory] = useState("recent");
  const [projectNotice, setProjectNotice] = useState<ProjectNoticeState>(null);
  const [projectAgentsMd, setProjectAgentsMd] = useState("");
  const refreshProjectAgentsMd = useCallback(async () => {
    if (!activeProject?.workspacePath) {
      setProjectAgentsMd("");
      return;
    }
    try {
      const md = await invoke<string>("read_project_agents_md", { projectPath: activeProject.workspacePath });
      setProjectAgentsMd(md ?? "");
    } catch {
      setProjectAgentsMd("");
    }
  }, [activeProject?.workspacePath]);
  const [newMemoryDraft, setNewMemoryDraft] = useState("");
  const [memorySearchQuery, setMemorySearchQuery] = useState("");
  const [showAllMemories, setShowAllMemories] = useState(false);
  const [memoryClearConfirmOpen, setMemoryClearConfirmOpen] = useState(false);
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [editingMemoryDraft, setEditingMemoryDraft] = useState("");
  const [customProjectsCollapsed, setCustomProjectsCollapsed] = useState(false);
  const [openProjectCardMenuId, setOpenProjectCardMenuId] = useState<string | null>(null);
  const [topicItemMenuSessionId, setTopicItemMenuSessionId] = useState<string | null>(null);
  const [isTaskTraceExpanded, setIsTaskTraceExpanded] = useState(false);
  const topicSearchInputRef = useRef<HTMLInputElement | null>(null);
  const topicMenuRef = useRef<HTMLDivElement | null>(null);
  const topicMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const projectMenuRef = useRef<HTMLDivElement | null>(null);
  const projectCardMenuRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const projectMoveGroupMenuRef = useRef<HTMLDivElement | null>(null);
  const projectAvatarInputRef = useRef<HTMLInputElement | null>(null);
  const projectAvatarPanelRef = useRef<HTMLDivElement | null>(null);
  const projectAvatarTriggerRef = useRef<HTMLButtonElement | null>(null);
  const topicItemMenuRef = useRef<HTMLDivElement | null>(null);
  const topicItemActionRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const layoutDragRef = useRef<{
    startX: number;
    startWidth: number;
  } | null>(null);

  const recommendedPrompts = emptyChatPrompts.slice(0, 4);
  const [isEmptyGuideCompact, setIsEmptyGuideCompact] = useState(() => readSqliteBackedValue(EMPTY_CHAT_GUIDE_COMPACT_STORAGE_KEY) === "1");
  const updateEmptyGuideCompact = useCallback((nextCompact: boolean) => {
    setIsEmptyGuideCompact(nextCompact);
    saveSqliteBackedValue(EMPTY_CHAT_GUIDE_COMPACT_STORAGE_KEY, nextCompact ? "1" : "0");
  }, []);
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
  const currentTopicTitle = activeSession?.title || (activeProject?.kind === "basic" ? "Omni" : activeProject?.title) || "Omni";
  const defaultTopicPanelVisible = !isTopicPanelAutoCollapsed;
  const isTopicPanelVisible = topicPanelManualVisible ?? defaultTopicPanelVisible;
  const defaultProjectPanelVisible = !isProjectPanelAutoCollapsed;
  const isProjectPanelVisible = projectPanelManualVisible ?? defaultProjectPanelVisible;
  const basicProject = projects.find((project) => project.kind === "basic") ?? null;
  const customProjects = projects.filter((project) => project.kind === "custom");
  const projectGroupNames = useMemo(
    () =>
      Array.from(
        new Set([
          ...projectGroups,
          ...customProjects
            .map((project) => project.groupName?.trim())
            .filter((groupName): groupName is string => Boolean(groupName)),
        ])
      ).sort((a, b) => a.localeCompare(b, "zh-CN")),
    [projectGroups, customProjects]
  );
  const activeProjectAvatarSeed = resolveProjectAvatarSeed(projects, activeProject?.id ?? null);
  const activeProjectPresetMeta = findPresetMetaByProject(activeProject);
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

  const MIN_COMPOSER_RESIZE_HEIGHT = 120;
  const MAX_COMPOSER_RESIZE_HEIGHT = 520;

  const handleComposerSplitterPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = composerElement?.getBoundingClientRect();
    composerSplitterDraggingRef.current = true;
    composerSplitterStartYRef.current = event.clientY;
    composerSplitterStartHeightRef.current = rect?.height ?? composerHeight;
  }, [composerElement, composerHeight]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (!composerSplitterDraggingRef.current) return;
      const delta = event.clientY - composerSplitterStartYRef.current;
      const nextHeight = Math.min(
        Math.max(composerSplitterStartHeightRef.current + delta, MIN_COMPOSER_RESIZE_HEIGHT),
        MAX_COMPOSER_RESIZE_HEIGHT
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
    () => [...ALWAYS_ALLOWED_LOCAL_TOOL_IDS, ...(activeProject?.allowedToolIds ?? [])],
    [activeProject?.allowedToolIds]
  );
  const allowedComposerSkillIds = activeProject?.allowedSkillIds ?? [];
  const activeMemoryScopeLabel = formatMemoryScopeLabel(activeProject?.memoryScope ?? "project");
  const showContextRecallBanner = messages.length === 0 && (relatedContext.memories.length > 0 || relatedContext.summaries.length > 0);
  const [isContextRecallBannerDismissed, setIsContextRecallBannerDismissed] = useState(false);
  const hasVisibleContextRecallBanner = showContextRecallBanner && !isContextRecallBannerDismissed;
  const useCompactEmptyGuideLayout = isEmptyGuideCompact && !hasVisibleContextRecallBanner;
  const taskAggregateSummary = latestTaskResult ? buildTaskAggregateSummary(latestTaskResult) : null;
  const showTaskPanel = sidePanelTab === "tasks";
  const composerContextPresetText = useMemo(() => "", []);
  const normalizedProjectSearchQuery = normalizeSearchText(projectSearchQuery);
  const isBasicProjectVisible = Boolean(
    basicProject &&
      (!normalizedProjectSearchQuery ||
        normalizeSearchText(`${basicProject.title} ${basicProject.description}`).includes(normalizedProjectSearchQuery))
  );
  const filteredCustomProjects = customProjects.filter((project) => {
    if (!normalizedProjectSearchQuery) return true;
    return normalizeSearchText(`${project.title} ${project.description}`).includes(normalizedProjectSearchQuery);
  });
  const groupedCustomProjects = useMemo<ProjectDisplayGroup[]>(() => {
    const grouped = new Map<string, Project[]>();
    filteredCustomProjects.forEach((project) => {
      const label = project.groupName?.trim() || DEFAULT_PROJECT_GROUP_LABEL;
      const list = grouped.get(label) ?? [];
      list.push(project);
      grouped.set(label, list);
    });

    return Array.from(grouped.entries())
      .sort(([labelA], [labelB]) => {
        if (labelA === DEFAULT_PROJECT_GROUP_LABEL) return -1;
        if (labelB === DEFAULT_PROJECT_GROUP_LABEL) return 1;
        return labelA.localeCompare(labelB, "zh-CN");
      })
      .map(([label, nextProjects]) => ({ label, projects: nextProjects }));
  }, [filteredCustomProjects]);
  const defaultProjectGroup = useMemo(
    () => groupedCustomProjects.find((group) => group.label === DEFAULT_PROJECT_GROUP_LABEL) ?? { label: DEFAULT_PROJECT_GROUP_LABEL, projects: [] },
    [groupedCustomProjects]
  );
  const namedProjectGroups = useMemo(
    () => groupedCustomProjects.filter((group) => group.label !== DEFAULT_PROJECT_GROUP_LABEL),
    [groupedCustomProjects]
  );
  const topicTitleById = useMemo(() => {
    const entries = groupedChatSessions.flatMap((group) => group.sessions.map((session) => [session.id, session.title] as const));
    return new Map(entries);
  }, [groupedChatSessions]);
  const normalizedMemorySearchQuery = normalizeSearchText(memorySearchQuery);
  const filteredProjectMemories = useMemo(() => {
    if (!normalizedMemorySearchQuery) {
      return projectMemories;
    }

    return projectMemories.filter((memory) => {
      const sourceTitle = memory.sourceSessionId ? topicTitleById.get(memory.sourceSessionId) ?? "" : "";
      return normalizeSearchText(`${memory.content} ${sourceTitle} ${getMemorySourceTypeLabel(memory.sourceType)}`).includes(normalizedMemorySearchQuery);
    });
  }, [projectMemories, normalizedMemorySearchQuery, topicTitleById]);
  const visibleProjectMemories = showAllMemories ? filteredProjectMemories : filteredProjectMemories.slice(0, 12);
  const filteredProjectAvatars = filterAvatarPresets(AVATAR_PRESETS, projectAvatarCategory, projectAvatarSearchQuery);
  const isProjectSettingsMode = Boolean(projectSettingsId && activeProject);
  const isCustomProjectSettingsMode = Boolean(isProjectSettingsMode && activeProject?.kind === "custom");
  useEffect(() => {
    if (isProjectSettingsMode) void refreshProjectAgentsMd();
  }, [isProjectSettingsMode, refreshProjectAgentsMd]);
  const [projectTitleDraft, setProjectTitleDraft] = useState(activeProject?.title ?? "");
  const [projectDescriptionDraft, setProjectDescriptionDraft] = useState(activeProject?.description ?? "");
  const [projectPromptDraft, setProjectPromptDraft] = useState(activeProject?.systemPrompt ?? "");
  const [projectModelDraft, setProjectModelDraft] = useState(activeProject?.defaultModelId ?? "");
  const [knowledgeCollections, setKnowledgeCollections] = useState<KnowledgeCollection[]>([]);
  const [isMessagesAtBottom, setIsMessagesAtBottom] = useState(true);
  const isMessagesAtBottomRef = useRef(true);
  const lastAutoScrolledSessionRef = useRef<string | null>(null);
  const selectedExecutionModel = availableModels.find((model) => model.id === executionModel) ?? null;
  const selectedProjectModel = availableModels.find((model) => model.id === projectModelDraft) ?? null;
  const selectedProjectKnowledgeCollection = knowledgeCollections.find((collection) => collection.id === activeProject?.knowledgeCollectionId) ?? null;
  const showProjectNotice = useCallback((message: string, tone: "success" | "error" = "success") => {
    setProjectNotice({ tone, message });
  }, []);
  const saveProjectPatch = useCallback(
    (patch: Partial<Project>, message: string) => {
      if (!activeProject) return null;
      const updated = onUpdateProject(activeProject.id, patch);
      showProjectNotice(updated ? message : "保存失败，请稍后重试", updated ? "success" : "error");
      return updated;
    },
    [activeProject, onUpdateProject, showProjectNotice]
  );
  const handleCreateProject = useCallback(() => {
    setCreateProjectDialogOpen(true);
  }, []);

  const handleCreateProjectFromDialog = useCallback(
    (draft: ProjectDraft) => {
      const created = onCreateCustomProject(draft);
      if (created && created.id) {
        showProjectNotice("项目已创建，可在项目设置中完善信息");
        setProjectSettingsId(created.id);
      }
    },
    [onCreateCustomProject, showProjectNotice]
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
    [onCopyMessage, showProjectNotice]
  );
  const startEditMemory = useCallback((memory: ProjectMemoryRecord) => {
    setEditingMemoryId(memory.id);
    setEditingMemoryDraft(memory.content);
  }, []);
  const cancelEditMemory = useCallback(() => {
    setEditingMemoryId(null);
    setEditingMemoryDraft("");
  }, []);
  const saveEditingMemory = useCallback(() => {
    if (!editingMemoryId) return;
    const updated = onUpdateProjectMemory(editingMemoryId, editingMemoryDraft);
    showProjectNotice(updated ? "记忆已更新" : "记忆更新失败", updated ? "success" : "error");
    if (updated) {
      cancelEditMemory();
    }
  }, [cancelEditMemory, editingMemoryDraft, editingMemoryId, onUpdateProjectMemory, showProjectNotice]);
  const addManualMemory = useCallback(() => {
    if (!activeProject) return;
    const added = onAddProjectMemory(activeProject.id, newMemoryDraft, activeChatId, "manual");
    showProjectNotice(added ? "记忆已添加" : "记忆已存在或内容太短", added ? "success" : "error");
    if (added) {
      setNewMemoryDraft("");
    }
  }, [activeProject, activeChatId, newMemoryDraft, onAddProjectMemory, showProjectNotice]);
  const openMemorySourceSession = useCallback(
    (sessionId: string | null | undefined) => {
      if (!sessionId || !topicTitleById.has(sessionId)) {
        showProjectNotice("来源会话已删除或不可用", "error");
        return;
      }

      onSelectChat(sessionId);
      setProjectSettingsId(null);
      setMemorySearchQuery("");
      setShowAllMemories(false);
      showProjectNotice("已打开记忆来源会话");
    },
    [onSelectChat, showProjectNotice, topicTitleById]
  );
  const clearCurrentProjectMemories = useCallback(() => {
    if (!activeProject) return;
    const removedCount = onClearProjectMemories(activeProject.id);
    setMemoryClearConfirmOpen(false);
    setEditingMemoryId(null);
    setEditingMemoryDraft("");
    showProjectNotice(removedCount > 0 ? `已清空 ${removedCount} 条记忆` : "当前没有可清空的记忆", removedCount > 0 ? "success" : "error");
  }, [activeProject, onClearProjectMemories, showProjectNotice]);
  const layoutClassName = useMemo(() => {
    const classNames = ["main-chat-layout"];
    if (projectPanelManualVisible === true) classNames.push("main-chat-layout--project-forced-open");
    if (!isProjectPanelVisible) classNames.push("main-chat-layout--project-collapsed");
    if (topicPanelManualVisible === true) classNames.push("main-chat-layout--topic-forced-open");
    if (!isTopicPanelVisible || showPluginMarketplace) classNames.push("main-chat-layout--topic-collapsed");
    if (isProjectSettingsMode) classNames.push("main-chat-layout--project-settings");
    return classNames.join(" ");
  }, [projectPanelManualVisible, isProjectPanelVisible, isProjectSettingsMode, isTopicPanelVisible, topicPanelManualVisible, showPluginMarketplace]);
  const layoutStyle = useMemo<CSSProperties>(
    () =>
      ({
        "--topic-panel-width": `${topicPanelWidth}px`,
      }) as CSSProperties,
    [topicPanelWidth]
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

    void invoke<{ collections: KnowledgeCollection[] }>("load_knowledge_library_command")
      .then((payload) => {
        if (!cancelled) {
          setKnowledgeCollections(Array.isArray(payload.collections) ? payload.collections : []);
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
      const nextHeight = Math.max(0, Math.round(composerElement.getBoundingClientRect().height || 0));
      setComposerHeight((current) => (current === nextHeight ? current : nextHeight));

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
      const distanceToBottom = scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight;
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
    scrollElement.scrollTo({ top: scrollElement.scrollHeight, behavior: "smooth" });
  }, [isMessagesAtBottom, isStreaming, messages, messagesScrollRef]);

  const scrollMessagesToBottom = useCallback(() => {
    const scrollElement = messagesScrollRef.current;
    scrollElement?.scrollTo({ top: scrollElement.scrollHeight, behavior: "smooth" });
  }, [messagesScrollRef]);

  useEffect(() => {
    setProjectTitleDraft(activeProject?.title ?? "");
    setProjectDescriptionDraft(activeProject?.description ?? "");
    setProjectPromptDraft(activeProject?.systemPrompt ?? "");
    setProjectModelDraft(activeProject?.defaultModelId ?? "");
    setMemorySearchQuery("");
    setShowAllMemories(false);
    setMemoryClearConfirmOpen(false);
    setEditingMemoryId(null);
    setEditingMemoryDraft("");
  }, [activeProject]);

  useEffect(() => {
    saveSqliteBackedValue(PROJECT_GROUPS_STORAGE_KEY, JSON.stringify(projectGroups));
  }, [projectGroups]);

  useEffect(() => {
    if (!workspaceElement) return;

    const topicCollapseThreshold = 1080;
    const topicExpandThreshold = 1160;
    const projectCollapseThreshold = 980;
    const projectExpandThreshold = 1040;

    const updateAutoCollapsed = () => {
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || workspaceElement.getBoundingClientRect().width || 0;

      setIsTopicPanelAutoCollapsed((current) => {
        const next = current ? viewportWidth < topicExpandThreshold : viewportWidth < topicCollapseThreshold;
        return next;
      });

      setIsProjectPanelAutoCollapsed((current) => {
        const next = current ? viewportWidth < projectExpandThreshold : viewportWidth < projectCollapseThreshold;
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
      if (projectMoveGroupMenuRef.current?.contains(target)) return;
      setOpenProjectCardMenuId(null);
      setProjectDeleteConfirm(null);
      setProjectMoveGroupMenuId(null);
      setProjectMoveGroupMenuPosition(null);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [openProjectCardMenuId]);

  useEffect(() => {
    if (!topicItemMenuSessionId) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (topicItemMenuRef.current?.contains(target)) return;
      const trigger = topicItemActionRefs.current[topicItemMenuSessionId];
      if (trigger?.contains(target)) return;
      setTopicItemMenuSessionId(null);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [topicItemMenuSessionId]);

  useEffect(() => {
    if (!projectAvatarPanelOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (projectAvatarPanelRef.current?.contains(target)) return;
      if (projectAvatarTriggerRef.current?.contains(target)) return;
      setProjectAvatarPanelOpen(false);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [projectAvatarPanelOpen]);

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

  const handleCreateProjectGroup = () => {
    const nextGroupName = projectGroupDraft.trim();
    if (!nextGroupName) {
      return;
    }
    const exists = projectGroupNames.some((groupName) => groupName === nextGroupName);
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
    setProjectGroups((current) => current.map((item) => (item === groupName ? nextGroupName : item)));
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
    if (projectSettingsId === projectDeleteConfirm.projectId) {
      setProjectSettingsId(null);
      setProjectAvatarPanelOpen(false);
    }
    setProjectDeleteConfirm(null);
    setOpenProjectCardMenuId(null);
  };

  const renderTopicItemActionMenu = (session: ChatSession) => (
    <span
      ref={(node) => {
        topicItemActionRefs.current[session.id] = node;
      }}
      className={`chat-topic-panel__pin chat-topic-panel__pin--menu ${topicItemMenuSessionId === session.id ? "chat-topic-panel__pin--menu-open" : ""}`}
      title="更多操作"
      aria-label="更多操作"
      role="button"
      tabIndex={0}
      onClick={(event) => {
        event.stopPropagation();
        setTopicItemMenuSessionId((current) => (current === session.id ? null : session.id));
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setTopicItemMenuSessionId(null);
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          setTopicItemMenuSessionId((current) => (current === session.id ? null : session.id));
        }
      }}
    >
      <MoreHorizontal size={12} strokeWidth={2} />
      {topicItemMenuSessionId === session.id && (
        <div
          ref={topicItemMenuRef}
          className="chat-topic-panel__item-menu"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <span
            className="chat-topic-panel__item-menu-action"
            role="button"
            tabIndex={0}
            onClick={(event) => {
              event.stopPropagation();
              onTogglePinChat(session);
              setTopicItemMenuSessionId(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                onTogglePinChat(session);
                setTopicItemMenuSessionId(null);
              }
            }}
          >
            <Pin size={12} strokeWidth={2} />
            <span>{session.pinned ? "取消置顶" : "置顶话题"}</span>
          </span>
          <span
            className="chat-topic-panel__item-menu-action"
            role="button"
            tabIndex={0}
            onClick={(event) => {
              event.stopPropagation();
              onToggleFavoriteChat(session);
              setTopicItemMenuSessionId(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                onToggleFavoriteChat(session);
                setTopicItemMenuSessionId(null);
              }
            }}
          >
            <Star size={12} strokeWidth={2} fill={session.favorite ? "currentColor" : "none"} />
            <span>{session.favorite ? "取消收藏" : "收藏话题"}</span>
          </span>
          <span
            className="chat-topic-panel__item-menu-action"
            role="button"
            tabIndex={0}
            onClick={(event) => {
              event.stopPropagation();
              onRenameChat(session);
              setTopicItemMenuSessionId(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                onRenameChat(session);
                setTopicItemMenuSessionId(null);
              }
            }}
          >
            <Pencil size={12} strokeWidth={2} />
            <span>重命名话题</span>
          </span>
          <span
            className="chat-topic-panel__item-menu-action chat-topic-panel__item-menu-action--danger"
            role="button"
            tabIndex={0}
            onClick={(event) => {
              event.stopPropagation();
              onDeleteChat(session);
              setTopicItemMenuSessionId(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                onDeleteChat(session);
                setTopicItemMenuSessionId(null);
              }
            }}
          >
            <Trash2 size={12} strokeWidth={2} />
            <span>删除话题</span>
          </span>
        </div>
      )}
    </span>
  );


  return (
    <div className={layoutClassName} style={layoutStyle}>
      <aside className="main-chat-nav">
        <button type="button" className="main-chat-nav__brand no-drag" title="Omni">
          <Bot size={20} strokeWidth={1.9} />
        </button>
        <div className="main-chat-nav__items">
          <button
            type="button"
            className={`main-chat-nav__item no-drag ${!showPluginMarketplace ? "main-chat-nav__item--active" : ""}`}
            title="聊天"
            onClick={() => setShowPluginMarketplace(false)}
          >
            <MessageSquare size={18} strokeWidth={1.9} />
          </button>
          <button
            type="button"
            className={`main-chat-nav__item no-drag ${showPluginMarketplace ? "main-chat-nav__item--active" : ""}`}
            title="插件广场"
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

        {showPluginMarketplace ? (
          <div className="chat-history-panel__marketplace-nav">
            <div className="chat-history-panel__marketplace-nav-header">
              <span>插件广场</span>
              <button type="button" onClick={() => setShowPluginMarketplace(false)} title="返回项目">
                <ChevronLeft size={16} strokeWidth={1.8} />
              </button>
            </div>
            <div className="chat-history-panel__marketplace-kind-list">
              {[
                { kind: "all" as const, label: "全部", icon: Puzzle },
                { kind: "skill" as const, label: "技能", icon: Wand2 },
                { kind: "tool" as const, label: "工具", icon: Puzzle },
                { kind: "connector" as const, label: "连接器", icon: Cable },
                { kind: "expert" as const, label: "专家", icon: Bot },
                { kind: "template" as const, label: "模板", icon: LayoutTemplate },
              ].map((item) => (
                <button
                  key={item.kind}
                  type="button"
                  className={`chat-history-panel__marketplace-kind ${marketplaceFilter.kind === item.kind ? "chat-history-panel__marketplace-kind--active" : ""}`}
                  onClick={() => setMarketplaceFilter((current) => ({ ...current, kind: item.kind, category: "全部" }))}
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
          {isBasicProjectVisible && basicProject && (
            <div className="chat-history-panel__project-section">
              <button
                type="button"
                className={`chat-history-panel__project ${activeProjectId === basicProject.id ? "chat-history-panel__project--active" : ""}`}
                onClick={() => {
                  setProjectSettingsId(null);
                  setProjectAvatarPanelOpen(false);
                  onSelectProject(basicProject.id);
                }}
              >
                <span className="chat-history-panel__project-icon">
                  {renderProjectAvatar(basicProject)}
                </span>
                <span className="chat-history-panel__project-copy">
                  <strong>{basicProject.title}</strong>
                </span>
                <span
                  className="chat-history-panel__project-menu"
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <button
                    type="button"
                    className="chat-history-panel__project-action"
                    title="记忆管理"
                    aria-label="打开 Omni 记忆管理"
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelectProject(basicProject.id);
                      setProjectSettingsId(basicProject.id);
                    }}
                  >
                    <Settings size={13} strokeWidth={1.9} />
                  </button>
                </span>
              </button>
            </div>
          )}

            <div className="chat-history-panel__project-section">
              <div className="chat-history-panel__project-group-header">
                <div className="chat-history-panel__project-group-label">{DEFAULT_PROJECT_GROUP_LABEL}</div>
                <div className="chat-history-panel__section-actions">
                  <div ref={projectMenuRef} className="chat-history-panel__section-menu">
                    <button
                      type="button"
                      className={`chat-history-panel__section-action ${projectMenuOpen ? "chat-history-panel__section-action--active" : ""}`}
                      onClick={() => setProjectMenuOpen((current) => !current)}
                      title="项目菜单"
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
                          <span>新建项目</span>
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
                    className={`chat-history-panel__section-action ${customProjectsCollapsed ? "" : "chat-history-panel__section-action--active"}`}
                    onClick={() => setCustomProjectsCollapsed((current) => !current)}
                    title={customProjectsCollapsed ? "展开列表" : "收起列表"}
                  >
                    {customProjectsCollapsed ? <ChevronRight size={14} strokeWidth={1.8} /> : <ChevronDown size={14} strokeWidth={1.8} />}
                  </button>
                </div>
              </div>
              {!customProjectsCollapsed && <div className="chat-history-panel__project-list">
                <div className="chat-history-panel__project-group">
                  {defaultProjectGroup.projects.length === 0 ? (
                    <button
                      type="button"
                      className="chat-history-panel__project-create"
                      onClick={() => void handleCreateProject()}
                    >
                      <Plus size={14} strokeWidth={1.9} />
                      <span>新建项目</span>
                    </button>
                  ) : (
                    defaultProjectGroup.projects.map((project, index) => (
                      <button
                        key={project.id}
                        type="button"
                        className={`chat-history-panel__project ${activeProjectId === project.id ? "chat-history-panel__project--active" : ""} ${openProjectCardMenuId === project.id ? "chat-history-panel__project--menu-open" : ""}`}
                        onClick={() => {
                          setProjectSettingsId(null);
                          setProjectAvatarPanelOpen(false);
                          onSelectProject(project.id);
                        }}
                      >
                        <span className="chat-history-panel__project-icon chat-history-panel__project-icon--custom">
                          {renderProjectAvatar(project, index)}
                        </span>
                        <span className="chat-history-panel__project-copy">
                          <strong>{project.title}</strong>
                        </span>
                        <span
                          ref={(node) => {
                            projectCardMenuRefs.current[project.id] = node;
                          }}
                          className="chat-history-panel__project-menu"
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
                              setOpenProjectCardMenuId((current) => (current === project.id ? null : project.id));
                            }}
                          >
                            <MoreHorizontal size={13} strokeWidth={1.9} />
                          </button>
                          {openProjectCardMenuId === project.id && (
                            <div className="chat-history-panel__project-dropdown">
                              {projectDeleteConfirm?.projectId === project.id ? (
                                <div className="chat-topic-panel__menu-confirm chat-history-panel__project-dropdown-confirm">
                                  <div className="chat-topic-panel__menu-confirm-title">{projectDeleteConfirm.title}</div>
                                  <div className="chat-topic-panel__menu-confirm-message">{projectDeleteConfirm.message}</div>
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
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setOpenProjectCardMenuId(null);
                                      onSelectProject(project.id);
                                      setProjectSettingsId(project.id);
                                    }}
                                  >
                                    <Settings size={13} strokeWidth={1.9} />
                                    <span>项目设置</span>
                                  </button>
                                  <div className="chat-history-panel__project-dropdown-divider" />
                                  <button
                                    type="button"
                                    className="chat-history-panel__project-dropdown-branch"
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
                                      setProjectMoveGroupMenuPosition({ top: nextTop, left: nextLeft });
                                      setProjectMoveGroupMenuId((current) => (current === project.id ? null : project.id));
                                    }}
                                  >
                                    <span className="chat-history-panel__project-dropdown-main">
                                      <FolderOpen size={13} strokeWidth={1.9} />
                                      <span>移动到分组</span>
                                    </span>
                                    <ChevronRight size={13} strokeWidth={1.9} />
                                  </button>
                                  <div className="chat-history-panel__project-dropdown-divider" />
                                  <button
                                    type="button"
                                    className="chat-history-panel__project-dropdown-danger"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setProjectDeleteConfirm({
                                        projectId: project.id,
                                        title: "删除项目",
                                        message: `确认删除“${project.title}”吗？相关话题和记忆会一并删除。`,
                                      });
                                    }}
                                  >
                                    <Trash2 size={13} strokeWidth={1.9} />
                                    <span>删除项目</span>
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
                {namedProjectGroups.length === 0 ? null : namedProjectGroups.map((group) => (
                  <div key={group.label} className="chat-history-panel__project-group">
                    <div className="chat-history-panel__project-group-label">{group.label}</div>
                    {group.projects.map((project, index) => (
                      <button
                        key={project.id}
                        type="button"
                        className={`chat-history-panel__project ${activeProjectId === project.id ? "chat-history-panel__project--active" : ""} ${openProjectCardMenuId === project.id ? "chat-history-panel__project--menu-open" : ""}`}
                        onClick={() => {
                          setProjectSettingsId(null);
                          setProjectAvatarPanelOpen(false);
                          onSelectProject(project.id);
                        }}
                      >
                        <span className="chat-history-panel__project-icon chat-history-panel__project-icon--custom">
                          {renderProjectAvatar(project, index)}
                        </span>
                        <span className="chat-history-panel__project-copy">
                          <strong>{project.title}</strong>
                        </span>
                        <span
                          ref={(node) => {
                            projectCardMenuRefs.current[project.id] = node;
                          }}
                          className="chat-history-panel__project-menu"
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
                              setOpenProjectCardMenuId((current) => (current === project.id ? null : project.id));
                            }}
                          >
                            <MoreHorizontal size={13} strokeWidth={1.9} />
                          </button>
                          {openProjectCardMenuId === project.id && (
                            <div className="chat-history-panel__project-dropdown">
                              {projectDeleteConfirm?.projectId === project.id ? (
                                <div className="chat-topic-panel__menu-confirm chat-history-panel__project-dropdown-confirm">
                                  <div className="chat-topic-panel__menu-confirm-title">{projectDeleteConfirm.title}</div>
                                  <div className="chat-topic-panel__menu-confirm-message">{projectDeleteConfirm.message}</div>
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
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setOpenProjectCardMenuId(null);
                                      onSelectProject(project.id);
                                      setProjectSettingsId(project.id);
                                    }}
                                  >
                                    <Settings size={13} strokeWidth={1.9} />
                                    <span>项目设置</span>
                                  </button>
                                  <div className="chat-history-panel__project-dropdown-divider" />
                                  <button
                                    type="button"
                                    className="chat-history-panel__project-dropdown-branch"
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
                                      setProjectMoveGroupMenuPosition({ top: nextTop, left: nextLeft });
                                      setProjectMoveGroupMenuId((current) => (current === project.id ? null : project.id));
                                    }}
                                  >
                                    <span className="chat-history-panel__project-dropdown-main">
                                      <FolderOpen size={13} strokeWidth={1.9} />
                                      <span>移动到分组</span>
                                    </span>
                                    <ChevronRight size={13} strokeWidth={1.9} />
                                  </button>
                                  <div className="chat-history-panel__project-dropdown-divider" />
                                  <button
                                    type="button"
                                    className="chat-history-panel__project-dropdown-danger"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setProjectDeleteConfirm({
                                        projectId: project.id,
                                        title: "删除项目",
                                        message: `确认删除“${project.title}”吗？相关话题和记忆会一并删除。`,
                                      });
                                    }}
                                  >
                                    <Trash2 size={13} strokeWidth={1.9} />
                                    <span>删除项目</span>
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
          </>
        )}
      </aside>

      {projectGroupManagerOpen && (
        <div
          className="omni-confirm-overlay"
          onClick={() => {
            setProjectGroupManagerOpen(false);
            setProjectGroupDraft("");
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
                  setProjectGroupManagerOpen(false);
                  setProjectGroupDraft("");
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
                    <span>{DEFAULT_PROJECT_GROUP_LABEL}</span>
                  </div>
                  <span className="chat-history-panel__group-manager-badge">系统</span>
                </div>
                {projectGroupNames.length === 0 ? (
                  <div className="chat-history-panel__group-manager-empty">还没有自定义分组</div>
                ) : (
                  projectGroupNames.map((groupName) => (
                    <div key={groupName} className="chat-history-panel__group-manager-item">
                      {editingProjectGroupName === groupName ? (
                        <>
                          <div className="chat-history-panel__group-manager-row">
                            <span className="chat-history-panel__group-manager-handle" aria-hidden="true">
                              <GripVertical size={14} strokeWidth={1.9} />
                            </span>
                            <input
                              className="chat-history-panel__group-manager-inline-input"
                              value={editingProjectGroupDraft}
                              onChange={(event) => setEditingProjectGroupDraft(event.target.value)}
                              onBlur={() => handleRenameProjectGroup(groupName)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  handleRenameProjectGroup(groupName);
                                }
                              }}
                              autoFocus
                            />
                          </div>
                          <div className="chat-history-panel__group-manager-actions">
                            <button type="button" onClick={() => handleRenameProjectGroup(groupName)}>
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
                                setEditingProjectGroupName(groupName);
                                setEditingProjectGroupDraft(groupName);
                              }}
                            >
                              <Pencil size={14} strokeWidth={1.9} />
                            </button>
                            <button type="button" onClick={() => handleDeleteProjectGroup(groupName)}>
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
              {projectGroupCreateMode ? (
                <div className="chat-history-panel__group-create chat-history-panel__group-create--dialog">
                  <input
                    value={projectGroupDraft}
                    onChange={(event) => setProjectGroupDraft(event.target.value)}
                    placeholder="添加新分组"
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        handleCreateProjectGroup();
                        setProjectGroupCreateMode(false);
                      }
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      handleCreateProjectGroup();
                      setProjectGroupCreateMode(false);
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
                  onClick={() => setProjectGroupCreateMode(true)}
                >
                  <Plus size={14} strokeWidth={1.9} />
                  <span>添加新分组</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {projectMoveGroupMenuId && projectMoveGroupMenuPosition && (
        <div
          ref={projectMoveGroupMenuRef}
          className="chat-history-panel__project-submenu chat-history-panel__project-submenu--floating"
          style={{
            top: projectMoveGroupMenuPosition.top,
            left: projectMoveGroupMenuPosition.left,
          }}
          onClick={(event) => event.stopPropagation()}
        >
          {[DEFAULT_PROJECT_GROUP_LABEL, ...projectGroupNames].map((groupName) => {
            const currentProject = customProjects.find((project) => project.id === projectMoveGroupMenuId);
            const currentGroupName = currentProject?.groupName?.trim() || DEFAULT_PROJECT_GROUP_LABEL;
            const isActive = currentGroupName === groupName;
            return (
            <button
              key={`${projectMoveGroupMenuId}-${groupName}-choice`}
              type="button"
              className={isActive ? "chat-history-panel__project-group-choice--active" : ""}
              onClick={(event) => {
                event.stopPropagation();
                onUpdateProject(projectMoveGroupMenuId, {
                  groupName: groupName === DEFAULT_PROJECT_GROUP_LABEL ? null : groupName,
                });
                setProjectMoveGroupMenuId(null);
                setProjectMoveGroupMenuPosition(null);
                setOpenProjectCardMenuId(null);
              }}
            >
              {isActive ? <Check size={13} strokeWidth={2.2} /> : <span className="chat-history-panel__project-group-choice-spacer" aria-hidden="true" />}
              <span>{groupName}</span>
              <span className="chat-history-panel__project-group-choice-tail" aria-hidden="true" />
            </button>
            );
          })}
          <div className="chat-history-panel__project-dropdown-divider" />
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setProjectMoveGroupMenuId(null);
              setProjectMoveGroupMenuPosition(null);
              setOpenProjectCardMenuId(null);
              setProjectGroupManagerOpen(true);
            }}
          >
            <span className="chat-history-panel__project-dropdown-main">
              <Plus size={13} strokeWidth={1.9} />
              <span>添加新分组</span>
            </span>
          </button>
        </div>
      )}

      <section className="main-chat-stage">
        {showPluginMarketplace && (
          <PluginMarketplace
            key={`marketplace-${marketplaceFilter.kind}-${marketplaceFilter.category}`}
            mainView
            initialFilter={marketplaceFilter}
            onClose={() => setShowPluginMarketplace(false)}
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
                {!isProjectSettingsMode && (
                  <button
                    type="button"
                    className="main-chat-toolbar__icon-button main-chat-toolbar__back-button no-drag"
                    aria-label={isProjectPanelVisible ? "收起项目栏" : "展开项目栏"}
                    title={isProjectPanelVisible ? "收起项目栏" : "展开项目栏"}
                    onClick={() =>
                      setProjectPanelManualVisible((currentValue) => {
                        const currentVisible = currentValue ?? defaultProjectPanelVisible;
                        const nextVisible = !currentVisible;
                        return nextVisible === defaultProjectPanelVisible ? null : nextVisible;
                      })
                    }
                  >
                    {isProjectPanelVisible ? (
                      <PanelLeftClose className="main-chat-toolbar__icon" strokeWidth={1.7} />
                    ) : (
                      <PanelLeftOpen className="main-chat-toolbar__icon" strokeWidth={1.7} />
                    )}
                  </button>
                )}
                {isProjectSettingsMode && (
                  <button
                    type="button"
                    className="main-chat-toolbar__icon-button main-chat-toolbar__back-button no-drag"
                    title="返回聊天"
                    onClick={() => {
                      setProjectSettingsId(null);
                      setProjectAvatarPanelOpen(false);
                    }}
                  >
                    <ChevronLeft className="main-chat-toolbar__icon" strokeWidth={1.8} />
                  </button>
                )}
                <div className="main-chat-toolbar__project-mark">
                  {renderProjectAvatar(activeProject, activeProjectAvatarSeed)}
                </div>
                <div className="main-chat-toolbar__project-copy main-chat-toolbar__project-copy--single-line">
                  <strong>{isProjectSettingsMode ? "项目设置" : currentTopicTitle}</strong>
                </div>
              </div>

              <div className="no-drag">
                <div className="main-chat-toolbar__model-stack">
                  <ModelSelector
                    currentModel={currentModel}
                    onModelChange={onModelChange}
                    label="主模型"
                    title={
                      selectedExecutionModel && executionModel !== currentModel
                        ? `当前项目会优先使用：${selectedExecutionModel.name}`
                        : undefined
                    }
                  />
                </div>
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
                onClick={() => void handleShareActiveSession()}
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
              <div className="omni-window-control-slot">{windowControls}</div>
            </div>
          </div>
        </header>

        <div className="main-chat-body">
          <section ref={setWorkspaceElement} className="main-chat-workspace" style={{ "--composer-height": `${composerHeight}px` } as CSSProperties}>
            <main className="main-chat-pane">
          {isProjectSettingsMode && activeProject ? (
            <div className="main-chat-scroll hide-scrollbar">
              <div className="omni-settings-dialog__sections omni-settings-dialog__sections--page">
                {isCustomProjectSettingsMode && (
                <>
                <div className="omni-settings-dialog__section">
                  <div className="omni-settings-dialog__section-title">项目信息</div>
                  <div className="omni-settings-dialog__project-overview">
                    <div className="omni-settings-dialog__project-form">
                      <div className="omni-settings-dialog__project-copy">
                        <div className="omni-settings-dialog__setting-label">基础信息</div>
                        <div className="omni-settings-dialog__setting-hint">名称、描述和角色设定会决定这个项目在聊天中的定位与表现。</div>
                      </div>
                      {activeProjectPresetMeta && (
                        <div className="omni-settings-dialog__preset-badge">
                          <span>来源预设</span>
                          <strong>{activeProjectPresetMeta.label}</strong>
                          <small>{activeProjectPresetMeta.hint}</small>
                        </div>
                      )}
                      <div className="omni-settings-dialog__project-side">
                        <div className="omni-settings-dialog__project-copy">
                          <div className="omni-settings-dialog__setting-label">项目头像</div>
                          <div className="omni-settings-dialog__setting-hint">头像会同步影响项目列表、当前项目头部和相关卡片展示。</div>
                        </div>
                        <div className="omni-settings-dialog__setting-control omni-settings-dialog__setting-control--avatar">
                          <button
                            ref={projectAvatarTriggerRef}
                            type="button"
                            className="omni-settings-dialog__avatar-hero"
                            onClick={() => setProjectAvatarPanelOpen((current) => !current)}
                            title="选择头像"
                          >
                            <span className="omni-settings-dialog__avatar-hero-preview">
                              {renderProjectAvatar(activeProject, activeProjectAvatarSeed)}
                            </span>
                            <span className="omni-settings-dialog__avatar-hero-copy">
                              <strong>点击更换头像</strong>
                              <span>{activeProject.avatarType === "image" ? "当前使用自定义图片" : "当前使用头像包图标"}</span>
                            </span>
                          </button>
                          {projectAvatarPanelOpen && (
                            <div ref={projectAvatarPanelRef} className="omni-settings-dialog__avatar-panel">
                              <div className="omni-settings-dialog__avatar-categories">
                                {AVATAR_CATEGORIES.map((category) => {
                                  const CategoryIcon = resolveAvatarCategoryIcon(category.icon);
                                  return (
                                  <button
                                    key={category.id}
                                    type="button"
                                    className={`omni-settings-dialog__avatar-category ${projectAvatarCategory === category.id ? "omni-settings-dialog__avatar-category--active" : ""}`}
                                    title={category.label}
                                    onClick={() => setProjectAvatarCategory(category.id)}
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
                                  value={projectAvatarSearchQuery}
                                  onChange={(event) => setProjectAvatarSearchQuery(event.target.value)}
                                  placeholder="搜索头像"
                                />
                              </div>
                              <div className="chat-history-panel__avatar-grid chat-history-panel__avatar-grid--detailed">
                              {filteredProjectAvatars.length > 0 ? (
                                filteredProjectAvatars.map((avatar) => (
                                    <button
                                      key={avatar.code}
                                      type="button"
                                      className={`chat-history-panel__avatar-option chat-history-panel__avatar-option--detailed chat-history-panel__avatar-option--tone-${avatar.tone} ${activeProject.avatarType !== "image" && resolveEmojiAvatarCode(activeProject.avatarValue) === avatar.code ? "chat-history-panel__avatar-option--active" : ""}`}
                                      onClick={() => {
                                      saveProjectPatch({
                                        sourcePresetId: avatar.code,
                                        avatarType: "emoji",
                                        avatarValue: `emoji:${avatar.code}`,
                                        systemPrompt: enhancePresetPromptIfNeeded(avatar.code, avatar.prompt),
                                        allowedToolIds: avatar.allowedToolIds ?? activeProject.allowedToolIds,
                                        allowedSkillIds: avatar.allowedSkillIds ?? activeProject.allowedSkillIds,
                                        defaultModelId: avatar.defaultModelId ?? activeProject.defaultModelId ?? null,
                                      }, "头像与预设已更新");
                                      setProjectPromptDraft(enhancePresetPromptIfNeeded(avatar.code, avatar.prompt));
                                        setProjectModelDraft(avatar.defaultModelId ?? activeProject.defaultModelId ?? "");
                                        setProjectAvatarPanelOpen(false);
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
                                onClick={() => projectAvatarInputRef.current?.click()}
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
                            value={projectTitleDraft}
                            onChange={(event) => setProjectTitleDraft(event.target.value)}
                            onBlur={() => saveProjectPatch({ title: projectTitleDraft }, "项目名称已保存")}
                          />
                        </label>
                        <label className="chat-topic-panel__field">
                          <span>默认模型</span>
                          <div className="omni-settings-dialog__model-select">
                            <OmniSelect
                              value={projectModelDraft}
                              onChange={(nextValue) => {
                                const nextModelId = projectModelDraft === nextValue ? "" : nextValue;
                                setProjectModelDraft(nextModelId);
                                saveProjectPatch({ defaultModelId: nextModelId || null }, "默认模型已更新");
                              }}
                              ariaLabel="项目默认模型"
                              className="omni-select--field"
                              placeholder="跟随主模型"
                              options={availableModels.map((model) => ({ value: model.id, label: model.name }))}
                            />
                            {selectedProjectModel && (
                              <div className="omni-settings-dialog__model-select-meta">
                                {selectedProjectModel.provider} / {selectedProjectModel.id} · 会覆盖主模型，仅当前项目生效
                              </div>
                            )}
                            {!selectedProjectModel && (
                              <div className="omni-settings-dialog__model-select-meta">
                                未单独指定时使用顶部选择的主模型
                              </div>
                            )}
                          </div>
                        </label>
                        <label className="chat-topic-panel__field">
                          <span>绑定知识库</span>
                          <div className="omni-settings-dialog__model-select">
                            <OmniSelect
                              value={activeProject.knowledgeCollectionId ?? ""}
                              onChange={(nextValue) => {
                                saveProjectPatch({ knowledgeCollectionId: nextValue || null }, "知识库绑定已更新");
                              }}
                              ariaLabel="项目绑定知识库"
                              className="omni-select--field"
                              options={[
                                { value: "", label: "全部知识库" },
                                ...knowledgeCollections.map((collection) => ({ value: collection.id, label: collection.name })),
                              ]}
                            />
                            <div className="omni-settings-dialog__model-select-meta">
                              {selectedProjectKnowledgeCollection
                                ? `仅检索：${selectedProjectKnowledgeCollection.name}`
                                : knowledgeCollections.length > 0
                                  ? "未绑定时会从全部知识库召回"
                                  : "还没有可绑定的知识库"}
                            </div>
                          </div>
                        </label>
                        <label className="chat-topic-panel__field">
                          <span>所属分组</span>
                          <OmniSelect
                            value={activeProject.groupName ?? ""}
                            onChange={(nextValue) => {
                              saveProjectPatch({ groupName: nextValue || null }, "项目分组已更新");
                            }}
                            ariaLabel="项目所属分组"
                            className="omni-select--field"
                            options={[
                              { value: "", label: DEFAULT_PROJECT_GROUP_LABEL },
                              ...projectGroupNames.map((groupName) => ({ value: groupName, label: groupName })),
                            ]}
                          />
                        </label>
                        <label className="chat-topic-panel__field omni-settings-dialog__field--full">
                          <span>描述</span>
                          <input
                            value={projectDescriptionDraft}
                            onChange={(event) => setProjectDescriptionDraft(event.target.value)}
                            onBlur={() => saveProjectPatch({ description: projectDescriptionDraft }, "项目描述已保存")}
                          />
                        </label>
                        <label className="chat-topic-panel__field omni-settings-dialog__field--full">
                          <span>角色设定</span>
                          <textarea
                            value={projectPromptDraft}
                            onChange={(event) => setProjectPromptDraft(event.target.value)}
                            onBlur={() => saveProjectPatch({ systemPrompt: projectPromptDraft }, "角色设定已保存")}
                            rows={5}
                          />
                        </label>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="omni-settings-dialog__section">
                  <div className="omni-settings-dialog__section-title">项目工作目录</div>
                  <div className="omni-settings-dialog__setting-hint">
                    绑定本地目录后，对话可读取该目录下的文件，并自动加载目录中的 AGENTS.md 作为本项目的额外指令。
                  </div>
                  <div className="omni-settings-dialog__workspace-row">
                    <input
                      className="omni-settings-dialog__workspace-path"
                      value={activeProject.workspacePath}
                      readOnly
                      placeholder="未绑定工作目录"
                    />
                    <button
                      type="button"
                      className="omni-settings-dialog__workspace-pick"
                      onClick={async () => {
                        try {
                          const selected = await open({ directory: true, title: "选择项目工作目录（可取消以跳过）" });
                          if (typeof selected === "string" && selected.trim()) {
                            saveProjectPatch({ workspacePath: selected.trim() }, "工作目录已更新");
                            await refreshProjectAgentsMd();
                          }
                        } catch {
                          showProjectNotice("无法打开目录选择器", "error");
                        }
                      }}
                    >
                      选择目录
                    </button>
                  </div>
                  {activeProject.workspacePath ? (
                    <div className="omni-settings-dialog__agents-md">
                      <div className="omni-settings-dialog__setting-label">AGENTS.md（自动读取，只读）</div>
                      <textarea
                        className="omni-settings-dialog__agents-md-text"
                        value={projectAgentsMd}
                        readOnly
                        rows={6}
                        placeholder="该目录没有 AGENTS.md 文件"
                      />
                    </div>
                  ) : null}
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
                          saveProjectPatch({ allowedToolIds: toolset.toolIds }, "工具集模板已应用");
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
                </>
                )}

                <div className="omni-settings-dialog__section">
                  <div className="omni-settings-dialog__section-title">记忆策略</div>
                  <div className="omni-settings-dialog__toggle-list">
                    <label className="omni-settings-dialog__toggle-row">
                      <div className="omni-settings-dialog__toggle-copy">
                        <strong>记忆范围</strong>
                        <span>控制这个项目能否读取历史记忆，以及召回的边界。</span>
                      </div>
                      <OmniSelect
                        value={activeProject.memoryScope}
                        onChange={(value) =>
                          saveProjectPatch({
                            memoryScope: value as ProjectMemoryScope,
                          }, "记忆范围已更新")
                        }
                        ariaLabel="项目记忆范围"
                        className="omni-select--memory"
                        options={[
                          { value: "off", label: "关闭记忆" },
                          { value: "session", label: "仅当前话题" },
                          { value: "project", label: "当前项目全局" },
                        ]}
                      />
                    </label>

                    <label className="omni-settings-dialog__toggle-row">
                      <div className="omni-settings-dialog__toggle-copy">
                        <strong>自动沉淀记忆</strong>
                        <span>将稳定偏好、约束或长期信息保存到该项目的记忆库。</span>
                      </div>
                      <OmniSwitch
                        checked={activeProject.autoSaveMemories}
                        onChange={(checked) =>
                          saveProjectPatch({
                            autoSaveMemories: checked,
                          }, checked ? "自动沉淀记忆已开启" : "自动沉淀记忆已关闭")
                        }
                        ariaLabel="自动沉淀记忆"
                      />
                    </label>

                    <label className="omni-settings-dialog__toggle-row">
                      <div className="omni-settings-dialog__toggle-copy">
                        <strong>自动沉淀摘要</strong>
                        <span>把当前话题的阶段结论保存为摘要，供后续继续接力。</span>
                      </div>
                      <OmniSwitch
                        checked={activeProject.autoSaveSummaries}
                        onChange={(checked) =>
                          saveProjectPatch({
                            autoSaveSummaries: checked,
                          }, checked ? "自动沉淀摘要已开启" : "自动沉淀摘要已关闭")
                        }
                        ariaLabel="自动沉淀摘要"
                      />
                    </label>
                  </div>
                </div>

                <div className="omni-settings-dialog__section">
                  <div className="omni-settings-dialog__section-title">记忆库</div>
                  <div className="omni-settings-dialog__project-copy">
                    <div className="omni-settings-dialog__setting-hint">
                      当前项目已沉淀 {projectMemories.length} 条长期记忆。记忆范围：{activeMemoryScopeLabel}，自动记忆
                      {activeProject.autoSaveMemories ? "已开启" : "已关闭"}，自动摘要{activeProject.autoSaveSummaries ? "已开启" : "已关闭"}。
                    </div>
                  </div>
                  <div className="omni-settings-dialog__memory-add">
                    <input
                      value={newMemoryDraft}
                      onChange={(event) => setNewMemoryDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          addManualMemory();
                        }
                      }}
                      placeholder="手动添加一条长期记忆，例如：以后回答都用中文"
                    />
                    <button type="button" onClick={addManualMemory} disabled={!newMemoryDraft.trim()}>
                      添加记忆
                    </button>
                  </div>
                  <div className="omni-settings-dialog__memory-toolbar">
                    <div className="omni-settings-dialog__memory-search">
                      <Search size={14} strokeWidth={1.8} />
                      <input
                        value={memorySearchQuery}
                        onChange={(event) => setMemorySearchQuery(event.target.value)}
                        placeholder="搜索记忆、来源会话或来源类型"
                      />
                    </div>
                    <button
                      type="button"
                      className="omni-settings-dialog__memory-clear"
                      onClick={() => setMemoryClearConfirmOpen(true)}
                      disabled={projectMemories.length === 0}
                    >
                      清空记忆
                    </button>
                  </div>
                  {projectMemories.length > 0 ? (
                    <div className="omni-settings-dialog__memory-list">
                      {visibleProjectMemories.map((memory) => (
                        <div key={memory.id} className="omni-settings-dialog__memory-item">
                          {editingMemoryId === memory.id ? (
                            <div className="omni-settings-dialog__memory-editor">
                              <textarea
                                value={editingMemoryDraft}
                                onChange={(event) => setEditingMemoryDraft(event.target.value)}
                                rows={3}
                              />
                              <div className="omni-settings-dialog__memory-actions">
                                <button type="button" onClick={cancelEditMemory}>
                                  取消
                                </button>
                                <button type="button" className="omni-settings-dialog__memory-save" onClick={saveEditingMemory}>
                                  保存
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <div className="omni-settings-dialog__memory-copy">
                                <strong>{memory.content}</strong>
                                <div className="omni-settings-dialog__memory-meta">
                                  <span className="omni-settings-dialog__memory-source-type">{getMemorySourceTypeLabel(memory.sourceType)}</span>
                                  <span>
                                    {memory.sourceSessionId
                                      ? `来源会话：${topicTitleById.get(memory.sourceSessionId) ?? "来源会话已删除或不可用"}`
                                      : "未记录来源会话"}
                                  </span>
                                  <span>{new Date(memory.updatedAt).toLocaleString("zh-CN")}</span>
                                </div>
                              </div>
                              <div className="omni-settings-dialog__memory-actions">
                                <button
                                  type="button"
                                  onClick={() => openMemorySourceSession(memory.sourceSessionId)}
                                  disabled={!memory.sourceSessionId || !topicTitleById.has(memory.sourceSessionId)}
                                >
                                  来源
                                </button>
                                <button type="button" onClick={() => startEditMemory(memory)}>
                                  编辑
                                </button>
                                <button
                                  type="button"
                                  className="omni-settings-dialog__memory-delete"
                                  onClick={() => {
                                    const deleted = onDeleteProjectMemory(memory.id);
                                    showProjectNotice(deleted ? "记忆已删除" : "记忆删除失败", deleted ? "success" : "error");
                                  }}
                                >
                                  删除
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      ))}
                      {filteredProjectMemories.length === 0 && (
                        <div className="omni-settings-dialog__memory-empty">没有匹配的记忆</div>
                      )}
                      {filteredProjectMemories.length > 12 && (
                        <button
                          type="button"
                          className="omni-settings-dialog__memory-more"
                          onClick={() => setShowAllMemories((current) => !current)}
                        >
                          {showAllMemories ? "收起部分记忆" : `显示全部 ${filteredProjectMemories.length} 条记忆`}
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="omni-settings-dialog__memory-empty">暂无已沉淀记忆</div>
                  )}
                  {memoryClearConfirmOpen && (
                    <div className="chat-topic-panel__menu-confirm omni-settings-dialog__memory-confirm">
                      <div className="chat-topic-panel__menu-confirm-title">清空当前项目记忆</div>
                      <div className="chat-topic-panel__menu-confirm-message">
                        将删除当前项目的 {projectMemories.length} 条长期记忆。此操作不会删除会话记录。
                      </div>
                      <div className="chat-topic-panel__menu-confirm-actions">
                        <button type="button" className="chat-topic-panel__menu-button" onClick={() => setMemoryClearConfirmOpen(false)}>
                          取消
                        </button>
                        <button type="button" className="chat-topic-panel__menu-button chat-topic-panel__menu-button--danger" onClick={clearCurrentProjectMemories}>
                          确认清空
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {isCustomProjectSettingsMode && (
                <>
                <div className="omni-settings-dialog__section">
                  <div className="omni-settings-dialog__section-title">
                    工具权限
                    <span className="omni-settings-dialog__section-subtitle">来自插件广场已启用的工具</span>
                  </div>
                  <div className="omni-settings-dialog__toggle-list">
                    {pluginRegistry
                      .listEnabledTools()
                      .filter((tool) => PROJECT_TOOL_OPTIONS.some((option) => option.id === tool.id))
                      .map((tool) => {
                      const checked = activeProject.allowedToolIds.includes(tool.id);
                      return (
                        <label key={tool.id} className="omni-settings-dialog__toggle-row">
                          <div className="omni-settings-dialog__toggle-copy">
                            <strong>{tool.name}</strong>
                            <span>{tool.description}</span>
                          </div>
                          <OmniSwitch
                            checked={checked}
                            onChange={(nextChecked) => {
                              const nextAllowedToolIds = nextChecked
                                ? [...activeProject.allowedToolIds, tool.id]
                                : activeProject.allowedToolIds.filter((item) => item !== tool.id);
                              saveProjectPatch({ allowedToolIds: nextAllowedToolIds }, "工具权限已更新");
                            }}
                            ariaLabel={tool.name}
                          />
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div className="omni-settings-dialog__section">
                  <div className="omni-settings-dialog__section-title">
                    技能权限
                    <span className="omni-settings-dialog__section-subtitle">来自插件广场已启用的技能</span>
                  </div>
                  <div className="omni-settings-dialog__toggle-list">
                    {pluginRegistry.listEnabledSkills().map((skill) => {
                      const checked = activeProject.allowedSkillIds.includes(skill.id);
                      return (
                        <label key={skill.id} className="omni-settings-dialog__toggle-row">
                          <div className="omni-settings-dialog__toggle-copy">
                            <strong>{skill.name}</strong>
                            <span>{skill.description} · {skill.command ?? `/${skill.id}`}</span>
                          </div>
                          <OmniSwitch
                            checked={checked}
                            onChange={(nextChecked) => {
                              const nextAllowedSkillIds = nextChecked
                                ? [...activeProject.allowedSkillIds, skill.id]
                                : activeProject.allowedSkillIds.filter((item) => item !== skill.id);
                              saveProjectPatch({ allowedSkillIds: nextAllowedSkillIds }, "技能权限已更新");
                            }}
                            ariaLabel={skill.name}
                          />
                        </label>
                      );
                    })}
                  </div>
                </div>
                </>
                )}

              </div>
              {isCustomProjectSettingsMode && (
              <input
                ref={projectAvatarInputRef}
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
                      saveProjectPatch({ avatarType: "image", avatarValue: result }, "自定义头像已更新");
                      setProjectAvatarPanelOpen(false);
                    }
                  };
                  reader.readAsDataURL(file);
                  event.currentTarget.value = "";
                }}
              />
              )}
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
                  <div className={`empty-chat-state${useCompactEmptyGuideLayout ? " empty-chat-state--compact" : ""}`}>
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
                            setTopicPanelManualVisible(true);
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
                        onClick={() => updateEmptyGuideCompact(!isEmptyGuideCompact)}
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
                            <button key={prompt} type="button" className="empty-chat-state__card" onClick={() => onUseEmptyPrompt(prompt)}>
                              <div className="empty-chat-state__card-icon">
                                {index % 2 === 0 ? <Compass size={18} strokeWidth={1.8} /> : <Sparkles size={18} strokeWidth={1.8} />}
                              </div>
                              <div className="empty-chat-state__card-copy">
                                <strong>{RECOMMENDED_PROJECT_PRESETS[index]?.title || "快速开始"}</strong>
                                <span>{RECOMMENDED_PROJECT_PRESETS[index]?.description || prompt}</span>
                              </div>
                              <ArrowRight size={16} strokeWidth={1.8} />
                            </button>
                          ))}
                        </div>
                        <div className="empty-chat-state__subhead">
                          <Sparkles size={14} strokeWidth={1.9} />
                          <span>快速创建项目</span>
                        </div>
                        <div className="empty-chat-state__cards">
                          {AVATAR_PRESETS.slice(0, 4).map((preset) => (
                            <button
                              key={preset.code}
                              type="button"
                              className="empty-chat-state__card"
                              onClick={() =>
                              onCreateCustomProject({
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
                      </>
                    )}
                  </div>
                )}

                {messages.map((msg, index) => {
                  const isCurrentStreamingMessage = isStreaming && index === messages.length - 1;
                  if (msg.role === "project" && !msg.content.trim() && !isCurrentStreamingMessage) {
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
                    />
                  );
                })}

                {error && <div className="main-chat-error animate-fade-in">{error}</div>}
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
                style={composerResizeHeight ? { height: `${composerResizeHeight}px` } : undefined}
              >
                <ChatInput
                  allowedToolIds={allowedComposerToolIds}
                  allowedSkillIds={allowedComposerSkillIds}
                  canStartNewTopic={Boolean(activeProject)}
                  contextPresetText={composerContextPresetText}
                  knowledgeCollections={knowledgeCollections}
                  onSend={onSend}
                  hasConversation={messages.some((message) => message.role === "user")}
                  usageLabel={activeSession ? formatUsageLabel(activeSession.usage) : null}
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
                  draftSignal={inputDraftKey}
                  onDraftChange={onDraftChange}
                />
              </div>
            </>
          )}

            </main>
          </section>

          {!isProjectSettingsMode && (
            <div
              className="main-chat-layout__splitter main-chat-layout__splitter--topic no-drag"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整工作台宽度"
              onPointerDown={handleLayoutDragPointerDown}
            />
          )}

          {!isProjectSettingsMode && <aside className="chat-topic-panel">
          <div className="chat-topic-panel__body">
            <div className="chat-topic-panel__toolbar">
              <div className="chat-topic-panel__title">
                <LayoutDashboard size={14} strokeWidth={2} />
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
                          onClick={() => handleDeleteSessions(allTopicSessions, "删除全部话题", "确定删除当前项目下的全部话题吗？")}
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
                              setProjectSettingsId(null);
                              setProjectAvatarPanelOpen(false);
                              setTopicItemMenuSessionId(null);
                              onSelectChat(session.id);
                            }}
                          >
                            <MessageSquare size={13} strokeWidth={1.9} className="chat-topic-panel__item-icon" />
                            <span className="chat-topic-panel__item-copy">
                              <span className="chat-topic-panel__item-title">{session.title}</span>
                            </span>
                            {renderTopicItemActionMenu(session)}
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
                        setProjectSettingsId(null);
                        setProjectAvatarPanelOpen(false);
                        setTopicItemMenuSessionId(null);
                        onSelectChat(session.id);
                      }}
                    >
                      <MessageSquare size={13} strokeWidth={1.9} className="chat-topic-panel__item-icon" />
                      <span className="chat-topic-panel__item-copy">
                        <span className="chat-topic-panel__item-title">{session.title}</span>
                      </span>
                      {renderTopicItemActionMenu(session)}
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
                          <strong>链路摘要</strong>
                          <span>
                            {taskAggregateSummary.childCount > 0 ? `共 ${taskAggregateSummary.childCount} 个子任务 · ` : ""}
                            {taskAggregateSummary.text}
                          </span>
                        </div>
                      )}
                      {latestTaskResult.trace.length > 0 && (
                        <button
                          type="button"
                          className="chat-topic-panel__inline-action"
                          onClick={() => setIsTaskTraceExpanded((current) => !current)}
                        >
                          {isTaskTraceExpanded ? "收起链路" : "查看回答链路"}
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

                {showTaskPanel && (
                  <div className="chat-topic-panel__section">
                    <div className="chat-topic-panel__section-title">
                      <History size={13} strokeWidth={2} />
                      <span>任务历史</span>
                    </div>
                    {taskRuntimeState.history.length > 1 ? (
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
                    ) : (
                      <div className="chat-topic-panel__empty">暂无任务记录</div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
          </aside>}
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
