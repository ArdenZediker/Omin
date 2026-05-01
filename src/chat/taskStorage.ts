import { readSqliteBackedValue, saveSqliteBackedValue } from "../app/sqliteStorage";
import type { TaskExecutionResult } from "./taskTypes";

export const TASK_HISTORY_STORAGE_KEY = "omni_task_history";

export function parseTaskHistorySnapshot(raw: string | null | undefined): TaskExecutionResult[] {
  try {
    const parsed = raw ? (JSON.parse(raw) as TaskExecutionResult[]) : [];
    return parsed.filter((item) => typeof item?.taskId === "string" && typeof item?.intent === "string" && typeof item?.status === "string");
  } catch {
    return [];
  }
}

export function getInitialTaskHistory() {
  if (typeof window === "undefined") return [];
  return parseTaskHistorySnapshot(readSqliteBackedValue(TASK_HISTORY_STORAGE_KEY));
}

export function serializeTaskHistorySnapshot(history: TaskExecutionResult[]) {
  return JSON.stringify(history);
}

export function saveTaskHistory(history: TaskExecutionResult[]) {
  saveSqliteBackedValue(TASK_HISTORY_STORAGE_KEY, serializeTaskHistorySnapshot(history));
}
