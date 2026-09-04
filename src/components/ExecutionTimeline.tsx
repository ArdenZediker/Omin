// WorkBuddy 式交错执行时间线（共享组件）。
// 把 reasoning / tool_call / action / artifact 步骤按时间顺序渲染为
// 「可折叠推理段 + 人类可读动作行 + 产物迷你卡片」，供聊天消息（ChatMessage）
// 与任务面板（MainChatView 回答链路）两处复用。
import { useState } from "react";
import {
  ChevronRight,
  File,
  FolderSearch,
  Loader2,
  PackagePlus,
  Terminal as TerminalIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ChatStep, ChatToolCallResult } from "../adapters/types";
import {
  getToolActionMeta,
  getFileBadgeLabel,
  extractToolFilePath,
  iconByName,
} from "../chat/toolActionMap";
import { parseSearchMatches, type ParsedSearchMatch } from "../chat/searchResultText";
import { requestOpenArtifactInPanel } from "../chat/artifacts";
import { openArtifactPath, revealArtifactPath } from "./ArtifactCards";

/** 从工具参数 JSON 提取一句简短摘要（取首个关键字段值），截断 60 字 */
export function formatToolArgs(args: string): string {
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
export function formatToolResult(result: string): string {
  const trimmed = (result ?? "").trim();
  if (!trimmed) return "";
  const firstLine = trimmed.split(/\r?\n/).find((line) => line.trim()) ?? "";
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}…` : firstLine;
}

/**
 * WorkBuddy 式交错时间线：把 reasoning / tool_call / action / artifact 按时间顺序渲染。
 * reasoning 段为可折叠的「深度思考」块；tool_call / action 渲染为带人类可读标签的动作行。
 */
export function ExecutionTimeline({
  steps,
  legacyReasoning,
  legacyTools,
  isStreaming,
  onOpenFileLocation,
}: {
  steps?: ChatStep[];
  legacyReasoning?: string;
  legacyTools?: ChatToolCallResult[];
  isStreaming?: boolean;
  /** 点击 /search_files 命中行回调：参数为匹配路径（相对工作区或绝对路径）与行号 */
  onOpenFileLocation?: (path: string, line: number) => void;
}) {
  const items: ChatStep[] =
    steps && steps.length > 0
      ? steps
      : [
          ...(legacyReasoning?.trim()
            ? [{ type: "reasoning", text: legacyReasoning.trim() } as ChatStep]
            : []),
          ...(legacyTools ?? []).map(
            (tool): ChatStep => ({
              type: "tool_call",
              name: tool.name,
              arguments: tool.arguments,
              result: tool.result,
              isError: tool.isError,
            })
          ),
        ];

  return (
    <div className="exec-timeline">
      {items.map((step, index) => {
        if (step.type === "reasoning") {
          const text = step.text.trim();
          if (!text) return null;
          return <ReasoningSegment key={`r-${index}`} text={text} isStreaming={Boolean(isStreaming)} />;
        }
        if (step.type === "tool_call") {
          const meta = getToolActionMeta(step.name);
          // running 过渡态仅在流式进行中有意义（转圈）；定案态 interrupted（或流式结束后仍遗留
          // running 步骤的旧数据兜底）一律弱化为「已中断」呈现，不再无限转圈。
          //
          // 兜底：当一条 running 步骤其实带回了成功结果（result 非空且 ！isError）—— 例如
          // arguments 序列化差异导致 appendLastProjectStep 没把它升级为完成态、或 onToolStep 比
          // finishTaskResult 慢一拍时遗留——不要把它误判为已中断，按成功完成渲染。
          const stepStatus = step.status;
          const hasSuccessResult =
            typeof step.result === "string" && step.result.trim().length > 0 && step.isError !== true;
          const isRunning = stepStatus === "running" && !hasSuccessResult && Boolean(isStreaming);
          const isInterrupted =
            (stepStatus === "interrupted" || (stepStatus === "running" && !hasSuccessResult && !isStreaming));
          const filePath = isRunning || isInterrupted ? null : extractToolFilePath(step.arguments, step.name);
          // /search_files 结果解析为可点击命中行（解析失败/无命中回退普通文本预览）
          const searchMatches =
            step.name === "search_files" && hasSuccessResult ? parseSearchMatches(step.result) : [];
          return (
            <ActionStep
              key={`t-${index}-${step.name}`}
              icon={meta.icon}
              verb={meta.verb}
              title={meta.title}
              argsSummary={formatToolArgs(step.arguments)}
              resultPreview={formatToolResult(step.result)}
              searchMatches={searchMatches.length > 0 ? searchMatches : undefined}
              onOpenFileLocation={onOpenFileLocation}
              file={filePath ? { path: filePath, badge: getFileBadgeLabel(step.name) } : undefined}
              isError={step.isError}
              isRunning={isRunning}
              isInterrupted={isInterrupted}
              hasSuccessResult={hasSuccessResult}
            />
          );
        }
        if (step.type === "action") {
          const Icon = iconByName(step.icon) ?? TerminalIcon;
          return (
            <ActionStep
              key={`a-${index}`}
              icon={Icon}
              verb={step.label}
              title={step.title}
              argsSummary={step.detail ?? ""}
              file={step.file}
            />
          );
        }
        if (step.type === "artifact") {
          return <ArtifactMiniRow key={`art-${index}`} artifactId={step.artifactId} title={step.title} />;
        }
        return null;
      })}
    </div>
  );
}

/** 单段推理：可折叠「深度思考」块，收起时显示首行预览，展开显示全文 */
function ReasoningSegment({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  const [open, setOpen] = useState(Boolean(isStreaming));
  const preview = text.split(/\r?\n/).find((line) => line.trim()) ?? text.slice(0, 80);
  return (
    <div className="exec-seg">
      <button
        type="button"
        className="exec-seg__toggle"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <ChevronRight size={12} strokeWidth={2} className={`exec-seg__chevron ${open ? "exec-seg__chevron--open" : ""}`} />
        <span className="exec-seg__label">深度思考</span>
        {!open && preview ? <span className="exec-seg__preview">{preview}</span> : null}
      </button>
      {open && <pre className="exec-seg__text">{text}</pre>}
    </div>
  );
}

/** 单个动作行：图标 + 中文动词 + 英文标题 + 参数摘要 + 可选迷你文件卡片 + 结果首行预览。
 *  isRunning 时渲染旋转 spinner、隐藏文件卡片与结果（工具尚未完成）；
 *  isInterrupted 为流式中断后遗留的 running 步骤，弱化呈现为「已中断」。
 *  hasSuccessResult 则即便上游因 race condition 把步骤留在 running 状态（result 已带回）
 *  也按完成态渲染，文件卡片照常出现，避免被误标「已中断」。 */
function ActionStep({
  icon: Icon,
  verb,
  title,
  argsSummary,
  resultPreview,
  searchMatches,
  onOpenFileLocation,
  file,
  isError,
  isRunning,
  isInterrupted,
  hasSuccessResult,
}: {
  icon: LucideIcon;
  verb: string;
  title: string;
  argsSummary?: string;
  resultPreview?: string;
  /** /search_files 的结构化命中行：非空时以可点击列表替代纯文本预览 */
  searchMatches?: ParsedSearchMatch[];
  onOpenFileLocation?: (path: string, line: number) => void;
  file?: { path: string; badge: string };
  isError?: boolean;
  isRunning?: boolean;
  isInterrupted?: boolean;
  hasSuccessResult?: boolean;
}) {
  const fileName = file ? file.path.split(/[\\/]/).pop() || file.path : "";
  // 有 result 但 status 字段仍为 running/interrupted（race 兜底）：按完成态渲染，不显示「已中断」。
  const effectivelyResolved = hasSuccessResult && !isError;
  const showSpinner = isRunning && !effectivelyResolved;
  const showInterrupted = isInterrupted && !effectivelyResolved;
  const stateClass = showSpinner
    ? "exec-action--running"
    : showInterrupted
      ? "exec-action--interrupted"
      : "";
  return (
    <div className={`exec-action ${isError ? "exec-action--error" : ""} ${stateClass}`}>
      {showSpinner ? (
        <Loader2 size={13} strokeWidth={2} className="exec-action__icon exec-action__icon--spin" />
      ) : (
        <Icon size={13} strokeWidth={2} className="exec-action__icon" />
      )}
      <div className="exec-action__body">
        <div className="exec-action__head">
          <span className="exec-action__verb">
            {showSpinner ? `正在${verb}` : showInterrupted ? "已中断" : verb}
          </span>
          <span className="exec-action__title">{title}</span>
          {argsSummary ? <span className="exec-action__args" title={argsSummary}>{argsSummary}</span> : null}
        </div>
        {!isRunning && !isInterrupted && file ? (
          <div className="exec-action__file-wrap">
            <button
              type="button"
              className="exec-action__file"
              title={`打开文件：${file.path}`}
              onClick={() => void openArtifactPath(file.path)}
            >
              <File size={13} strokeWidth={2} className="exec-action__file-icon" />
              <span className="exec-action__file-name">{fileName}</span>
              <span className="exec-action__file-badge">{file.badge}</span>
            </button>
            <button
              type="button"
              className="exec-action__file-action"
              title="在文件夹中显示"
              aria-label="在文件夹中显示"
              onClick={() => void revealArtifactPath(file.path)}
            >
              <FolderSearch size={14} strokeWidth={2} />
            </button>
          </div>
        ) : null}
        {searchMatches && searchMatches.length > 0 ? (
          <div className="exec-search-matches">
            {searchMatches.map((match, matchIndex) => (
              <div key={`${match.path}:${match.line}:${matchIndex}`} className="exec-search-match">
                <button
                  type="button"
                  className="exec-search-match__loc"
                  title={`在产物面板打开 ${match.path} 并定位到第 ${match.line} 行`}
                  onClick={() => onOpenFileLocation?.(match.path, match.line)}
                >
                  {match.path}:{match.line}
                </button>
                <span className="exec-search-match__text">{match.text}</span>
              </div>
            ))}
          </div>
        ) : resultPreview ? (
          <div className="exec-action__result">{resultPreview}</div>
        ) : null}
      </div>
    </div>
  );
}

/** action step 携带的产物引用：点击在右侧产物面板打开 */
function ArtifactMiniRow({ artifactId, title }: { artifactId: string; title: string }) {
  return (
    <button type="button" className="exec-artifact" onClick={() => requestOpenArtifactInPanel(artifactId)}>
      <PackagePlus size={13} strokeWidth={2} className="exec-artifact__icon" />
      <span className="exec-artifact__title">{title}</span>
      <span className="exec-artifact__open">在产物面板打开</span>
    </button>
  );
}
