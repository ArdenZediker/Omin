import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Copy,
  FileDown,
  Pencil,
  RefreshCw,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ChatAttachment, ChatStep, ChatToolCallResult, Message } from "../adapters/types";
import type { KnowledgeContextSource } from "../chat/knowledgeTypes";
import { renderMarkdown } from "../app/renderMarkdown";
import { getToolActionMeta, isFileProducingTool, getFileBadgeLabel, extractToolFilePath } from "../chat/toolActionMap";
import { countIncompleteToolSteps, isResolvedAsSuccess } from "../chat/stepSettlement";
import { ExecutionTimeline, formatToolArgs, formatToolResult } from "./ExecutionTimeline";
import ArtifactCards from "./ArtifactCards";
import AttachmentChip from "./AttachmentChip";
import { savePastedFileAttachment, compressImageBlob } from "./attachmentUtils";

interface ChatMessageProps {
  message: Message;
  index: number;
  isStreaming?: boolean;
  isEditing?: boolean;
  onCopy?: (message: Message) => void;
  onEdit?: (index: number) => void;
  onCancelEdit?: () => void;
  onSubmitEdit?: (index: number, content: string, images?: string[], attachments?: ChatAttachment[]) => void;
  onRegenerate?: (index: number) => void;
  onSaveAsMarkdown?: (message: Message) => void | Promise<void>;
  /** 打开右侧变更面板（按事件总线通知 MainChatView 切换 tab） */
  onOpenChangesPanel?: () => void;
  /** 点击 /search_files 命中行：在右侧产物面板打开该文件并定位行号 */
  onOpenFileLocation?: (path: string, line: number) => void;
  /** 点击消息中的文件附件：在右侧产物面板打开该文件 */
  onOpenAttachment?: (path: string) => void;
}

