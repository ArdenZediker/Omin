import { useEffect, useRef, useState } from "react";
import { Brain, ChevronDown, Copy, Pencil, RefreshCw } from "lucide-react";
import type { Message } from "../adapters/types";
import type { KnowledgeContextSource } from "../chat/knowledgeTypes";
import { renderMarkdown } from "../app/renderMarkdown";
import ArtifactCards from "./ArtifactCards";

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
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const knowledgeSources = message.knowledgeContext?.sources ?? [];
  const visibleKnowledgeSources = sourcesExpanded ? knowledgeSources : knowledgeSources.slice(0, 3);
  const hiddenKnowledgeSourceCount = Math.max(0, knowledgeSources.length - visibleKnowledgeSources.length);

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
    <div data-message-index={index} className={`animate-fade-in flex flex-col ${isUser ? "items-end" : "items-start"}`}>
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
        <div className="message-project max-w-[95%] text-sm markdown-body">
          {message.reasoning ? <ReasoningBlock reasoning={message.reasoning} /> : null}
          <div className={isStreaming && message.content.trim() ? "cursor-blink" : ""}>
            {isStreaming && !message.content.trim() ? <ThinkingIndicator /> : renderMarkdown(message.content)}
          </div>
          {knowledgeSources.length ? (
            <div className="message-knowledge-sources">
              <div className="message-knowledge-sources__header">
                <span>知识来源</span>
                <span>{knowledgeSources.length} 条命中</span>
              </div>
              <div className="message-knowledge-sources__list">
                {visibleKnowledgeSources.map((source, index) => (
                  <KnowledgeSourceCard key={`${source.chunkId}-${index}`} source={source} />
                ))}
              </div>
              {hiddenKnowledgeSourceCount > 0 && (
                <button type="button" className="message-knowledge-sources__toggle" onClick={() => setSourcesExpanded(true)}>
                  查看全部 {knowledgeSources.length} 条来源
                </button>
              )}
              {sourcesExpanded && knowledgeSources.length > 3 && (
                <button type="button" className="message-knowledge-sources__toggle" onClick={() => setSourcesExpanded(false)}>
                  收起来源
                </button>
              )}
            </div>
          ) : null}
          {message.artifacts && message.artifacts.length > 0 ? <ArtifactCards artifacts={message.artifacts} /> : null}
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

/** 推理模型的思考链折叠块（R1 / Gemini thinking / o 系列）。默认收起，点击展开。 */
function ReasoningBlock({ reasoning }: { reasoning: string }) {
  const [expanded, setExpanded] = useState(false);
  const trimmed = reasoning.trim();
  const isStreamingTail = /[。！？；…\s]$/.test(trimmed) === false;

  return (
    <div className={`message-reasoning ${expanded ? "message-reasoning--expanded" : ""}`}>
      <button
        type="button"
        className="message-reasoning__toggle"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        <Brain size={14} strokeWidth={1.8} className="message-reasoning__icon" />
        <span className="message-reasoning__label">思考过程</span>
        <span className="message-reasoning__meta">{trimmed.length} 字{isStreamingTail ? "…" : ""}</span>
        <ChevronDown size={14} strokeWidth={2} className={`message-reasoning__chevron ${expanded ? "message-reasoning__chevron--open" : ""}`} />
      </button>
      {expanded && (
        <div className="message-reasoning__body">
          <pre className="message-reasoning__text">{trimmed}</pre>
        </div>
      )}
    </div>
  );
}

function KnowledgeSourceCard({ source }: { source: KnowledgeContextSource }) {
  return (
    <div className="message-knowledge-source">
      <div className="message-knowledge-source__top">
        <div className="message-knowledge-source__title-block">
          <div className="message-knowledge-source__title">{source.chunkTitle || source.sourceName}</div>
          <div className="message-knowledge-source__collection">{source.collectionName}</div>
        </div>
        <div className="message-knowledge-source__score">score {source.score.toFixed(2)}</div>
      </div>
      <div className="message-knowledge-source__meta">
        {source.sourcePath ? <span>{source.sourcePath}</span> : null}
        {source.favorite ? <span>收藏</span> : null}
        {source.accessCount > 0 ? <span>访问 {source.accessCount}</span> : null}
      </div>
      <div className="message-knowledge-source__excerpt">{source.excerpt}</div>
    </div>
  );
}
