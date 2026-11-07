import { loadAppKvEntries, readSqliteBackedValue, saveAppKvEntry, saveSqliteBackedValue } from "../app/sqliteStorage";
import type { TaskExecutionResult } from "./taskTypes";

export const TASK_HISTORY_STORAGE_KEY = "omni_task_history";

export function taskHistoryStorageKey(windowLabel: string) {
  return `${TASK_HISTORY_STORAGE_KEY}:${windowLabel}`;
}

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

export async function getInitialTaskHistory(windowLabel = "main") {
  if (typeof window === "undefined") return [];
  const key = taskHistoryStorageKey(windowLabel);
  let raw: string | null | undefined;
  if (canUseTauriStorage()) {
    const entries = await loadAppKvEntries(windowLabel === "main" ? [key, TASK_HISTORY_STORAGE_KEY] : [key]);
    raw = entries[key] ?? (windowLabel === "main" ? entries[TASK_HISTORY_STORAGE_KEY] : undefined);
  } else {
    raw = readSqliteBackedValue(key);
  }
  // 旧整窗快照只由 main 迁移；保留旧 key，写入新 key 成功后它不再参与读取。
  raw ??= readSqliteBackedValue(key) ?? (windowLabel === "main" ? readSqliteBackedValue(TASK_HISTORY_STORAGE_KEY) : null);
  return parseTaskHistorySnapshot(raw);
}

export function serializeTaskHistorySnapshot(history: TaskExecutionResult[]) {
  return JSON.stringify(history);
}

export async function saveTaskHistory(history: TaskExecutionResult[], windowLabel = "main") {
  const key = taskHistoryStorageKey(windowLabel);
  const serialized = serializeTaskHistorySnapshot(history);
  if (canUseTauriStorage()) {
    await saveAppKvEntry(key, serialized);
    localStorage.removeItem(key);
    return;
  }
  saveSqliteBackedValue(key, serialized);
}

/** 仅处理启动快照；正在执行的新任务绝不能被 hydration 误判为中断。 */
export function recoverInterruptedTasks(history: TaskExecutionResult[]): TaskExecutionResult[] {
  return history.map((task) => task.status !== "running" ? task : {
    ...task,
    status: "aborted",
    error: "上次运行已中断，外部操作结果可能未知。请先核实结果，再主动发送新消息继续；不会重播旧工具。",
  });
}

/** History is newest-first; a later successful run clears an older interruption for this session. */
export function getLatestTaskForSession(history: TaskExecutionResult[], sessionId: string | null | undefined) {
  if (!sessionId) return null;
  return history.find((task) => task.sessionId === sessionId) ?? null;
}

/** 一个 webview 一个 writer：等待 hydration、按顺序合并自己的任务，再保存不可变快照。 */
export function createTaskHistoryStore(windowLabel: string) {
  let history: TaskExecutionResult[] = [];
  let hydration: Promise<void> | undefined;
  let hydrated = false;
  let queue: Promise<unknown> = Promise.resolve();
  const load = () => {
    hydration ??= (async () => {
      history = recoverInterruptedTasks(await getInitialTaskHistory(windowLabel));
      // 完成迁移/中断恢复后才放行开始回调。空库不写，尤其不在初次 render 写 []。
      if (history.length) await saveTaskHistory(history, windowLabel);
      hydrated = true;
    })().catch((error) => {
      hydration = undefined;
      throw error;
    });
    return hydration;
  };
  return {
    load,
    getHistory: () => history,
    record(task: TaskExecutionResult) {
      // 执行器会继续改变 plan/trace，必须在入队时拍快照。
      const snapshot = JSON.parse(JSON.stringify(task)) as TaskExecutionResult;
      const operation = queue.catch(() => undefined).then(async () => {
        if (!hydrated) await load();
        let terminalCount = 0;
        history = [snapshot, ...history.filter((entry) => entry.taskId !== snapshot.taskId)]
          .filter((entry) => entry.status === "running" || terminalCount++ < 12);
        await saveTaskHistory(history, windowLabel);
      });
      queue = operation;
      return operation;
    },
  };
}
