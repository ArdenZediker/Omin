import { readSqliteBackedJson, saveSqliteBackedValue } from "../app/sqliteStorage";

export const EXPERT_TEAMS_STORAGE_KEY = "omni_expert_teams_v1";

export type ExpertTeamMember = {
  id: string;
  expertId: string;
  name: string;
  role: string;
};

export type ExpertTeam = {
  id: string;
  name: string;
  description: string;
  members: ExpertTeamMember[];
  createdAt: number;
  updatedAt: number;
};

export type ExpertTeamTaskStatus = "pending" | "in_progress" | "completed" | "blocked";

export type ExpertTeamTask = {
  id: string;
  title: string;
  description: string;
  ownerMemberId: string | null;
  blockedBy: string[];
  status: ExpertTeamTaskStatus;
  revision: number;
  updatedAt: number;
};

export type ExpertTeamMessage = {
  id: string;
  fromMemberId: string;
  toMemberId: string | "lead";
  content: string;
  createdAt: number;
};

export type ExpertTeamEvent =
  | { type: "task_created"; task: ExpertTeamTask }
  | { type: "task_updated"; task: ExpertTeamTask; expectedRevision: number }
  | { type: "message_sent"; message: ExpertTeamMessage };

export type ExpertTeamRun = {
  id: string;
  teamId: string;
  sessionId: string;
  status: "provisioning" | "running" | "completed" | "failed" | "interrupted";
  events: ExpertTeamEvent[];
  createdAt: number;
  updatedAt: number;
};

type ExpertTeamStore = {
  teams: ExpertTeam[];
  runs: ExpertTeamRun[];
};

const listeners = new Set<() => void>();
let version = 0;
let teamSnapshotSignature = "";
let teamSnapshot: readonly ExpertTeam[] = [];

function readStore(): ExpertTeamStore {
  const value = readSqliteBackedJson<Partial<ExpertTeamStore>>(EXPERT_TEAMS_STORAGE_KEY, {});
  return {
    teams: Array.isArray(value.teams) ? value.teams : [],
    runs: Array.isArray(value.runs) ? value.runs : [],
  };
}

function writeStore(store: ExpertTeamStore): void {
  saveSqliteBackedValue(EXPERT_TEAMS_STORAGE_KEY, JSON.stringify(store));
  teamSnapshotSignature = "";
  version += 1;
  listeners.forEach((listener) => listener());
}

