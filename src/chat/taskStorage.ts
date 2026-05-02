import { loadAppKvEntries, readSqliteBackedValue, saveAppKvEntry, saveSqliteBackedValue } from "../app/sqliteStorage";
import type { TaskExecutionResult } from "./taskTypes";

export const TASK_HISTORY_STORAGE_KEY = "omni_task_history";

function canUseTauriStorage() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function parseTaskHistorySnapshot(raw: string | null | undefined): TaskExecutionResult[] {
  try {
    const parsed = raw ? (JSON.parse(raw) as TaskExecutionResult[]) : [];
    return parsed.filter((item) => typeof item?.taskId === "string" && typeof item?.intent === "string" && typeof item?.status === "string");
  } catch {
    return [];
  }
}

export async function getInitialTaskHistory() {
  if (typeof window === "undefined") return [];
  if (canUseTauriStorage()) {
    const entries = await loadAppKvEntries([TASK_HISTORY_STORAGE_KEY]);
    return parseTaskHistorySnapshot(entries[TASK_HISTORY_STORAGE_KEY]);
  }
  return parseTaskHistorySnapshot(readSqliteBackedValue(TASK_HISTORY_STORAGE_KEY));
}

export function serializeTaskHistorySnapshot(history: TaskExecutionResult[]) {
  return JSON.stringify(history);
}

export async function saveTaskHistory(history: TaskExecutionResult[]) {
  const serialized = serializeTaskHistorySnapshot(history);
  if (canUseTauriStorage()) {
    await saveAppKvEntry(TASK_HISTORY_STORAGE_KEY, serialized);
    localStorage.removeItem(TASK_HISTORY_STORAGE_KEY);
    return;
  }
  saveSqliteBackedValue(TASK_HISTORY_STORAGE_KEY, serialized);
}
