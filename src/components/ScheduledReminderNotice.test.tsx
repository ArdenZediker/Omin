import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ScheduledReminderNotice from "./ScheduledReminderNotice";

const task = {
  id: "reminder-1", title: "复盘", prompt: "检查本周进展", cron: "0 9 * * *",
  target: "notification" as const, enabled: true, createdAt: 1, updatedAt: 1,
};

describe("ScheduledReminderNotice", () => {
  it("shows failure context and exposes an accessible manual retry", async () => {
    const retry = vi.fn(async () => undefined);
    render(<ScheduledReminderNotice tasks={[task]} issues={{
      [task.id]: { taskId: task.id, code: "failed", message: "系统通知权限未获允许" },
    }} onRetry={retry} />);
    expect(screen.getByRole("status", { name: "提醒状态" })).toHaveTextContent("系统通知权限未获允许");
    fireEvent.click(screen.getByRole("button", { name: "手动再次提醒：复盘" }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith(task.id));
  });

  it("does not offer retry before a delivery claim or for disabled reminders", () => {
    const { rerender } = render(<ScheduledReminderNotice tasks={[task]} issues={{
      [task.id]: { taskId: task.id, code: "invalid", message: "cron 格式错误" },
    }} onRetry={vi.fn(async () => undefined)} />);
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<ScheduledReminderNotice tasks={[{ ...task, enabled: false }]} issues={{
      [task.id]: { taskId: task.id, code: "failed", message: "投递失败" },
    }} onRetry={vi.fn(async () => undefined)} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
