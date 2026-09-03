// 产出归档配置：生成文档的「产出根目录」与「对话镜像为 Markdown」开关。
// 全部走前端设置（sqliteStorage），无需改动 Rust；实际落盘复用已有的 write_text_file 命令。

import { invoke } from "@tauri-apps/api/core";
import { readSqliteBackedValue, saveSqliteBackedValue } from "./sqliteStorage";
import type { ChatSession } from "../chat/types";

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
