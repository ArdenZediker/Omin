import type { Project } from "../chat/types";
import { Bot, FolderOpen } from "lucide-react";
import { readSqliteBackedValue } from "../app/sqliteStorage";

/** 会话头像中的气泡图标：圆润消息气泡 + 三个点。 */
export function SessionAvatarIcon(props: { size?: number; color?: string }) {
  const { size = 12, color = "currentColor" } = props;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path
        d="M6 5h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-9l-3.5 3v-3H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"
        fill="currentColor"
        fillOpacity="0.18"
      />
      <circle cx="9.5" cy="11.5" r="1.1" fill={color} stroke="none" />
      <circle cx="12" cy="11.5" r="1.1" fill={color} stroke="none" />
      <circle cx="14.5" cy="11.5" r="1.1" fill={color} stroke="none" />
    </svg>
  );
}

export const MAIN_LAYOUT_TOPIC_WIDTH_STORAGE_KEY = "main_layout_topic_width";
export const EMPTY_CHAT_GUIDE_COMPACT_STORAGE_KEY =
  "main_empty_chat_guide_compact";
export const DEFAULT_TOPIC_PANEL_WIDTH = 240;
export const MIN_TOPIC_PANEL_WIDTH = 220;
/** 话题/产物面板的理论最大宽度上限（用于初始化读回持久化值时兜底，
 *  远高于常见屏幕宽度，实际拖动不再受此硬限制，由 MIN_MAIN_CHAT_AREA_WIDTH
 *  决定可拖到的最宽位置）。 */
export const MAX_TOPIC_PANEL_WIDTH = 2000;
/** 中间聊天区域保留的最小宽度；拖动右侧面板时，面板最宽可拖到
 *  window.innerWidth - MIN_MAIN_CHAT_AREA_WIDTH，避免把聊天区完全盖住。 */
export const MIN_MAIN_CHAT_AREA_WIDTH = 220;

export const PROJECT_GROUPS_STORAGE_KEY = "project_groups";
export const DEFAULT_PROJECT_GROUP_LABEL = "项目空间";
export const QUESTION_PREVIEW_MAX_LENGTH = 48;

/** 历史提问列表中展示用的提问摘要：去除首尾空白 + 折叠内部空白后截断，避免
 *  多行换行把列表项撑高。 */
export function truncateQuestionPreview(content: string, maxLength: number = QUESTION_PREVIEW_MAX_LENGTH): string {
  const compact = content.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(1, maxLength - 1))}…`;
}

export function readProjectGroupsStorageValue(): string | null {
  return readSqliteBackedValue(PROJECT_GROUPS_STORAGE_KEY);
}

export function clampPanelWidth(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function readStoredPanelWidth(
  storageKey: string,
  fallback: number,
  min: number,
  max: number,
) {
  const saved = readSqliteBackedValue(storageKey);
  if (!saved) return fallback;
  const parsed = Number.parseInt(saved, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return clampPanelWidth(parsed, min, max);
}

export function normalizeSearchText(value: string) {
  return value.toLocaleLowerCase().replace(/\s+/g, "");
}

export function renderProjectAvatar(project: Project | null) {
  if (project?.avatarType === "image" && project.avatarValue) {
    return (
      <img
        src={project.avatarValue}
        alt=""
        className="chat-history-panel__project-image"
      />
    );
  }

  if (project?.kind === "custom") {
    return (
      <FolderOpen
        size={24}
        strokeWidth={1.8}
        className="chat-history-panel__project-folder-icon"
      />
    );
  }

  return (
    <Bot
      size={20}
      strokeWidth={1.8}
      className="chat-history-panel__project-folder-icon"
    />
  );
}

export function getSessionAvatarStyle(
  id: string
): { backgroundColor: string; color: string } {
  const colors = [
    { bg: "var(--omni-accent-soft, rgba(31, 111, 235, 0.15))", fg: "var(--omni-accent-strong, #1d4ed8)" },
    { bg: "var(--omni-skill-bg, rgba(130, 80, 223, 0.12))", fg: "var(--omni-skill, #8250df)" },
    { bg: "var(--omni-warning-bg, rgba(154, 103, 0, 0.1))", fg: "var(--omni-warning, #9a6700)" },
    { bg: "var(--omni-danger-soft, rgba(220, 38, 38, 0.08))", fg: "var(--omni-danger, #cf222e)" },
    { bg: "var(--omni-app-success-bg, rgba(99, 153, 34, 0.12))", fg: "var(--omni-app-success, #3b6d11)" },
    { bg: "color-mix(in srgb, var(--omni-link, #2563eb) 12%, transparent)", fg: "var(--omni-link, #2563eb)" },
    { bg: "color-mix(in srgb, var(--omni-accent, #1f6feb) 9%, transparent)", fg: "var(--omni-primary, #1f6feb)" },
    { bg: "color-mix(in srgb, var(--omni-app-success, #3b6d11) 10%, transparent)", fg: "var(--omni-app-success, #3b6d11)" },
  ];
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % colors.length;
  const { bg, fg } = colors[index];
  return { backgroundColor: bg, color: fg };
}

/** 空间头部「在内部新建会话」按钮图标：圆角消息气泡 + 加号。 */
export function NewSessionInSpaceIcon(props: { size?: number; color?: string }) {
  const { size = 16, color = "currentColor" } = props;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.7-5.7A8.38 8.38 0 0 1 3.9 11.5a8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      <path d="M12 9v6 M9 12h6" />
    </svg>
  );
}
