import type { AssistantProfile } from "../chat/types";
import type { TaskRuntimeState } from "../chat/taskTypes";

export type DesktopRuntimeSnapshot = {
  activeAssistantId: string | null;
  activeAssistantTitle: string | null;
  activeTaskId: string | null;
  activeTaskGoal: string | null;
  taskCount: number;
};

export function buildDesktopRuntimeSnapshot(options: {
  activeAssistant: AssistantProfile | null;
  taskRuntimeState: TaskRuntimeState;
}): DesktopRuntimeSnapshot {
  const { activeAssistant, taskRuntimeState } = options;
  return {
    activeAssistantId: activeAssistant?.id ?? null,
    activeAssistantTitle: activeAssistant?.title ?? null,
    activeTaskId: taskRuntimeState.activeTask?.taskId ?? null,
    activeTaskGoal: taskRuntimeState.activeTask?.plan.goal ?? null,
    taskCount: taskRuntimeState.history.length,
  };
}
