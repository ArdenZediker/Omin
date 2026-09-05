import type {
  ProjectMemoryScope,
  ProjectMemorySourceType,
} from "../chat/types";
import type { Project } from "../chat/types";
import type { TaskExecutionResult } from "../chat/taskTypes";
import { Bot, FolderOpen } from "lucide-react";
import { readSqliteBackedValue } from "../app/sqliteStorage";

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

/** 对话框（输入区）拖动时的最小高度。 */
export const MIN_COMPOSER_RESIZE_HEIGHT = 120;
/** 对话框的理论最大高度上限（仅用于持久化读回兜底，远高于屏幕，
 *  实际拖动由 MIN_MESSAGE_AREA_HEIGHT 动态限制）。 */
export const MAX_COMPOSER_RESIZE_HEIGHT = 2000;
/** 消息区保留的最小高度；拖动对话框时，最高可拖到
 *  window.innerHeight - MIN_MESSAGE_AREA_HEIGHT，避免把消息区完全盖住。 */
export const MIN_MESSAGE_AREA_HEIGHT = 120;
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

export function getMemorySourceTypeLabel(sourceType?: ProjectMemorySourceType) {
  if (sourceType === "auto") return "自动沉淀";
  if (sourceType === "manual") return "手动添加";
  if (sourceType === "command") return "命令写入";
  return "旧记录";
}

export function buildTaskAggregateSummary(task: TaskExecutionResult) {
  const childCount = task.plan.childTaskIds?.length ?? 0;
  const lastTrace = task.trace
    .slice(-2)
    .map((entry) => entry.message)
    .join(" · ");
  if (childCount <= 0 && !lastTrace) return null;
  return {
    childCount,
    text: lastTrace || "已拆分并执行子任务",
  };
}

export function formatMemoryScopeLabel(scope: ProjectMemoryScope) {
  switch (scope) {
    case "off":
      return "不启用记忆";
    case "session":
      return "仅当前话题";
    case "project":
    default:
      return "当前项目全局";
  }
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
        size={20}
        strokeWidth={1.9}
        className="chat-history-panel__project-folder-icon"
      />
    );
  }

  return (
    <Bot
      size={20}
      strokeWidth={1.9}
      className="chat-history-panel__project-folder-icon"
    />
  );
}
