import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Bot,
  Check,
  ChevronRight,
  Command,
  ListChecks,
  LoaderCircle,
  Paperclip,
  Plus,
  Send,
  Square,
  Target,
  UsersRound,
  X,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import {
  getSlashTrigger,
  getAllLocalCommands,
  getMatchingSlashSuggestions,
  type SlashSuggestion,
} from "../chat/skills";
import {
  findBuiltinSlashCommand,
  type BuiltinCommandDefinition,
} from "../chat/builtinCommands";
import {
  buildBuiltinSessionContext,
  clearBuiltinGoal,
  migrateBuiltinSessionState,
  readBuiltinSessionState,
  setBuiltinGoal,
  setBuiltinGoalPhase,
  setBuiltinPlanMode,
  type BuiltinSessionState,
} from "../chat/builtinCommandState";
import { compactHistoryNow } from "../chat/engine";
import { modelRegistry } from "../adapters/registry";
import type { KnowledgeCollection } from "../chat/knowledgeTypes";
import type { ChatAttachment, ChatImage, Message } from "../adapters/types";
import type { ChatSendOptions, ChatUsageStats } from "../chat/types";
import type { PluginManifest } from "../plugins/types";
import type { ExpertTeam } from "../plugins/expertTeams";
import PermissionModeSelector from "./PermissionModeSelector";
import AttachmentChip from "./AttachmentChip";
import type { ContextUsageSnapshot } from "./ContextUsagePanel";
import ChatStatsLine from "./ChatStatsLine";
import ModelSelector from "./ModelSelector";
import { baseNameOf, isImageFile, readLocalImageAsDataURL, savePastedFileAttachment, compressImageBlob } from "./attachmentUtils";

interface ChatInputProps {
  canStartNewTopic?: boolean;
  allowedToolIds?: string[];
  allowedSkillIds?: string[];
  currentModel?: string | null;
  modelTitle?: string;
  hasConversation?: boolean;
  contextUsage?: ContextUsageSnapshot;
  messages?: Message[];
  sessionUsage?: ChatUsageStats;
  contextPresetText?: string;
  knowledgeCollections?: KnowledgeCollection[];
  sessionId?: string | null;
  onReplaceSessionMessages?: (messages: Message[]) => void;
  /** 可选专家（@专家 = 本轮对话切换为该专家的角色/工具/技能集） */
  experts?: PluginManifest[];
  expertTeams?: readonly ExpertTeam[];
  boundExpert?: { id: string; name: string } | null;
  onSummonExpert?: (expert: PluginManifest) => void;
  onStartNewTopic?: () => void;
  onModelChange?: (modelId: string) => void;
  onSend: (content: string, images?: ChatImage[], options?: ChatSendOptions) => void | Promise<void>;
  isLoading: boolean;
  isSendBlocked?: boolean;
  onStop: () => void;
  focusSignal?: number;
  draftScopeKey?: string;
  draftValue?: string;
  draftImages?: ChatImage[];
  draftAttachments?: ChatAttachment[];
  draftSignal?: number;
  onDraftChange?: (text: string, images: ChatImage[], attachments: ChatAttachment[]) => void;
}

type KnowledgeMentionTrigger = {
  start: number;
  end: number;
  query: string;
};

/** @ 提及建议条目：知识库（本轮检索范围）或专家（本轮角色切换）。 */
type MentionSuggestion =
  | { kind: "knowledge"; collection: KnowledgeCollection }
  | { kind: "expert"; expert: PluginManifest };

function normalizeMentionText(value: string) {
  return value.trim().toLocaleLowerCase();
}

function hasDistinctSuggestionTitle(command: string, title: string) {
  const normalize = (value: string) =>
    value
      .trim()
      .replace(/^\/+/, "")
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .toLocaleLowerCase();
  return normalize(command) !== normalize(title);
}

function getDisplayedSuggestionCommand(suggestion: SlashSuggestion) {
  return suggestion.kind === "builtin" ? `/${suggestion.title}` : suggestion.command;
}

function getLeadingSlashToken(value: string): string | null {
  const leading = value.match(/^(\/[^\s]*)/)?.[1] ?? "";
  return leading.length > 1 ? leading : null;
}

function getKnowledgeMentionTrigger(value: string, caretIndex: number): KnowledgeMentionTrigger | null {
  const safeCaretIndex = Math.max(0, Math.min(caretIndex, value.length));
  const prefix = value.slice(0, safeCaretIndex);
  const match = prefix.match(/(^|\s)@([^\s@]*)$/);
  if (!match) {
    return null;
  }

  const query = match[2] ?? "";
  return {
    start: prefix.length - query.length - 1,
    end: safeCaretIndex,
    query,
  };
}

function scrollElementIntoView(element: HTMLElement | null | undefined) {
  if (typeof element?.scrollIntoView !== "function") {
    return;
  }

  element.scrollIntoView({ block: "nearest" });
}

