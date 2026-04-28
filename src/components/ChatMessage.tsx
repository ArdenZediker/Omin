import { useEffect, useRef, useState } from "react";
import { Copy, Pencil, RefreshCw } from "lucide-react";
import type { Message } from "../adapters/types";

interface ChatMessageProps {
  message: Message;
  index: number;
  isStreaming?: boolean;
  isEditing?: boolean;
  onCopy?: (message: Message) => void;
  onEdit?: (index: number) => void;
  onCancelEdit?: () => void;
  onSubmitEdit?: (index: number, content: string) => void;
  onRegenerate?: (index: number) => void;
}

export default function ChatMessage({
  message,
  index,
  isStreaming,
  isEditing,
  onCopy,
  onEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
}: ChatMessageProps) {
  const isUser = message.role === "user";
  const [editValue, setEditValue] = useState(message.content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!isEditing) return;
    setEditValue(message.content);
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.selectionStart = textarea.value.length;
      textarea.selectionEnd = textarea.value.length;
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
    });
  }, [isEditing, message.content]);

  return (
    <div className={`animate-fade-in flex flex-col ${isUser ? "items-end" : "items-start"}`}>
      {isUser && isEditing ? (
        <div className="message-edit-box">
          <textarea
            ref={textareaRef}
            value={editValue}
            onChange={(event) => {
              setEditValue(event.target.value);
              event.currentTarget.style.height = "auto";
              event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 220)}px`;
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onCancelEdit?.();
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (editValue.trim()) {
                  onSubmitEdit?.(index, editValue.trim());
                }
              }
            }}
            className="message-edit-box__textarea"
            rows={1}
          />
          <div className="message-edit-box__actions">
            <button type="button" className="message-edit-box__button" onClick={onCancelEdit}>
              取消
            </button>
            <button
              type="button"
              className="message-edit-box__button message-edit-box__button--primary"
              disabled={!editValue.trim()}
              onClick={() => onSubmitEdit?.(index, editValue.trim())}
            >
              发送
            </button>
          </div>
        </div>
      ) : isUser ? (
        <div className="max-w-[85%] px-3 py-2 rounded-2xl rounded-br-md bg-gradient-to-br from-violet-500/80 to-indigo-600/80 text-white/95 text-sm">
          {message.images && message.images.length > 0 && (
            <div className="flex gap-1 mb-1.5">
              {message.images.map((img, imageIndex) => (
                <img
                  key={imageIndex}
                  src={img.startsWith("data:") ? img : `data:image/png;base64,${img}`}
                  alt="图片附件"
                  className="w-16 h-16 rounded-lg object-cover"
                />
              ))}
            </div>
          )}
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        </div>
      ) : (
        <div className="message-assistant max-w-[95%] text-sm markdown-body">
          <div className={isStreaming && message.content.trim() ? "cursor-blink" : ""}>
            {isStreaming && !message.content.trim() ? <ThinkingIndicator /> : renderMarkdown(message.content)}
          </div>
        </div>
      )}
      {!isStreaming && !isEditing && (
        <div className={`mt-1.5 flex items-center gap-1.5 ${isUser ? "justify-end" : "justify-start"}`}>
          <MessageActionButton label="复制" onClick={() => onCopy?.(message)}>
            <Copy size={16} strokeWidth={1.8} />
          </MessageActionButton>
          {isUser ? (
            <MessageActionButton label="重新编辑" onClick={() => onEdit?.(index)}>
              <Pencil size={16} strokeWidth={1.8} />
            </MessageActionButton>
          ) : (
            <MessageActionButton label="重新生成" onClick={() => onRegenerate?.(index)}>
              <RefreshCw size={16} strokeWidth={1.8} />
            </MessageActionButton>
          )}
        </div>
      )}
    </div>
  );
}

function MessageActionButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className="message-action-button" title={label} aria-label={label} onClick={onClick}>
      <span className="sr-only">{label}</span>
      <span className="h-4 w-4">{children}</span>
    </button>
  );
}

function ThinkingIndicator() {
  return (
    <div className="message-thinking" role="status" aria-live="polite">
      <span className="message-thinking__spinner" aria-hidden="true" />
      <span>正在思考</span>
      <span className="message-thinking__dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
    </div>
  );
}

function renderMarkdown(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const lines = text.split("\n");
  let inCodeBlock = false;
  let codeContent = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("```")) {
      if (inCodeBlock) {
        parts.push(
          <pre key={i}>
            <code>{codeContent.trim()}</code>
          </pre>
        );
        codeContent = "";
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeContent += `${line}\n`;
      continue;
    }

    if (line.startsWith("### ")) {
      parts.push(<h3 key={i}>{line.slice(4)}</h3>);
    } else if (line.startsWith("## ")) {
      parts.push(<h2 key={i}>{line.slice(3)}</h2>);
    } else if (line.startsWith("# ")) {
      parts.push(<h1 key={i}>{line.slice(2)}</h1>);
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      parts.push(<li key={i}>{renderInline(line.slice(2))}</li>);
    } else if (line.trim() === "") {
      parts.push(<div key={i} className="h-1.5" />);
    } else {
      parts.push(<p key={i}>{renderInline(line)}</p>);
    }
  }

  return <>{parts}</>;
}

function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const str = match[0];
    if (str.startsWith("`")) {
      parts.push(<code key={match.index}>{str.slice(1, -1)}</code>);
    } else if (str.startsWith("**")) {
      parts.push(<strong key={match.index}>{str.slice(2, -2)}</strong>);
    } else if (str.startsWith("*")) {
      parts.push(<em key={match.index}>{str.slice(1, -1)}</em>);
    }
    lastIndex = match.index + str.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? <>{parts}</> : text;
}
