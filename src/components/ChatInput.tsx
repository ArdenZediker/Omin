import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Bot,
  CirclePlus,
  Eraser,
  GitCompare,
  Languages,
  ListCollapse,
  MessageCircleQuestion,
  Pencil,
  PencilLine,
  Pin,
  Settings,
  Square,
  X,
} from "lucide-react";
import { buildSlashDraft, getMatchingSlashSuggestions, type SlashSuggestion } from "../chat/skills";

interface ChatInputProps {
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
      textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
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
    if ((!input.trim() && images.length === 0) || isLoading) return;
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

      <div className="chat-composer__row">
        <div className="chat-composer__input-wrap">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="请输入消息…（输入 / 查看命令，Enter 发送，Shift+Enter 换行）"
            className="chat-composer__textarea hide-scrollbar"
            rows={1}
            disabled={isLoading}
          />
        </div>

        {isLoading ? (
          <button onClick={onStop} className="chat-composer__send chat-composer__send--stop" title="停止生成" type="button">
            <Square className="w-4 h-4 text-red-400" fill="currentColor" strokeWidth={1.8} />
          </button>
        ) : (
          <button onClick={handleSubmit} disabled={!input.trim() && images.length === 0} className="chat-composer__send" title="发送消息" type="button">
            <ArrowRight className="w-4 h-4 text-white" strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  );
}
