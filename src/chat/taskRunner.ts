import type { Message } from "../adapters/types";
import type { ToolExecutionResult } from "./toolRegistry";
import type { ChatExecutionResult } from "./types";
import type { TaskPlan, TaskStatus, TaskStep, TaskTraceEntry } from "./taskTypes";

export type TaskRunnerState = {
  finalResult?: ChatExecutionResult;
  conversationMessages?: Message[];
  toolResult?: ToolExecutionResult;
  error?: string;
};

export type TaskRunnerStepApi = {
  appendTrace: (message: string) => void;
  setFinalResult: (result: ChatExecutionResult) => void;
  setConversationMessages: (messages: Message[]) => void;
  setToolResult: (result: ToolExecutionResult) => void;
};

export type TaskRunnerStepContext = {
  plan: TaskPlan;
  step: TaskStep;
  state: TaskRunnerState;
  signal?: AbortSignal;
  api: TaskRunnerStepApi;
};

export async function runTaskPlan(options: {
  plan: TaskPlan;
  signal?: AbortSignal;
  initialState?: TaskRunnerState;
  executeStep: (context: TaskRunnerStepContext) => Promise<void>;
}): Promise<{
  plan: TaskPlan;
  trace: TaskTraceEntry[];
  status: TaskStatus;
  state: TaskRunnerState;
}> {
  const { plan, signal, initialState, executeStep } = options;
  const trace: TaskTraceEntry[] = [];
  const state: TaskRunnerState = {
    conversationMessages: initialState?.conversationMessages ?? plan.sourceMessages,
    finalResult: initialState?.finalResult,
    error: initialState?.error,
  };

  const appendTrace = (step: TaskStep, message: string) => {
    trace.push({
      at: Date.now(),
      stage: step.stage,
      message,
    });
  };

  const updateStepStatus = (stepId: string, status: TaskStep["status"]) => {
    plan.steps = plan.steps.map((step) => (step.id === stepId ? { ...step, status } : step));
  };

  for (const step of plan.steps) {
    if (signal?.aborted) {
      updateStepStatus(step.id, "failed");
      appendTrace(step, "任务已取消");
      state.error = "Request aborted";
      return { plan, trace, status: "aborted", state };
    }

    try {
      await executeStep({
        plan,
        step,
        state,
        signal,
        api: {
          appendTrace: (message) => appendTrace(step, message),
          setFinalResult: (result) => {
            state.finalResult = result;
          },
          setConversationMessages: (messages) => {
            state.conversationMessages = messages;
          },
          setToolResult: (result) => {
            state.toolResult = result;
          },
        },
      });

      updateStepStatus(step.id, "completed");
    } catch (error) {
      updateStepStatus(step.id, "failed");
      state.error = error instanceof Error ? error.message : "Unknown task error";
      appendTrace(step, signal?.aborted ? "任务已取消" : "步骤执行失败");
      return {
        plan,
        trace,
        status: signal?.aborted ? "aborted" : "failed",
        state,
      };
    }
  }

  return {
    plan,
    trace,
    status: "completed",
    state,
  };
}
