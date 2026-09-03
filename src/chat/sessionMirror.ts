// 对话镜像：开启「镜像对话为 Markdown」后，每场会话在其产出目录写入 <sessionId>.md。
// 与生成文档共用同一产出根目录（项目slug / 会话slug 子目录），SQLite 仍是事实源，这里只是侧写。

import { invoke } from "@tauri-apps/api/core";
import type { ChatSession, Project } from "./types";
import { buildSessionOutputDir, getEffectiveOutputRoot, isMirrorSessionsEnabled } from "../app/outputStorage";
import { renderSessionMarkdown } from "../app/outputStorage";

// 防抖：同一会话 1.5s 内多次更新只落盘一次，避免流式输出时高频写文件。
const DEBOUNCE_MS = 1500;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const pending = new Map<string, { session: ChatSession; project: Project | null }>();

/** 安排一次（防抖的）对话镜像写入。镜像开关关闭或未在浏览器环境时直接跳过。 */
export function scheduleSessionMirror(session: ChatSession, project: Project | null): void {
  if (typeof window === "undefined" || !isMirrorSessionsEnabled()) return;
  pending.set(session.id, { session, project });

  const existing = timers.get(session.id);
  if (existing) clearTimeout(existing);
  timers.set(
    session.id,
    setTimeout(() => {
      void flushSessionMirror(session.id);
    }, DEBOUNCE_MS)
  );
}

/** 取消某会话的待写镜像（如会话被删除时）。 */
export function clearSessionMirrorSchedule(sessionId: string): void {
  const timer = timers.get(sessionId);
  if (timer) clearTimeout(timer);
  timers.delete(sessionId);
  pending.delete(sessionId);
}

async function flushSessionMirror(sessionId: string): Promise<void> {
  const entry = pending.get(sessionId);
  pending.delete(sessionId);
  timers.delete(sessionId);
  if (!entry) return;

  const { session, project } = entry;
  try {
    // 与导出工具保持一致：有项目工作区时用它作基底，否则用「产出根目录」设置（未设回退默认）。
    // 这样对话 md 会落在与生成文件相同的「项目 / 会话」子目录里。
    const base = project?.workspacePath || (await getEffectiveOutputRoot());
    if (!base) return;
    const dir = buildSessionOutputDir(base, project?.title, session.title, session.id);
    const content = renderSessionMarkdown(session, project?.title);
    const path = `${dir.replace(/[\\/]+$/, "")}/${session.id}.md`;
    const workspacePath = project?.workspacePath || null;
    await invoke("write_text_file", { path, content, overwrite: true, workspacePath });
  } catch {
    // 镜像失败不影响主流程（如目录不可写、被围栏拒绝等）。
  }
}
