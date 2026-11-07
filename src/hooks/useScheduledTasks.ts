import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ScheduledTaskRecord } from "../chat/types";
import type { ChatImage } from "../adapters/types";
import { findLatestScheduleOccurrence } from "./scheduledTaskCron";
import { scheduleStateStore, type ScheduleDeliveryRecord, type ScheduleStateStore } from "./scheduledTaskState";

export type ScheduleIssue = {
  taskId: string;
  code: "invalid" | "storage" | "unavailable" | "failed" | "unknown";
  message: string;
  slotKey?: string;
};

export type ScheduledReminderActions = {
  setDraft: (draft: string, images?: ChatImage[]) => Promise<void>;
  /** Must actually request/send a system notification; reject on permission/delivery failure. */
  sendSystemNotification?: (title: string, body: string) => Promise<void>;
  /** Select and open the named session, then place the prompt only in that session.
   * Reject a deleted session; never fall back to whichever session happens to be active. */
  openSessionReminder?: (sessionId: string, draft: string) => Promise<void>;
  openChat?: (focusInput?: boolean) => Promise<void>;
  notify?: (title: string, body: string) => void | Promise<void>;
};

export type UseScheduledTasksArgs = {
  scheduledTasks: ScheduledTaskRecord[];
  setScheduledTasks: React.Dispatch<React.SetStateAction<ScheduledTaskRecord[]>>;
  desktopActions: ScheduledReminderActions;
  ready?: boolean;
  /** In a browser preview explicitly pass true; Tauri owner is derived from label=main. */
  isOwner?: boolean;
  onIssue?: (issue: ScheduleIssue) => void;
  stateStore?: ScheduleStateStore;
};

let activeOwner: symbol | null = null;
const inFlightTasks = new Set<string>();

function mayOwnScheduling(explicit?: boolean): boolean {
  if (explicit === false || typeof window === "undefined") return false;
  if (!("__TAURI_INTERNALS__" in window)) return explicit === true;
  try { return getCurrentWindow().label === "main"; } catch { return false; }
}

