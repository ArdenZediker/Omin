import { useEffect } from "react";
import type { ScheduledTaskRecord } from "../chat/types";

type UseScheduledTasksArgs = {
  scheduledTasks: ScheduledTaskRecord[];
  setScheduledTasks: React.Dispatch<React.SetStateAction<ScheduledTaskRecord[]>>;
  desktopActions: {
    openChat: (focusInput?: boolean) => Promise<void>;
    notify: (title: string, body: string) => void | Promise<void>;
    setDraft: (draft: string, images?: string[]) => Promise<void>;
  };
};

function isTaskDue(task: ScheduledTaskRecord) {
  if (!task.enabled) return false;
  if (!task.lastRunAt) return true;
  return Date.now() - task.lastRunAt > 60_000;
}

export function useScheduledTasks({ scheduledTasks, setScheduledTasks, desktopActions }: UseScheduledTasksArgs) {
  useEffect(() => {
    if (scheduledTasks.length === 0) return;

    let cancelled = false;
    const runDueTasks = async () => {
      for (const task of scheduledTasks) {
        if (cancelled || !isTaskDue(task)) continue;

        if (task.target === "desktop") {
          await desktopActions.setDraft(task.prompt);
        } else if (task.target === "notification") {
          await desktopActions.notify(task.title, task.prompt);
        } else {
          await desktopActions.openChat(true);
          await desktopActions.setDraft(task.prompt);
        }

        setScheduledTasks((current) =>
          current.map((item) =>
            item.id === task.id
              ? {
                  ...item,
                  lastRunAt: Date.now(),
                  updatedAt: Date.now(),
                }
              : item
          )
        );
      }
    };

    void runDueTasks();
    const timer = window.setInterval(() => {
      void runDueTasks();
    }, 30_000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [desktopActions, scheduledTasks, setScheduledTasks]);
}
