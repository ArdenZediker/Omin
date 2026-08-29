import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  Bot,
  CirclePlus,
  Eraser,
  Paperclip,
  Pencil,
  Pin,
  Settings,
  Square,
  X,
} from "lucide-react";
import { buildSlashDraft, getAllLocalCommands, getMatchingSlashSuggestions, type SlashSuggestion } from "../chat/skills";
import type { KnowledgeCollection } from "../chat/knowledgeTypes";
import type { ChatSendOptions } from "../chat/types";

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
  draftSignal?: number;
  onDraftChange?: (text: string, images: string[]) => void;
  fixedHeight?: number | null;
  onSubmit?: () => void;
}

const LOCAL_COMMAND_ICON_MAP: Record<string, React.ComponentType<{ size?: number; strokeWidth?: number }>> = {
  new: CirclePlus,
  clear: Eraser,
  settings: Settings,
  model: Bot,
  rename: Pencil,
  pin: Pin,
};

const IMMEDIATE_COMMAND_IDS = new Set(["new", "clear", "settings", "pet", "pin"]);
const IMMEDIATE_COMMAND_PAYLOADS: Record<string, string> = {
  pet: "/pet",
};

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

function SuggestionIcon({ suggestion }: { suggestion: SlashSuggestion }) {
  const Icon = LOCAL_COMMAND_ICON_MAP[suggestion.id] ?? CirclePlus;
  return <Icon size={16} strokeWidth={1.8} />;
}

export default function ChatInput({
  canStartNewTopic = false,
  allowedToolIds,
  allowedSkillIds,
  hasConversation = false,
  usageLabel,
  contextPresetText,
  onStartNewTopic,
  onSend,
  knowledgeCollections = [],
  isLoading,
  isSendBlocked = false,
  onStop,
  focusSignal,
  draftScopeKey,
  draftValue,
  draftImages,
  draftSignal,
  onDraftChange,
  fixedHeight,
  onSubmit,
}: ChatInputProps) {
  const [input, setInput] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const [dismissedSlashInput, setDismissedSlashInput] = useState("");
  const [selectedKnowledgeCollection, setSelectedKnowledgeCollection] = useState<KnowledgeCollection | null>(null);
  const [selectedKnowledgeIndex, setSelectedKnowledgeIndex] = useState(0);
  const [dismissedMentionInput, setDismissedMentionInput] = useState("");
  const [caretIndex, setCaretIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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
  const hasComposerStatus = Boolean(activeModeLabel || selectedKnowledgeCollection || images.length > 0);
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

    onDraftChange?.(input, images);
  }, [images, input, onDraftChange]);

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

    const nextImages = await Promise.all(
      imageFiles.map(
        (file) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (readerEvent) => resolve(readerEvent.target?.result as string);
            reader.onerror = () => reject(reader.error ?? new Error("图片读取失败"));
            reader.readAsDataURL(file);
          })
      )
    );

    setImages((prev) => [...prev, ...nextImages]);
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

  const buildSendOptions = (): ChatSendOptions => ({
    hiddenContext: contextPresetText?.trim() ? contextPresetText : undefined,
    knowledgeCollectionId: selectedKnowledgeCollection?.id ?? null,
  });

  const handleSubmit = () => {
    if ((!trimmedInput && images.length === 0) || isLoading || isSendBlocked) {
      return;
    }

    void onSend(trimmedInput, images.length > 0 ? images : undefined, buildSendOptions());
    setInput("");
    setImages([]);
    setSelectedKnowledgeCollection(null);
    setCaretIndex(0);
    clearSuggestionDismissal();
    clearMentionDismissal();
    onSubmit?.();
  };

  const submitImmediateCommand = (command: string) => {
    if (isLoading || isSendBlocked) {
      return;
    }

    void onSend(command, undefined, {
      hiddenContext: contextPresetText?.trim() ? contextPresetText : undefined,
    });
    setInput("");
    setImages([]);
    setSelectedKnowledgeCollection(null);
    setCaretIndex(0);
    clearSuggestionDismissal();
    clearMentionDismissal();
  };
  const sendDisabledTitle = isSendBlocked ? "请先配置可用模型或等待当前会话完成" : "发送消息";

  const applySuggestion = (suggestion: SlashSuggestion) => {
    if (IMMEDIATE_COMMAND_IDS.has(suggestion.id)) {
      submitImmediateCommand(IMMEDIATE_COMMAND_PAYLOADS[suggestion.id] ?? suggestion.command);
      return;
    }

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

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length > 0) {
      await appendImageFiles(files);
    }
    event.target.value = "";
  };

  return (
    <div className={`chat-composer${fixedHeight ? " chat-composer--fixed-height" : ""}`}>
      {images.length > 0 && (
        <div className="chat-composer__attachments">
          {images.map((img, index) => (
            <div key={index} className="relative group">
              <img src={img} alt="图片附件" className="w-12 h-12 rounded-lg object-cover border border-white/10" />
              <button
                onClick={() => setImages((prev) => prev.filter((_, imageIndex) => imageIndex !== index))}
                className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                title="移除图片"
                type="button"
              >
                <X size={10} strokeWidth={2.2} />
              </button>
            </div>
          ))}
        </div>
      )}

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

          {images.length > 0 && (
            <button
              type="button"
              className="chat-composer__status-chip"
              onClick={() => fileInputRef.current?.click()}
              title="继续添加图片"
            >
              <Paperclip size={13} strokeWidth={1.9} />
              <span>附件: {images.length} 张图片</span>
            </button>
          )}
        </div>
      )}

      <div className="chat-composer__panel">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            void handleFileSelect(event);
          }}
        />

        <div className="chat-composer__toolbar">
          <div className="chat-composer__toolbar-group">
            <button
              type="button"
              className="chat-composer__tool-button"
              title="上传图片"
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip size={16} strokeWidth={1.8} />
            </button>
          </div>

          <div className="chat-composer__toolbar-badge">{usageLabel ?? "--"}</div>

          <div className="chat-composer__toolbar-group chat-composer__toolbar-group--right">
            <button type="button" className="chat-composer__tool-button" title="展开">
              <ArrowRight size={16} strokeWidth={1.8} className="chat-composer__tool-button-arrow" />
            </button>
          </div>
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
        </div>

        <div className="chat-composer__footer">
          <div className="chat-composer__footer-row">
            <div className="chat-composer__footer-hint">Enter 发送 / Shift + Enter 换行</div>
            <div className="chat-composer__footer-actions">
              {canStartNewTopic ? (
                <button
                  type="button"
                  className="chat-composer__aux-button chat-composer__aux-button--topic"
                  title={hasConversation ? "开启新话题" : "创建新话题"}
                  onClick={onStartNewTopic}
                >
                  <CirclePlus size={16} strokeWidth={1.8} />
                  <span>新话题</span>
                </button>
              ) : null}

              {isLoading ? (
                <button onClick={onStop} className="chat-composer__submit chat-composer__submit--stop" title="停止生成" type="button">
                  <Square className="w-4 h-4" fill="currentColor" strokeWidth={1.8} />
                </button>
              ) : (
                <button
                  onClick={handleSubmit}
                  disabled={isSendBlocked || (!trimmedInput && images.length === 0)}
                  className="chat-composer__submit"
                  title={sendDisabledTitle}
                  type="button"
                >
                  <span>发送</span>
                  <ArrowRight className="chat-composer__submit-icon" strokeWidth={2} />
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
                    <SuggestionIcon suggestion={suggestion} />
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
