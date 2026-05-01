import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import {
  ArrowRight,
  Bot,
  Check,
  Compass,
  Cpu,
  FolderOpen,
  Hash,
  History,
  MessageSquare,
  MoreHorizontal,
  PawPrint,
  PanelRightClose,
  PanelRightOpen,
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
  Trash2,
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
  { id: "search_sessions", label: "搜索会话", description: "按标题或内容检索本地会话" },
  { id: "read_session", label: "读取会话", description: "查看指定会话的上下文内容" },
  { id: "list_files", label: "列出文件", description: "浏览当前工作区文件与目录" },
  { id: "read_file", label: "读取文件", description: "读取文件正文用于分析或问答" },
  { id: "search_files", label: "搜索文件", description: "按关键字搜索工作区内容" },
  { id: "analyze_files", label: "分析文件", description: "组合搜索与阅读能力完成分析" },
];

const ASSISTANT_SKILL_OPTIONS = [
  { id: "summarize", label: "总结", description: "提炼重点，输出简洁摘要" },
  { id: "translate", label: "翻译", description: "在多语言之间转换内容" },
  { id: "rewrite", label: "改写", description: "按语气或风格重写表达" },
  { id: "explain", label: "解释", description: "解释概念、代码或流程" },
  { id: "compare", label: "对比", description: "比较方案差异与优缺点" },
];

const TOPIC_PANEL_WIDTH = 272;
const TOPIC_PANEL_AUTO_COLLAPSE_RATIO = 2 / 3;
const AVATAR_CATEGORIES = [
  { id: "recent", label: "常用", icon: History },
  { id: "general", label: "通用", icon: Sparkles },
  { id: "analysis", label: "分析", icon: Cpu },
  { id: "creative", label: "创作", icon: PawPrint },
];
const AVATAR_LIBRARY = [
  {
    code: "1F916",
    label: "默认助手",
    category: "recent",
    tone: "blue",
    hint: "稳定通用",
    prompt: "你是一名稳定、可靠的通用 AI 助手。优先准确理解用户意图，用简洁清晰的中文回答问题；当需求不明确时先补足关键信息，再给出可执行结果。",
  },
  {
    code: "1F9E0",
    label: "分析专家",
    category: "recent",
    tone: "violet",
    hint: "结构拆解",
    prompt: "你是一名分析型 AI 助手。面对复杂问题时，先拆解目标、约束和关键变量，再逐步推导出结论；输出强调结构、依据和可验证性。",
  },
  {
    code: "1F4A1",
    label: "灵感教练",
    category: "recent",
    tone: "amber",
    hint: "创意发散",
    prompt: "你是一名创意型 AI 助手。擅长围绕主题发散思路、提出新方向和可落地的表达方案；回答要有新意，但避免空泛和堆砌概念。",
  },
  {
    code: "1F680",
    label: "执行引擎",
    category: "recent",
    tone: "cyan",
    hint: "结果推进",
    prompt: "你是一名执行导向的 AI 助手。重点关注目标达成、步骤推进和结果交付；优先给出明确行动项、执行顺序、风险点和验收标准。",
  },
  {
    code: "2728",
    label: "通用顾问",
    category: "general",
    tone: "blue",
    hint: "日常问答",
    prompt: "你是一名通用顾问型 AI 助手。适合日常问答、资料整理和简单建议；回答保持平衡、清晰、易读，并尽量给出用户下一步可执行建议。",
  },
  {
    code: "1F44D",
    label: "效率助手",
    category: "general",
    tone: "green",
    hint: "流程提速",
    prompt: "你是一名效率优化 AI 助手。擅长把复杂事情转成更快执行的步骤、模板和清单；输出以节省时间、降低重复劳动为优先目标。",
  },
  {
    code: "1F60A",
    label: "陪聊助手",
    category: "general",
    tone: "pink",
    hint: "轻松对话",
    prompt: "你是一名自然、轻松的陪聊型 AI 助手。保持友好、自然和有边界感，善于顺着用户语境继续对话，同时避免过度表演和空洞安慰。",
  },
  {
    code: "1F60E",
    label: "产品经理",
    category: "general",
    tone: "slate",
    hint: "需求梳理",
    prompt: "你是一名产品经理型 AI 助手。擅长梳理需求、定义目标、识别边界、比较方案并给出取舍建议；输出偏结构化和决策导向。",
  },
  {
    code: "1F914",
    label: "问题拆解",
    category: "analysis",
    tone: "violet",
    hint: "定位核心",
    prompt: "你是一名问题拆解 AI 助手。接到任务后，先识别问题本质、根因和依赖关系，再给出分层分析；不要直接跳到结论，先把逻辑链路说明白。",
  },
  {
    code: "1F3AF",
    label: "目标规划",
    category: "analysis",
    tone: "red",
    hint: "路径规划",
    prompt: "你是一名目标规划 AI 助手。擅长围绕目标倒推阶段、里程碑和资源安排；回答要体现优先级、依赖关系、节奏控制和风险预案。",
  },
  {
    code: "1F4BB",
    label: "代码专家",
    category: "analysis",
    tone: "cyan",
    hint: "技术实现",
    prompt: "你是一名代码专家型 AI 助手。面对开发问题时，优先理解上下文、明确问题边界，再给出准确实现、修复建议或重构方案；避免泛泛而谈。",
  },
  {
    code: "1F6E0-FE0F",
    label: "排障助手",
    category: "analysis",
    tone: "amber",
    hint: "故障修复",
    prompt: "你是一名排障型 AI 助手。擅长根据现象定位原因、列出排查路径、缩小问题范围并提出修复方案；输出优先考虑诊断顺序和验证方法。",
  },
  {
    code: "1F929",
    label: "创意策划",
    category: "creative",
    tone: "pink",
    hint: "主题提案",
    prompt: "你是一名创意策划 AI 助手。擅长围绕主题输出概念、命名、故事线和表达形式；回答要兼顾新意、辨识度和执行可行性。",
  },
  {
    code: "1F973",
    label: "活动助手",
    category: "creative",
    tone: "orange",
    hint: "方案包装",
    prompt: "你是一名活动策划 AI 助手。适合产出活动主题、流程、亮点设计和传播卖点；输出既要有氛围感，也要能落到执行细节。",
  },
  {
    code: "1F98A",
    label: "品牌灵狐",
    category: "creative",
    tone: "orange",
    hint: "风格表达",
    prompt: "你是一名品牌表达 AI 助手。擅长统一语气、视觉方向、品牌个性和内容风格；输出要注重辨识度、一致性和传播感。",
  },
  {
    code: "1F989",
    label: "夜读猫头鹰",
    category: "creative",
    tone: "slate",
    hint: "内容润色",
    prompt: "你是一名内容润色 AI 助手。擅长改写文案、优化表达、提炼重点和统一语气；输出要更顺、更准、更有节奏感，但不能偏离原意。",
  },
];

