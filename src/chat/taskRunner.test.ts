import { describe, expect, it } from "vitest";
import { runTaskPlan } from "./taskRunner";
import type { TaskPlan } from "./taskTypes";
import { executeTask } from "./taskExecutor";

vi.mock("./engine", () => ({ executeChatTurn: vi.fn(async () => ({
  content: "部分输出",
  model: "test",
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  estimated: true,
  costUsd: 0,
})) }));
import { executeChatTurn } from "./engine";
import { vi } from "vitest";

describe("runTaskPlan", () => {
  it("最后一步等待期间取消仍是 aborted，保留已经返回的输出", async () => {
    const controller = new AbortController();
    const plan: TaskPlan = { taskId: "test", intent: "chat", goal: "test", model: "test", sourceMessages: [], createdAt: 0,
      steps: [{ id: "last", title: "last", kind: "finalize", stage: "finalize", status: "pending" }] };
    const result = await runTaskPlan({ plan, signal: controller.signal, executeStep: async ({ api }) => {
      api.setToolResult({ ok: true, outputText: "已写入" });
      controller.abort();
    } });
    expect(result.status).toBe("aborted");
    expect(result.state.toolResult?.outputText).toBe("已写入");
  });

  it("校验阶段失败会将任务标失败，并保留模型的部分输出", async () => {
    vi.mocked(executeChatTurn).mockResolvedValueOnce({
      content: "部分输出", model: "test", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, estimated: true, costUsd: 0,
      steps: [{ type: "tool_call", name: "read_file", arguments: "{}", result: "权限拒绝", isError: true }],
    });
    const result = await executeTask({ model: "test", messages: [] });
    expect(result.status).toBe("failed");
    expect(result.finalResult?.content).toBe("部分输出");
    expect(result.plan.steps.find((step) => step.kind === "review")?.status).toBe("failed");
  });
});
