// 右侧「变更」侧边栏 — 非 git 实现（对齐 WorkBuddy「Changes」视图）
//
// 数据来自消息内「查看所有变更」按钮：ChatMessage 汇总该条消息里所有
// 「产出/修改文件」的工具步骤（export_* / write_text_file / git_commit …），
// 经 onOpenChangesPanel 传上来的 ChangeEntry[]。完全不依赖目录是否为 git 仓库，
// 也不受嵌套 git 仓库影响——展示的是「本次任务 agent 实际改动的文件」。
//
// 展示格式：一行一个文件名，右侧 +N/−M 差异统计，点击行展开 diff。
import { useState } from "react";
import { FileCode2, X } from "lucide-react";
import type { ChangeEntry } from "../chat/toolActionMap";

interface ChangesPanelProps {
  /** 由消息「查看所有变更」传上来的本次任务文件改动清单（非 git） */
  changes: ChangeEntry[];
  /** 嵌入其他面板时由父级控制显示关闭按钮 */
  onClose?: () => void;
}

export default function ChangesPanel({ changes, onClose }: ChangesPanelProps) {
  return (
    <aside className="changes-panel">
      <div className="changes-panel__header">
        <div className="changes-panel__tabs">
          <span className="changes-panel__tab changes-panel__tab--active" role="tab" aria-selected>
            <FileCode2 size={12} strokeWidth={2} />
            <span className="changes-panel__tab-label">变更</span>
            {changes.length > 0 ? <span className="changes-panel__tab-count">{changes.length}</span> : null}
          </span>
        </div>
        <div className="changes-panel__header-actions">
          {onClose ? (
            <button
              type="button"
              className="changes-panel__iconbtn"
              onClick={onClose}
              title="关闭变更面板"
              aria-label="关闭变更面板"
            >
              <X size={14} strokeWidth={2} />
            </button>
          ) : null}
        </div>
      </div>

      {changes.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="changes-panel__overview">
          <ul className="changes-panel__entries">
            {changes.map((entry, idx) => (
              <ChangeEntryRow
                key={`${entry.name}::${entry.path ?? entry.title}::${idx}`}
                entry={entry}
              />
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}

function ChangeEntryRow({ entry }: { entry: ChangeEntry }) {
  const [diffOpen, setDiffOpen] = useState(false);
  const filename = entry.path ? fileNameOf(entry.path) : entry.title;
  const hasDiff = Boolean(entry.diff && entry.diff.diffContent?.trim());

  return (
    <li className={`changes-panel__entry ${entry.isError ? "changes-panel__entry--error" : ""}`}>
      <button
        type="button"
        className="changes-panel__entry-row"
        onClick={() => setDiffOpen((v) => !v)}
        title={entry.path ?? entry.title}
      >
        <span className="changes-panel__entry-name">{filename}</span>
        {hasDiff ? (
          <span className="changes-panel__entry-stats">
            <span className="diff-add">+{entry.diff!.insertions}</span>
            <span className="diff-del">−{entry.diff!.deletions}</span>
          </span>
        ) : null}
      </button>
      {hasDiff && diffOpen ? <DiffView content={entry.diff!.diffContent} /> : null}
    </li>
  );
}

/** 自渲染 unified-diff：按行着色 +/−，默认折叠（由点击行展开）。不引 diff2html。 */
function DiffView({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <div className="changes-panel__diff">
      <pre className="changes-panel__diff-pre">
        {lines.map((line, idx) => {
          const cls =
            line.startsWith("+") && !line.startsWith("+++")
              ? "diff-line diff-line--add"
              : line.startsWith("-") && !line.startsWith("---")
                ? "diff-line diff-line--del"
                : line.startsWith("@@")
                  ? "diff-line diff-line--hunk"
                  : "diff-line";
          return (
            <div key={idx} className={cls}>
              {line || " "}
            </div>
          );
        })}
      </pre>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="changes-panel__empty">
      <FileCode2 size={26} strokeWidth={1.4} />
      <p>暂无变更</p>
      <span>点击对话消息中的「查看所有变更」按钮，查看本次任务 agent 实际改动的文件。</span>
    </div>
  );
}

// ===== 小工具 =====

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

// 仅用于测试导出（不让组件树被 hoist 时丢失类型）
export type { ChangesPanelProps };
