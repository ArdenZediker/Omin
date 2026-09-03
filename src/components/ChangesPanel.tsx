// 右侧「变更」侧边栏 — 对应截图 2/3/4
//
// 实现方式与现有 ArtifactsPanel 对齐：
//  - 顶部标签栏（概览 / 已打开文件详情）
//  - 概览视图展示工作区变更汇总与文件列表（按未跟踪/工作区/删除/已暂存分组）
//  - 点击文件进入详情视图，单栏 unified diff（左侧行号 + 增删高亮）
//
// 数据全部走 src/chat/gitChanges.ts 调 Tauri 命令 git_status_files / git_diff_file。
// 工作区路径从 prop 传入；为 null 时显示「无项目/无 git 仓库」空态。
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, FileCode2, FolderGit2, FolderSearch, GitBranch, Loader2, RefreshCw, X } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  CHANGE_GROUP_LABEL,
  CHANGE_GROUP_ORDER,
  describeGitStatus,
  fetchGitDiff,
  fetchGitStatus,
  groupForStatus,
  parseUnifiedDiff,
  summarizeChanges,
  type ChangeGroup,
  type GitFileChange,
  type GitFileDiff,
} from "../chat/gitChanges";

interface ChangesPanelProps {
  /** 当前激活项目的工作区根路径；为 null 时可临时通过「选择目录…」指定一个 git 仓 */
  workspacePath: string | null;
  /** 当前分支名（可选，用于 header 显示） */
  branchName?: string | null;
  /** 嵌入其他面板时由父级控制显示关闭按钮 */
  onClose?: () => void;
}

export default function ChangesPanel({ workspacePath, branchName, onClose }: ChangesPanelProps) {
  // 当 props.workspacePath 为空时，允许用户用「选择目录…」按钮临时选一个本地 git 仓查看变更。
  // props 一旦重新提供有效路径，自动清掉临时选择，让项目自身优先。
  const [overridePath, setOverridePath] = useState<string | null>(null);
  const effectivePath = workspacePath || overridePath || null;
  const [files, setFiles] = useState<GitFileChange[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  const [diff, setDiff] = useState<GitFileDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  useEffect(() => {
    if (workspacePath) setOverridePath(null);
  }, [workspacePath]);

  const pickTemporaryDirectory = useCallback(async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "选择本地目录查看 Git 变更",
      });
      if (typeof picked === "string" && picked.trim()) {
        setOverridePath(picked.trim());
        setOpenFilePath(null);
        setDiff(null);
        setDiffError(null);
      }
    } catch (error) {
      setLoadError(typeof error === "string" ? error : String(error ?? "选择目录失败"));
    }
  }, []);

  // ===== 加载 git status =====
  const reloadStatus = useCallback(async () => {
    if (!effectivePath) {
      setFiles([]);
      setLoadError(null);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const list = await fetchGitStatus(effectivePath);
      setFiles(list);
    } catch (e) {
      setFiles([]);
      setLoadError(typeof e === "string" ? e : String(e ?? "加载变更失败"));
    } finally {
      setLoading(false);
    }
  }, [effectivePath]);

  useEffect(() => {
    void reloadStatus();
  }, [reloadStatus]);

  // ===== 进入 diff 详情 =====
  const openFile = useCallback(
    async (file: GitFileChange) => {
      setOpenFilePath(file.path);
      setDiff(null);
      setDiffError(null);
      setDiffLoading(true);
      try {
        const next = await fetchGitDiff(effectivePath, file.path, file.staged && file.status !== "??");
        setDiff(next);
      } catch (e) {
        setDiffError(typeof e === "string" ? e : String(e ?? "读取 diff 失败"));
      } finally {
        setDiffLoading(false);
      }
    },
    [effectivePath],
  );

  const closeFile = useCallback(() => {
    setOpenFilePath(null);
    setDiff(null);
    setDiffError(null);
  }, []);

  const backToOverview = useCallback(() => {
    setOpenFilePath(null);
  }, []);

  // ===== 文件分组 =====
  const groupedFiles = useMemo(() => {
    const groups = new Map<ChangeGroup, GitFileChange[]>();
    if (!files) return groups;
    for (const f of files) {
      const g = groupForStatus(f.status, f.staged);
      const arr = groups.get(g) ?? [];
      arr.push(f);
      groups.set(g, arr);
    }
    return groups;
  }, [files]);

  const summary = useMemo(() => summarizeChanges(files ?? []), [files]);

  return (
    <aside className="changes-panel">
      <div className="changes-panel__header">
        <div className="changes-panel__tabs">
          <button
            type="button"
            role="tab"
            aria-selected={openFilePath == null}
            className={`changes-panel__tab ${openFilePath == null ? "changes-panel__tab--active" : ""}`}
            title="变更概览"
            onClick={backToOverview}
          >
            <FileCode2 size={12} strokeWidth={2} />
            <span className="changes-panel__tab-label">概览</span>
          </button>
          {openFilePath ? (
            <button
              type="button"
              role="tab"
              aria-selected
              className="changes-panel__tab changes-panel__tab--active"
              title={openFilePath}
            >
              <span className="changes-panel__tab-label" title={openFilePath}>
                {fileNameOf(openFilePath)}
              </span>
              <span
                className="changes-panel__tab-close"
                role="button"
                aria-label="关闭详情"
                title="关闭详情"
                onClick={(e) => {
                  e.stopPropagation();
                  closeFile();
                }}
              >
                <X size={11} strokeWidth={2} />
              </span>
            </button>
          ) : null}
        </div>
        <div className="changes-panel__header-actions">
          <button
            type="button"
            className="changes-panel__iconbtn"
            onClick={() => void pickTemporaryDirectory()}
            title="临时选择其他本地目录查看变更"
            aria-label="选择目录"
            disabled={Boolean(workspacePath)}
          >
            <FolderSearch size={13} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="changes-panel__iconbtn"
            onClick={() => void reloadStatus()}
            title="刷新变更列表"
            aria-label="刷新变更列表"
            disabled={loading}
          >
            <RefreshCw size={13} strokeWidth={2} className={loading ? "changes-panel__iconbtn--spin" : undefined} />
          </button>
          {onClose ? (
            <button type="button" className="changes-panel__iconbtn" onClick={onClose} title="关闭变更面板" aria-label="关闭变更面板">
              <X size={14} strokeWidth={2} />
            </button>
          ) : null}
        </div>
      </div>

      {openFilePath == null ? (
        <OverviewView
          workspacePath={effectivePath}
          branchName={branchName}
          files={files ?? []}
          summary={summary}
          loading={loading}
          loadError={loadError}
          groupedFiles={groupedFiles}
          onOpenFile={openFile}
          onReload={reloadStatus}
          onPickDirectory={() => void pickTemporaryDirectory()}
        />
      ) : (
        <DiffView
          path={openFilePath}
          diff={diff}
          loading={diffLoading}
          error={diffError}
          onBack={backToOverview}
        />
      )}
    </aside>
  );
}