/** 「查看所有变更」弹层中一条文件产出/修改记录 */
interface ChangeEntry {
  name: string;
  verb: string;
  title: string;
  Icon: LucideIcon;
  path?: string;
  badge: string;
  argsSummary: string;
  resultPreview: string;
  isError?: boolean;
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
  onSaveAsMarkdown,
  onOpenChangesPanel,
  onOpenFileLocation,
  onOpenAttachment,
}: ChatMessageProps) {
  // 工具结果消息已合并到对应 assistant 的 toolCallResults，不单独渲染
  if (message.role === "tool") return null;

  const isUser = message.role === "user";
  const [editValue, setEditValue] = useState(message.content);
  // 编辑态下附件的可变副本：用户可删除旧附件，也可在文本框粘贴新文件/图片，
  // 提交时随 onSubmitEdit 回传，覆盖原消息的 images / attachments。
  const [editImages, setEditImages] = useState<string[]>(message.images ?? []);
  const [editAttachments, setEditAttachments] = useState<ChatAttachment[]>(message.attachments ?? []);
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const knowledgeSources = message.knowledgeContext?.sources ?? [];
  const visibleKnowledgeSources = sourcesExpanded ? knowledgeSources : knowledgeSources.slice(0, 3);
  const hiddenKnowledgeSourceCount = Math.max(0, knowledgeSources.length - visibleKnowledgeSources.length);
  const artifactSectionRef = useRef<HTMLDivElement>(null);
  const artifactCount = message.artifacts?.length ?? 0;
  /** 所有「产出/修改文件」的工具步骤，用于「查看所有变更」弹层。
   *  与 stepSettlement.ts 共享 isResolvedAsSuccess 兜底：流式期间 race 让 step.status
   *  遗留为 running 但 result 已带回成功信息时，依旧作为「已完成变更」计入，
   *  避免「摘要显示已完成 · 6 个动作」但 footer 区无「查看所有变更」按钮。 */
  const changeEntries = useMemo<ChangeEntry[]>(() => {
    const sourceTools: Array<{ name: string; arguments: string; result: string; isError?: boolean }> = (
      message.steps && message.steps.length > 0
        ? (message.steps as ChatStep[]).filter(
            (s): s is Extract<ChatStep, { type: "tool_call" }> =>
              s.type === "tool_call" && (isResolvedAsSuccess(s) || !s.status),
          )
        : (message.toolCallResults ?? []).map((t) => ({
            name: t.name,
            arguments: t.arguments,
            result: t.result,
            isError: t.isError,
          }))
    );
    return sourceTools
      .filter((t) => isFileProducingTool(t.name))
      .map((t) => {
        const meta = getToolActionMeta(t.name);
        const path = extractToolFilePath(t.arguments, t.name);
        return {
          name: t.name,
          verb: meta.verb,
          title: meta.title,
          Icon: meta.icon,
          path,
          badge: getFileBadgeLabel(t.name),
          argsSummary: formatToolArgs(t.arguments),
          resultPreview: formatToolResult(t.result),
          isError: t.isError,
        };
      });
  }, [message.steps, message.toolCallResults]);
  const changeCount = changeEntries.length;

  useEffect(() => {
    if (!isEditing) return;
    setEditValue(message.content);
    setEditImages(message.images ?? []);
    setEditAttachments(message.attachments ?? []);
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

  // 编辑态：通过 Tauri 文件对话框补充图片/文件附件（与输入框上传同一套逻辑）
  const appendEditImageFiles = (files: File[]) => {
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) return;

    void Promise.all(imageFiles.map((file) => compressImageBlob(file))).then((nextImages) => {
      setEditImages((prev) => [...prev, ...nextImages.filter((src) => src.length > 0)]);
    });
  };

  const handleEditPaste = (event: React.ClipboardEvent) => {
    const clipboardFiles = event.clipboardData.files;
    if (clipboardFiles && clipboardFiles.length > 0) {
      event.preventDefault();
      const fileList = Array.from(clipboardFiles);
      const imageFiles = fileList.filter((file) => file.type.startsWith("image/"));
      const docFiles = fileList.filter((file) => !file.type.startsWith("image/"));

      if (imageFiles.length > 0) {
        appendEditImageFiles(imageFiles);
      }

      if (docFiles.length > 0) {
        void (async () => {
          const nextAttachments: ChatAttachment[] = [];
          for (const file of docFiles) {
            const attachment = await savePastedFileAttachment(file);
            if (attachment) {
              nextAttachments.push(attachment);
            }
          }
          if (nextAttachments.length === 0) return;
          setEditAttachments((prev) => {
            const existingPaths = new Set(prev.map((attachment) => attachment.path));
            return [...prev, ...nextAttachments.filter((attachment) => !existingPaths.has(attachment.path))];
          });
        })();
      }
      return;
    }

    const items = event.clipboardData.items;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        event.preventDefault();
        const blob = item.getAsFile();
        if (blob) appendEditImageFiles([blob]);
        break;
      }
    }
  };

  return (
    <div data-message-index={index} className={`animate-fade-in flex flex-col ${isUser ? "items-end" : "items-start"}`}>
      {isUser && isEditing ? (
        <div className="message-edit-box">
          {(editImages.length > 0 || editAttachments.length > 0) && (
            <div className="message-edit-box__attachments">
              {editImages.map((img, imageIndex) => (
                <AttachmentChip
                  key={`edit-${img.slice(0, 24)}-${imageIndex}`}
                  src={img}
                  name={`image_${imageIndex + 1}.png`}
                  index={imageIndex}
                  removable
                  onRemove={() => setEditImages((prev) => prev.filter((_, i) => i !== imageIndex))}
                />
              ))}
              {editAttachments.map((attachment, attachmentIndex) => (
                <AttachmentChip
                  key={`edit-${attachment.path}-${attachmentIndex}`}
                  src={attachment.path}
                  name={attachment.name}
                  index={attachmentIndex}
                  size={attachment.size}
                  removable
                  onRemove={() => setEditAttachments((prev) => prev.filter((_, i) => i !== attachmentIndex))}
                  onClick={
                    !attachment.path.startsWith("data:")
                      ? () => onOpenAttachment?.(attachment.path)
                      : undefined
                  }
                />
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={editValue}
            onChange={(event) => {
              setEditValue(event.target.value);
              event.currentTarget.style.height = "auto";
              event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 220)}px`;
            }}
            onPaste={handleEditPaste}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onCancelEdit?.();
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (editValue.trim()) {
                  onSubmitEdit?.(index, editValue.trim(), editImages, editAttachments);
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
              onClick={() => onSubmitEdit?.(index, editValue.trim(), editImages, editAttachments)}
            >
              发送
            </button>
          </div>
        </div>
      ) : isUser ? (
        <div className="max-w-[85%] px-3 py-2 rounded-2xl rounded-br-md bg-gradient-to-br from-violet-500/80 to-indigo-600/80 text-white/95 text-sm">
          {message.images && message.images.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-1.5">
              {message.images.map((img, imageIndex) => (
                <AttachmentChip
                  key={`${img.slice(0, 24)}-${imageIndex}`}
                  src={img}
                  name={`image_${imageIndex + 1}.png`}
                  index={imageIndex}
                />
              ))}
            </div>
          )}
          {message.attachments && message.attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-1.5">
              {message.attachments.map((attachment, attachmentIndex) => (
                <AttachmentChip
                  key={attachment.path}
                  src={attachment.path}
                  name={attachment.name}
                  index={attachmentIndex}
                  size={attachment.size}
                  onClick={
                    onOpenAttachment && !attachment.path.startsWith("data:")
                      ? () => onOpenAttachment(attachment.path)
                      : undefined
                  }
                />
              ))}
            </div>
          )}
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        </div>
      ) : (
        <div className="message-project max-w-[95%] text-sm markdown-body">
          {/* 思考块：始终展示，确保 UI 元素可见；无内容时显示「未触发深度推理」提示 */}
          <ThinkingBlock
            reasoning={message.reasoning}
            toolCallResults={message.toolCallResults}
            steps={message.steps}
            isStreaming={isStreaming}
            onOpenFileLocation={onOpenFileLocation}
          />
          <div className={isStreaming && message.content.trim() ? "cursor-blink" : ""}>
            {renderMarkdown(message.content)}
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
          {message.artifacts && message.artifacts.length > 0 ? (
            <div ref={artifactSectionRef}>
              <ArtifactCards artifacts={message.artifacts} />
            </div>
          ) : null}
          {(artifactCount > 0 || changeCount > 0) && (
            <div className="message-aggregate">
              {artifactCount > 0 && (
                <button
                  type="button"
                  className="message-aggregate__link"
                  onClick={() => artifactSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })}
                >
                  查看所有产物 ({artifactCount})
                </button>
              )}
              {changeCount > 0 && (
                <button type="button" className="message-aggregate__link" onClick={onOpenChangesPanel}>
                  查看所有变更 ({changeCount})
                </button>
              )}
            </div>
          )}
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
            <>
              <MessageActionButton label="重新生成" onClick={() => onRegenerate?.(index)}>
                <RefreshCw size={16} strokeWidth={1.8} />
              </MessageActionButton>
              <MessageActionButton label="存为 .md" onClick={() => onSaveAsMarkdown?.(message)}>
                <FileDown size={16} strokeWidth={1.8} />
              </MessageActionButton>
            </>
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

// 工具图标 / 动作标签映射已迁移至 src/chat/toolActionMap.ts（getToolActionMeta 等）。
// 执行时间线组件已抽取至 src/components/ExecutionTimeline.tsx（聊天消息与任务面板共用）。

/** 思考过程折叠块：始终展示（WorkBuddy 风格）。空内容时显示「未触发深度推理」提示，
 * 让用户在任何回答下都能看到 UI 元素。优先按 `steps` 按轮交错渲染（WorkBuddy 式
 * 「推理…调用工具…推理…」）；缺失时回落到 `reasoning + toolCallResults` 固定顺序。 */
function ThinkingBlock({
  reasoning,
  toolCallResults,
  steps,
  isStreaming,
  forceExpandSignal,
  onOpenFileLocation,
}: {
  reasoning?: string;
  toolCallResults?: ChatToolCallResult[];
  steps?: ChatStep[];
  isStreaming?: boolean;
  /** 自增信号：变化时强制展开时间线（供「查看所有变更」按钮触发） */
  forceExpandSignal?: number;
  /** 点击 /search_files 命中行：在产物面板打开文件并定位行号 */
  onOpenFileLocation?: (path: string, line: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  /** 用户手动点过折叠按钮后置位：新一轮开始前不再强制展开，结束后也不强制收起 */
  const userToggledRef = useRef(false);
  const wasStreamingRef = useRef(Boolean(isStreaming));

  // 流式期间自动展开（思考过程实时显示在块内），结束后自动收起为摘要行并保持可再展开。
  useEffect(() => {
    const streaming = Boolean(isStreaming);
    if (streaming && !wasStreamingRef.current) {
      userToggledRef.current = false;
      setExpanded(true);
    } else if (!streaming && wasStreamingRef.current && !userToggledRef.current) {
      setExpanded(false);
    }
    wasStreamingRef.current = streaming;
  }, [isStreaming]);

  // 外部「查看所有变更」等信号触发时强制展开
  useEffect(() => {
    if (forceExpandSignal && forceExpandSignal > 0) setExpanded(true);
  }, [forceExpandSignal]);

  const useSteps = Array.isArray(steps) && steps.length > 0;
  const trimmedReasoning = useSteps
    ? (steps as ChatStep[])
        .filter((s): s is Extract<ChatStep, { type: "reasoning" }> => s.type === "reasoning")
        .map((s) => s.text)
        .join("\n\n")
        .trim()
    : (reasoning?.trim() ?? "");
  const tools = useSteps
    ? (steps as ChatStep[]).filter((s): s is Extract<ChatStep, { type: "tool_call" }> => s.type === "tool_call")
    : (toolCallResults ?? []);
  const hasReasoning = Boolean(trimmedReasoning);
  /** 引擎级动作（知识检索/历史压缩）与产物步骤也计入「动作」，避免只有这些步骤时被误判为空态 */
  const actionTotal =
    tools.length +
    (useSteps ? (steps as ChatStep[]).filter((s) => s.type === "action" || s.type === "artifact").length : 0);
  const isEmpty = !hasReasoning && actionTotal === 0 && !isStreaming;
  const isThinking = Boolean(isStreaming) && !hasReasoning && actionTotal === 0;
  /** 未完成（running 过渡态或已中断定案）的工具步骤数：>0 说明本轮被中断，收起摘要不谎称「已完成」 */
  const incompleteToolCount = countIncompleteToolSteps(steps as ChatStep[] | undefined);

  // 收起态摘要行（WorkBuddy 式「已完成 · 思考 + N 个动作」；被中断时前缀改为「已中断」）
  const summaryText = isThinking
    ? "思考中…"
    : Boolean(isStreaming) && (hasReasoning || actionTotal > 0)
      ? "执行中…"
      : !isStreaming && (hasReasoning || actionTotal > 0)
        ? `${incompleteToolCount > 0 ? "已中断" : "已完成"} · ${hasReasoning && actionTotal > 0 ? "思考 + " : hasReasoning ? "深度思考" : ""}${actionTotal > 0 ? `${actionTotal} 个动作` : ""}`
        : "";

  return (
    <div className={`message-reasoning ${expanded ? "message-reasoning--expanded" : ""} ${isEmpty ? "message-reasoning--empty" : ""}`}>
      <button
        type="button"
        className="message-reasoning__toggle"
        onClick={() => {
          userToggledRef.current = true;
          setExpanded((current) => !current);
        }}
        aria-expanded={expanded}
      >
        <span className="message-reasoning__label">深度思考</span>
        {!expanded && summaryText ? <span className="message-reasoning__summary">{summaryText}</span> : null}
        <ChevronDown size={14} strokeWidth={2} className={`message-reasoning__chevron ${expanded ? "message-reasoning__chevron--open" : ""}`} />
      </button>
      {expanded && (
        <div className="message-reasoning__body">
          {isThinking ? (
            <div className="message-reasoning__thinking">
              <ThinkingIndicator />
              <p className="message-reasoning__empty-hint">模型正在思考中，推理过程将实时显示在这里。</p>
            </div>
          ) : isEmpty ? (
            <p className="message-reasoning__empty-hint">
              本次回答未使用推理模型或工具调用，直接给出最终答复。如需查看思考过程：
            </p>
          ) : (
            <ExecutionTimeline
              steps={useSteps ? (steps as ChatStep[]) : undefined}
              legacyReasoning={!useSteps ? reasoning : undefined}
              legacyTools={!useSteps ? toolCallResults : undefined}
              isStreaming={isStreaming}
              onOpenFileLocation={onOpenFileLocation}
            />
          )}
          {isEmpty && (
            <ul className="message-reasoning__empty-tips">
              <li>在「设置 → 模型」切换到支持 reasoning 的模型（如 DeepSeek-R1、o1、Gemini 2.5 thinking）</li>
              <li>让 AI 跑实际任务（如搜索文件、读取项目、导出文档），会自动触发工具调用步骤</li>
            </ul>
          )}
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
