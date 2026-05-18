import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
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
import { buildSlashDraft, getMatchingSlashSuggestions, LOCAL_SLASH_COMMANDS, type SlashSuggestion } from "../chat/skills";

interface ChatInputProps {
  canStartNewTopic?: boolean;
  hasConversation?: boolean;
  usageLabel?: string | null;
  contextPresetText?: string;
  onStartNewTopic?: () => void;
  onSend: (content: string, images?: string[], hiddenContext?: string) => void;
  isLoading: boolean;
  onStop: () => void;
  focusSignal?: number;
  draftValue?: string;
  draftImages?: string[];
  draftSignal?: number;
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

function SuggestionIcon({ suggestion }: { suggestion: SlashSuggestion }) {
  const Icon = LOCAL_COMMAND_ICON_MAP[suggestion.id] ?? CirclePlus;
  return <Icon size={16} strokeWidth={1.8} />;
}

export default function ChatInput({
  canStartNewTopic = false,
  hasConversation = false,
  usageLabel,
  contextPresetText,
  onStartNewTopic,
  onSend,
  isLoading,
  onStop,
  focusSignal,
  draftValue,
  draftImages,
  draftSignal,
}: ChatInputProps) {
  const [input, setInput] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const [dismissedSlashInput, setDismissedSlashInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const suggestionItemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const matchedSuggestions = getMatchingSlashSuggestions(input);
  const localSuggestions = matchedSuggestions.filter((suggestion) => suggestion.kind === "local");
  const trimmedInput = input.trim();
  const activeSlashCommand = trimmedInput.startsWith("/") ? trimmedInput.split(/\s+/)[0].toLowerCase() : "";
  const activeLocalCommand = LOCAL_SLASH_COMMANDS.find((item) => item.command === activeSlashCommand) ?? null;
  const activeModeLabel = activeLocalCommand?.title ?? null;
  const activeModeTypeLabel = activeLocalCommand ? "工具模式" : null;
  const hasComposerStatus = Boolean(activeModeLabel || images.length > 0);
  const showSlashSuggestions =
    localSuggestions.length > 0 &&
    !activeModeLabel &&
    trimmedInput.startsWith("/") &&
    input !== dismissedSlashInput;

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 280)}px`;
    }
  }, [input]);

  useEffect(() => {
    if (typeof focusSignal === "number") {
      textareaRef.current?.focus();
    }
  }, [focusSignal]);

  useEffect(() => {
    if (typeof draftSignal === "number" && typeof draftValue === "string") {
      setInput(draftValue);
      setImages(draftImages ?? []);
      textareaRef.current?.focus();
    }
  }, [draftImages, draftSignal, draftValue]);

  useEffect(() => {
    suggestionItemRefs.current = suggestionItemRefs.current.slice(0, localSuggestions.length);
  }, [localSuggestions.length]);

  useEffect(() => {
    if (!showSlashSuggestions) {
      setSelectedSuggestionIndex(0);
      return;
    }

    setSelectedSuggestionIndex((current) => Math.min(current, localSuggestions.length - 1));
  }, [localSuggestions.length, showSlashSuggestions]);

  useEffect(() => {
    if (!showSlashSuggestions) {
      return;
    }

    suggestionItemRefs.current[selectedSuggestionIndex]?.scrollIntoView({ block: "nearest" });
  }, [selectedSuggestionIndex, showSlashSuggestions]);

  useEffect(() => {
    if (!dismissedSlashInput) {
      return;
    }

    if (input !== dismissedSlashInput) {
      setDismissedSlashInput("");
    }
  }, [dismissedSlashInput, input]);

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

  const handleSubmit = () => {
    if ((!trimmedInput && images.length === 0) || isLoading) {
      return;
    }

    const hiddenContext = contextPresetText?.trim() ? contextPresetText : undefined;
    onSend(trimmedInput, images.length > 0 ? images : undefined, hiddenContext);
    setInput("");
    setImages([]);
    clearSuggestionDismissal();
  };

  const submitImmediateCommand = (command: string) => {
    if (isLoading) {
      return;
    }

    const hiddenContext = contextPresetText?.trim() ? contextPresetText : undefined;
    onSend(command, undefined, hiddenContext);
    setInput("");
    setImages([]);
    clearSuggestionDismissal();
  };

  const applySuggestion = (suggestion: SlashSuggestion) => {
    if (IMMEDIATE_COMMAND_IDS.has(suggestion.id)) {
      submitImmediateCommand(IMMEDIATE_COMMAND_PAYLOADS[suggestion.id] ?? suggestion.command);
      return;
    }

    setInput(buildSlashDraft(suggestion));
    clearSuggestionDismissal();
    textareaRef.current?.focus();
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
    <div className="chat-composer">
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
                onChange={(event) => setInput(event.target.value)}
                onKeyDownCapture={handleKeyDown}
                onPaste={handlePaste}
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
              {canStartNewTopic && hasConversation ? (
                <button
                  type="button"
                  className="chat-composer__aux-button chat-composer__aux-button--topic"
                  title="开启新话题"
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
                <button onClick={handleSubmit} disabled={!trimmedInput && images.length === 0} className="chat-composer__submit" title="发送消息" type="button">
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
    </div>
  );
}