export default function ChatInput({
    allowedToolIds,
    allowedSkillIds,
    currentModel,
    modelTitle,
    onModelChange,
    contextUsage,
    messages = [],
    sessionUsage,
    contextPresetText,
  sessionId,
  onReplaceSessionMessages,
  onSend,
  knowledgeCollections = [],
  experts = [],
  expertTeams = [],
  boundExpert = null,
  onSummonExpert,
  isLoading,
  isSendBlocked = false,
  onStop,
  focusSignal,
  draftScopeKey,
  draftValue,
  draftImages,
  draftAttachments,
  draftSignal,
  onDraftChange,
}: ChatInputProps) {
  const [input, setInput] = useState("");
  const [images, setImages] = useState<ChatImage[]>([]);
  /** 非图片类本地文件附件（绝对路径引用；不内联内容，发送时注入 prompt 让模型用 /read_file 读取） */
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const [dismissedSlashInput, setDismissedSlashInput] = useState("");
  const [selectedKnowledgeCollection, setSelectedKnowledgeCollection] = useState<KnowledgeCollection | null>(null);
  const [selectedExpert, setSelectedExpert] = useState<PluginManifest | null>(null);
  const [selectedExpertTeam, setSelectedExpertTeam] = useState<ExpertTeam | null>(null);
  const [isAddMenuOpen, setIsAddMenuOpen] = useState(false);
  const [openToolbarPicker, setOpenToolbarPicker] = useState<"knowledge" | "expert" | "team" | null>(null);
  const [selectedKnowledgeIndex, setSelectedKnowledgeIndex] = useState(0);
  const [dismissedMentionInput, setDismissedMentionInput] = useState("");
  const [caretIndex, setCaretIndex] = useState(0);
  const [textareaScrollTop, setTextareaScrollTop] = useState(0);
  const [pendingFollowUps, setPendingFollowUps] = useState<Array<{ id: string; content: string }>>([]);
  const [isFollowUpSubmitting, setIsFollowUpSubmitting] = useState(false);
  const builtinScopeKey = sessionId ?? `draft:${draftScopeKey ?? "default"}`;
  const [builtinSessionState, setBuiltinSessionState] = useState<BuiltinSessionState>(
    () => readBuiltinSessionState(builtinScopeKey)
  );
  const [permissionOpenSignal, setPermissionOpenSignal] = useState(0);
  const [modelOpenSignal, setModelOpenSignal] = useState(0);
  const [commandNotice, setCommandNotice] = useState<string | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const toolbarPickerRef = useRef<HTMLDivElement>(null);
  const slashSuggestionsRef = useRef<HTMLDivElement>(null);
  const suggestionItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const knowledgeSuggestionItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const lastDraftScopeRef = useRef<string | undefined>(undefined);
  const lastDraftSignalRef = useRef<number | undefined>(undefined);
  const lastBuiltinScopeRef = useRef(builtinScopeKey);
  const suppressNextDraftReportRef = useRef(false);

  useEffect(() => {
    const previousScope = lastBuiltinScopeRef.current;
    if (
      previousScope !== builtinScopeKey
      && previousScope.startsWith("draft:")
      && sessionId
    ) {
      migrateBuiltinSessionState(previousScope, builtinScopeKey);
    }
    lastBuiltinScopeRef.current = builtinScopeKey;
    setBuiltinSessionState(readBuiltinSessionState(builtinScopeKey));
  }, [builtinScopeKey, sessionId]);

  useEffect(() => {
    if (!commandNotice) {
      return;
    }
    const timer = window.setTimeout(() => setCommandNotice(null), 3600);
    return () => window.clearTimeout(timer);
  }, [commandNotice]);

  useEffect(() => {
    if (!isAddMenuOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!toolbarPickerRef.current?.contains(event.target as Node)) {
        setIsAddMenuOpen(false);
        setOpenToolbarPicker(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (openToolbarPicker) {
          setOpenToolbarPicker(null);
        } else {
          setIsAddMenuOpen(false);
        }
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isAddMenuOpen, openToolbarPicker]);

  const syncTextareaHeight = () => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    if (input.length === 0) {
      textarea.style.height = "36px";
      return;
    }
    textarea.style.height = "auto";
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, 36), 320);
    const currentHeight = Number.parseFloat(textarea.style.height || "0");
    if (!Number.isFinite(currentHeight) || Math.abs(currentHeight - nextHeight) > 0.5) {
      textarea.style.height = `${nextHeight}px`;
    }
  };

  const slashTrigger = getSlashTrigger(input, caretIndex);
  const slashQuery = slashTrigger?.query ?? null;
  const matchedSuggestions = useMemo(
    () => slashQuery === null
      ? []
      : getMatchingSlashSuggestions(slashQuery, allowedToolIds, allowedSkillIds),
    [allowedSkillIds, allowedToolIds, slashQuery],
  );
  const slashSuggestions = matchedSuggestions;
  const trimmedInput = input.trim();
  const activeSlashCommand = trimmedInput.match(/^\/\S+/)?.[0].toLowerCase() ?? "";
  const activeBuiltinCommand = findBuiltinSlashCommand(trimmedInput);
  const activeLocalCommand = activeBuiltinCommand
    ? null
    : getAllLocalCommands().find((item) => item.command === activeSlashCommand) ?? null;
  const leadingSlashToken = getLeadingSlashToken(input);
  const highlightedCommandToken = leadingSlashToken && (
    activeBuiltinCommand
    || activeLocalCommand
    || matchedSuggestions.some((suggestion) =>
      suggestion.command.toLocaleLowerCase().startsWith(leadingSlashToken.toLocaleLowerCase())
    )
  )
    ? leadingSlashToken
    : null;
  const commandHighlightSuffix = highlightedCommandToken
    ? input.slice(highlightedCommandToken.length)
    : "";
  const showCommandTextDecoration = Boolean(highlightedCommandToken);
  const activeModeLabel = activeLocalCommand?.title ?? null;
  const activeModeTypeLabel = activeLocalCommand ? (activeLocalCommand.kind === "skill" ? "技能模式" : "工具模式") : null;
  const mentionTrigger = getKnowledgeMentionTrigger(input, caretIndex);
  const mentionQuery = mentionTrigger?.query ?? null;
  const normalizedMentionQuery = normalizeMentionText(mentionQuery ?? "");
  const matchesMention = (haystack: string) =>
    !normalizedMentionQuery || normalizeMentionText(haystack).includes(normalizedMentionQuery);
  const mentionSuggestions: MentionSuggestion[] = [
    ...knowledgeCollections
      .filter((collection) => {
        if (selectedKnowledgeCollection?.id === collection.id) return false;
        return matchesMention(`${collection.name} ${collection.description ?? ""}`);
      })
      .map((collection) => ({ kind: "knowledge" as const, collection })),
    ...experts
      .filter((expert) => {
        if (selectedExpert?.id === expert.id) return false;
        return matchesMention(`${expert.name} ${expert.description ?? ""} ${(expert.tags ?? []).join(" ")}`);
      })
      .map((expert) => ({ kind: "expert" as const, expert })),
  ].slice(0, 8);
  const hasComposerStatus = Boolean(
    activeModeLabel
    || builtinSessionState.goal
    || builtinSessionState.planMode
    || commandNotice
    || isCompacting
    || selectedKnowledgeCollection
    || selectedExpert
    || selectedExpertTeam
    || pendingFollowUps.length > 0,
  );
  const showMentionSuggestions = Boolean(mentionTrigger && input !== dismissedMentionInput && mentionSuggestions.length > 0);
  const showSlashSuggestions = Boolean(
    slashTrigger &&
    slashSuggestions.length > 0 &&
    !activeModeLabel &&
    input !== dismissedSlashInput &&
    !mentionTrigger,
  );
  const slashSuggestionGroups = [
    {
      commandKind: "add" as const,
      title: "添加",
      items: slashSuggestions
        .map((suggestion, index) => ({ suggestion, index }))
        .filter(({ suggestion }) => suggestion.commandKind === "add"),
    },
    {
      commandKind: "command" as const,
      title: "指令",
      items: slashSuggestions
        .map((suggestion, index) => ({ suggestion, index }))
        .filter(({ suggestion }) => suggestion.commandKind === "command"),
    },
    {
      commandKind: "tool" as const,
      title: "工具",
      items: slashSuggestions
        .map((suggestion, index) => ({ suggestion, index }))
        .filter(({ suggestion }) => suggestion.commandKind === "tool"),
    },
    {
      commandKind: "skill" as const,
      title: "技能",
      items: slashSuggestions
        .map((suggestion, index) => ({ suggestion, index }))
        .filter(({ suggestion }) => suggestion.commandKind === "skill"),
    },
  ].filter((group) => group.items.length > 0);

  useLayoutEffect(() => {
    syncTextareaHeight();
  }, [input]);

  useEffect(() => {
    if (typeof focusSignal === "number") {
      textareaRef.current?.focus();
    }
  }, [focusSignal]);

  useEffect(() => {
    setPendingFollowUps([]);
    setIsFollowUpSubmitting(false);
  }, [draftScopeKey]);

  useEffect(() => {
    if (!isLoading) {
      setPendingFollowUps([]);
      setIsFollowUpSubmitting(false);
    }
  }, [isLoading]);

  useEffect(() => {
    const scopeChanged = draftScopeKey !== lastDraftScopeRef.current;
    const signalChanged = draftSignal !== lastDraftSignalRef.current;

    if (!scopeChanged && !signalChanged) {
      return;
    }

    lastDraftScopeRef.current = draftScopeKey;
    lastDraftSignalRef.current = draftSignal;

    if (typeof draftValue === "string") {
      suppressNextDraftReportRef.current = true;
      setInput(draftValue);
      setImages(draftImages ?? []);
      setAttachments(draftAttachments ?? []);
      setCaretIndex(draftValue.length);

      if (scopeChanged) {
        setSelectedKnowledgeCollection(null);
        clearSuggestionDismissal();
        clearMentionDismissal();
      }

      if (signalChanged && !scopeChanged) {
        textareaRef.current?.focus();
      }
    }
  }, [draftImages, draftScopeKey, draftSignal, draftValue]);

  useEffect(() => {
    if (suppressNextDraftReportRef.current) {
      suppressNextDraftReportRef.current = false;
      return;
    }

    onDraftChange?.(input, images, attachments);
  }, [attachments, images, input, onDraftChange]);

  useEffect(() => {
    suggestionItemRefs.current = suggestionItemRefs.current.slice(0, slashSuggestions.length);
  }, [slashSuggestions.length]);

  useEffect(() => {
    setSelectedSuggestionIndex(0);
  }, [slashQuery, slashTrigger?.start]);

  useEffect(() => {
    knowledgeSuggestionItemRefs.current = knowledgeSuggestionItemRefs.current.slice(0, mentionSuggestions.length);
  }, [mentionSuggestions.length]);

  useEffect(() => {
    if (!showSlashSuggestions) {
      setSelectedSuggestionIndex(0);
      return;
    }

    setSelectedSuggestionIndex((current) => Math.min(current, slashSuggestions.length - 1));
  }, [slashSuggestions.length, showSlashSuggestions]);

  useEffect(() => {
    if (!showMentionSuggestions) {
      setSelectedKnowledgeIndex(0);
      return;
    }

    setSelectedKnowledgeIndex((current) => Math.min(current, mentionSuggestions.length - 1));
  }, [mentionSuggestions.length, showMentionSuggestions]);

  useEffect(() => {
    if (!showSlashSuggestions) {
      return;
    }

    scrollElementIntoView(suggestionItemRefs.current[selectedSuggestionIndex]);
  }, [selectedSuggestionIndex, showSlashSuggestions]);

  useEffect(() => {
    if (!showMentionSuggestions) {
      return;
    }

    scrollElementIntoView(knowledgeSuggestionItemRefs.current[selectedKnowledgeIndex]);
  }, [selectedKnowledgeIndex, showMentionSuggestions]);

  useEffect(() => {
    if (!dismissedSlashInput) {
      return;
    }

    if (input !== dismissedSlashInput) {
      setDismissedSlashInput("");
    }
  }, [dismissedSlashInput, input]);

  useEffect(() => {
    setDismissedSlashInput("");
  }, [caretIndex]);

  useEffect(() => {
    if (!showSlashSuggestions) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        slashSuggestionsRef.current?.contains(target)
        || textareaRef.current?.contains(target)
      ) {
        return;
      }
      setDismissedSlashInput(input);
    };

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [input, showSlashSuggestions]);

  useEffect(() => {
    if (!dismissedMentionInput) {
      return;
    }

    if (input !== dismissedMentionInput) {
      setDismissedMentionInput("");
    }
  }, [dismissedMentionInput, input]);

  useEffect(() => {
    if (!selectedKnowledgeCollection) {
      return;
    }

    if (knowledgeCollections.length > 0 && !knowledgeCollections.some((collection) => collection.id === selectedKnowledgeCollection.id)) {
      setSelectedKnowledgeCollection(null);
    }
  }, [knowledgeCollections, selectedKnowledgeCollection]);

  /**
   * 当前光标在正文中的字符偏移：上传/粘贴文件的瞬间用它定位附件应该出现在文字的哪个位置。
   * 优先读 textarea 实时的 selectionStart（点击工具栏按钮会让 textarea 失焦，但 selectionStart 通常仍在），
   * 读不到时回退到 state 里维护的 caretIndex，最后兜底为正文末尾。
   */
  const getCaretOffset = () => {
    const textarea = textareaRef.current;
    if (textarea && typeof textarea.selectionStart === "number") {
      return Math.min(textarea.selectionStart, input.length);
    }
    return Math.min(caretIndex, input.length);
  };

  const appendImageFiles = async (files: File[], insertOffset: number) => {
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      return;
    }

    const nextEntries = await Promise.all(
      imageFiles.map((file) =>
        compressImageBlob(file).then((src) => ({
          src,
          name: file.name?.trim() || "Clipboard Image.png",
          offset: insertOffset,
        })),
      ),
    );

    setImages((prev) => [...prev, ...nextEntries.filter((entry) => entry.src.length > 0)]);
  };

  const clearSuggestionDismissal = () => {
    setDismissedSlashInput("");
  };

  const clearMentionDismissal = () => {
    setDismissedMentionInput("");
  };

  const updateCaretFromTextarea = (textarea: HTMLTextAreaElement | null) => {
    if (!textarea) {
      return;
    }

    setCaretIndex(textarea.selectionStart ?? textarea.value.length);
  };

  const focusTextareaAt = (nextCaretIndex: number) => {
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }

      textarea.focus();
      textarea.setSelectionRange(nextCaretIndex, nextCaretIndex);
      setCaretIndex(nextCaretIndex);
    });
  };

  const focusComposerFromBackground = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target;
    if (
      target instanceof Element
      && target.closest("button, a, input, textarea, select, [contenteditable='true'], [role='button']")
    ) {
      return;
    }
    event.preventDefault();
    textareaRef.current?.focus();
  };

  const handleAddFiles = async () => {
    try {
      // 光标位置必须在打开对话框之前采样：对话框期间 textarea 失焦，之后读不到真实光标。
      const insertOffset = getCaretOffset();
      const selected = await open({ multiple: true, title: "选择要上传的图片或文件" });
      if (!selected) {
        return;
      }

      const paths = Array.isArray(selected) ? selected : [selected];
      const imageEntries = await Promise.all(
        paths
          .filter((path) => isImageFile(path))
          .map(async (path) => {
            try {
              const src = await readLocalImageAsDataURL(path);
              return { src, name: baseNameOf(path) };
            } catch (error) {
              console.error("读取图片失败", path, error);
              return null;
            }
          })
      );
      const validImages = imageEntries.filter((entry): entry is { src: string; name: string } => entry !== null);

      const nextAttachments: ChatAttachment[] = paths
        .filter((path) => !isImageFile(path))
        .map((path) => ({ path, name: baseNameOf(path), size: null as number | null, offset: insertOffset }));

      if (validImages.length > 0) {
        setImages((prev) => [
          ...prev,
          ...validImages.map((entry) => ({ src: entry.src, name: entry.name, offset: insertOffset })),
        ]);
      }

      setAttachments((prev) => {
        const existingPaths = new Set(prev.map((attachment) => attachment.path));
        const unique = nextAttachments.filter((attachment) => !existingPaths.has(attachment.path));
        return unique.length > 0 ? [...prev, ...unique] : prev;
      });
    } catch (error) {
      console.error("选择本地文件失败", error);
    }
  };

  /**
   * 附件按上传时的光标位置排序，让输入框里的顺序与最终消息里的顺序一致
   * （光标在前→排在前面，光标在后→排在后面）。offset 缺省视为 0。
   * 注意：排序后数组下标已不是原始下标，删除必须按 path 过滤，不能按 index。
   */
  const orderedAttachments = attachments
    .map((attachment, index) => ({ attachment, index, offset: attachment.offset ?? 0 }))
    .sort((a, b) => a.offset - b.offset || a.index - b.index)
    .map((item) => item.attachment);

  /** 图片同样按上传时的光标位置排序，与附件保持一致（光标在前→排在前面）。 */
  const orderedImages = images
    .map((image, index) => ({ image, index, offset: image.offset ?? 0 }))
    .sort((a, b) => a.offset - b.offset || a.index - b.index)
    .map((item) => item.image);

  /**
   * 输入框预览：附件与图片统一排在文字输入区之前（「统一在前方」）。
   * 不再按上传/粘贴时的光标位置（offset）排序，避免 chip 在文字中间穿插导致视觉错位。
   */
  const composedMedia = useMemo(() => {
    const items: Array<{
      kind: "image" | "attachment";
      image?: ChatImage;
      attachment?: ChatAttachment;
      key: string;
    }> = [];
    attachments.forEach((attachment) => {
      items.push({ kind: "attachment", attachment, key: attachment.path });
    });
    images.forEach((image, index) => {
      items.push({ kind: "image", image, key: `${image.src.slice(0, 24)}-${index}` });
    });
    return items;
  }, [images, attachments]);

  const stripActiveSlashToken = () => {
    const trigger = getSlashTrigger(input, textareaRef.current?.selectionStart ?? caretIndex);
    if (!trigger) {
      return;
    }
    const nextInput = `${input.slice(0, trigger.start)}${input.slice(trigger.end)}`
      .replace(/[ \t]{2,}/g, " ")
      .trim();
    setInput(nextInput);
    setCaretIndex(nextInput.length);
    clearSuggestionDismissal();
    focusTextareaAt(nextInput.length);
  };

  const applyGoalCommand = (args: string) => {
    const trimmedArgs = args.trim();
    if (!trimmedArgs) {
      const currentGoal = builtinSessionState.goal;
      setCommandNotice(
        currentGoal
          ? `当前目标：${currentGoal.objective}。可输入 /goal edit 新目标、/goal pause、/goal resume 或 /goal clear`
          : "输入目标，Omni 会在后续轮次持续围绕它推进"
      );
      setInput("/goal ");
      focusTextareaAt(6);
      return;
    }

    const [verb, ...rest] = trimmedArgs.split(/\s+/);
    const normalizedVerb = verb.toLocaleLowerCase();
    if (normalizedVerb === "pause") {
      if (!builtinSessionState.goal) {
        setCommandNotice("当前没有可暂停的目标");
        return;
      }
      setBuiltinSessionState(setBuiltinGoalPhase(builtinScopeKey, "paused"));
      setCommandNotice("目标已暂停，后续请求不会再注入该目标");
      return;
    }
    if (normalizedVerb === "resume") {
      if (!builtinSessionState.goal) {
        setCommandNotice("当前没有可恢复的目标");
        return;
      }
      setBuiltinSessionState(setBuiltinGoalPhase(builtinScopeKey, "active"));
      setCommandNotice("目标已恢复，后续请求会继续围绕它推进");
      return;
    }
    if (normalizedVerb === "clear") {
      setBuiltinSessionState(clearBuiltinGoal(builtinScopeKey));
      setCommandNotice("已清除当前目标");
      return;
    }

    const objective = normalizedVerb === "edit" ? rest.join(" ").trim() : trimmedArgs;
    if (!objective) {
      setCommandNotice("请在 /goal 后输入目标内容");
      return;
    }
    setBuiltinSessionState(setBuiltinGoal(builtinScopeKey, objective));
    setCommandNotice(`目标已${normalizedVerb === "edit" ? "更新" : "保存"}：${objective}`);
  };

  const togglePlanMode = () => {
    const nextPlanMode = !builtinSessionState.planMode;
    setBuiltinSessionState(setBuiltinPlanMode(builtinScopeKey, nextPlanMode));
    setCommandNotice(nextPlanMode
      ? "已进入计划模式：只分析并给出计划，确认后再执行"
      : "已退出计划模式");
  };

  const compactConversationNow = async () => {
    if (isCompacting) {
      return;
    }
    if (!currentModel) {
      setCommandNotice("请先配置模型，再压缩对话");
      return;
    }
    if (!sessionId || !onReplaceSessionMessages) {
      setCommandNotice("当前会话还不可压缩");
      return;
    }

    setIsCompacting(true);
    try {
      const result = await compactHistoryNow({
        model: currentModel,
        requestMessages: messages,
        modelConfig: modelRegistry.getModelConfig(currentModel),
      });
      if (!result.compaction || result.messages === messages) {
        setCommandNotice("可压缩的历史不足，当前对话保持原样");
        return;
      }
      onReplaceSessionMessages(result.messages);
      setCommandNotice(
        result.compaction.fallback
          ? "已丢弃最旧的历史消息，为当前对话释放上下文空间"
          : `已压缩 ${result.compaction.removedCount} 条较早消息`
      );
    } catch (error) {
      console.error("手动压缩对话失败", error);
      setCommandNotice("压缩失败，请稍后重试");
    } finally {
      setIsCompacting(false);
    }
  };

  const executeBuiltinCommand = async (
    command: BuiltinCommandDefinition,
    args = ""
  ) => {
    switch (command.id) {
      case "file":
        stripActiveSlashToken();
        await handleAddFiles();
        return;
      case "goal":
        applyGoalCommand(args);
        return;
      case "plan":
        stripActiveSlashToken();
        togglePlanMode();
        return;
      case "compact":
        stripActiveSlashToken();
        await compactConversationNow();
        return;
      case "permission":
        stripActiveSlashToken();
        setPermissionOpenSignal((current) => current + 1);
        return;
      case "model":
        stripActiveSlashToken();
        if (!currentModel) {
          setCommandNotice("请先在设置中配置可用模型");
          return;
        }
        setModelOpenSignal((current) => current + 1);
        return;
    }
  };

  const executeBuiltinSlashInput = async (text: string): Promise<boolean> => {
    const command = findBuiltinSlashCommand(text);
    if (!command) {
      return false;
    }
    const trimmed = text.trim();
    const token = trimmed.match(/^\/\S+/)?.[0] ?? command.command;
    const args = trimmed.slice(token.length).trim();
    await executeBuiltinCommand(command, args);
    return true;
  };

  const builtinContext = buildBuiltinSessionContext(builtinSessionState);
  const buildSendOptions = (): ChatSendOptions => ({
    hiddenContext: [
      contextPresetText?.trim(),
      builtinContext,
    ].filter(Boolean).join("\n\n") || undefined,
    knowledgeCollectionId: selectedKnowledgeCollection?.id ?? null,
    knowledgeCollectionName: selectedKnowledgeCollection?.name ?? null,
    expertId: selectedExpert?.id ?? null,
    expertName: selectedExpert?.name ?? null,
    ...(selectedExpertTeam ? { expertTeamId: selectedExpertTeam.id, expertTeamName: selectedExpertTeam.name } : {}),
    selectedMode: activeLocalCommand
      ? { kind: activeLocalCommand.kind, command: activeSlashCommand, name: activeModeLabel ?? activeSlashCommand }
      : null,
    attachments: attachments.length > 0 ? orderedAttachments : undefined,
  });

  const handleSubmit = async () => {
    if (
      (!trimmedInput && images.length === 0 && attachments.length === 0)
      || isFollowUpSubmitting
    ) {
      return;
    }

    if (activeBuiltinCommand) {
      if (await executeBuiltinSlashInput(trimmedInput)) {
        const hasGoalArguments = activeBuiltinCommand.id === "goal"
          && trimmedInput.trim() !== activeBuiltinCommand.command;
        if (activeBuiltinCommand.id !== "goal" || hasGoalArguments) {
          setInput("");
          setCaretIndex(0);
        }
        return;
      }
    }

    if (isSendBlocked) {
      return;
    }

    const submittedAsFollowUp = isLoading;
    if (submittedAsFollowUp) {
      setIsFollowUpSubmitting(true);
      try {
        await onSend(trimmedInput, images.length > 0 ? orderedImages : undefined, buildSendOptions());
      } catch {
        return;
      } finally {
        setIsFollowUpSubmitting(false);
      }
      setPendingFollowUps((current) => [
        ...current,
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          content: trimmedInput || `已追加 ${images.length + attachments.length} 个附件`,
        },
      ]);
    } else {
      void onSend(trimmedInput, images.length > 0 ? orderedImages : undefined, buildSendOptions());
    }
    setInput("");
    setImages([]);
    setAttachments([]);
    setSelectedKnowledgeCollection(null);
    setSelectedExpert(null);
    setSelectedExpertTeam(null);
    setCaretIndex(0);
    clearSuggestionDismissal();
    clearMentionDismissal();
  };

  const sendDisabledTitle = isSendBlocked ? "请先配置可用模型或等待当前会话完成" : "发送消息";

  const applySuggestion = (suggestion: SlashSuggestion) => {
    const displayedCommand = getDisplayedSuggestionCommand(suggestion);
    if (suggestion.kind === "builtin" && suggestion.builtinId !== "goal") {
      const command = findBuiltinSlashCommand(suggestion.command);
      if (command) {
        void executeBuiltinCommand(command);
      }
      return;
    }

    const textarea = textareaRef.current;
    const trigger = getSlashTrigger(input, textarea?.selectionStart ?? caretIndex);
    if (!trigger) {
      const nextInput = `${displayedCommand} `;
      setInput(nextInput);
      clearSuggestionDismissal();
      focusTextareaAt(nextInput.length);
      return;
    }

    const before = input.slice(0, trigger.start);
    const after = input.slice(trigger.end);
    const suffix = after.replace(/^[ \t]+/, "");
    const separator = suffix.length === 0 || suffix.startsWith("\n") ? (after.length === 0 ? " " : "") : " ";
    const nextInput = `${before}${displayedCommand}${separator}${suffix}`;
    const nextCaretIndex = before.length + displayedCommand.length + separator.length;
    setInput(nextInput);
    clearSuggestionDismissal();
    focusTextareaAt(nextCaretIndex);
  };

  const applyMentionSuggestion = (suggestion: MentionSuggestion) => {
    const textarea = textareaRef.current;
    const trigger = getKnowledgeMentionTrigger(input, textarea?.selectionStart ?? caretIndex);
    if (suggestion.kind === "knowledge") {
      setSelectedKnowledgeCollection(suggestion.collection);
    } else if (boundExpert && boundExpert.id !== suggestion.expert.id && onSummonExpert) {
      onSummonExpert(suggestion.expert);
    } else {
      setSelectedExpert(suggestion.expert);
      setSelectedExpertTeam(null);
    }
    clearMentionDismissal();

    if (!trigger) {
      textareaRef.current?.focus();
      return;
    }

    const before = input.slice(0, trigger.start);
    const after = input.slice(trigger.end);
    const needsSpace = before.length > 0 && !/\s$/.test(before) && after.length > 0 && !/^\s/.test(after);
    const nextInput = `${before}${needsSpace ? " " : ""}${after}`.replace(/[ \t]{2,}/g, " ");
    const nextCaretIndex = Math.min(before.length + (needsSpace ? 1 : 0), nextInput.length);
    setInput(nextInput);
    focusTextareaAt(nextCaretIndex);
  };

  useEffect(() => {
    if (!showSlashSuggestions) {
      return;
    }

    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.activeElement !== textareaRef.current) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissedSlashInput(input);
        return;
      }

      if (event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        applySuggestion(slashSuggestions[selectedSuggestionIndex] ?? slashSuggestions[0]);
      }
    };

    window.addEventListener("keydown", onWindowKeyDown, true);
    return () => window.removeEventListener("keydown", onWindowKeyDown, true);
  }, [applySuggestion, input, slashSuggestions, selectedSuggestionIndex, showSlashSuggestions]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (showMentionSuggestions && mentionSuggestions.length > 0) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissedMentionInput(input);
        return;
      }

      if (event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        applyMentionSuggestion(mentionSuggestions[selectedKnowledgeIndex] ?? mentionSuggestions[0]);
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        setSelectedKnowledgeIndex((current) => (current + 1) % mentionSuggestions.length);
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setSelectedKnowledgeIndex((current) => (current - 1 + mentionSuggestions.length) % mentionSuggestions.length);
        return;
      }

      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        applyMentionSuggestion(mentionSuggestions[selectedKnowledgeIndex] ?? mentionSuggestions[0]);
        return;
      }
    }

    if (showSlashSuggestions && slashSuggestions.length > 0) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissedSlashInput(input);
        return;
      }

      if (event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        applySuggestion(slashSuggestions[selectedSuggestionIndex] ?? slashSuggestions[0]);
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        setSelectedSuggestionIndex((current) => (current + 1) % slashSuggestions.length);
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setSelectedSuggestionIndex((current) => (current - 1 + slashSuggestions.length) % slashSuggestions.length);
        return;
      }

      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        applySuggestion(slashSuggestions[selectedSuggestionIndex] ?? slashSuggestions[0]);
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      void handleSubmit();
    }
  };

  const handlePaste = (event: React.ClipboardEvent) => {
    // 同步采样光标位置：下面的保存/压缩是异步的，届时 event 已不可用。
    const pasteOffset = getCaretOffset();

    // 剪贴板同时携带文件（CF_HDROP）时，Chromium/WebView2 会把 DataTransfer 切成「文件模式」，
    // 导致 event.clipboardData.getData("text/plain") 返回空，但系统剪贴板的 CF_UNICODETEXT 仍在。
    // 先同步取一次文字（有值就插），取不到再用 Tauri 系统级 readText() 异步补回；失败静默回退。
    const pastedText = event.clipboardData.getData("text/plain") ?? "";
    const insertPastedText = (textToInsert: string = pastedText) => {
      if (!textToInsert) return;
      setInput((current) => current.slice(0, pasteOffset) + textToInsert + current.slice(pasteOffset));
      focusTextareaAt(pasteOffset + textToInsert.length);
    };
    const fallbackReadSystemText = () => {
      void readText()
        .then((systemText) => insertPastedText(systemText ?? ""))
        .catch(() => {
          // 非 Tauri 环境或权限不足：至少保留文件。
        });
    };

    const clipboardFiles = event.clipboardData.files;
    if (clipboardFiles && clipboardFiles.length > 0) {
      event.preventDefault();
      // 先把文字插回输入框：否则上面的 preventDefault 会把文字的默认粘贴一起取消。
      insertPastedText();
      if (!pastedText) fallbackReadSystemText();

      const fileList = Array.from(clipboardFiles);
      const imageFiles = fileList.filter((file) => file.type.startsWith("image/"));
      const docFiles = fileList.filter((file) => !file.type.startsWith("image/"));

      if (imageFiles.length > 0) {
        void appendImageFiles(imageFiles, pasteOffset);
      }

      if (docFiles.length > 0) {
        void (async () => {
          const nextAttachments: ChatAttachment[] = [];
          for (const file of docFiles) {
            const attachment = await savePastedFileAttachment(file);
            if (attachment) {
              nextAttachments.push({ ...attachment, offset: pasteOffset });
            }
          }
          if (nextAttachments.length === 0) return;
          setAttachments((prev) => {
            const existingPaths = new Set(prev.map((a) => a.path));
            const unique = nextAttachments.filter((a) => !existingPaths.has(a.path));
            return unique.length > 0 ? [...prev, ...unique] : prev;
          });
        })();
      }
      return;
    }

    // 兜底：部分环境只暴露 items（如某些截图工具的剪贴板）。
    const items = event.clipboardData.items;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        event.preventDefault();
        insertPastedText();
        if (!pastedText) fallbackReadSystemText();
        const blob = item.getAsFile();
        if (blob) {
          void appendImageFiles([blob], pasteOffset);
        }
        break;
      }
    }
  };

  return (
    <div className="chat-composer">
      <div className="chat-composer__panel">
        <div className="chat-composer__body">
          {composedMedia.length > 0 && (
            <div className="chat-composer__context chat-composer__context--attachments">
              <div className="chat-composer__attachments">
                {composedMedia.map((media, index) =>
                  media.kind === "image" ? (
                    <AttachmentChip
                      key={media.key}
                      src={media.image!.src}
                      name={media.image!.name ?? `image_${index + 1}.png`}
                      index={index}
                      removable
                      onRemove={() => {
                        setImages((prev) => prev.filter((item) => item !== media.image!));
                      }}
                    />
                  ) : (
                    <AttachmentChip
                      key={media.key}
                      src={media.attachment!.path}
                      name={media.attachment!.name}
                      index={index}
                      size={media.attachment!.size}
                      removable
                      onRemove={() => setAttachments((prev) => prev.filter((item) => item !== media.attachment!))}
                    />
                  ),
                )}
              </div>
            </div>
          )}

          <div className="chat-composer__editor-wrap" onPointerDown={focusComposerFromBackground}>
            <div className="chat-composer__editor">
              {hasComposerStatus && (
                <div className="chat-composer__status">
                  {pendingFollowUps.map((followUp) => (
                    <div
                      key={followUp.id}
                      className="chat-composer__status-chip chat-composer__status-chip--pending"
                      title={`已追加到当前回答：${followUp.content}`}
                    >
                      <LoaderCircle
                        className="chat-composer__status-spinner"
                        size={13}
                        strokeWidth={1.9}
                      />
                      <span>已追加: {followUp.content}</span>
                    </div>
                  ))}
                  {isCompacting && (
                    <div className="chat-composer__status-chip chat-composer__status-chip--pending">
                      <LoaderCircle className="chat-composer__status-spinner" size={13} strokeWidth={2} />
                      <span>正在压缩较早的对话…</span>
                    </div>
                  )}
                  {builtinSessionState.goal && (
                    <div className="chat-composer__status-chip-group chat-composer__status-chip--goal">
                      <button
                        type="button"
                        className="chat-composer__status-chip-main"
                        title={builtinSessionState.goal.phase === "active" ? "点击暂停目标" : "点击恢复目标"}
                        onClick={() => {
                          const nextPhase = builtinSessionState.goal?.phase === "active" ? "paused" : "active";
                          setBuiltinSessionState(setBuiltinGoalPhase(builtinScopeKey, nextPhase));
                          setCommandNotice(nextPhase === "active" ? "目标已恢复" : "目标已暂停");
                        }}
                      >
                        <Target size={13} strokeWidth={2} />
                        <span>
                          目标{builtinSessionState.goal.phase === "paused" ? "（已暂停）" : ""}: {builtinSessionState.goal.objective}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="chat-composer__status-chip-close"
                        title="清除当前目标"
                        aria-label="清除当前目标"
                        onClick={() => {
                          setBuiltinSessionState(clearBuiltinGoal(builtinScopeKey));
                          setCommandNotice("已清除当前目标");
                        }}
                      >
                        <X size={12} strokeWidth={2} />
                      </button>
                    </div>
                  )}
                  {builtinSessionState.planMode && (
                    <button
                      type="button"
                      className="chat-composer__status-chip chat-composer__status-chip--plan"
                      title="退出计划模式"
                      onClick={togglePlanMode}
                    >
                      <ListChecks size={13} strokeWidth={2} />
                      <span>计划模式</span>
                      <X size={12} strokeWidth={2} />
                    </button>
                  )}
                  {commandNotice && (
                    <div
                      className="chat-composer__status-chip chat-composer__status-chip--notice"
                      role="status"
                      title={commandNotice}
                    >
                      <span>{commandNotice}</span>
                    </div>
                  )}
                  {activeModeLabel && activeModeTypeLabel && (
                    <button
                      type="button"
                      className="chat-composer__status-chip"
                      onClick={() => {
                        setInput((current) => current.replace(/^\/\S+\s*/, ""));
                        clearSuggestionDismissal();
                        textareaRef.current?.focus();
                      }}
                      title="清除当前模式"
                    >
                      <Bot size={13} strokeWidth={2} />
                      <span>{activeModeTypeLabel}: {activeModeLabel}</span>
                      <X size={12} strokeWidth={2} />
                    </button>
                  )}

                  {selectedKnowledgeCollection && (
                    <button
                      type="button"
                      className="chat-composer__status-chip chat-composer__status-chip--knowledge"
                      onClick={() => {
                        setSelectedKnowledgeCollection(null);
                        textareaRef.current?.focus();
                      }}
                      title="取消本次知识库选择"
                    >
                      <BookOpen size={13} strokeWidth={2} />
                      <span>@ {selectedKnowledgeCollection.name}</span>
                      <X size={12} strokeWidth={2} />
                    </button>
                  )}

                  {selectedExpert && (
                    <button
                      type="button"
                      className="chat-composer__status-chip chat-composer__status-chip--expert"
                      onClick={() => {
                        setSelectedExpert(null);
                        textareaRef.current?.focus();
                      }}
                      title="取消本次专家对话（恢复默认角色）"
                    >
                      <Bot size={13} strokeWidth={2} />
                      <span>专家: {selectedExpert.name}</span>
                      <X size={12} strokeWidth={2} />
                    </button>
                  )}
                  {selectedExpertTeam && (
                    <button
                      type="button"
                      className="chat-composer__status-chip chat-composer__status-chip--expert"
                      onClick={() => {
                        setSelectedExpertTeam(null);
                        textareaRef.current?.focus();
                      }}
                      title="取消本次专家团"
                    >
                      <UsersRound size={13} strokeWidth={2} />
                      <span>专家团: {selectedExpertTeam.name}</span>
                      <X size={12} strokeWidth={2} />
                    </button>
                  )}
                </div>
              )}
              <div
                className={`chat-composer__textarea-shell${
                  showCommandTextDecoration ? " chat-composer__textarea-shell--with-command" : ""
                }`}
              >
                {showCommandTextDecoration && (
                  <div
                    className="chat-composer__command-mirror"
                    aria-hidden="true"
                    style={{ transform: `translateY(-${textareaScrollTop}px)` }}
                  >
                    <span className="chat-composer__command-highlight">
                      {highlightedCommandToken}
                    </span>
                    {commandHighlightSuffix}
                  </div>
                )}
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(event) => {
                    setInput(event.target.value);
                    updateCaretFromTextarea(event.currentTarget);
                  }}
                  onClick={(event) => updateCaretFromTextarea(event.currentTarget)}
                  onKeyDownCapture={handleKeyDown}
                  onKeyUp={(event) => updateCaretFromTextarea(event.currentTarget)}
                  onPaste={handlePaste}
                  onSelect={(event) => updateCaretFromTextarea(event.currentTarget)}
                  onScroll={(event) => setTextareaScrollTop(event.currentTarget.scrollTop)}
                  placeholder="输入聊天内容..."
                  className={`chat-composer__textarea hide-scrollbar${
                    showCommandTextDecoration ? " chat-composer__textarea--command-active" : ""
                  }`}
                  aria-autocomplete={showSlashSuggestions ? "list" : undefined}
                  aria-controls={showSlashSuggestions ? "chat-slash-command-listbox" : undefined}
                  aria-activedescendant={
                    showSlashSuggestions
                      ? `chat-slash-command-option-${selectedSuggestionIndex}`
                      : undefined
                  }
                  rows={1}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="chat-composer__footer">
          <div className="chat-composer__footer-row">
            <div className="chat-composer__footer-tools">
              <div className="chat-composer__add-menu" ref={toolbarPickerRef}>
                <button
                  type="button"
                  className={`chat-composer__tool-button chat-composer__tool-button--add${isAddMenuOpen ? " chat-composer__tool-button--active" : ""}`}
                  title="添加文件或选择对话方式"
                  aria-label="添加"
                  aria-expanded={isAddMenuOpen}
                  onClick={() => {
                    if (isAddMenuOpen) {
                      setIsAddMenuOpen(false);
                      setOpenToolbarPicker(null);
                    } else {
                      setIsAddMenuOpen(true);
                    }
                  }}
                >
                  <Plus size={20} strokeWidth={1.8} />
                </button>
                {isAddMenuOpen && (
                  <div className="chat-composer__add-panel" role="group" aria-label="添加与选择">
                    <div className="chat-composer__add-panel-main">
                      <button
                        type="button"
                        className="chat-composer__add-menu-item"
                        aria-label="上传图片或文件"
                        onClick={() => {
                          setIsAddMenuOpen(false);
                          setOpenToolbarPicker(null);
                          void handleAddFiles();
                        }}
                      >
                        <Paperclip size={17} strokeWidth={1.8} />
                        <span>添加文件</span>
                      </button>
                      <div className="chat-composer__add-menu-divider" />
                      <button
                        type="button"
                        className={`chat-composer__add-menu-item${openToolbarPicker === "expert" ? " chat-composer__add-menu-item--active" : ""}`}
                        aria-label="召唤专家"
                        aria-expanded={openToolbarPicker === "expert"}
                        onMouseEnter={() => setOpenToolbarPicker("expert")}
                        onFocus={() => setOpenToolbarPicker("expert")}
                        onClick={() => setOpenToolbarPicker("expert")}
                      >
                        <Bot size={17} strokeWidth={1.8} />
                        <span>专家</span>
                        <ChevronRight size={15} className="chat-composer__add-menu-chevron" />
                      </button>
                      <button
                        type="button"
                        className={`chat-composer__add-menu-item${openToolbarPicker === "team" ? " chat-composer__add-menu-item--active" : ""}`}
                        title={boundExpert ? "当前会话已绑定专家，专家团请在新对话中使用" : undefined}
                        aria-label="选择专家团"
                        aria-expanded={openToolbarPicker === "team"}
                        disabled={Boolean(boundExpert)}
                        onMouseEnter={() => setOpenToolbarPicker("team")}
                        onFocus={() => setOpenToolbarPicker("team")}
                        onClick={() => setOpenToolbarPicker("team")}
                      >
                        <UsersRound size={17} strokeWidth={1.8} />
                        <span>专家团</span>
                        <ChevronRight size={15} className="chat-composer__add-menu-chevron" />
                      </button>
                      <button
                        type="button"
                        className={`chat-composer__add-menu-item${openToolbarPicker === "knowledge" ? " chat-composer__add-menu-item--active" : ""}`}
                        aria-label="选择知识库"
                        aria-expanded={openToolbarPicker === "knowledge"}
                        onMouseEnter={() => setOpenToolbarPicker("knowledge")}
                        onFocus={() => setOpenToolbarPicker("knowledge")}
                        onClick={() => setOpenToolbarPicker("knowledge")}
                      >
                        <BookOpen size={17} strokeWidth={1.8} />
                        <span>知识库</span>
                        <ChevronRight size={15} className="chat-composer__add-menu-chevron" />
                      </button>
                    </div>
                    {openToolbarPicker === "expert" && (
                      <div className="chat-composer__picker chat-composer__picker--choice" role="group" aria-label="选择专家">
                        <div className="chat-composer__picker-heading">召唤专家</div>
                        {experts.map((expert) => (
                          <button
                            key={expert.id}
                            type="button"
                            className={`chat-composer__picker-option${(selectedExpert?.id ?? boundExpert?.id) === expert.id ? " chat-composer__picker-option--selected" : ""}`}
                            disabled={Boolean(!onSummonExpert && boundExpert && boundExpert.id !== expert.id)}
                            onClick={() => {
                              setOpenToolbarPicker(null);
                              setIsAddMenuOpen(false);
                              if (onSummonExpert) {
                                onSummonExpert(expert);
                              } else {
                                setSelectedExpert(expert);
                                setSelectedExpertTeam(null);
                                textareaRef.current?.focus();
                              }
                            }}
                          >
                            <span className="chat-composer__picker-option-copy">
                              <strong>{expert.name}</strong>
                              <small>{onSummonExpert ? "召唤会新建绑定此专家的对话" : expert.description}</small>
                            </span>
                            {(selectedExpert?.id ?? boundExpert?.id) === expert.id && <Check size={15} />}
                          </button>
                        ))}
                        {experts.length === 0 && <div className="chat-composer__picker-empty">暂无可用专家</div>}
                      </div>
                    )}
                    {openToolbarPicker === "team" && (
                      <div className="chat-composer__picker chat-composer__picker--choice" role="group" aria-label="选择专家团">
                        <div className="chat-composer__picker-heading">本轮协作专家团</div>
                        {expertTeams.map((team) => (
                          <button
                            key={team.id}
                            type="button"
                            className={`chat-composer__picker-option${selectedExpertTeam?.id === team.id ? " chat-composer__picker-option--selected" : ""}`}
                            onClick={() => {
                              setSelectedExpertTeam(team);
                              setSelectedExpert(null);
                              setOpenToolbarPicker(null);
                              setIsAddMenuOpen(false);
                              textareaRef.current?.focus();
                            }}
                          >
                            <span className="chat-composer__picker-option-copy">
                              <strong>{team.name}</strong>
                              <small>{team.members.length} 位成员{team.description ? ` · ${team.description}` : ""}</small>
                            </span>
                            {selectedExpertTeam?.id === team.id && <Check size={15} />}
                          </button>
                        ))}
                        {expertTeams.length === 0 && <div className="chat-composer__picker-empty">请先在扩展中心创建专家并配置专家团</div>}
                      </div>
                    )}
                    {openToolbarPicker === "knowledge" && (
                      <div className="chat-composer__picker chat-composer__picker--choice" role="group" aria-label="选择知识库">
                        <div className="chat-composer__picker-heading">本轮检索范围</div>
                        <button
                          type="button"
                          className={`chat-composer__picker-option${selectedKnowledgeCollection ? "" : " chat-composer__picker-option--selected"}`}
                          onClick={() => {
                            setSelectedKnowledgeCollection(null);
                            setOpenToolbarPicker(null);
                            setIsAddMenuOpen(false);
                            textareaRef.current?.focus();
                          }}
                        >
                          <span className="chat-composer__picker-option-copy">
                            <strong>不指定知识库</strong>
                            <small>不限定到某一个知识库</small>
                          </span>
                          {!selectedKnowledgeCollection && <Check size={15} />}
                        </button>
                        {knowledgeCollections.map((collection) => (
                          <button
                            key={collection.id}
                            type="button"
                            className={`chat-composer__picker-option${selectedKnowledgeCollection?.id === collection.id ? " chat-composer__picker-option--selected" : ""}`}
                            onClick={() => {
                              setSelectedKnowledgeCollection(collection);
                              setOpenToolbarPicker(null);
                              setIsAddMenuOpen(false);
                              textareaRef.current?.focus();
                            }}
                          >
                            <span className="chat-composer__picker-option-copy">
                              <strong>{collection.name}</strong>
                              {collection.description && <small>{collection.description}</small>}
                            </span>
                            {selectedKnowledgeCollection?.id === collection.id && <Check size={15} />}
                          </button>
                        ))}
                        {knowledgeCollections.length === 0 && <div className="chat-composer__picker-empty">暂无可用知识库</div>}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <PermissionModeSelector openSignal={permissionOpenSignal} />
            </div>
            <div className="chat-composer__footer-actions">
              {typeof currentModel === "string" && (
                <div className="chat-composer__model">
                  <ModelSelector
                    currentModel={currentModel}
                    onModelChange={onModelChange ?? (() => undefined)}
                    title={modelTitle}
                    openSignal={modelOpenSignal}
                  />
                </div>
              )}
              {isLoading ? (
                <button
                  onClick={onStop}
                  className="chat-composer__submit chat-composer__submit--stop"
                  title="停止生成"
                  type="button"
                >
                  <Square className="chat-composer__submit-icon" size={18} strokeWidth={1.8} fill="currentColor" />
                </button>
              ) : (
                <button
                  onClick={() => void handleSubmit()}
                  disabled={isSendBlocked || (!trimmedInput && images.length === 0 && attachments.length === 0)}
                  className="chat-composer__submit"
                  title={sendDisabledTitle}
                  type="button"
                >
                  <Send className="chat-composer__submit-icon" size={18} strokeWidth={1.8} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <ChatStatsLine
        messages={messages}
        sessionUsage={sessionUsage}
        contextUsage={contextUsage}
        isLoading={isLoading}
      />

      {showSlashSuggestions && (
        <div
          ref={slashSuggestionsRef}
          id="chat-slash-command-listbox"
          className="chat-composer__suggestions chat-composer__suggestions--slash"
          role="listbox"
          aria-label="斜杠命令"
        >
          <div className="chat-composer__suggestions-list">
            {slashSuggestionGroups.map((group) => (
              <div
                key={group.commandKind}
                className="chat-composer__suggestion-group"
                role="group"
                aria-labelledby={`chat-slash-command-group-${group.commandKind}`}
              >
                <div
                  id={`chat-slash-command-group-${group.commandKind}`}
                  className="chat-composer__suggestion-group-title"
                >
                  {group.title}
                </div>
                {group.items.map(({ suggestion, index }) => {
                  const displayedCommand = getDisplayedSuggestionCommand(suggestion);
                  const showTitle = hasDistinctSuggestionTitle(displayedCommand, suggestion.title);
                  const showTitleFirst = suggestion.kind === "builtin" && showTitle;
                  return (
                    <button
                      id={`chat-slash-command-option-${index}`}
                      key={`${suggestion.commandKind}-${suggestion.id}`}
                      ref={(element) => {
                        suggestionItemRefs.current[index] = element;
                      }}
                      type="button"
                      role="option"
                      aria-selected={selectedSuggestionIndex === index}
                      className={`chat-composer__suggestion chat-composer__suggestion--${suggestion.commandKind}${
                        selectedSuggestionIndex === index ? " chat-composer__suggestion--active" : ""
                      }`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => applySuggestion(suggestion)}
                      onMouseEnter={() => setSelectedSuggestionIndex(index)}
                    >
                      <span className="chat-composer__suggestion-icon" aria-hidden="true">
                        <Command className="chat-composer__suggestion-command-icon" size={15} strokeWidth={1.8} />
                      </span>
                      <span
                        className={`chat-composer__suggestion-copy${
                          showTitle ? " chat-composer__suggestion-copy--with-title" : ""
                        }${showTitleFirst ? " chat-composer__suggestion-copy--title-first" : ""}`}
                      >
                        {showTitleFirst && <span className="chat-composer__suggestion-title">{suggestion.title}</span>}
                        <span className="chat-composer__suggestion-command">{displayedCommand}</span>
                        {showTitle && !showTitleFirst && <span className="chat-composer__suggestion-title">{suggestion.title}</span>}
                        <span className="chat-composer__suggestion-description">{suggestion.description}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      {showMentionSuggestions && (
        <div className="chat-composer__suggestions chat-composer__suggestions--knowledge">
          <div className="chat-composer__suggestions-list">
            <div className="chat-composer__suggestion-group">
              <div className="chat-composer__suggestion-group-title">选择知识库或专家</div>
              {mentionSuggestions.map((suggestion, index) => {
                const isExpert = suggestion.kind === "expert";
                const title = isExpert
                  ? `@ ${suggestion.expert.name}`
                  : `@ ${suggestion.collection.name}`;
                const description = isExpert
                  ? suggestion.expert.description?.trim() || "本轮对话切换为该专家"
                  : suggestion.collection.description?.trim() || "使用该知识库回答本次问题";
                return (
                  <button
                    key={isExpert ? `expert-${suggestion.expert.id}` : `knowledge-${suggestion.collection.id}`}
                    ref={(element) => {
                      knowledgeSuggestionItemRefs.current[index] = element;
                    }}
                    type="button"
                    className={`chat-composer__suggestion chat-composer__suggestion--knowledge${
                      selectedKnowledgeIndex === index ? " chat-composer__suggestion--active" : ""
                    }`}
                    onClick={() => applyMentionSuggestion(suggestion)}
                    onMouseEnter={() => setSelectedKnowledgeIndex(index)}
                  >
                    <span className="chat-composer__suggestion-icon" aria-hidden="true">
                      {isExpert ? <Bot size={15} strokeWidth={1.8} /> : <BookOpen size={15} strokeWidth={1.8} />}
                    </span>
                    <span className="chat-composer__suggestion-copy chat-composer__suggestion-copy--knowledge">
                      <span className="chat-composer__suggestion-command">{title}</span>
                      <span className="chat-composer__suggestion-description">{description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
