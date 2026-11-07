import type { ScheduledTaskRecord } from "../chat/types";

const MINUTE = 60_000;
export const SCHEDULE_CATCHUP_MS = 24 * 60 * MINUTE;
export type ScheduleOccurrence = { scheduledAt: number; slotKey: string };
type CronField = { values: Set<number>; wildcard: boolean };
export type ParsedCron = { fields: CronField[] };

function parseField(source: string, min: number, max: number, name: string): CronField {
  const values = new Set<number>();
  for (const part of source.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error(`cron ${name}格式无效：${source}`);
    const [, range, stepText] = match;
    const step = stepText ? Number(stepText) : 1;
    const [startText, endText] = range.split("-");
    const start = range === "*" ? min : Number(startText);
    const end = range === "*" ? max : endText !== undefined ? Number(endText) : stepText ? max : start;
    if (!Number.isSafeInteger(step) || step < 1 || start < min || end > max || start > end) {
      throw new Error(`cron ${name}范围无效：${source}（允许 ${min}–${max}，步长须为正整数）`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return { values, wildcard: source.startsWith("*") };
}

/** Numeric five-field cron: minute hour day-of-month month weekday (0/7 = Sunday).
 * Supports *, lists, ranges and positive steps. Restricted DOM/DOW use OR;
 * when either field starts with *, both fields must match. No seconds/macros/names. */
export function parseCron(expression: string): ParsedCron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron 必须包含五字段：分钟 小时 日 月 星期");
  const bounds = [[0, 59, "分钟"], [0, 23, "小时"], [1, 31, "日"], [1, 12, "月"], [0, 7, "星期"]] as const;
  const fields = parts.map((part, index) => {
    const [min, max, name] = bounds[index];
    return parseField(part, min, max, name);
  });
  if (fields[4].values.has(7)) fields[4].values.add(0);
  return { fields };
}

export function localScheduleSlotKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function matchesCron(cron: ParsedCron, date: Date): boolean {
  const [minute, hour, day, month, weekday] = cron.fields;
  const dayMatches = day.values.has(date.getDate());
  const weekMatches = weekday.values.has(date.getDay());
  return minute.values.has(date.getMinutes()) && hour.values.has(date.getHours()) && month.values.has(date.getMonth() + 1)
    && (day.wildcard || weekday.wildcard ? dayMatches && weekMatches : dayMatches || weekMatches);
}

/** Walk elapsed minutes and match local calendar fields. Nonexistent DST minutes
 * do not fire; repeated local minutes share a persisted slotKey. */
export function findLatestScheduleOccurrence(task: ScheduledTaskRecord, now: number): ScheduleOccurrence | null {
  if (!task.enabled) return null;
  const cron = parseCron(task.cron);
  if (!Number.isFinite(task.createdAt) || !Number.isFinite(now)) throw new Error("提醒创建时间无效");
  if (task.lastRunAt != null && !Number.isFinite(task.lastRunAt)) throw new Error("提醒上次时段时间无效");
  const lower = Math.max(task.createdAt, now - SCHEDULE_CATCHUP_MS);
  for (let time = Math.floor(now / MINUTE) * MINUTE; time >= lower; time -= MINUTE) {
    if (task.lastRunAt != null && time <= task.lastRunAt) return null;
    const date = new Date(time);
    if (matchesCron(cron, date)) return { scheduledAt: time, slotKey: localScheduleSlotKey(date) };
  }
  return null;
}
