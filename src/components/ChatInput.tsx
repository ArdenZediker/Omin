import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Bot,
  CirclePlus,
  Eraser,
  GitCompare,
  Languages,
  LibraryBig,
  ListCollapse,
  MessageCircleQuestion,
  Paperclip,
  Pencil,
  PencilLine,
  Pin,
  Settings,
  Square,
  TimerReset,
  X,
} from "lucide-react";
import { buildSlashDraft, getMatchingSlashSuggestions, type SlashSuggestion } from "../chat/skills";

interface ChatInputProps {
  canStartNewTopic?: boolean;
  hasConversation?: boolean;
  usageLabel?: string | null;
  onStartNewTopic?: () => void;
  onSend: (content: string, images?: string[]) => void;
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

const SKILL_ICON_MAP: Record<string, React.ComponentType<{ size?: number; strokeWidth?: number }>> = {
  summarize: ListCollapse,
  translate: Languages,
  rewrite: PencilLine,
  explain: MessageCircleQuestion,
  compare: GitCompare,
};

function SuggestionIcon({ suggestion }: { suggestion: SlashSuggestion }) {
  const Icon =
    suggestion.kind === "local"
      ? (LOCAL_COMMAND_ICON_MAP[suggestion.id] ?? CirclePlus)
      : (SKILL_ICON_MAP[suggestion.id] ?? MessageCircleQuestion);

  return <Icon size={16} strokeWidth={1.8} />;
}

export default function ChatInput({
  canStartNewTopic = false,
  hasConversation = false,
  usageLabel,
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
  const matchedSuggestions = getMatchingSlashSuggestions(input);
  const localSuggestions = matchedSuggestions.filter((suggestion) => suggestion.kind === "local");
  const skillSuggestions = matchedSuggestions.filter((suggestion) => suggestion.kind === "skill");

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

  const handleSubmit = () => {
    if ((!input.trim() && images.length === 0) || isLoading) {
      return;
    }

    onSend(input.trim(), images.length > 0 ? images : undefined);
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
          const reader = new FileReader();
          reader.onload = (readerEvent) => {
            const result = readerEvent.target?.result as string;
            setImages((prev) => [...prev, result]);
          };
          reader.readAsDataURL(blob);
        }
        break;
      }
    }
  };

  return (
    <div className="chat-composer">
      {matchedSuggestions.length > 0 && (
        <div className="chat-composer__skills">
          {localSuggestions.length > 0 && (
            <div className="chat-composer__skills-group">
              <div className="chat-composer__skills-group-title">命令</div>
              {localSuggestions.map((suggestion) => (
                <button
                  key={`${suggestion.kind}-${suggestion.id}`}
                  type="button"
                  className="chat-composer__skill"
                  onClick={() => {
                    setInput(buildSlashDraft(suggestion));
                    textareaRef.current?.focus();
                  }}
                >
                  <span className="chat-composer__skill-icon" aria-hidden="true">
                    <SuggestionIcon suggestion={suggestion} />
                  </span>
                  <span className="chat-composer__skill-command">{suggestion.command}</span>
                  <span className="chat-composer__skill-description">{suggestion.description}</span>
                </button>
              ))}
            </div>
          )}

          {skillSuggestions.length > 0 && (
            <div className="chat-composer__skills-group">
              <div className="chat-composer__skills-group-title">技能</div>
              {skillSuggestions.map((suggestion) => (
                <button
                  key={`${suggestion.kind}-${suggestion.id}`}
                  type="button"
                  className="chat-composer__skill"
                  onClick={() => {
                    setInput(buildSlashDraft(suggestion));
                    textareaRef.current?.focus();
                  }}
                >
                  <span className="chat-composer__skill-icon" aria-hidden="true">
                    <SuggestionIcon suggestion={suggestion} />
                  </span>
                  <span className="chat-composer__skill-command">{suggestion.command}</span>
                  <span className="chat-composer__skill-description">{suggestion.description}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

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

      <div className="chat-composer__panel">
        <div className="chat-composer__toolbar">
          <div className="chat-composer__toolbar-group">
            <button type="button" className="chat-composer__tool-button" title="模型工具">
              <Bot size={16} strokeWidth={1.8} />
            </button>
            <button type="button" className="chat-composer__tool-button" title="上传附件">
              <Paperclip size={16} strokeWidth={1.8} />
            </button>
            <button type="button" className="chat-composer__tool-button" title="知识库">
              <LibraryBig size={16} strokeWidth={1.8} />
            </button>
            <button type="button" className="chat-composer__tool-button" title="计时器">
              <TimerReset size={16} strokeWidth={1.8} />
            </button>
          </div>
          <div className="chat-composer__toolbar-badge">{usageLabel ?? "--"}</div>
          <div className="chat-composer__toolbar-group chat-composer__toolbar-group--right">
            <button type="button" className="chat-composer__tool-button" title="布局">
              <CirclePlus size={16} strokeWidth={1.8} />
            </button>
            <button type="button" className="chat-composer__tool-button" title="展开">
              <ArrowRight size={16} strokeWidth={1.8} className="chat-composer__tool-button-arrow" />
            </button>
          </div>
        </div>

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

        <div className="chat-composer__footer">
          <div className="chat-composer__footer-hint">↵ 发送 / Shift + ↵ 换行</div>
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
            ) : (
              <button type="button" className="chat-composer__aux-button" title="工具箱">
                <LibraryBig size={16} strokeWidth={1.8} />
              </button>
            )}
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
  );
}