function getEmojiAssetSrc(code: string) {
  return `https://cdn.jsdelivr.net/gh/hfg-gmuend/openmoji@master/color/svg/${code.trim().toUpperCase()}.svg`;
}

const LEGACY_AVATAR_CODE_MAP: Record<string, string> = {
  "🦉": "1F989",
  "😊": "1F60A",
  "😀": "1F600",
  "😄": "1F604",
  "😁": "1F601",
  "😎": "1F60E",
  "🥳": "1F973",
  "🤓": "1F913",
  "😺": "1F63A",
  "🐶": "1F436",
  "🦊": "1F98A",
  "🐼": "1F43C",
  "🐸": "1F438",
  "🤖": "1F916",
  "👾": "1F47E",
  "🎯": "1F3AF",
  "⭐": "2B50",
  "🔥": "1F525",
  "🌈": "1F308",
  "🍀": "1F340",
  "🌸": "1F338",
  "🍎": "1F34E",
  "⚽": "26BD",
  "🎵": "1F3B5",
  "🚀": "1F680",
};

const CUSTOM_ASSISTANT_AVATAR_CODES = ["1F916", "1F9E0", "1F47E", "1F4A1", "1F680", "1F3AF"];

function resolveEmojiAvatarCode(value?: string | null) {
  if (!value) return null;
  if (value.startsWith("emoji:")) return value.slice(6).trim().toUpperCase();
  return LEGACY_AVATAR_CODE_MAP[value] ?? null;
}

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

