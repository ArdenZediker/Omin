// 产出归档配置：「产出根目录」设置、路径工具与附件快照。
// 全部走前端设置（sqliteStorage），无需改动 Rust；实际落盘复用已有的 write_text_file / copy_file_to_store 命令。

import { invoke } from "@tauri-apps/api/core";
import { readSqliteBackedValue, saveSqliteBackedValue } from "./sqliteStorage";
import { loadBasicSettings } from "../app/settingsStore";
import { BASIC_SETTINGS_STORAGE_KEY, DEFAULT_BASIC_SETTINGS } from "../app/constants";
import { getFallbackWorkspacePath } from "../chat/storage";
import type { ChatAttachment } from "../adapters/types";

export const OUTPUT_ROOT_KEY = "omni_output_root_v1";

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
 * 解析「有效产出根目录」：导出文档/表格/演示/Markdown 与附件快照的落地根。
 *
 * 优先级（对齐 codex「永远在工作空间内」的极简哲学，避免再堆一个独立「产出目录」设置）：
 *  1. 用户主动设置的「固定归档目录」覆盖（仅当用户在设置里勾选并选择后才存在）；
 *  2. 否则落到「有效工作空间」下的 `Omni-导出` 子目录：
 *     - 全局默认工作空间（BasicSettings.defaultWorkspacePath）；
 *     - 再回退兜底目录（<data_root>/fallback-workspace，仿 codex ~/.codex）。
 *
 * 这样未绑定工作空间的会话，其生成物也落在明确、可预期的目录，而非散到 ~/Documents。
 * 返回空串表示无法解析（如非 Tauri 环境）。
 */
export async function getEffectiveOutputRoot(): Promise<string> {
  // ① 用户显式覆盖：想把导出固定归档到工作空间之外时才需要
  const override = getOutputRootSetting();
  if (override && isAbsolutePath(override)) return override;

  // ② 默认：有效工作空间 / Omni-导出
  const defaultWs =
    loadBasicSettings(BASIC_SETTINGS_STORAGE_KEY, DEFAULT_BASIC_SETTINGS).defaultWorkspacePath?.trim() ?? "";
  const base = defaultWs || getFallbackWorkspacePath();
  if (base) return joinPath(base, "Omni-导出");
  return "";
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
 * 会话附件快照目录：产出根 / 项目slug / sessions/<sessionId>/attachments。
 *
 * 纯 sessionId 分桶：会话标题会随对话推进变化，含标题的目录会让同一会话
 * 不同时间的附件散落多处；sessionId 稳定不变，附件按绝对路径存取，
 * 目录名可读性无碍。旧版（标题_slug_id8）目录中的既有快照不受影响。
 */
export function buildAttachmentSnapshotDir(
  base: string,
  projectTitle: string | null | undefined,
  sessionId: string
): string {
  return joinPath(base, sanitizeDirName(projectTitle || "no-project"), "sessions", sessionId, "attachments");
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
  context: { projectTitle: string | null | undefined; sessionId: string }
): Promise<ChatAttachment[]> {
  if (attachments.length === 0) return attachments;

  const base = await getEffectiveOutputRoot();
  if (!base) return attachments;

  const dir = buildAttachmentSnapshotDir(base, context.projectTitle, context.sessionId);
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
