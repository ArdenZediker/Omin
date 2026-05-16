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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const matchedSuggestions = getMatchingSlashSuggestions(input);
  const localSuggestions = matchedSuggestions.filter((suggestion) => suggestion.kind === "local");

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

  const handleSubmit = () => {
    if ((!input.trim() && images.length === 0) || isLoading) {
      return;
    }

    const visibleContent = input.trim();
    const hiddenContext = contextPresetText?.trim() ? contextPresetText : undefined;

    onSend(visibleContent, images.length > 0 ? images : undefined, hiddenContext);
    setInput("");
    setImages([]);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
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

  const activeSlashCommand = input.trim().startsWith("/") ? input.trim().split(/\s+/)[0].toLowerCase() : "";
  const activeLocalCommand = LOCAL_SLASH_COMMANDS.find((item) => item.command === activeSlashCommand) ?? null;
  const activeModeLabel = activeLocalCommand?.title ?? null;
  const activeModeTypeLabel = activeLocalCommand ? "工具模式" : null;
  const hasComposerStatus = Boolean(activeModeLabel || images.length > 0);
  const showSlashSuggestions = localSuggestions.length > 0 && !activeModeLabel;

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
                onKeyDown={handleKeyDown}
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
                <button onClick={handleSubmit} disabled={!input.trim() && images.length === 0} className="chat-composer__submit" title="发送消息" type="button">
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
            {localSuggestions.length > 0 && (
              <div className="chat-composer__suggestion-group">
                <div className="chat-composer__suggestion-group-title">本地命令</div>
                {localSuggestions.map((suggestion) => (
                  <button
                    key={`${suggestion.kind}-${suggestion.id}`}
                    type="button"
                    className="chat-composer__suggestion"
                    onClick={() => {
                      setInput(buildSlashDraft(suggestion));
                      textareaRef.current?.focus();
                    }}
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
            )}
          </div>
        </div>
      )}
    </div>
  );
}