export const expertTeamRegistry = {
  getVersion(): number {
    return version;
  },

  getSnapshot(): readonly ExpertTeam[] {
    const teams = readStore().teams;
    const signature = JSON.stringify(teams);
    if (signature !== teamSnapshotSignature) {
      teamSnapshotSignature = signature;
      teamSnapshot = teams;
    }
    return teamSnapshot;
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  list(): ExpertTeam[] {
    return readStore().teams;
  },

  get(id: string): ExpertTeam | null {
    return readStore().teams.find((team) => team.id === id) ?? null;
  },

  save(team: ExpertTeam): ExpertTeam {
    validateTeam(team);
    const store = readStore();
    const index = store.teams.findIndex((entry) => entry.id === team.id);
    const saved = { ...team, updatedAt: Date.now() };
    if (index < 0) store.teams.push(saved);
    else store.teams[index] = saved;
    writeStore(store);
    return saved;
  },

  remove(id: string): boolean {
    const store = readStore();
    if (store.runs.some((run) => run.teamId === id && (run.status === "provisioning" || run.status === "running"))) {
      throw new Error("团队仍有运行中的协作，完成或中断后才能删除");
    }
    const next = store.teams.filter((team) => team.id !== id);
    if (next.length === store.teams.length) return false;
    store.teams = next;
    writeStore(store);
    return true;
  },

  listRuns(teamId?: string): ExpertTeamRun[] {
    const runs = readStore().runs;
    return teamId ? runs.filter((run) => run.teamId === teamId) : runs;
  },

  startRun(run: ExpertTeamRun): ExpertTeamRun {
    const store = readStore();
    if (!store.teams.some((team) => team.id === run.teamId)) throw new Error("找不到对应的专家团");
    if (store.runs.some((entry) => entry.id === run.id)) throw new Error(`团队运行 id 已存在：${run.id}`);
    store.runs.push(run);
    writeStore(store);
    return run;
  },

  setRunStatus(runId: string, status: "running" | "failed" | "interrupted"): ExpertTeamRun {
    const store = readStore();
    const run = store.runs.find((entry) => entry.id === runId);
    if (!run) throw new Error(`团队运行不存在：${runId}`);
    if (run.status !== "provisioning" && run.status !== "running") throw new Error("团队运行已经结束");
    run.status = status;
    run.updatedAt = Date.now();
    writeStore(store);
    return run;
  },

  appendEvent(runId: string, event: ExpertTeamEvent): ExpertTeamRun {
    const store = readStore();
    const run = store.runs.find((entry) => entry.id === runId);
    if (!run) throw new Error(`团队运行不存在：${runId}`);
    if (run.status !== "running" && run.status !== "provisioning") throw new Error("团队运行已结束，不能追加协作事件");
    if (event.type === "task_updated") {
      const current = [...run.events].reverse().find((entry) =>
        (entry.type === "task_created" || entry.type === "task_updated") && entry.task.id === event.task.id,
      );
      if (!current || (current.type !== "task_created" && current.type !== "task_updated")) {
        throw new Error(`团队任务不存在：${event.task.id}`);
      }
      if (current.task.revision !== event.expectedRevision) throw new Error("团队任务版本冲突，请刷新后重试");
      if (event.task.revision !== event.expectedRevision + 1) throw new Error("团队任务版本必须递增 1");
    }
    run.events.push(event);
    run.updatedAt = Date.now();
    writeStore(store);
    return run;
  },

  finishRun(runId: string, status: ExpertTeamRun["status"]): ExpertTeamRun {
    if (!["completed", "failed", "interrupted"].includes(status)) throw new Error("结束状态无效");
    const store = readStore();
    const run = store.runs.find((entry) => entry.id === runId);
    if (!run) throw new Error(`团队运行不存在：${runId}`);
    if (run.status !== "provisioning" && run.status !== "running") throw new Error("团队运行已经结束");
    run.status = status;
    run.updatedAt = Date.now();
    writeStore(store);
    return run;
  },

  recoverInterruptedRuns(): number {
    const store = readStore();
    let recovered = 0;
    for (const run of store.runs) {
      if (run.status !== "provisioning" && run.status !== "running") continue;
      run.status = "interrupted";
      run.updatedAt = Date.now();
      recovered += 1;
    }
    if (recovered > 0) writeStore(store);
    return recovered;
  },
};

export function validateTeam(team: ExpertTeam): void {
  if (!team.id.trim() || !team.name.trim()) throw new Error("专家团需要唯一 id 和名称");
  if (team.members.length === 0) throw new Error("专家团至少需要一名成员");
  if (team.members.length > 5) throw new Error("每个专家团最多 5 名成员");
  const memberIds = new Set<string>();
  for (const member of team.members) {
    if (!member.id.trim() || !member.expertId.trim() || !member.role.trim()) throw new Error("每位成员都需要专家档案和明确分工");
    if (memberIds.has(member.id)) throw new Error(`专家团成员 id 重复：${member.id}`);
    memberIds.add(member.id);
  }
}

export function projectTeamTasks(events: readonly ExpertTeamEvent[]): ExpertTeamTask[] {
  const tasks = new Map<string, ExpertTeamTask>();
  for (const event of events) {
    if (event.type === "task_created" || event.type === "task_updated") tasks.set(event.task.id, event.task);
  }
  return [...tasks.values()].sort((left, right) => left.updatedAt - right.updatedAt);
}

export function projectTeamMessages(events: readonly ExpertTeamEvent[]): ExpertTeamMessage[] {
  return events.filter((event): event is Extract<ExpertTeamEvent, { type: "message_sent" }> => event.type === "message_sent")
    .map((event) => event.message)
    .sort((left, right) => left.createdAt - right.createdAt);
}