// ===== 概览视图 =====

interface OverviewProps {
  workspacePath: string | null;
  branchName?: string | null;
  files: GitFileChange[];
  summary: ReturnType<typeof summarizeChanges>;
  loading: boolean;
  loadError: string | null;
  groupedFiles: Map<ChangeGroup, GitFileChange[]>;
  onOpenFile: (file: GitFileChange) => void;
  onReload: () => void;
  /** 无项目工作区时由父级注入「选择目录…」回调，让空态可一键唤起选择器 */
  onPickDirectory?: () => void;
}

function OverviewView({
  workspacePath,
  branchName,
  files,
  summary,
  loading,
  loadError,
  groupedFiles,
  onOpenFile,
  onReload,
  onPickDirectory,
}: OverviewProps) {
  if (!workspacePath) {
    return (
      <EmptyState
        icon={<FolderGit2 size={26} strokeWidth={1.4} />}
        title="未绑定项目工作区"
        hint={
          onPickDirectory
            ? "为当前会话绑定一个本地项目后可自动跟随；在此之前，可临时选一个本地目录查看变更。"
            : "为当前会话绑定一个本地项目后，会在此展示该工作区的 Git 变更列表。"
        }
        action={onPickDirectory ? { label: "选择目录…", onClick: onPickDirectory } : undefined}
      />
    );
  }

  if (loadError) {
    return (
      <EmptyState
        icon={<FolderGit2 size={26} strokeWidth={1.4} />}
        title="无法读取工作区变更"
        hint={loadError}
        action={{ label: "重试", onClick: onReload }}
      />
    );
  }

  if (loading && files.length === 0) {
    return (
      <div className="changes-panel__loading">
        <Loader2 size={16} strokeWidth={1.8} className="changes-panel__iconbtn--spin" />
        <span>正在读取变更…</span>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <EmptyState
        icon={<FolderGit2 size={26} strokeWidth={1.4} />}
        title="工作区干净"
        hint="没有未跟踪、未暂存或已暂存的改动。"
      />
    );
  }

  const orderedGroups = (Object.keys(CHANGE_GROUP_ORDER) as ChangeGroup[])
    .filter((g) => (groupedFiles.get(g)?.length ?? 0) > 0)
    .sort((a, b) => CHANGE_GROUP_ORDER[a] - CHANGE_GROUP_ORDER[b]);

  return (
    <div className="changes-panel__overview">
      <div className="changes-panel__overview-summary">
        {branchName ? (
          <div className="changes-panel__branch" title={`当前分支：${branchName}`}>
            <GitBranch size={13} strokeWidth={1.9} />
            <span>{branchName}</span>
          </div>
        ) : null}
        <div className="changes-panel__root" title={`工作区根：${workspacePath}`}>
          <FolderGit2 size={12} strokeWidth={1.9} />
          <span>{workspacePath}</span>
        </div>
        <div className="changes-panel__counts" title="总加/删行数">
          <strong className="changes-panel__count--add">+{summary.additions}</strong>
          <strong className="changes-panel__count--del">-{summary.deletions}</strong>
          {summary.binaryCount > 0 ? (
            <span className="changes-panel__binary" title="二进制文件不计入行数">
              · 二进制 {summary.binaryCount}
            </span>
          ) : null}
        </div>
        <div className="changes-panel__filemeta" title="变更文件总数">
          文件变更 <strong>{files.length}</strong>
        </div>
      </div>

      <div className="changes-panel__list">
        {orderedGroups.map((group) => (
          <GroupSection
            key={group}
            group={group}
            files={groupedFiles.get(group) ?? []}
            onOpenFile={onOpenFile}
          />
        ))}
      </div>
    </div>
  );
}

