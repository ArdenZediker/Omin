import { Pin } from "lucide-react";
import type { ProjectMemoryScope, ProjectMemorySourceType } from "../chat/types";
import type { Project } from "../chat/types";
import type { TaskExecutionResult } from "../chat/taskTypes";
import { AVATAR_PRESETS } from "../config/manifests/avatars";
import { resolveProjectAvatarImageSrc } from "../config/manifests/avatarHelpers";
import { readSqliteBackedValue } from "../app/sqliteStorage";

export const MAIN_LAYOUT_TOPIC_WIDTH_STORAGE_KEY = "main_layout_topic_width";
export const EMPTY_CHAT_GUIDE_COMPACT_STORAGE_KEY = "main_empty_chat_guide_compact";
export const DEFAULT_TOPIC_PANEL_WIDTH = 240;
export const MIN_TOPIC_PANEL_WIDTH = 220;
export const MAX_TOPIC_PANEL_WIDTH = 360;
export const PROJECT_GROUPS_STORAGE_KEY = "assistant_groups";
export const DEFAULT_PROJECT_GROUP_LABEL = "默认列表";

export function clampPanelWidth(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function readStoredPanelWidth(storageKey: string, fallback: number, min: number, max: number) {
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

export function findPresetMetaByProject(project: Project | null) {
  if (!project?.sourcePresetId) return null;
  return AVATAR_PRESETS.find((preset) => preset.code === project.sourcePresetId) ?? null;
}

export function buildTaskAggregateSummary(task: TaskExecutionResult) {
  const childCount = task.plan.childTaskIds?.length ?? 0;
  const lastTrace = task.trace.slice(-2).map((entry) => entry.message).join(" · ");
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

export function enhancePresetPromptIfNeeded(presetCode: string, prompt: string) {
  if (presetCode !== "2728") {
    return prompt;
  }

  return `## 角色定位
你是通用顾问型 AI 助手，适合处理日常问答、资料整理、轻咨询和方向建议。

## 核心职责
- 帮用户把问题说明白、理清楚、做顺。
- 提供平衡、稳健、易理解的建议。
- 在信息不足时先补关键信息，不仓促下结论。

## 行为要求
- 优先理解用户真实目标，而不是只回答字面问题。
- 多方案场景下，给出简短比较和推荐，不并列堆砌。
- 如果用户只想快速拿结果，先给结论，再补说明。
- 如果任务存在明显风险、前提不足或信息冲突，要主动指出。

## 边界与禁忌
- 不要为了显得聪明而过度延展问题。
- 不要在不确定时装懂或编造事实。
- 不要输出空泛安慰、套话或无执行价值的建议。
- 不要把简单问题复杂化。

## 澄清策略
- 只有当缺少关键信息会影响结论时，才提出澄清问题。
- 澄清问题尽量少，一次只问最关键的 1 到 2 个。

## 输出风格
- 使用中文。
- 表达自然、克制、清楚。
- 少空话，少套话。
- 尽量给出用户下一步可以直接执行的建议。`;
}

export function renderProjectAvatar(project: Project | null, seed = 0) {
  return <img src={resolveProjectAvatarImageSrc(project, seed)} alt="" className="chat-history-panel__project-image" />;
}
