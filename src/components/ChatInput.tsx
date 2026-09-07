import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Bot,
  CirclePlus,
  Paperclip,
  Send,
  Square,
  X,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { buildSlashDraft, getAllLocalCommands, getMatchingSlashSuggestions, type SlashSuggestion } from "../chat/skills";
import type { KnowledgeCollection } from "../chat/knowledgeTypes";
import type { ChatAttachment, ChatImage } from "../adapters/types";
import type { ChatSendOptions } from "../chat/types";
import PermissionModeSelector from "./PermissionModeSelector";
import AttachmentChip from "./AttachmentChip";
import { baseNameOf, isImageFile, readLocalImageAsDataURL, savePastedFileAttachment, compressImageBlob } from "./attachmentUtils";

interface ChatInputProps {
  canStartNewTopic?: boolean;
  allowedToolIds?: string[];
  allowedSkillIds?: string[];
  hasConversation?: boolean;
  usageLabel?: string | null;
  contextPresetText?: string;
  knowledgeCollections?: KnowledgeCollection[];
  onStartNewTopic?: () => void;
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
  fixedHeight?: number | null;
  onSubmit?: () => void;
}

type KnowledgeMentionTrigger = {
  start: number;
  end: number;
  query: string;
};

function normalizeMentionText(value: string) {
  return value.trim().toLocaleLowerCase();
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

function SuggestionIcon() {
  return <CirclePlus size={16} strokeWidth={1.8} />;
}

export default function ChatInput({
  allowedToolIds,
  allowedSkillIds,
  usageLabel,
  contextPresetText,
  onSend,
  knowledgeCollections = [],
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
  fixedHeight,
  onSubmit,
}: ChatInputProps) {
  const [input, setInput] = useState("");
  const [images, setImages] = useState<ChatImage[]>([]);
  /** 非图片类本地文件附件（绝对路径引用；不内联内容，发送时注入 prompt 让模型用 /read_file 读取） */
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const [dismissedSlashInput, setDismissedSlashInput] = useState("");
  const [selectedKnowledgeCollection, setSelectedKnowledgeCollection] = useState<KnowledgeCollection | null>(null);
  const [selectedKnowledgeIndex, setSelectedKnowledgeIndex] = useState(0);
  const [dismissedMentionInput, setDismissedMentionInput] = useState("");
  const [caretIndex, setCaretIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const suggestionItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const knowledgeSuggestionItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const lastDraftScopeRef = useRef<string | undefined>(undefined);
  const lastDraftSignalRef = useRef<number | undefined>(undefined);
  const suppressNextDraftReportRef = useRef(false);

  const syncTextareaHeight = () => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    // 固定高度模式下由外层容器高度控制，textarea 内部滚动，不再自动撑开。
    if (fixedHeight) {
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

  const matchedSuggestions = getMatchingSlashSuggestions(input, allowedToolIds, allowedSkillIds);
  const localSuggestions = matchedSuggestions.filter((suggestion) => suggestion.kind === "local");
  const trimmedInput = input.trim();
  const activeSlashCommand = trimmedInput.startsWith("/") ? trimmedInput.split(/\s+/)[0].toLowerCase() : "";
  const activeLocalCommand = getAllLocalCommands().find((item) => item.command === activeSlashCommand) ?? null;
  const activeModeLabel = activeLocalCommand?.title ?? null;
  const activeModeTypeLabel = activeLocalCommand ? (activeLocalCommand.kind === "skill" ? "技能模式" : "工具模式") : null;
  const mentionTrigger = getKnowledgeMentionTrigger(input, caretIndex);
  const mentionQuery = mentionTrigger?.query ?? null;
  const normalizedMentionQuery = normalizeMentionText(mentionQuery ?? "");
  const knowledgeSuggestions = knowledgeCollections
    .filter((collection) => {
      if (selectedKnowledgeCollection?.id === collection.id) {
        return false;
      }
      if (!normalizedMentionQuery) {
        return true;
      }
      return normalizeMentionText(`${collection.name} ${collection.description ?? ""}`).includes(normalizedMentionQuery);
    })
    .slice(0, 8);
  const hasComposerStatus = Boolean(activeModeLabel || selectedKnowledgeCollection);
  const canShowKnowledgeSuggestions = Boolean(mentionTrigger && input !== dismissedMentionInput && knowledgeCollections.length > 0);
  const showKnowledgeSuggestions = canShowKnowledgeSuggestions && knowledgeSuggestions.length > 0;
  const showSlashSuggestions =
    localSuggestions.length > 0 &&
    !activeModeLabel &&
    trimmedInput.startsWith("/") &&
    input !== dismissedSlashInput &&
    !mentionTrigger;

  useLayoutEffect(() => {
    syncTextareaHeight();
  }, [input]);

  useEffect(() => {
    if (typeof focusSignal === "number") {
      textareaRef.current?.focus();
    }
  }, [focusSignal]);

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
    suggestionItemRefs.current = suggestionItemRefs.current.slice(0, localSuggestions.length);
  }, [localSuggestions.length]);

  useEffect(() => {
    knowledgeSuggestionItemRefs.current = knowledgeSuggestionItemRefs.current.slice(0, knowledgeSuggestions.length);
  }, [knowledgeSuggestions.length]);

  useEffect(() => {
    if (!showSlashSuggestions) {
      setSelectedSuggestionIndex(0);
      return;
    }

    setSelectedSuggestionIndex((current) => Math.min(current, localSuggestions.length - 1));
  }, [localSuggestions.length, showSlashSuggestions]);

  useEffect(() => {
    if (!showKnowledgeSuggestions) {
      setSelectedKnowledgeIndex(0);
      return;
    }

    setSelectedKnowledgeIndex((current) => Math.min(current, knowledgeSuggestions.length - 1));
  }, [knowledgeSuggestions.length, showKnowledgeSuggestions]);

  useEffect(() => {
    if (!showSlashSuggestions) {
      return;
    }

    scrollElementIntoView(suggestionItemRefs.current[selectedSuggestionIndex]);
  }, [selectedSuggestionIndex, showSlashSuggestions]);

  useEffect(() => {
    if (!showKnowledgeSuggestions) {
      return;
    }

    scrollElementIntoView(knowledgeSuggestionItemRefs.current[selectedKnowledgeIndex]);
  }, [selectedKnowledgeIndex, showKnowledgeSuggestions]);

  useEffect(() => {
    if (!dismissedSlashInput) {
      return;
    }

    if (input !== dismissedSlashInput) {
      setDismissedSlashInput("");
    }
  }, [dismissedSlashInput, input]);

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
   * 输入框预览：把图片与附件合并成同一个按 offset 排序的流，
   * 让「输入框里看到的顺序」与「发送后消息里的交错顺序」保持一致。
   * offset 相同则按添加先后（全局 seq）排列——与 ChatMessage.buildUserMessageSegments 的稳定排序语义一致。
   */
  const composedMedia = useMemo(() => {
    const items: Array<{
      kind: "image" | "attachment";
      offset: number;
      seq: number;
      image?: ChatImage;
      attachment?: ChatAttachment;
      key: string;
    }> = [];
    let seq = 0;
    images.forEach((image, index) => {
      items.push({ kind: "image", offset: image.offset ?? 0, seq: seq++, image, key: `${image.src.slice(0, 24)}-${index}` });
    });
    attachments.forEach((attachment) => {
      items.push({ kind: "attachment", offset: attachment.offset ?? 0, seq: seq++, attachment, key: attachment.path });
    });
    items.sort((a, b) => a.offset - b.offset || a.seq - b.seq);
    return items;
  }, [images, attachments]);

  const buildSendOptions = (): ChatSendOptions => ({
    hiddenContext: contextPresetText?.trim() ? contextPresetText : undefined,
    knowledgeCollectionId: selectedKnowledgeCollection?.id ?? null,
    attachments: attachments.length > 0 ? orderedAttachments : undefined,
  });

  const handleSubmit = () => {
    if ((!trimmedInput && images.length === 0 && attachments.length === 0) || isLoading || isSendBlocked) {
      return;
    }

    void onSend(trimmedInput, images.length > 0 ? orderedImages : undefined, buildSendOptions());
    setInput("");
    setImages([]);
    setAttachments([]);
    setSelectedKnowledgeCollection(null);
    setCaretIndex(0);
    clearSuggestionDismissal();
    clearMentionDismissal();
    onSubmit?.();
  };

  const sendDisabledTitle = isSendBlocked ? "请先配置可用模型或等待当前会话完成" : "发送消息";

  const applySuggestion = (suggestion: SlashSuggestion) => {
    setInput(buildSlashDraft(suggestion));
    clearSuggestionDismissal();
    textareaRef.current?.focus();
  };

  const applyKnowledgeSuggestion = (collection: KnowledgeCollection) => {
    const textarea = textareaRef.current;
    const trigger = getKnowledgeMentionTrigger(input, textarea?.selectionStart ?? caretIndex);
    setSelectedKnowledgeCollection(collection);
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
      if (document.activeElement !== textareaRef.current) {
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
        applySuggestion(localSuggestions[selectedSuggestionIndex] ?? localSuggestions[0]);
      }
    };

    window.addEventListener("keydown", onWindowKeyDown, true);
    return () => window.removeEventListener("keydown", onWindowKeyDown, true);
  }, [applySuggestion, input, localSuggestions, selectedSuggestionIndex, showSlashSuggestions]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (showKnowledgeSuggestions && knowledgeSuggestions.length > 0) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissedMentionInput(input);
        return;
      }

      if (event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        applyKnowledgeSuggestion(knowledgeSuggestions[selectedKnowledgeIndex] ?? knowledgeSuggestions[0]);
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        setSelectedKnowledgeIndex((current) => (current + 1) % knowledgeSuggestions.length);
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setSelectedKnowledgeIndex((current) => (current - 1 + knowledgeSuggestions.length) % knowledgeSuggestions.length);
        return;
      }

      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        applyKnowledgeSuggestion(knowledgeSuggestions[selectedKnowledgeIndex] ?? knowledgeSuggestions[0]);
        return;
      }
    }

    if (showSlashSuggestions && localSuggestions.length > 0) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissedSlashInput(input);
        return;
      }

      if (event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        applySuggestion(localSuggestions[selectedSuggestionIndex] ?? localSuggestions[0]);
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        setSelectedSuggestionIndex((current) => (current + 1) % localSuggestions.length);
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setSelectedSuggestionIndex((current) => (current - 1 + localSuggestions.length) % localSuggestions.length);
        return;
      }

      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        applySuggestion(localSuggestions[selectedSuggestionIndex] ?? localSuggestions[0]);
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      handleSubmit();
    }
  };

  const handlePaste = (event: React.ClipboardEvent) => {
    // 同步采样光标位置：下面的保存/压缩是异步的，届时 event 已不可用。
    const pasteOffset = getCaretOffset();
    const clipboardFiles = event.clipboardData.files;
    if (clipboardFiles && clipboardFiles.length > 0) {
      event.preventDefault();
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
        const blob = item.getAsFile();
        if (blob) {
          void appendImageFiles([blob], pasteOffset);
        }
        break;
      }
    }
  };

  return (
    <div className={`chat-composer${fixedHeight ? " chat-composer--fixed-height" : ""}`}>
      {hasComposerStatus && (
        <div className="chat-composer__status">
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
              <Bot size={13} strokeWidth={1.9} />
              <span>
                {activeModeTypeLabel}: {activeModeLabel}
              </span>
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
              <BookOpen size={13} strokeWidth={1.9} />
              <span>@ {selectedKnowledgeCollection.name}</span>
              <X size={12} strokeWidth={2} />
            </button>
          )}

        </div>
      )}

      <div className="chat-composer__panel">
        <div className="chat-composer__toolbar">
          <PermissionModeSelector />

          <div className="chat-composer__toolbar-group">
            <button
              type="button"
              className="chat-composer__tool-button"
              title="上传图片或文件（随消息让模型读取）"
              onClick={() => void handleAddFiles()}
            >
              <Paperclip size={16} strokeWidth={1.8} />
            </button>
          </div>

          <div className="chat-composer__toolbar-badge">{usageLabel ?? "--"}</div>

        </div>

        <div className="chat-composer__body">
          <div className="chat-composer__editor-wrap">
            <div className="chat-composer__editor">
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
                placeholder="输入聊天内容..."
                className="chat-composer__textarea hide-scrollbar"
                rows={1}
                disabled={isLoading}
              />
            </div>
          </div>
          {composedMedia.length > 0 && (
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
                      setImages((prev) => prev.filter((item) => item.src !== media.image!.src));
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
                    onRemove={() => setAttachments((prev) => prev.filter((item) => item.path !== media.attachment!.path))}
                  />
                ),
              )}
            </div>
          )}
        </div>

        <div className="chat-composer__footer">
          <div className="chat-composer__footer-row">
            <div className="chat-composer__footer-hint">Enter 发送 / Shift + Enter 换行</div>
            <div className="chat-composer__footer-actions">
              {isLoading ? (
                <button onClick={onStop} className="chat-composer__submit" title="停止生成" type="button">
                  <Square className="chat-composer__submit-icon" size={18} strokeWidth={2} fill="currentColor" />
                </button>
              ) : (
                <button
                  onClick={handleSubmit}
                  disabled={isSendBlocked || (!trimmedInput && images.length === 0)}
                  className="chat-composer__submit"
                  title={sendDisabledTitle}
                  type="button"
                >
                  <Send className="chat-composer__submit-icon" size={18} strokeWidth={2} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {showSlashSuggestions && (
        <div className="chat-composer__suggestions">
          <div className="chat-composer__suggestions-list">
            <div className="chat-composer__suggestion-group">
              <div className="chat-composer__suggestion-group-title">本地命令</div>
              {localSuggestions.map((suggestion, index) => (
                <button
                  key={`${suggestion.kind}-${suggestion.id}`}
                  ref={(element) => {
                    suggestionItemRefs.current[index] = element;
                  }}
                  type="button"
                  className={`chat-composer__suggestion${selectedSuggestionIndex === index ? " chat-composer__suggestion--active" : ""}`}
                  onClick={() => applySuggestion(suggestion)}
                  onMouseEnter={() => setSelectedSuggestionIndex(index)}
                >
                  <span className="chat-composer__suggestion-icon" aria-hidden="true">
                    <SuggestionIcon />
                  </span>
                  <span className="chat-composer__suggestion-copy">
                    <span className="chat-composer__suggestion-command">{suggestion.command}</span>
                    <span className="chat-composer__suggestion-description">{suggestion.description}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {showKnowledgeSuggestions && (
        <div className="chat-composer__suggestions chat-composer__suggestions--knowledge">
          <div className="chat-composer__suggestions-list">
            <div className="chat-composer__suggestion-group">
              <div className="chat-composer__suggestion-group-title">选择知识库</div>
              {knowledgeSuggestions.map((collection, index) => (
                <button
                  key={collection.id}
                  ref={(element) => {
                    knowledgeSuggestionItemRefs.current[index] = element;
                  }}
                  type="button"
                  className={`chat-composer__suggestion chat-composer__suggestion--knowledge${
                    selectedKnowledgeIndex === index ? " chat-composer__suggestion--active" : ""
                  }`}
                  onClick={() => applyKnowledgeSuggestion(collection)}
                  onMouseEnter={() => setSelectedKnowledgeIndex(index)}
                >
                  <span className="chat-composer__suggestion-icon" aria-hidden="true">
                    <BookOpen size={15} strokeWidth={1.9} />
                  </span>
                  <span className="chat-composer__suggestion-copy chat-composer__suggestion-copy--knowledge">
                    <span className="chat-composer__suggestion-command">@ {collection.name}</span>
                    <span className="chat-composer__suggestion-description">
                      {collection.description?.trim() || "使用该知识库回答本次问题"}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
