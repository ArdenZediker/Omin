import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TaskExecutionResult } from "../chat/taskTypes";
import { InterruptedTaskBadge, InterruptedTaskNotice } from "./TaskStatusIndicators";

function task(status: TaskExecutionResult["status"]): TaskExecutionResult {
  return {
    taskId: "task-1", sessionId: "session-1", intent: "chat", status,
    error: "上次运行已中断，外部操作结果可能未知。",
    plan: { taskId: "task-1", intent: "chat", goal: "test", model: "test", sourceMessages: [], steps: [], createdAt: 1 },
    trace: [],
  };
}

describe("task interruption status", () => {
  it("shows actionable restart guidance without replaying tools", () => {
    render(<InterruptedTaskNotice task={task("aborted")} />);
    expect(screen.getByRole("status")).toHaveTextContent("外部操作结果可能未知");
    expect(screen.getByRole("status")).toHaveTextContent("发送新消息继续");
    expect(screen.getByRole("status")).toHaveTextContent("旧工具不会自动重放");
  });

  it("does not show an interruption notice for a successful latest run", () => {
    const { container } = render(<InterruptedTaskNotice task={task("completed")} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("labels interrupted task sessions for non-color-only recognition", () => {
    render(<InterruptedTaskBadge />);
    expect(screen.getByLabelText("任务已中断")).toHaveTextContent("已中断");
  });
});
