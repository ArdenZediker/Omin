// Omni - 「变更」侧边栏数据层
// 拉取工作区 git 变更列表 + 单文件 diff,均为结构化数据(已由 Rust 端解析好),
// 前端无需再处理文本解析与 stdout 编码,只负责展示与刷新。
import { invoke } from "@tauri-apps/api/core";

/** `git_status_files` / `git_diff_file` 返回的结构化记录 */
export interface GitFileChange {
  /** 相对工作区根的 POSIX 路径（已用 `/` 分隔） */
  path: string;
  /** 两位 XY 码：左 X=索引区状态、右 Y=工作区状态；`??`=未跟踪 */
  status: string;
  /** 增加行数；二进制文件（`git diff --numstat` 输出 `- -`）为 -1 */
  additions: number;
  /** 删除行数；二进制为 -1 */
  deletions: number;
  /** 是否有已暂存的修改 */
  staged: boolean;
}

export interface GitFileDiff {
  path: string;
  status: string;
  /** unified diff 全文，可能为空（文件无修改或全部已恢复） */
  unified_diff: string;
  additions: number;
  deletions: number;
}

/**
 * 拉取当前项目工作区的全部变更（git status + numstat 合并）。
 * `projectPath` 为 null 时 Rust 走 cwd,失败也不会再回退到「错误非 git 仓库」的文本——后端会抛 Err。
 */
export async function fetchGitStatus(projectPath: string | null): Promise<GitFileChange[]> {
  return invoke<GitFileChange[]>("git_status_files", { projectPath });
}

/**
 * 拉取单个文件的 unified diff。
 * `staged=true` 看已暂存内容,否则看工作区相对 HEAD 的 diff。
 * 未跟踪文件会自动用 `diff --no-index /dev/null <path>` 生成完整新增块。
 */
export async function fetchGitDiff(
  projectPath: string | null,
  filePath: string,
  staged: boolean = false,
): Promise<GitFileDiff> {
  return invoke<GitFileDiff>("git_diff_file", { projectPath, filePath, staged });
}

/** XY 码 → 中文描述,用于 UI 标签与可读性 */
export function describeGitStatus(status: string): string {
  // 优先按 X (索引区)判断:字母能区分「已暂存」的精确动作;Y (工作区)用于兜底
  const x = status.charAt(0);
  const y = status.charAt(1);
  if (status === "??") return "未跟踪";
  if (x === "A" || y === "A") return "新增";
  if (x === "D" || y === "D") return "已删除";
  if (x === "R" || y === "R") return "已重命名";
  if (x === "C" || y === "C") return "已复制";
  if (x === "M" || y === "M") return "已修改";
  if (status === "  ") return "无变更";
  return status.trim() || "未知";
}

/** 简单状态分组,决定文件列表的视觉分组与排序 */
export type ChangeGroup = "untracked" | "unstaged" | "staged" | "deleted";
export function groupForStatus(status: string, staged: boolean): ChangeGroup {
  if (status === "??") return "untracked";
  if (staged) return "staged";
  if (status.startsWith("D") || status.endsWith("D")) return "deleted";
  return "unstaged";
}

export const CHANGE_GROUP_ORDER: Record<ChangeGroup, number> = {
  untracked: 0,
  unstaged: 1,
  deleted: 2,
  staged: 3,
};

export const CHANGE_GROUP_LABEL: Record<ChangeGroup, string> = {
  untracked: "未跟踪",
  unstaged: "工作区改动",
  deleted: "删除",
  staged: "已暂存",
};

/**
 * 根据全量文件改动做一行汇总：「+23700 −19839」。
 * 二进制文件不计入（additions/deletions 可能为 -1）。
 */
export function summarizeChanges(files: GitFileChange[]): { additions: number; deletions: number; binaryCount: number } {
  let additions = 0;
  let deletions = 0;
  let binaryCount = 0;
  for (const f of files) {
    if (f.additions === -1 || f.deletions === -1) {
      binaryCount += 1;
      continue;
    }
    additions += f.additions;
    deletions += f.deletions;
  }
  return { additions, deletions, binaryCount };
}

/**
 * 把单段 diff 按 `@@` hunks 拆成段（含 hunk 头 + 行内容）,方便前端按段虚拟化或折叠。
 * 同时解析加/删行用于左侧行号显示(暂未在 UI 启用,但保留 hook)。
 */
export interface DiffSegment {
  /** 形如 `@@ -10,5 +12,7 @@` 的 hunk 头;首段可能为空 */
  header: string;
  /** 起始 old 行号(0=未知) */
  oldLineStart: number;
  /** 起始 new 行号(0=未知) */
  newLineStart: number;
  /** 该段内的每一行（含前缀 + / - / 空格 + 内容） */
  lines: string[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseUnifiedDiff(text: string): DiffSegment[] {
  const segments: DiffSegment[] = [];
  if (!text || text.trim().length === 0) return segments;
  const rawLines = text.split(/\r?\n/);
  let current: DiffSegment | null = null;
  // 在遇到 @@ 之前的全部行都视为文件头（diff/索引/---/+++ 等），独立成段
  for (const line of rawLines) {
    if (line.startsWith("@@")) {
      // 进入 hunk 之前先把手头的 current（如果还是空的「文件头段」）封入 segments
      // 文件头段 header === "" 表示「尚未遇到任何 hunk 的开场」
      if (current) {
        segments.push(current);
        current = null;
      }
      const m = HUNK_RE.exec(line);
      current = {
        header: line,
        oldLineStart: m ? Number(m[1]) : 0,
        newLineStart: m ? Number(m[2]) : 0,
        lines: [],
      };
      continue;
    }
    if (!current) {
      // 还没遇到 hunk — 收集文件头
      current = { header: "", oldLineStart: 0, newLineStart: 0, lines: [line] };
      continue;
    }
    if (current.header === "") {
      // 还在收集文件头（在第一个 @@ 之前）
      current.lines.push(line);
      continue;
    }
    // hunk 内容
    current.lines.push(line);
  }
  if (current) segments.push(current);
  return segments;
}
