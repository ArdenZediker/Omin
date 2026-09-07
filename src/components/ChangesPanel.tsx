// 右侧「变更」侧边栏 — 非 git 实现（对齐 WorkBuddy「Changes」视图）
//
// 数据来自消息内「查看所有变更」按钮：ChatMessage 汇总该条消息里所有
// 「产出/修改文件」的工具步骤（export_* / write_text_file / git_commit …），
// 经 onOpenChangesPanel 传上来的 ChangeEntry[]。完全不依赖目录是否为 git 仓库，
// 也不受嵌套 git 仓库影响——展示的是「本次任务 agent 实际改动的文件」。
//
// 交互：文件列表 → 点击某行 → 进入该文件的 diff 详情页（顶部返回 + 文件名 + 统计 + 关闭）。
import { useState } from "react";
import { ArrowLeft, FileCode2, X } from "lucide-react";
import type { ChangeEntry } from "../chat/toolActionMap";
import type { FileDiff } from "../chat/fileDiff";

interface ChangesPanelProps {
  /** 由消息「查看所有变更」传上来的本次任务文件改动清单（非 git） */
  changes: ChangeEntry[];
  /** 嵌入其他面板时由父级控制显示关闭按钮 */
  onClose?: () => void;
}

export default function ChangesPanel({ changes, onClose }: ChangesPanelProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const activeEntry = activeIndex != null ? changes[activeIndex] ?? null : null;

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
      ) : activeEntry && activeIndex != null ? (
        <DiffDetailView
          entry={activeEntry}
          onBack={() => setActiveIndex(null)}
          onClose={onClose}
        />
      ) : (
        <FileListView changes={changes} onSelect={setActiveIndex} />
      )}
    </aside>
  );
}

function FileListView({
  changes,
  onSelect,
}: {
  changes: ChangeEntry[];
  onSelect: (index: number) => void;
}) {
  return (
    <div className="changes-panel__list">
      <ul className="changes-panel__files">
        {changes.map((entry, idx) => {
          const filename = entry.path ? fileNameOf(entry.path) : entry.title;
          const hasDiff = Boolean(entry.diff && entry.diff.diffContent?.trim());
          return (
            <li key={`${entry.name}::${entry.path ?? entry.title}::${idx}`}>
              <button
                type="button"
                className="changes-panel__file"
                onClick={() => onSelect(idx)}
                title={entry.path ?? entry.title}
              >
                <span className="changes-panel__file-name">{filename}</span>
                {hasDiff ? (
                  <span className="changes-panel__file-stats">
                    <span className="changes-panel__file-stats-add">+{entry.diff!.insertions}</span>
                    <span className="changes-panel__file-stats-del">−{entry.diff!.deletions}</span>
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DiffDetailView({
  entry,
  onBack,
  onClose,
}: {
  entry: ChangeEntry;
  onBack: () => void;
  onClose?: () => void;
}) {
  const filename = entry.path ? fileNameOf(entry.path) : entry.title;
  const hasDiff = Boolean(entry.diff && entry.diff.diffContent?.trim());

  return (
    <div className="changes-panel__diff">
      <div className="changes-panel__diff-head">
        <button
          type="button"
          className="changes-panel__diff-back"
          onClick={onBack}
          title="返回文件列表"
          aria-label="返回文件列表"
        >
          <ArrowLeft size={16} strokeWidth={1.8} />
        </button>
        <span className="changes-panel__diff-title" title={entry.path ?? entry.title}>
          {filename}
        </span>
        {hasDiff ? (
          <span className="changes-panel__diff-stats">
            <span className="changes-panel__diff-stats-add">+{entry.diff!.insertions}</span>
            <span className="changes-panel__diff-stats-del">−{entry.diff!.deletions}</span>
          </span>
        ) : null}
        {onClose ? (
          <button
            type="button"
            className="changes-panel__diff-back"
            onClick={onClose}
            title="关闭变更面板"
            aria-label="关闭变更面板"
          >
            <X size={16} strokeWidth={1.8} />
          </button>
        ) : null}
      </div>
      <div className="changes-panel__diff-body">
        {hasDiff ? (
          <DiffTable diff={entry.diff!} />
        ) : (
          <div className="changes-panel__empty-diff">该文件无 diff 预览</div>
        )}
      </div>
    </div>
  );
}

/** 把 unified-diff 解析成带行号的表格结构 */
function DiffTable({ diff }: { diff: FileDiff }) {
  const hunks = parseUnifiedDiff(diff.diffContent);
  return (
    <div className="changes-panel__diff-wrap">
      {hunks.map((hunk, hIdx) => (
        <table key={hIdx} className="changes-panel__hunk-table">
          <tbody>
            {hunk.lines.map((line, lIdx) => (
              <tr
                key={lIdx}
                className={[
                  "changes-panel__line",
                  line.type === "add" ? "changes-panel__line--add" : "",
                  line.type === "del" ? "changes-panel__line--del" : "",
                  line.type === "meta" ? "changes-panel__line--meta" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <td className="changes-panel__lineno">{line.oldLine ?? ""}</td>
                <td className="changes-panel__lineno">{line.newLine ?? ""}</td>
                <td className="changes-panel__line">
                  <span className="changes-panel__line-prefix">{line.prefix}</span>
                  <span className="changes-panel__line-text">{line.text}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </div>
  );
}

interface DiffLine {
  type: "add" | "del" | "equal" | "meta";
  prefix: string;
  text: string;
  oldLine?: number;
  newLine?: number;
}

interface Hunk {
  header: string;
  lines: DiffLine[];
}

function parseUnifiedDiff(content: string): Hunk[] {
  const lines = content.split("\n");
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

    if (line.startsWith("@@")) {
      const parsed = parseHunkHeader(line);
      oldLine = parsed.oldStart;
      newLine = parsed.newStart;
      current = { header: line, lines: [] };
      hunks.push(current);
      current.lines.push({ type: "meta", prefix: "", text: line });
      continue;
    }

    if (line.startsWith("---") || line.startsWith("+++")) {
      // 文件头 meta 行：跳过，已在标题处显示
      continue;
    }

    if (!current) continue;

    if (line === "\\ No newline at end of file") {
      current.lines.push({ type: "meta", prefix: "", text: line });
      continue;
    }

    const prefix = line.charAt(0);
    const text = line.slice(1);

    switch (prefix) {
      case "+":
        current.lines.push({ type: "add", prefix: "+", text, newLine });
        newLine++;
        break;
      case "-":
        current.lines.push({ type: "del", prefix: "−", text, oldLine });
        oldLine++;
        break;
      case " ":
        current.lines.push({ type: "equal", prefix: " ", text, oldLine, newLine });
        oldLine++;
        newLine++;
        break;
      default:
        // 无前缀的上下文行（部分 diff 格式）按 equal 处理
        current.lines.push({ type: "equal", prefix: "", text: line, oldLine, newLine });
        oldLine++;
        newLine++;
        break;
    }
  }

  return hunks;
}

function parseHunkHeader(line: string) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) return { oldStart: 0, oldCount: 0, newStart: 0, newCount: 0 };
  return {
    oldStart: parseInt(match[1], 10),
    oldCount: parseInt(match[2] ?? "1", 10),
    newStart: parseInt(match[3], 10),
    newCount: parseInt(match[4] ?? "1", 10),
  };
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

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

// 仅用于测试导出（不让组件树被 hoist 时丢失类型）
export type { ChangesPanelProps };
