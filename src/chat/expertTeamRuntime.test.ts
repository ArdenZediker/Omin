import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ value: "{}" }));
vi.mock("../app/sqliteStorage", () => ({
  readSqliteBackedJson: (_key: string, fallback: unknown) => {
    try { return JSON.parse(storage.value); } catch { return fallback; }
  },
  saveSqliteBackedValue: (_key: string, value: string) => { storage.value = value; },
}));

import { expertTeamRegistry, projectTeamMessages, projectTeamTasks, type ExpertTeam } from "../plugins/expertTeams";
import { formatExpertTeamReports, runExpertTeamRound } from "./expertTeamRuntime";

const team: ExpertTeam = {
  id: "release-review",
  name: "发布评审团",
  description: "检查上线风险",
  members: [
    { id: "code", expertId: "code-review", name: "代码评审", role: "检查回归与正确性" },
    { id: "security", expertId: "security-review", name: "安全评审", role: "检查权限与数据风险" },
  ],
  createdAt: 1,
  updatedAt: 1,
};

describe("expertTeamRuntime", () => {
  beforeEach(() => {
    storage.value = JSON.stringify({ teams: [team], runs: [] });
  });

  it("records member reports and completes assigned tasks in the durable team run", async () => {
    const result = await runExpertTeamRound({
      team,
      sessionId: "chat-1",
      task: "检查本次发布",
      runMembers: async () => [
        { memberId: "code", memberName: "代码评审", expertId: "code-review", outputText: "没有回归问题" },
        { memberId: "security", memberName: "安全评审", expertId: "security-review", outputText: "需要确认访问令牌轮换" },
      ],
    });

    expect(result.run.status).toBe("completed");
    expect(projectTeamTasks(result.run.events).map((task) => task.status)).toEqual(["completed", "completed"]);
    expect(projectTeamMessages(result.run.events).map((message) => message.fromMemberId)).toEqual(["code", "security"]);
    expect(formatExpertTeamReports(team, result.reports)).toContain("需要确认访问令牌轮换");
  });

  it("persists failed and interrupted run states", async () => {
    await expect(runExpertTeamRound({
      team,
      sessionId: "chat-2",
      task: "failed task",
      runMembers: async () => { throw new Error("upstream unavailable"); },
    })).rejects.toThrow("upstream unavailable");
    const runsAfterFailure = expertTeamRegistry.listRuns(team.id);
    expect(runsAfterFailure[runsAfterFailure.length - 1]?.status).toBe("failed");

    const controller = new AbortController();
    controller.abort();
    await expect(runExpertTeamRound({
      team,
      sessionId: "chat-3",
      task: "cancelled task",
      signal: controller.signal,
      runMembers: async () => [],
    })).rejects.toThrow();
    const runsAfterInterrupt = expertTeamRegistry.listRuns(team.id);
    expect(runsAfterInterrupt[runsAfterInterrupt.length - 1]?.status).toBe("interrupted");
  });
});
