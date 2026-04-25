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

export default function ChatInput({ onSend, isLoading, onStop, focusSignal, draftValue, draftImages, draftSignal }: ChatInputProps) {
  const [input, setInput] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const matchedSuggestions = getMatchingSlashSuggestions(input);

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
          {matchedSuggestions.map((suggestion) => (
            <button
              key={`${suggestion.kind}-${suggestion.id}`}
              type="button"
              className="chat-composer__skill"
              onClick={() => {
                setInput(buildSlashDraft(suggestion));
                textareaRef.current?.focus();
              }}
            >
              <span className="chat-composer__skill-command">{suggestion.command}</span>
              <span className="chat-composer__skill-title">{suggestion.title}</span>
              <span className={`chat-composer__skill-badge ${suggestion.kind === "local" ? "chat-composer__skill-badge--local" : ""}`}>
                {suggestion.kind === "local" ? "Local" : "Skill"}
              </span>
              <span className="chat-composer__skill-description">{suggestion.description}</span>
            </button>
          ))}
        </div>
      )}

      {images.length > 0 && (
        <div className="chat-composer__attachments">
          {images.map((img, i) => (
            <div key={i} className="relative group">
              <img src={img} alt="attachment" className="w-12 h-12 rounded-lg object-cover border border-white/10" />
              <button
                onClick={() => setImages((prev) => prev.filter((_, idx) => idx !== i))}
                className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500/80 text-white flex items-center justify-center text-[8px] opacity-0 group-hover:opacity-100 transition-opacity"
                title="Remove image"
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
            placeholder="请输入消息…（Enter 发送，Shift+Enter 换行）"
            className="chat-composer__textarea hide-scrollbar"
            rows={1}
            disabled={isLoading}
          />
        </div>

        {isLoading ? (
          <button
            onClick={onStop}
            className="chat-composer__send chat-composer__send--stop"
            title="Stop generation"
            type="button"
          >
            <svg className="w-4 h-4 text-red-400" fill="currentColor" viewBox="0 0 24 24">
              <rect x="6" y="6" width="12" height="12" rx="1" />
            </svg>
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={!input.trim() && images.length === 0}
            className="chat-composer__send"
            title="Send"
            type="button"
          >
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
