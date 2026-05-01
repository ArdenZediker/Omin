import type { SubAgentTaskKind, SubAgentTaskRecord } from "./taskTypes";

function createSubAgentTaskId(parentTaskId: string, kind: SubAgentTaskKind) {
  return `${parentTaskId}:sub:${kind}:${Math.random().toString(36).slice(2, 8)}`;
}

export function createSubAgentTask(input: {
  parentTaskId: string;
  kind: SubAgentTaskKind;
  title: string;
  payload: string;
}): SubAgentTaskRecord {
  const now = Date.now();
  return {
    id: createSubAgentTaskId(input.parentTaskId, input.kind),
    parentTaskId: input.parentTaskId,
    kind: input.kind,
    title: input.title,
    payload: input.payload,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
}

export function completeSubAgentTask(task: SubAgentTaskRecord, result: string) {
  return {
    ...task,
    result,
    status: "completed" as const,
    updatedAt: Date.now(),
  };
}

export function failSubAgentTask(task: SubAgentTaskRecord, result: string) {
  return {
    ...task,
    result,
    status: "failed" as const,
    updatedAt: Date.now(),
  };
}

export function collectSubAgentResults(tasks: SubAgentTaskRecord[]) {
  return tasks
    .filter((task) => task.status === "completed" && task.result)
    .map((task) => `[${task.kind}] ${task.title}\n${task.result}`)
    .join("\n\n");
}

export function canRunSubAgentTask(kind: SubAgentTaskKind, allowedToolIds: string[]) {
  if (kind === "search") {
    return allowedToolIds.includes("search_files") || allowedToolIds.includes("search_sessions");
  }
  if (kind === "file_analysis") {
    return allowedToolIds.includes("read_file") || allowedToolIds.includes("analyze_files");
  }
  if (kind === "content_draft") {
    return true;
  }
  return false;
}
