import { useEffect, useRef, useState } from "react";
import { buildSlashDraft, getMatchingSlashSuggestions } from "../chat/skills";

interface ChatInputProps {
  onSend: (content: string, images?: string[]) => void;
  isLoading: boolean;
  onStop: () => void;
  focusSignal?: number;
  draftValue?: string;
  draftImages?: string[];
  draftSignal?: number;
}

function CommandIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M7 5L3 10L7 15" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13 5L17 10L13 15" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SkillIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M10 3L16 6.5V13.5L10 17L4 13.5V6.5L10 3Z" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M10 6.5L13 8.2V11.8L10 13.5L7 11.8V8.2L10 6.5Z" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (blob) {
          const reader = new FileReader();
          reader.onload = (ev) => {
            const result = ev.target?.result as string;
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
                    <CommandIcon />
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
                    <SkillIcon />
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
          {images.map((img, i) => (
            <div key={i} className="relative group">
              <img src={img} alt="图片附件" className="w-12 h-12 rounded-lg object-cover border border-white/10" />
              <button
                onClick={() => setImages((prev) => prev.filter((_, idx) => idx !== i))}
                className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500/80 text-white flex items-center justify-center text-[8px] opacity-0 group-hover:opacity-100 transition-opacity"
                title="移除图片"
                type="button"
              >
                ×
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
            onChange={(e) => setInput(e.target.value)}
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
            <svg className="w-4 h-4 text-red-400" fill="currentColor" viewBox="0 0 24 24">
              <rect x="6" y="6" width="12" height="12" rx="1" />
            </svg>
          </button>
        ) : (
          <button onClick={handleSubmit} disabled={!input.trim() && images.length === 0} className="chat-composer__send" title="发送消息" type="button">
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
