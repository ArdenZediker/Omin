import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
import type { ChatAttachment } from "../adapters/types";
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
  onSend: (content: string, images?: string[], options?: ChatSendOptions) => void | Promise<void>;
  isLoading: boolean;
  isSendBlocked?: boolean;
  onStop: () => void;
  focusSignal?: number;
  draftScopeKey?: string;
  draftValue?: string;
  draftImages?: string[];
  draftAttachments?: ChatAttachment[];
  draftSignal?: number;
  onDraftChange?: (text: string, images: string[], attachments: ChatAttachment[]) => void;
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
  const [images, setImages] = useState<string[]>([]);
  const [imageNames, setImageNames] = useState<string[]>([]);
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
      setImageNames((draftImages ?? []).map((_, imageIndex) => `image_${imageIndex + 1}.png`));
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

  const appendImageFiles = async (files: File[]) => {
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      return;
    }

    const nextEntries = await Promise.all(
      imageFiles.map((file) =>
        compressImageBlob(file).then((src) => ({
          src,
          name: file.name?.trim() || "Clipboard Image.png",
        })),
      ),
    );

    setImages((prev) => [...prev, ...nextEntries.map((entry) => entry.src)]);
    setImageNames((prev) => [...prev, ...nextEntries.map((entry) => entry.name)]);
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
        .map((path) => ({ path, name: baseNameOf(path), size: null as number | null }));

      if (validImages.length > 0) {
        setImages((prev) => [...prev, ...validImages.map((entry) => entry.src)]);
        setImageNames((prev) => [...prev, ...validImages.map((entry) => entry.name)]);
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

  const buildSendOptions = (): ChatSendOptions => ({
    hiddenContext: contextPresetText?.trim() ? contextPresetText : undefined,
    knowledgeCollectionId: selectedKnowledgeCollection?.id ?? null,
    attachments: attachments.length > 0 ? attachments : undefined,
  });

  const handleSubmit = () => {
    if ((!trimmedInput && images.length === 0 && attachments.length === 0) || isLoading || isSendBlocked) {
      return;
    }

    void onSend(trimmedInput, images.length > 0 ? images : undefined, buildSendOptions());
    setInput("");
    setImages([]);
    setImageNames([]);
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
    const clipboardFiles = event.clipboardData.files;
    if (clipboardFiles && clipboardFiles.length > 0) {
      event.preventDefault();
      const fileList = Array.from(clipboardFiles);
      const imageFiles = fileList.filter((file) => file.type.startsWith("image/"));
      const docFiles = fileList.filter((file) => !file.type.startsWith("image/"));

      if (imageFiles.length > 0) {
        void appendImageFiles(imageFiles);
      }

      if (docFiles.length > 0) {
        void (async () => {
          const nextAttachments: ChatAttachment[] = [];
          for (const file of docFiles) {
            const attachment = await savePastedFileAttachment(file);
            if (attachment) {
              nextAttachments.push(attachment);
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
          void appendImageFiles([blob]);
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
          {images.length > 0 && (
            <div className="chat-composer__attachments">
              {images.map((img, index) => (
                <AttachmentChip
                  key={`${img.slice(0, 24)}-${index}`}
                  src={img}
                  name={imageNames[index]}
                  index={index}
                  removable
                  onRemove={() => {
                    setImages((prev) => prev.filter((_, imageIndex) => imageIndex !== index));
                    setImageNames((prev) => prev.filter((_, imageIndex) => imageIndex !== index));
                  }}
                />
              ))}
            </div>
          )}
          {attachments.length > 0 && (
            <div className="chat-composer__attachments">
              {attachments.map((attachment, index) => (
                <AttachmentChip
                  key={attachment.path}
                  src={attachment.path}
                  name={attachment.name}
                  index={index}
                  size={attachment.size}
                  removable
                  onRemove={() => setAttachments((prev) => prev.filter((_, attachmentIndex) => attachmentIndex !== index))}
                />
              ))}
            </div>
          )}
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
