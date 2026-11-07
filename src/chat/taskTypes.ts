import type { Message } from "../adapters/types";
import type { ToolExecutionResult } from "./toolRegistry";
import type { ChatExecutionResult } from "./types";

export type TaskIntent = "chat" | "local_command" | "tool_chain";

export type TaskStage = "plan" | "act" | "review" | "finalize";

export type TaskStatus = "running" | "completed" | "failed" | "aborted";

export type TaskStepStatus = "pending" | "completed" | "failed";

export type TaskStepKind = "input" | "tool" | "model" | "review" | "finalize";

export type TaskStep = {
  id: string;
  title: string;
  kind: TaskStepKind;
  stage: TaskStage;
  status: TaskStepStatus;
};

export type TaskTraceEntry = {
  at: number;
  stage: TaskStage;
  message: string;
};

export type TaskPlan = {
  taskId: string;
  parentTaskId?: string | null;
  childTaskIds?: string[];
  delegatedTo?: string | null;
  intent: TaskIntent;
  goal: string;
  model: string;
  sourceMessages: Message[];
  steps: TaskStep[];
  createdAt: number;
  metadata?: Record<string, string | number | boolean | null>;
};

export type TaskExecutionResult = {
  taskId: string;
  /** Owning conversation; used to restore task status beside its session after restart. */
  sessionId?: string | null;
  intent: TaskIntent;
  status: TaskStatus;
  plan: TaskPlan;
  trace: TaskTraceEntry[];
  conversationMessages?: Message[];
  finalResult?: ChatExecutionResult;
  toolResult?: ToolExecutionResult;
  /** Streamed output survives abort/review failure even without a final model result. */
  partialText?: string;
  partialReasoning?: string;
  partialSteps?: import("./types").ChatStep[];
  error?: string;
};

export type TaskRuntimeState = {
  activeTask: TaskExecutionResult | null;
  history: TaskExecutionResult[];
};


