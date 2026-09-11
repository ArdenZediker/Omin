// 产出归档配置：产出目录解析、路径工具与附件快照。
//
// 目录哲学（与 codex / atomcode / deepseek-harness 一致的三分法）：
//   ① 会话数据（消息 + 附件快照 + 工具输出）→ 应用数据根，按项目分桶：
//        <数据根>/chat-sessions/<项目slug_id8>/<sessionId>/
//          session.jsonl        对话消息（Rust 权威存储，路径由 Rust 拥有）
//          attachments/         附件快照（应用内部数据，随会话一起备份/删除）
//   ② 模型产物（导出的文档/表格/演示/Markdown）→ 落会话的工作目录：
//        <会话 cwd>/Omni-导出/<日期>/<项目>/<会话>/
//      产物是「交付给用户的文件」：能看见、能 git 提交、能共享；因此不进应用备份，
//      删会话也不删除磁盘文件——它已经是用户项目的一部分。
//   ③ cwd 本身由会话固化（会话 → 项目 → 默认工作空间 → 兜底目录）。
//
// 会话目录的实际位置由 Rust 解析（前端调 resolve_session_dir，不复制分桶规则）；
// 「固定归档目录」设置（OUTPUT_ROOT_KEY）保留为产物落点的覆盖项。

import { invoke } from "@tauri-apps/api/core";
import { readSqliteBackedValue, saveSqliteBackedValue } from "./sqliteStorage";
import type { ChatAttachment } from "../adapters/types";

export const OUTPUT_ROOT_KEY = "omni_output_root_v1";

/// 产物在工作目录下的子目录名：不跟源码混在根目录。
export const OUTPUT_SUBDIR = "Omni-导出";

// ---------- 设置读写 ----------

export function getOutputRootSetting(): string {
  if (typeof window === "undefined") return "";
  return readSqliteBackedValue(OUTPUT_ROOT_KEY)?.trim() ?? "";
}

export function setOutputRootSetting(value: string): void {
  saveSqliteBackedValue(OUTPUT_ROOT_KEY, value.trim());
}

// ---------- 路径工具 ----------

export function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");
}

/** 清洗成安全的目录名：保留中文/字母数字，限制长度，去首尾非法/点空格。 */
export function sanitizeDirName(raw: string): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40)
    .replace(/[. ]+$/, "");
  return cleaned || "untitled";
}

/**
 * 日期桶目录名：本地时区的 `YYYY-MM-DD`。
 *
 * 产物落在工作目录下的公共产出树（`Omni-导出`）里，按会话创建日期切分能减少平铺。
 * 取会话 createdAt 而非写入时刻，避免跨天继续对话时把同一会话的产物劈成两半。
 */