function GroupSection({
  group,
  files,
  onOpenFile,
}: {
  group: ChangeGroup;
  files: GitFileChange[];
  onOpenFile: (file: GitFileChange) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const groupTotal = useMemo(
    () =>
      files.reduce(
        (acc, f) => ({
          additions: acc.additions + (f.additions === -1 ? 0 : f.additions),
          deletions: acc.deletions + (f.deletions === -1 ? 0 : f.deletions),
          binary: acc.binary + (f.additions === -1 ? 1 : 0),
        }),
        { additions: 0, deletions: 0, binary: 0 },
      ),
    [files],
  );

  return (
    <section className="changes-panel__group">
      <button
        type="button"
        className="changes-panel__group-header"
        onClick={() => setExpanded((cur) => !cur)}
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown size={12} strokeWidth={2} /> : <ChevronRight size={12} strokeWidth={2} />}
        <span className="changes-panel__group-name">{CHANGE_GROUP_LABEL[group]}</span>
        <span className="changes-panel__group-count">{files.length}</span>
        {groupTotal.binary > 0 ? (
          <span className="changes-panel__group-binary">· 二进制 {groupTotal.binary}</span>
        ) : null}
      </button>
      {expanded ? (
        <ul className="changes-panel__files">
          {files.map((f) => (
            <li key={f.path}>
              <button
                type="button"
                className={`changes-panel__file ${f.status === "??" ? "changes-panel__file--untracked" : ""} ${
                  f.status.startsWith("D") || f.status.endsWith("D") ? "changes-panel__file--deleted" : ""
                }`}
                onClick={() => onOpenFile(f)}
                title={`${describeGitStatus(f.status)} · ${f.path}`}
              >
                <span className="changes-panel__file-status" aria-hidden="true">
                  {shortStatusBadge(f.status)}
                </span>
                <span className="changes-panel__file-name">{fileNameOf(f.path)}</span>
                <span className="changes-panel__file-dir">{fileDirOf(f.path)}</span>
                <span className="changes-panel__file-stats">
                  {f.additions === -1 ? (
                    <span className="changes-panel__file-binary">二进制</span>
                  ) : (
                    <>
                      <span className="changes-panel__count--add">+{f.additions}</span>
                      <span className="changes-panel__count--del">-{f.deletions}</span>
                    </>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// ===== Diff 详情视图 =====

interface DiffViewProps {
  path: string;
  diff: GitFileDiff | null;
  loading: boolean;
  error: string | null;
  onBack: () => void;
}

function DiffView({ path, diff, loading, error, onBack }: DiffViewProps) {
  return (
    <div className="changes-panel__diff">
      <div className="changes-panel__diff-head">
        <button type="button" className="changes-panel__diff-back" onClick={onBack} title="返回概览" aria-label="返回概览">
          <ArrowLeft size={14} strokeWidth={2} />
        </button>
        <div className="changes-panel__diff-title" title={path}>
          {fileNameOf(path)}
        </div>
        <div className="changes-panel__diff-stats">
          {diff ? (
            <>
              <span className="changes-panel__count--add">+{diff.additions}</span>
              <span className="changes-panel__count--del">-{diff.deletions}</span>
            </>
          ) : null}
        </div>
      </div>
      <div className="changes-panel__diff-body">
        {loading ? (
          <div className="changes-panel__loading">
            <Loader2 size={16} strokeWidth={1.8} className="changes-panel__iconbtn--spin" />
            <span>正在读取 diff…</span>
          </div>
        ) : error ? (
          <EmptyState
            icon={<FileCode2 size={26} strokeWidth={1.4} />}
            title="读取 diff 失败"
            hint={error}
          />
        ) : diff && diff.unified_diff.trim().length === 0 ? (
          <EmptyState
            icon={<FileCode2 size={26} strokeWidth={1.4} />}
            title="无修改"
            hint="当前所选状态（工作区/暂存）下文件没有 diff。"
          />
        ) : diff ? (
          <DiffBody diff={diff} />
        ) : null}
      </div>
    </div>
  );
}

function DiffBody({ diff }: { diff: GitFileDiff }) {
  const segments = useMemo(() => parseUnifiedDiff(diff.unified_diff), [diff.unified_diff]);
  const fileHeader = useMemo(() => segments[0]?.lines ?? [], [segments]);
  const hunks = useMemo(() => segments.slice(1).filter((s) => s.header.startsWith("@@")), [segments]);

  if (hunks.length === 0) {
    // 全是文件头,没有 hunk (例如是工作区状态但没拿到 diff) — 直接展示原始文本
    return (
      <pre className="changes-panel__rawdiff">
        {diff.unified_diff}
      </pre>
    );
  }

  return (
    <div className="changes-panel__diff-wrap">
      <div className="changes-panel__file-header">
        {fileHeader.slice(0, 6).map((line, idx) => (
          <div key={idx} className="changes-panel__file-header-line">
            {line}
          </div>
        ))}
      </div>
      {hunks.map((seg, idx) => (
        <HunkView key={idx} segment={seg} />
      ))}
    </div>
  );
}

function HunkView({ segment }: { segment: ReturnType<typeof parseUnifiedDiff>[number] }) {
  let oldLine = segment.oldLineStart;
  let newLine = segment.newLineStart;
  return (
    <div className="changes-panel__hunk">
      <div className="changes-panel__hunk-head">{segment.header}</div>
      <table className="changes-panel__hunk-table">
        <tbody>
          {segment.lines.map((line, idx) => {
            const prefix = line[0] ?? " ";
            const content = line.slice(1);
            let oldLn: number | null = null;
            let newLn: number | null = null;
            if (prefix === " ") {
              oldLn = oldLine++;
              newLn = newLine++;
            } else if (prefix === "-") {
              oldLn = oldLine++;
            } else if (prefix === "+") {
              newLn = newLine++;
            } else if (prefix === "\\") {
              // "\ No newline at end of file" — 跳过
            }
            const cls =
              prefix === "+"
                ? "changes-panel__line--add"
                : prefix === "-"
                  ? "changes-panel__line--del"
                  : prefix === "\\"
                    ? "changes-panel__line--meta"
                    : "changes-panel__line--ctx";
            return (
              <tr key={idx} className={cls}>
                <td className="changes-panel__lineno">{oldLn ?? ""}</td>
                <td className="changes-panel__lineno">{newLn ?? ""}</td>
                <td className="changes-panel__line">
                  <span className="changes-panel__line-prefix">{prefix}</span>
                  <span className="changes-panel__line-text">{content}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ===== 通用空态 =====

function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="changes-panel__empty">
      {icon}
      <p>{title}</p>
      <span>{hint}</span>
      {action ? (
        <button type="button" className="changes-panel__empty-action" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

// ===== 小工具 =====

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function fileDirOf(path: string): string {
  const sepIdx = path.lastIndexOf("/");
  if (sepIdx < 0) return "";
  return path.slice(0, sepIdx);
}

function shortStatusBadge(status: string): string {
  if (status === "??") return "U";
  if (status.startsWith("A") || status.endsWith("A")) return "A";
  if (status.startsWith("D") || status.endsWith("D")) return "D";
  if (status.startsWith("M") || status.endsWith("M")) return "M";
  if (status.startsWith("R") || status.endsWith("R")) return "R";
  if (status.startsWith("C") || status.endsWith("C")) return "C";
  return "·";
}

// 仅用于测试导出（不让组件树被 hoist 时丢失类型）
export type { ChangesPanelProps };
