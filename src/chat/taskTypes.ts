import type { Message } from "../adapters/types";
import type { ToolExecutionResult } from "./toolRegistry";
import type { ChatExecutionResult } from "./types";

export type TaskIntent = "chat" | "prompt_skill" | "local_command" | "tool_chain";

export type TaskStage = "plan" | "act" | "review" | "finalize";

export type TaskStatus = "running" | "completed" | "failed" | "aborted";

export type TaskStepStatus = "pending" | "completed" | "failed";

export type TaskStepKind = "input" | "skill" | "tool" | "model" | "review" | "finalize";

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
  intent: TaskIntent;
  status: TaskStatus;
  plan: TaskPlan;
  trace: TaskTraceEntry[];
  conversationMessages?: Message[];
  finalResult?: ChatExecutionResult;
  toolResult?: ToolExecutionResult;
  error?: string;
};

export type TaskRuntimeState = {
  activeTask: TaskExecutionResult | null;
  history: TaskExecutionResult[];
};

export type SubAgentTaskKind = "search" | "file_analysis" | "content_draft";

export type SubAgentTaskRecord = {
  id: string;
  parentTaskId: string;
  kind: SubAgentTaskKind;
  title: string;
  payload: string;
  status: "pending" | "running" | "completed" | "failed";
  result?: string;
  createdAt: number;
  updatedAt: number;
};

export type MultiAgentRuntimeState = {
  tasks: SubAgentTaskRecord[];
  aggregatedResult?: string;
};