function deliveryFor(task: ScheduledTaskRecord, actions: ScheduledReminderActions): () => Promise<void> {
  switch (task.target) {
    case "desktop": return () => actions.setDraft(task.prompt);
    case "notification": {
      if (!actions.sendSystemNotification) throw new Error("系统通知尚未接通，提醒未投递");
      return () => actions.sendSystemNotification!(task.title, task.prompt);
    }
    case "session": {
      if (!task.sessionId) throw new Error("提醒未指定会话，不能投递到当前会话");
      if (!actions.openSessionReminder) throw new Error("会话提醒尚未接通，提醒未投递");
      return () => actions.openSessionReminder!(task.sessionId!, task.prompt);
    }
    default: throw new Error("不支持的提醒目标");
  }
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function useScheduledTasks(args: UseScheduledTasksArgs) {
  const current = useRef(args);
  current.current = args;
  const [issues, setIssues] = useState<Record<string, ScheduleIssue>>({});
  const [deliveries, setDeliveries] = useState<Record<string, ScheduleDeliveryRecord>>({});
  const retryRef = useRef<(taskId: string) => Promise<void>>(async () => undefined);
  const isOwner = mayOwnScheduling(args.isOwner);
  const ready = args.ready ?? true;
  const store = args.stateStore ?? scheduleStateStore;

  useEffect(() => {
    if (!isOwner || !ready) return;
    const token = Symbol("schedule-owner");
    let cancelled = false;
    let ticking = false;
    const published = new Map<string, string>();
    const owns = () => !cancelled && activeOwner === token;
    const report = (issue: ScheduleIssue) => {
      if (!owns()) return;
      const signature = JSON.stringify(issue);
      if (published.get(issue.taskId) === signature) return;
      published.set(issue.taskId, signature);
      setIssues((old) => ({ ...old, [issue.taskId]: issue }));
      current.current.onIssue?.(issue);
    };
    const clearIssue = (id: string) => {
      if (!owns()) return;
      published.delete(id);
      setIssues((old) => {
        if (!(id in old)) return old;
        const next = { ...old }; delete next[id]; return next;
      });
    };
    const showRecord = (record: ScheduleDeliveryRecord | null) => {
      if (!record || !owns()) return;
      setDeliveries((old) => ({ ...old, [record.taskId]: record }));
      current.current.setScheduledTasks((old) => {
        const item = old.find((task) => task.id === record.taskId);
        if (!item || (item.lastRunAt ?? -Infinity) >= record.scheduledAt) return old;
        return old.map((task) => task.id === record.taskId ? { ...task, lastRunAt: record.scheduledAt } : task);
      });
      if (record.status === "claimed" || record.status === "unknown") {
        report({ taskId: record.taskId, code: "unknown", slotKey: record.slotKey,
          message: record.message ?? "上次提醒已认领，投递结果未知；不会自动重复，可手动再提醒。" });
      } else if (record.status === "failed") {
        report({ taskId: record.taskId, code: "failed", slotKey: record.slotKey,
          message: record.message ?? "提醒投递失败；不会自动重复，可手动再提醒。" });
      }
    };

    const attempt = async (task: ScheduledTaskRecord, retryClaimId?: string) => {
      if (!owns() || inFlightTasks.has(task.id)) return;
      inFlightTasks.add(task.id);
      try {
        let previous: ScheduleDeliveryRecord | null;
        try { previous = await store.load(task.id); }
        catch (error) { report({ taskId: task.id, code: "storage", message: `无法读取提醒状态：${errorText(error)}` }); return; }
        if (!owns()) return;
        showRecord(previous);
        let occurrence;
        try { occurrence = retryClaimId && previous ? previous : findLatestScheduleOccurrence(task, Date.now()); }
        catch (error) { report({ taskId: task.id, code: "invalid", message: errorText(error) }); return; }
        if (!occurrence || (!retryClaimId && previous && occurrence.slotKey <= previous.slotKey)) return;
        clearIssue(task.id);
        let deliver: () => Promise<void>;
        try { deliver = deliveryFor(task, current.current.desktopActions); }
        catch (error) { report({ taskId: task.id, code: "unavailable", message: errorText(error) }); return; }
        const latest = current.current.scheduledTasks.find((item) => item.id === task.id);
        if (!latest?.enabled || latest.cron !== task.cron || latest.target !== task.target
          || latest.sessionId !== task.sessionId || latest.prompt !== task.prompt) return;
        let result;
        try { result = await store.claim(task.id, occurrence, Date.now(), retryClaimId); }
        catch (error) { report({ taskId: task.id, code: "storage", message: `提醒认领保存失败，未投递：${errorText(error)}` }); return; }
        if (!result.claimed || !result.record) { showRecord(result.record); return; }
        const record = result.record;
        setDeliveries((old) => ({ ...old, [record.taskId]: record }));
        current.current.setScheduledTasks((old) => old.map((item) => item.id === record.taskId
          && (item.lastRunAt ?? -Infinity) < record.scheduledAt
          ? { ...item, lastRunAt: record.scheduledAt } : item));
        const stillCurrent = current.current.scheduledTasks.find((item) => item.id === task.id);
        let status: "delivered" | "unknown" = "unknown";
        let message: string | undefined;
        if (!owns() || !stillCurrent?.enabled || stillCurrent.cron !== task.cron
          || stillCurrent.target !== task.target || stillCurrent.sessionId !== task.sessionId || stillCurrent.prompt !== task.prompt) {
          message = "认领后窗口退出或提醒已修改，未继续投递；可手动再提醒。";
        } else {
          try { await deliver(); status = "delivered"; }
          catch (error) { message = `提醒投递未确认：${errorText(error)}；不会自动重复，可手动再提醒。`; }
        }
        try {
          const settled = await store.settle(record, status, message);
          if (status === "delivered") clearIssue(task.id);
          showRecord(settled);
        } catch (error) {
          showRecord({ ...record, status: "unknown", message: `提醒结果保存失败：${errorText(error)}；不会自动重复。` });
        }
      } finally { inFlightTasks.delete(task.id); }
    };

    const tick = async () => {
      if (cancelled || ticking) return;
      if (activeOwner === null) activeOwner = token;
      if (!owns()) return;
      ticking = true;
      try {
        for (const task of current.current.scheduledTasks) {
          if (!owns()) break;
          if (task.enabled) await attempt(task);
          else clearIssue(task.id);
        }
      } finally { ticking = false; }
    };
    retryRef.current = async (taskId) => {
      if (!owns() || inFlightTasks.has(taskId)) return;
      const task = current.current.scheduledTasks.find((item) => item.id === taskId && item.enabled);
      if (!task) return;
      try {
        const record = await store.load(taskId);
        if (record && record.status !== "delivered") await attempt(task, record.claimId);
      } catch (error) { report({ taskId, code: "storage", message: errorText(error) }); }
    };
    const wake = () => { void tick(); };
    wake();
    const timer = window.setInterval(wake, 30_000);
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      cancelled = true;
      if (activeOwner === token) activeOwner = null;
      retryRef.current = async () => undefined;
      window.clearInterval(timer);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [isOwner, ready, store]);

  const retryReminder = useCallback((taskId: string) => retryRef.current(taskId), []);
  return { issues, deliveries, retryReminder };
}
