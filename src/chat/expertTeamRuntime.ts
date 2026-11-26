import type { ExpertTeam, ExpertTeamRun } from "../plugins/expertTeams";
import { expertTeamRegistry } from "../plugins/expertTeams";

export type TeamMemberResult = {
  memberId: string;
  memberName: string;
  expertId: string;
  outputText: string;
};

export async function runExpertTeamRound(options: {
  team: ExpertTeam;
  sessionId: string;
  task: string;
  signal?: AbortSignal;
  runMembers: (task: string) => Promise<TeamMemberResult[]>;
}): Promise<{ run: ExpertTeamRun; reports: TeamMemberResult[] }> {
  const { team, sessionId, task, signal, runMembers } = options;
  const now = Date.now();
  const run: ExpertTeamRun = {
    id: `team-run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    teamId: team.id,
    sessionId,
    status: "provisioning",
    events: [],
    createdAt: now,
    updatedAt: now,
  };
  expertTeamRegistry.startRun(run);
  const tasks = team.members.map((member, index) => ({
    id: `${run.id}-task-${index + 1}`,
    title: member.role,
    description: task,
    ownerMemberId: member.id,
    blockedBy: [],
    status: "pending" as const,
    revision: 1,
    updatedAt: Date.now(),
  }));

  try {
    expertTeamRegistry.setRunStatus(run.id, "running");
    for (const taskRecord of tasks) {
      expertTeamRegistry.appendEvent(run.id, { type: "task_created", task: taskRecord });
      expertTeamRegistry.appendEvent(run.id, {
        type: "task_updated",
        expectedRevision: taskRecord.revision,
        task: { ...taskRecord, status: "in_progress", revision: taskRecord.revision + 1, updatedAt: Date.now() },
      });
    }
    if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");
    const reports = await runMembers(task);
    for (let index = 0; index < reports.length; index += 1) {
      const report = reports[index];
      const taskRecord = tasks[index];
      if (!report || !taskRecord) continue;
      expertTeamRegistry.appendEvent(run.id, {
        type: "message_sent",
        message: {
          id: `${run.id}-message-${index + 1}`,
          fromMemberId: report.memberId,
          toMemberId: "lead",
          content: report.outputText,
          createdAt: Date.now(),
        },
      });
      expertTeamRegistry.appendEvent(run.id, {
        type: "task_updated",
        expectedRevision: taskRecord.revision + 1,
        task: { ...taskRecord, status: "completed", revision: taskRecord.revision + 2, updatedAt: Date.now() },
      });
    }
    return { run: expertTeamRegistry.finishRun(run.id, "completed"), reports };
  } catch (error) {
    const aborted = signal?.aborted || (error instanceof DOMException && error.name === "AbortError");
    expertTeamRegistry.finishRun(run.id, aborted ? "interrupted" : "failed");
    throw error;
  }
}

export function formatExpertTeamReports(team: ExpertTeam, reports: readonly TeamMemberResult[]): string {
  const members = new Map(team.members.map((member) => [member.id, member]));
  return [
    `## 专家团：${team.name}`,
    team.description ? `共同目标：${team.description}` : "",
    ...reports.map((report) => {
      const member = members.get(report.memberId);
      return `### ${report.memberName} · ${member?.role ?? "专家意见"}\n\n${report.outputText}`;
    }),
    "请综合成员结论，处理意见冲突并给出统一答复。",
  ].filter(Boolean).join("\n\n");
}