export function dateFolderName(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function joinPath(dir: string, ...parts: string[]): string {
  let base = dir.replace(/[\\/]+$/, "");
  for (const part of parts) {
    if (part) base = `${base}/${part}`;
  }
  return base;
}

/** 单个会话目录名：标题 + 短 id，保证同项目内唯一且可读。 */
export function sessionDirName(sessionTitle: string, sessionId: string): string {
  return `${sanitizeDirName(sessionTitle || "session")}_${sessionId.slice(0, 8)}`;
}

// ---------- 会话数据目录（由 Rust 解析） ----------

/**
 * 会话数据目录：`<数据根>/chat-sessions/<项目分桶>/<sessionId>`。
 *
 * 分桶规则属于 Rust（storage.rs 的 session_bucket_name），前端不复制，
 * 改由命令 resolve_session_dir 解析——它同时兼容旧版扁平结构与项目改名后的历史位置。
 * 返回空串表示无法解析（如非 Tauri 环境或会话不存在）。
 */
export async function resolveSessionDir(sessionId: string): Promise<string> {
  if (!sessionId) return "";
  try {
    const dir = await invoke<string>("resolve_session_dir", { sessionId });
    return dir?.trim() ?? "";
  } catch {
    return "";
  }
}

/**
 * 附件快照目录：`<会话数据目录>/attachments`。
 *
 * 恒定落在会话目录内、不受「固定归档目录」影响——附件快照是应用内部数据（让消息自包含），
 * 不该占用用户的工作区，且应随会话一起备份与删除。
 */
export async function resolveAttachmentSnapshotDir(sessionId: string): Promise<string> {
  const dir = await resolveSessionDir(sessionId);
  return dir ? joinPath(dir, "attachments") : "";
}

/**
 * 导出产物目录。
 *
 *  ① 用户主动设置的「固定归档目录」覆盖：`<override>/<日期>/<项目>/<会话>`；
 *  ② 默认：`<会话工作目录>/Omni-导出/<日期>/<项目>/<会话>`。
 *
 * 返回空串表示无法解析（非 Tauri 环境或会话没有可用工作目录），调用方应退化为裸文件名。
 */
export async function resolveSessionOutputDir(context: {
  sessionId: string;
  workspacePath: string;
  projectTitle: string | null | undefined;
  sessionTitle: string;
  createdAt?: number;
}): Promise<string> {
  const segments = [
    dateFolderName(context.createdAt ?? Date.now()),
    sanitizeDirName(context.projectTitle || "no-project"),
    sessionDirName(context.sessionTitle, context.sessionId),
  ];
  const override = getOutputRootSetting();
  if (override && isAbsolutePath(override)) {
    return joinPath(override, ...segments);
  }
  const cwd = context.workspacePath?.trim();
  if (!cwd) return "";
  return joinPath(cwd, OUTPUT_SUBDIR, ...segments);
}

// ---------- 会话附件快照 ----------

/** 从绝对路径取文件名（兼容 / 与 \ 两种分隔符）。 */
function baseNameOfPath(p: string): string {
  return p.split(/[\\/]/).pop() || "attachment";
}

/** 清洗附件文件名：去掉路径分隔符与非法字符，保留扩展名，空则兜底。 */
export function sanitizeAttachmentFileName(raw: string): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || "attachment";
}

/**
 * 把用户随消息附带的本地文件复制一份到会话目录的 attachments/ 下，返回改写了路径的附件列表。
 *
 * 背景：附件此前只存原始绝对路径，用户移动/重命名/删除原文件后，模型回看历史消息时
 * /read_file 就读不到了。发送时落一份快照，让非图片附件也像图片（base64 内联进消息体）
 * 一样自包含——语义对齐 DeepSeek / WorkBuddy 的「摄取副本」而非「记指针」。
 *
 * 降级：会话目录无法确定（非 Tauri 环境）或复制失败时，保留原路径返回，不阻断发送；
 * 此时退化为旧行为，由 /read_file 报错提示用户重新选择文件。
 */
export async function snapshotAttachments(
  attachments: ChatAttachment[],
  context: { sessionId: string }
): Promise<ChatAttachment[]> {
  if (attachments.length === 0) return attachments;

  const dir = await resolveAttachmentSnapshotDir(context.sessionId);
  if (!dir) return attachments;

  const snapshotted: ChatAttachment[] = [];

  for (const attachment of attachments) {
    const fileName = sanitizeAttachmentFileName(attachment.name || baseNameOfPath(attachment.path));
    try {
      const copied = await invoke<{ path: string; size: number }>("copy_file_to_store", {
        src: attachment.path,
        dst: joinPath(dir, fileName),
      });
      if (copied?.path) {
        // name 保留用户看到的原始文件名，path 指向快照，size 用落盘后的真实字节数。
        // offset 必须透传——它记录了该附件在正文中的插入位置，渲染时靠它决定 chip 排在文字前/中/后。
        snapshotted.push({
          path: copied.path,
          name: attachment.name,
          size: copied.size ?? null,
          offset: attachment.offset,
        });
        continue;
      }
    } catch (error) {
      // 落快照失败不应阻断发送：退回原始路径，由 /read_file 报错提示用户重新选择。
      console.error("附件快照失败，回退原始路径", error);
    }
    snapshotted.push(attachment);
  }

  return snapshotted;
}
