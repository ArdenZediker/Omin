// 产出归档配置：生成文档的「产出根目录」与「对话镜像为 Markdown」开关。
// 全部走前端设置（sqliteStorage），无需改动 Rust；实际落盘复用已有的 write_text_file 命令。

import { invoke } from "@tauri-apps/api/core";
import { readSqliteBackedValue, saveSqliteBackedValue } from "./sqliteStorage";
import type { ChatSession } from "../chat/types";
import type { ChatAttachment } from "../adapters/types";

export const OUTPUT_ROOT_KEY = "omni_output_root_v1";
export const MIRROR_SESSIONS_KEY = "omni_mirror_sessions_md_v1";

// ---------- 设置读写 ----------

export function getOutputRootSetting(): string {
  if (typeof window === "undefined") return "";
  return readSqliteBackedValue(OUTPUT_ROOT_KEY)?.trim() ?? "";
}

export function setOutputRootSetting(value: string): void {
  saveSqliteBackedValue(OUTPUT_ROOT_KEY, value.trim());
}

export function isMirrorSessionsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return readSqliteBackedValue(MIRROR_SESSIONS_KEY) === "true";
}

export function setMirrorSessionsEnabled(enabled: boolean): void {
  saveSqliteBackedValue(MIRROR_SESSIONS_KEY, enabled ? "true" : "false");
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

/** 计算某会话的产出目录：base / 项目slug / 会话slug。 */
export function buildSessionOutputDir(
  base: string,
  projectTitle: string | null | undefined,
  sessionTitle: string,
  sessionId: string
): string {
  return joinPath(base, sanitizeDirName(projectTitle || "no-project"), sessionDirName(sessionTitle, sessionId));
}

/**
 * 产出根目录：优先用用户设置的绝对路径；否则回退系统文档目录/Omni（与既有默认行为一致）。
 * 返回空串表示无法确定（如非 Tauri 环境）。
 */
export async function getEffectiveOutputRoot(): Promise<string> {
  const setting = getOutputRootSetting();
  if (setting && isAbsolutePath(setting)) return setting;
  try {
    const dir = await invoke<string>("default_artifact_dir");
    if (typeof dir === "string" && dir.trim()) return joinPath(dir.trim(), "Omni");
  } catch {
    // 忽略：回退空串
  }
  return "";
}

// ---------- 对话渲染 ----------

function renderMessageContent(content: string): string {
  return content.trim();
}

/** 把一场对话渲染成 Markdown：标题 + 元信息 + 按角色分节的消息。 */
export function renderSessionMarkdown(session: ChatSession, projectTitle?: string | null): string {
  const lines: string[] = [];
  lines.push(`# ${session.title || "未命名对话"}`);
  lines.push("");
  if (projectTitle) {
    lines.push(`> 项目：${projectTitle}`);
    lines.push("");
  }
  const created = new Date(session.createdAt).toISOString().replace("T", " ").slice(0, 19);
  const updated = new Date(session.updatedAt).toISOString().replace("T", " ").slice(0, 19);
  lines.push(`> 创建：${created}　更新：${updated}　会话ID：${session.id}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  for (const msg of session.messages) {
    const role = msg.role === "user" ? "用户" : msg.role === "project" ? "Omni" : msg.role;
    const body = renderMessageContent(msg.content) || "_（空）_";
    lines.push(`## ${role}`);
    lines.push("");
    lines.push(body);
    lines.push("");
  }
  return lines.join("\n");
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

/** 会话附件快照目录：产出根 / 项目slug / 会话slug / attachments。 */
export function buildAttachmentSnapshotDir(
  base: string,
  projectTitle: string | null | undefined,
  sessionTitle: string,
  sessionId: string
): string {
  return joinPath(buildSessionOutputDir(base, projectTitle, sessionTitle, sessionId), "attachments");
}

/**
 * 把用户随消息附带的本地文件复制一份到会话产物目录，返回改写了路径的附件列表。
 *
 * 背景：附件此前只存原始绝对路径，用户移动/重命名/删除原文件后，模型回看历史消息时
 * /read_file 就读不到了。发送时落一份快照，让非图片附件也像图片（base64 内联进消息体）
 * 一样自包含——语义对齐 DeepSeek / WorkBuddy 的「摄取副本」而非「记指针」。
 *
 * 降级：产出根目录无法确定（非 Tauri 环境）或复制失败时，保留原路径返回，不阻断发送；
 * 此时退化为旧行为，由 /read_file 报错提示用户重新选择文件。
 */
export async function snapshotAttachments(
  attachments: ChatAttachment[],
  context: { projectTitle: string | null | undefined; sessionTitle: string; sessionId: string }
): Promise<ChatAttachment[]> {
  if (attachments.length === 0) return attachments;

  const base = await getEffectiveOutputRoot();
  if (!base) return attachments;

  const dir = buildAttachmentSnapshotDir(base, context.projectTitle, context.sessionTitle, context.sessionId);
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
        snapshotted.push({ path: copied.path, name: attachment.name, size: copied.size ?? null });
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