function renderAssistantAvatar(assistant: AssistantProfile | null, seed = 0) {
  const fallbackCode = assistant?.kind === "basic" ? "1F989" : CUSTOM_ASSISTANT_AVATAR_CODES[seed % CUSTOM_ASSISTANT_AVATAR_CODES.length];

  if (!assistant) {
    return <img src={getEmojiAssetSrc("1F989")} alt="" className="chat-history-panel__assistant-image" />;
  }

  if (assistant.avatarType === "image" && assistant.avatarValue) {
    return <img src={assistant.avatarValue} alt="" className="chat-history-panel__assistant-image" />;
  }

  const avatarCode = resolveEmojiAvatarCode(assistant.avatarValue);
  if (avatarCode) {
    return <img src={getEmojiAssetSrc(avatarCode)} alt="" className="chat-history-panel__assistant-image" />;
  }

  return <img src={getEmojiAssetSrc(fallbackCode)} alt="" className="chat-history-panel__assistant-image" />;
}

function resolveAssistantAvatarSeed(assistants: AssistantProfile[], assistantId: string | null) {
  if (!assistantId) return 0;
  const customAssistants = assistants.filter((assistant) => assistant.kind === "custom");
  const index = customAssistants.findIndex((assistant) => assistant.id === assistantId);
  return index >= 0 ? index : 0;
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
  const [assistantSearchQuery, setAssistantSearchQuery] = useState("");
  const [assistantMenuOpen, setAssistantMenuOpen] = useState(false);
  const [assistantSettingsId, setAssistantSettingsId] = useState<string | null>(null);
  const [assistantAvatarPanelOpen, setAssistantAvatarPanelOpen] = useState(false);
  const [assistantAvatarSearchQuery, setAssistantAvatarSearchQuery] = useState("");
  const [assistantAvatarCategory, setAssistantAvatarCategory] = useState("recent");
  const [customAssistantsCollapsed, setCustomAssistantsCollapsed] = useState(false);
  const topicSearchInputRef = useRef<HTMLInputElement | null>(null);
  const topicMenuRef = useRef<HTMLDivElement | null>(null);
  const topicMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const assistantMenuRef = useRef<HTMLDivElement | null>(null);
  const assistantAvatarInputRef = useRef<HTMLInputElement | null>(null);
  const assistantAvatarPanelRef = useRef<HTMLDivElement | null>(null);
  const assistantAvatarTriggerRef = useRef<HTMLButtonElement | null>(null);

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
  const activeAssistantAvatarSeed = resolveAssistantAvatarSeed(assistants, activeAssistant?.id ?? null);
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
  const filteredAssistantAvatars = AVATAR_LIBRARY.filter((avatar) => {
    const matchesCategory = assistantAvatarCategory === "recent" ? true : avatar.category === assistantAvatarCategory;
    if (!matchesCategory) return false;
    if (!assistantAvatarSearchQuery) return true;
    return normalizeSearchText(`${avatar.code} ${avatar.label} ${avatar.category} ${avatar.tone} ${avatar.hint}`).includes(normalizeSearchText(assistantAvatarSearchQuery));
  });
  const isAssistantSettingsMode = Boolean(assistantSettingsId && activeAssistant?.kind === "custom");
  const [assistantTitleDraft, setAssistantTitleDraft] = useState(activeAssistant?.title ?? "");
  const [assistantDescriptionDraft, setAssistantDescriptionDraft] = useState(activeAssistant?.description ?? "");
  const [assistantPromptDraft, setAssistantPromptDraft] = useState(activeAssistant?.systemPrompt ?? "");
  const [assistantModelDraft, setAssistantModelDraft] = useState(activeAssistant?.defaultModelId ?? "");
  const layoutClassName = useMemo(() => {
    const classNames = ["main-chat-layout"];
    if (topicPanelManualVisible === true) classNames.push("main-chat-layout--topic-forced-open");
    if (!isTopicPanelVisible) classNames.push("main-chat-layout--topic-collapsed");
    if (isAssistantSettingsMode) classNames.push("main-chat-layout--assistant-settings");
    return classNames.join(" ");
  }, [isAssistantSettingsMode, isTopicPanelVisible, topicPanelManualVisible]);

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
  useEffect(() => {
    if (!assistantMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (assistantMenuRef.current?.contains(target)) return;
      setAssistantMenuOpen(false);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [assistantMenuOpen]);

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
          <Bot size={20} strokeWidth={1.9} />
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
                onClick={() => onSelectAssistant(basicAssistant.id)}
              >
                <span className="chat-history-panel__assistant-icon">
                  {renderAssistantAvatar(basicAssistant)}
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
                {filteredCustomAssistants.length === 0 ? (
                  <div className="chat-history-panel__assistant-empty">
                    {customAssistants.length === 0 ? "还没有自定义助手" : "没有匹配的助手"}
                  </div>
                ) : (
                filteredCustomAssistants.map((assistant, index) => (
                  <button
                    key={assistant.id}
                    type="button"
                    className={`chat-history-panel__assistant ${activeAssistantId === assistant.id ? "chat-history-panel__assistant--active" : ""}`}
                    onClick={() => onSelectAssistant(assistant.id)}
                  >
                    <span className="chat-history-panel__assistant-icon chat-history-panel__assistant-icon--custom">
                      {renderAssistantAvatar(assistant, index)}
                    </span>
                    <span className="chat-history-panel__assistant-copy">
                      <strong>{assistant.title}</strong>
                      <span>{assistant.description}</span>
                    </span>
                    <span
                      className="chat-history-panel__assistant-action"
                      role="button"
                      tabIndex={0}
                      title="助手设置"
                      aria-label="助手设置"
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelectAssistant(assistant.id);
                        setAssistantSettingsId(assistant.id);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          event.stopPropagation();
                          onSelectAssistant(assistant.id);
                          setAssistantSettingsId(assistant.id);
                        }
                      }}
                    >
                      <Settings size={13} strokeWidth={1.9} />
                    </span>
                  </button>
                ))
                )}
              </div>}
            </div>

        </div>
      </aside>

      <section ref={setWorkspaceElement} className="main-chat-workspace" style={{ "--composer-height": `${composerHeight}px` } as CSSProperties}>
        <header className="main-chat-header drag-region">
          <div className="main-chat-toolbar">
            <div className="main-chat-toolbar__session main-chat-toolbar__session--hero">
              <div className="main-chat-toolbar__assistant">
                <div className="main-chat-toolbar__assistant-mark">
                  {renderAssistantAvatar(activeAssistant, activeAssistantAvatarSeed)}
                </div>
                <div className="main-chat-toolbar__assistant-copy">
                  <strong>{isAssistantSettingsMode ? "助手设置" : currentTopicTitle}</strong>
                  <span>{isAssistantSettingsMode ? "在中间区域配置当前自定义助手" : activeAssistant?.description || "开始新一轮思考、问答或执行任务"}</span>
                </div>
              </div>

              <div className="no-drag">
                <ModelSelector currentModel={currentModel} onModelChange={onModelChange} />
              </div>
            </div>

            <div className="main-chat-toolbar__actions no-drag">
              {isAssistantSettingsMode && (
                <button
                  type="button"
                  className="main-chat-toolbar__icon-button"
                  title="返回聊天"
                  onClick={() => {
                    setAssistantSettingsId(null);
                    setAssistantAvatarPanelOpen(false);
                  }}
                >
                  <ChevronLeft className="main-chat-toolbar__icon" strokeWidth={1.8} />
                </button>
              )}
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
                          <input
                            value={assistantModelDraft}
                            onChange={(event) => setAssistantModelDraft(event.target.value)}
                            onBlur={() => onUpdateAssistantProfile(activeAssistant.id, { defaultModelId: assistantModelDraft || null })}
                            placeholder="例如 gpt-4o"
                          />
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

                    <div className="omni-settings-dialog__assistant-side">
                      <div className="omni-settings-dialog__assistant-copy">
                        <div className="omni-settings-dialog__setting-label">助手头像</div>
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
                              {AVATAR_CATEGORIES.map((category) => (
                                <button
                                  key={category.id}
                                  type="button"
                                  className={`omni-settings-dialog__avatar-category ${assistantAvatarCategory === category.id ? "omni-settings-dialog__avatar-category--active" : ""}`}
                                  title={category.label}
                                  onClick={() => setAssistantAvatarCategory(category.id)}
                                >
                                  <category.icon size={14} strokeWidth={1.8} />
                                  <span>{category.label}</span>
                                </button>
                              ))}
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
                                        avatarType: "emoji",
                                        avatarValue: `emoji:${avatar.code}`,
                                        systemPrompt: avatar.prompt,
                                      });
                                      setAssistantPromptDraft(avatar.prompt);
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
                      return (
                        <label key={skill.id} className="omni-settings-dialog__toggle-row">
                          <div className="omni-settings-dialog__toggle-copy">
                            <strong>{skill.label}</strong>
                            <span>{skill.description}</span>
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
            </>
          )}

        </main>

        {!isAssistantSettingsMode && <aside className="chat-topic-panel">
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
        </aside>}
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
