import { useState } from "react";
import type { ScheduledTaskRecord } from "../chat/types";
import type { ScheduleIssue } from "../hooks/useScheduledTasks";
import "./scheduledReminderNotice.css";

type Props = {
  tasks: ScheduledTaskRecord[];
  issues: Record<string, ScheduleIssue>;
  onRetry: (taskId: string) => Promise<void>;
};

export default function ScheduledReminderNotice({ tasks, issues, onRetry }: Props) {
  const [retrying, setRetrying] = useState<string | null>(null);
  const visible = tasks.filter((task) => task.enabled && issues[task.id]);
  if (!visible.length) return null;
  return (
    <aside className="scheduled-reminder-notice" role="status" aria-label="提醒状态">
      <strong>有 {visible.length} 项提醒需要处理</strong>
      <ul>
        {visible.map((task) => {
          const issue = issues[task.id];
          const canRetry = issue.code === "failed" || issue.code === "unknown";
          return (
            <li key={task.id}>
              <span><b>{task.title}</b>：{issue.message}</span>
              {canRetry && <button type="button" disabled={retrying !== null}
                aria-label={`手动再次提醒：${task.title}`}
                onClick={async () => {
                  setRetrying(task.id);
                  try { await onRetry(task.id); } finally { setRetrying(null); }
                }}>{retrying === task.id ? "正在重试…" : "手动再提醒"}</button>}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
