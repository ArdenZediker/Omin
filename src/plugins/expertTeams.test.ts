import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ value: "{}" }));
vi.mock("../app/sqliteStorage", () => ({
  readSqliteBackedJson: (_key: string, fallback: unknown) => {
    try { return JSON.parse(storage.value); } catch { return fallback; }
  },
  saveSqliteBackedValue: (_key: string, value: string) => { storage.value = value; },
}));

import { expertTeamRegistry, projectTeamMessages, projectTeamTasks, type ExpertTeam, type ExpertTeamRun } from "./expertTeams";

const team: ExpertTeam = {
  id: "team-review",
  name: "评审团",
  description: "多角色评审",
  members: [
    { id: "reviewer", expertId: "expert-code", name: "代码评审", role: "检查正确性与回归风险" },
    { id: "security", expertId: "expert-security", name: "安全专家", role: "检查安全边界" },
  ],
  createdAt: 1,
  updatedAt: 1,
};

const run: ExpertTeamRun = {
  id: "run-1",
  teamId: team.id,
  sessionId: "session-1",
  status: "running",
  events: [],
  createdAt: 2,
  updatedAt: 2,
};

describe("expertTeamRegistry", () => {
  beforeEach(() => { storage.value = JSON.stringify({ teams: [], runs: [] }); });

  it("persists named teams and notifies subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = expertTeamRegistry.subscribe(listener);
    expertTeamRegistry.save(team);
    expect(expertTeamRegistry.get(team.id)?.members).toHaveLength(2);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("requires unique, explicitly assigned members and caps team size", () => {
    expect(() => expertTeamRegistry.save({ ...team, members: [] })).toThrow("至少需要一名成员");
    expect(() => expertTeamRegistry.save({ ...team, members: [team.members[0], { ...team.members[1], id: "reviewer" }] }))
      .toThrow("成员 id 重复");
    expect(() => expertTeamRegistry.save({ ...team, members: Array.from({ length: 6 }, (_, index) => ({
      id: `m${index}`, expertId: `e${index}`, name: `n${index}`, role: "review",
    })) })).toThrow("最多 5 名成员");
  });

  it("replays the task board and message log from durable events", () => {
    const events = [
      { type: "task_created" as const, task: { id: "task-1", title: "Review", description: "Check diff", ownerMemberId: "reviewer", blockedBy: [], status: "pending" as const, revision: 1, updatedAt: 3 } },
      { type: "task_updated" as const, expectedRevision: 1, task: { id: "task-1", title: "Review", description: "Check diff", ownerMemberId: "reviewer", blockedBy: [], status: "completed" as const, revision: 2, updatedAt: 4 } },
      { type: "message_sent" as const, message: { id: "message-1", fromMemberId: "reviewer", toMemberId: "lead", content: "No regressions found", createdAt: 5 } },
    ];
    expect(projectTeamTasks(events)[0].status).toBe("completed");
    expect(projectTeamMessages(events)[0].content).toBe("No regressions found");
  });

  it("rejects stale task writes and preserves run history after completion", () => {
    expertTeamRegistry.save(team);
    expertTeamRegistry.startRun(run);
    expertTeamRegistry.appendEvent(run.id, {
      type: "task_created",
      task: { id: "task-1", title: "Review", description: "Check", ownerMemberId: "reviewer", blockedBy: [], status: "pending", revision: 1, updatedAt: 3 },
    });
    expect(() => expertTeamRegistry.appendEvent(run.id, {
      type: "task_updated", expectedRevision: 0,
      task: { id: "task-1", title: "Review", description: "Check", ownerMemberId: "reviewer", blockedBy: [], status: "completed", revision: 1, updatedAt: 4 },
    })).toThrow("版本冲突");
    expertTeamRegistry.finishRun(run.id, "completed");
    expect(expertTeamRegistry.listRuns(team.id)[0].events).toHaveLength(1);
    expect(() => expertTeamRegistry.remove(team.id)).not.toThrow();
  });

  it("prevents removing a team with active work", () => {
    expertTeamRegistry.save(team);
    expertTeamRegistry.startRun(run);
    expect(() => expertTeamRegistry.remove(team.id)).toThrow("仍有运行中的协作");
  });

  it("marks unfinished runs interrupted during application recovery", () => {
    expertTeamRegistry.save(team);
    expertTeamRegistry.startRun(run);
    expect(expertTeamRegistry.recoverInterruptedRuns()).toBe(1);
    expect(expertTeamRegistry.listRuns(team.id)[0].status).toBe("interrupted");
  });
});
