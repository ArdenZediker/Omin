import { describe, expect, it } from "vitest";
import type { ScheduledTaskRecord } from "../chat/types";
import { findLatestScheduleOccurrence, localScheduleSlotKey, matchesCron, parseCron, SCHEDULE_CATCHUP_MS } from "./scheduledTaskCron";

const time = (day: number, hour = 12, minute = 0, second = 0) => new Date(2026, 9, day, hour, minute, second).getTime();
const task = (cron: string, extra: Partial<ScheduledTaskRecord> = {}): ScheduledTaskRecord => ({
  id: "test", title: "test", prompt: "test", cron, enabled: true, target: "desktop",
  createdAt: time(20), updatedAt: time(20), ...extra,
});

describe("five-field local cron", () => {
  it.each([
    ["*/15 * * * *", time(25, 12, 44), time(25, 12, 30)],
    ["0 9 * * *", time(25, 12), time(25, 9)],
    ["0 9 * * 0", time(25, 12), time(25, 9)],
    ["0 9 * * 7", time(25, 12), time(25, 9)],
    ["5,35 8-18/2 * 10 0-6", time(25, 12, 40), time(25, 12, 35)],
    ["10/20 * * * *", time(25, 12, 35), time(25, 12, 30)],
  ])("%s computes only the most recent due minute", (cron, now, expected) => {
    expect(findLatestScheduleOccurrence(task(cron), now)?.scheduledAt).toBe(expected);
  });

  it("uses local calendar values and a timezone-free wall-clock key", () => {
    const date = new Date(2026, 9, 25, 9, 7);
    expect(matchesCron(parseCron("7 9 25 10 *"), date)).toBe(true);
    expect(localScheduleSlotKey(date)).toBe("2026-10-25T09:07");
  });

  it("uses OR for two restricted day fields and AND for a wildcard day field", () => {
    expect(matchesCron(parseCron("0 12 1 * 0"), new Date(time(25)))).toBe(true);
    expect(matchesCron(parseCron("0 12 1 * 0"), new Date(time(26)))).toBe(false);
    expect(matchesCron(parseCron("0 12 * * 0"), new Date(time(26)))).toBe(false);
  });

  it.each(["", "* * * *", "0 * * * * *", "60 * * * *", "0 24 * * *", "0 0 0 * *",
    "0 0 * 13 *", "0 0 * * 8", "*/0 * * * *", "8-2 * * * *", "1,,2 * * * *",
    "0 0 ? * *", "@daily", "0 0 * * MON", "*/-1 * * * *", "*/1.5 * * * *",
  ])("rejects unsupported/invalid cron %s", (cron) => { expect(() => parseCron(cron)).toThrow(); });

  it("does not deliver disabled or future-created tasks", () => {
    expect(findLatestScheduleOccurrence(task("* * * * *", { enabled: false }), time(25))).toBeNull();
    expect(findLatestScheduleOccurrence(task("* * * * *", { createdAt: time(26) }), time(25))).toBeNull();
  });

  it("never replays occurrences before creation, including earlier seconds of creation minute", () => {
    expect(findLatestScheduleOccurrence(task("0 9 * * *", { createdAt: time(25, 10) }), time(25, 12))).toBeNull();
    expect(findLatestScheduleOccurrence(task("* * * * *", { createdAt: time(25, 12, 0, 10) }), time(25, 12, 0, 45))).toBeNull();
  });

  it("includes exactly the 24h boundary, excludes older due slots", () => {
    expect(time(25, 9) - time(24, 9)).toBe(SCHEDULE_CATCHUP_MS);
    expect(findLatestScheduleOccurrence(task("0 9 * * 6"), time(25, 9))?.scheduledAt).toBe(time(24, 9));
    expect(findLatestScheduleOccurrence(task("0 9 * * 6"), time(25, 9, 0, 1))).toBeNull();
  });

  it("does not search older slots after the newest one was claimed", () => {
    expect(findLatestScheduleOccurrence(task("* * * * *", { lastRunAt: time(25, 12) }), time(25, 12, 0, 30))).toBeNull();
  });

  it("impossible calendar dates never fire", () => {
    expect(findLatestScheduleOccurrence(task("0 0 31 2 *"), new Date(2026, 2, 1).getTime())).toBeNull();
  });
});
