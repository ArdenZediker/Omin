import { useEffect, useRef, useState } from "react";
import {
  Brain,
  ChevronDown,
  Copy,
  Eye,
  FileDown,
  FolderTree,
  GitBranch,
  PackagePlus,
  Pencil,
  RefreshCw,
  Search,
  Terminal as TerminalIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ChatToolCallResult, Message } from "../adapters/types";
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
  // 工具结果消息已合并到对应 assistant 的 toolCallResults，不单独渲染
  if (message.role === "tool") return null;

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
          {message.reasoning || (message.toolCallResults && message.toolCallResults.length > 0) ? (
            <ThinkingBlock
              reasoning={message.reasoning}
              toolCallResults={message.toolCallResults}
              isStreaming={isStreaming}
            />
          ) : null}
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

/** 工具名 → 图标 / 中文标题的映射（覆盖内置 + Web/Git/Office/Export 等工具） */
const TOOL_ICONS: Record<string, LucideIcon> = {
  search_sessions: Search,
  search_files: Search,
  web_search: Search,
  read_session: Eye,
  read_file: Eye,
  read_persona: Eye,
  web_fetch: Eye,
  list_files: FolderTree,
  git_info: GitBranch,
  git_commit: GitBranch,
  git_pr: GitBranch,
  export_docx: FileDown,
  export_xlsx: FileDown,
  export_pptx: FileDown,
  install_expert: PackagePlus,
  install_skill: PackagePlus,
  update_persona: Pencil,
};

const TOOL_TITLES: Record<string, string> = {
  search_sessions: "搜索会话",
  read_session: "读取会话",
  list_files: "列出文件",
  read_file: "读取文件",
  search_files: "搜索文件",
  read_persona: "读取个性化",
  update_persona: "更新个性化",
  install_expert: "安装专家",
  web_search: "联网搜索",
  web_fetch: "网页抓取",
  git_info: "Git 查看",
  git_commit: "Git 提交",
  git_pr: "创建 PR",
  export_docx: "导出 Word",
  export_xlsx: "导出 Excel",
  export_pptx: "导出 PPT",
  install_skill: "安装技能",
};

/** 从工具参数 JSON 提取一句简短摘要（取首个关键字段值），截断 60 字 */
function formatToolArgs(args: string): string {
  const trimmed = (args ?? "").trim();
  if (!trimmed) return "";
  try {
    const obj = JSON.parse(trimmed);
    const priorityKeys = ["path", "query", "keyword", "url", "command", "message", "title", "name"];
    for (const key of priorityKeys) {
      const value = obj?.[key];
      if (typeof value === "string" && value.trim()) {
        return value.length > 60 ? `${value.slice(0, 57)}…` : value;
      }
    }
    const first = Object.values(obj ?? {}).find((v) => typeof v === "string" && (v as string).trim());
    if (typeof first === "string") {
      return first.length > 60 ? `${first.slice(0, 57)}…` : first;
    }
    return "";
  } catch {
    return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
  }
}

/** 结果首行预览（截断 200 字；空结果不显示） */
function formatToolResult(result: string): string {
  const trimmed = (result ?? "").trim();
  if (!trimmed) return "";
  const firstLine = trimmed.split(/\r?\n/).find((line) => line.trim()) ?? "";
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}…` : firstLine;
}

/** 思考过程折叠块：reasoning 推理 + 工具调用步骤（WorkBuddy 风格）。无内容不显示。 */
function ThinkingBlock({
  reasoning,
  toolCallResults,
  isStreaming,
}: {
  reasoning?: string;
  toolCallResults?: ChatToolCallResult[];
  isStreaming?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const trimmedReasoning = reasoning?.trim() ?? "";
  const tools = toolCallResults ?? [];
  if (!trimmedReasoning && tools.length === 0) return null;

  const isStreamingTail = isStreaming && trimmedReasoning.length > 0 && /[。！？；…\s]$/.test(trimmedReasoning) === false;
  const summaryParts: string[] = [];
  if (trimmedReasoning.length) summaryParts.push(`${trimmedReasoning.length} 字思考`);
  if (tools.length) summaryParts.push(`${tools.length} 个工具`);
  const summary = summaryParts.join(" · ");

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
        <span className="message-reasoning__meta">{summary}{isStreamingTail ? "…" : ""}</span>
        <ChevronDown size={14} strokeWidth={2} className={`message-reasoning__chevron ${expanded ? "message-reasoning__chevron--open" : ""}`} />
      </button>
      {expanded && (
        <div className="message-reasoning__body">
          {trimmedReasoning && (
            <pre className="message-reasoning__text">{trimmedReasoning}</pre>
          )}
          {tools.length > 0 && (
            <div className="message-reasoning__steps">
              {tools.map((step, index) => (
                <ToolCallStep key={`${step.id}-${index}`} step={step} index={index} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 单个工具调用步骤：图标 + 序号 + 工具名 + 参数摘要 + 结果首行预览 */
function ToolCallStep({ step, index }: { step: ChatToolCallResult; index: number }) {
  const Icon = TOOL_ICONS[step.name] ?? TerminalIcon;
  const title = TOOL_TITLES[step.name] ?? step.name;
  const argsSummary = formatToolArgs(step.arguments);
  const resultPreview = formatToolResult(step.result);

  return (
    <div className={`message-reasoning__step ${step.isError ? "message-reasoning__step--error" : ""}`}>
      <div className="message-reasoning__step-head">
        <Icon size={12} strokeWidth={2} className="message-reasoning__step-icon" />
        <span className="message-reasoning__step-num">{index + 1}</span>
        <span className="message-reasoning__step-title">{title}</span>
        {argsSummary ? (
          <span className="message-reasoning__step-args" title={argsSummary}>{argsSummary}</span>
        ) : null}
      </div>
      {resultPreview ? (
        <div className="message-reasoning__step-result">{resultPreview}</div>
      ) : null}
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
