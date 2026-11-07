import { AlertTriangle } from "lucide-react";
import type { TaskExecutionResult } from "../chat/taskTypes";

export function InterruptedTaskNotice({ task }: { task: TaskExecutionResult | null }) {
  if (!task || task.status !== "aborted") return null;
  return (
    <div className="main-chat-interrupted-notice" role="status" aria-live="polite">
      <AlertTriangle size={15} aria-hidden="true" />
      <span>
        上次任务已中断，外部操作结果可能未知。请先核实结果，再在本会话发送新消息继续；旧工具不会自动重放。
      </span>
    </div>
  );
}

export function InterruptedTaskBadge() {
  return (
    <span className="chat-history-panel__task-status" title="最近一次任务已中断" aria-label="任务已中断">
      已中断
    </span>
  );
}
