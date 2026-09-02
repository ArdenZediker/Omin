import type {
  ProjectMemoryScope,
  ProjectMemorySourceType,
} from "../chat/types";
import type { Project } from "../chat/types";
import type { TaskExecutionResult } from "../chat/taskTypes";
import { resolveProjectAvatarImageSrc } from "../config/manifests/avatarHelpers";
import { readSqliteBackedValue } from "../app/sqliteStorage";

export const MAIN_LAYOUT_TOPIC_WIDTH_STORAGE_KEY = "main_layout_topic_width";
export const EMPTY_CHAT_GUIDE_COMPACT_STORAGE_KEY =
  "main_empty_chat_guide_compact";
export const DEFAULT_TOPIC_PANEL_WIDTH = 240;
export const MIN_TOPIC_PANEL_WIDTH = 220;
export const MAX_TOPIC_PANEL_WIDTH = 360;
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

export function renderProjectAvatar(project: Project | null, seed = 0) {
  return (
    <img
      src={resolveProjectAvatarImageSrc(project, seed)}
      alt=""
      className="chat-history-panel__project-image"
    />
  );
}
