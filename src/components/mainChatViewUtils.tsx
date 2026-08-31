import { Pin } from "lucide-react";
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

export function renderTopicGroupLabel(label: string) {
  if (label === "置顶") {
    return (
      <>
        <Pin size={11} strokeWidth={2} />
        <span>置顶话题</span>
      </>
    );
  }

  return <span>{label}</span>;
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
