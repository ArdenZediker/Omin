import { describe, expect, it } from "vitest";
import { createChatRunOutput, mergeChatRunReply } from "./chatRunOutput";
import type { TaskExecutionResult } from "../chat/taskTypes";

describe("mergeChatRunReply", () => {
  it("keeps streamed text, reasoning and tool results when a task fails before final output", () => {
    const run = createChatRunOutput("session-1", 1, null, [{ role: "user", content: "读文件" }]);
    const task: TaskExecutionResult = {
      taskId: "task-1", intent: "chat", status: "failed", trace: [],
      plan: { taskId: "task-1", intent: "chat", goal: "读文件", model: "test", sourceMessages: run.messages, steps: [], createdAt: 1 },
      partialText: "已读取片段", partialReasoning: "正在整理",
      partialSteps: [{ type: "tool_call", name: "read_file", arguments: "{}", result: "片段" }],
      error: "network disconnected",
    };
    const reply = mergeChatRunReply(run, { role: "project", content: "" }, task);
    expect(reply.content).toBe("已读取片段");
    expect(reply.reasoning).toBe("正在整理");
    expect(reply.steps).toContainEqual(expect.objectContaining({ type: "tool_call", name: "read_file", result: "片段" }));
  });
});
