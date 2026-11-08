import { readSqliteBackedJson, saveSqliteBackedValue } from "../app/sqliteStorage";

export const BUILTIN_SESSION_STATE_KEY = "omni_builtin_command_session_state_v1";

export type BuiltinGoalPhase = "active" | "paused";

export type BuiltinGoal = {
  objective: string;
  phase: BuiltinGoalPhase;
  createdAt: number;
  updatedAt: number;
};

export type BuiltinSessionState = {
  goal: BuiltinGoal | null;
  planMode: boolean;
};

type BuiltinSessionStateStore = Record<string, BuiltinSessionState>;

export const EMPTY_BUILTIN_SESSION_STATE: BuiltinSessionState = {
  goal: null,
  planMode: false,
};

function normalizeScopeKey(scopeKey: string): string {
  return scopeKey.trim() || "draft:default";
}

function readStore(): BuiltinSessionStateStore {
  return readSqliteBackedJson<BuiltinSessionStateStore>(BUILTIN_SESSION_STATE_KEY, {});
}

function writeStore(store: BuiltinSessionStateStore): void {
  saveSqliteBackedValue(BUILTIN_SESSION_STATE_KEY, JSON.stringify(store));
}

export function readBuiltinSessionState(scopeKey: string): BuiltinSessionState {
  const state = readStore()[normalizeScopeKey(scopeKey)];
  if (!state || typeof state !== "object") {
    return EMPTY_BUILTIN_SESSION_STATE;
  }

  const goal = state.goal && typeof state.goal.objective === "string" && state.goal.objective.trim()
    ? {
        objective: state.goal.objective.trim(),
        phase: state.goal.phase === "paused" ? "paused" as const : "active" as const,
        createdAt: Number.isFinite(state.goal.createdAt) ? state.goal.createdAt : Date.now(),
        updatedAt: Number.isFinite(state.goal.updatedAt) ? state.goal.updatedAt : Date.now(),
      }
    : null;

  return {
    goal,
    planMode: state.planMode === true,
  };
}

export function saveBuiltinSessionState(scopeKey: string, state: BuiltinSessionState): void {
  const store = readStore();
  const key = normalizeScopeKey(scopeKey);
  if (!state.goal && !state.planMode) {
    delete store[key];
  } else {
    store[key] = state;
  }
  writeStore(store);
}

export function setBuiltinGoal(scopeKey: string, objective: string): BuiltinSessionState {
  const current = readBuiltinSessionState(scopeKey);
  const now = Date.now();
  const next: BuiltinSessionState = {
    ...current,
    goal: {
      objective: objective.trim(),
      phase: "active",
      createdAt: current.goal?.createdAt ?? now,
      updatedAt: now,
    },
  };
  saveBuiltinSessionState(scopeKey, next);
  return next;
}

export function setBuiltinGoalPhase(scopeKey: string, phase: BuiltinGoalPhase): BuiltinSessionState {
  const current = readBuiltinSessionState(scopeKey);
  if (!current.goal) {
    return current;
  }
  const next: BuiltinSessionState = {
    ...current,
    goal: {
      ...current.goal,
      phase,
      updatedAt: Date.now(),
    },
  };
  saveBuiltinSessionState(scopeKey, next);
  return next;
}

export function clearBuiltinGoal(scopeKey: string): BuiltinSessionState {
  const current = readBuiltinSessionState(scopeKey);
  const next: BuiltinSessionState = {
    ...current,
    goal: null,
  };
  saveBuiltinSessionState(scopeKey, next);
  return next;
}

export function setBuiltinPlanMode(scopeKey: string, planMode: boolean): BuiltinSessionState {
  const current = readBuiltinSessionState(scopeKey);
  const next: BuiltinSessionState = {
    ...current,
    planMode,
  };
  saveBuiltinSessionState(scopeKey, next);
  return next;
}

export function migrateBuiltinSessionState(fromScopeKey: string, toScopeKey: string): void {
  if (normalizeScopeKey(fromScopeKey) === normalizeScopeKey(toScopeKey)) {
    return;
  }
  const store = readStore();
  const fromKey = normalizeScopeKey(fromScopeKey);
  const toKey = normalizeScopeKey(toScopeKey);
  const source = store[fromKey];
  if (!source) {
    return;
  }
  if (!store[toKey]) {
    store[toKey] = source;
  }
  delete store[fromKey];
  writeStore(store);
}

/**
 * 目标与计划模式不伪装成普通聊天文本，而是作为隐藏上下文进入每一轮请求。
 * 目标只在 active 时持续注入；暂停后保留记录但不再影响模型。
 */
export function buildBuiltinSessionContext(state: BuiltinSessionState): string | undefined {
  const blocks: string[] = [];
  if (state.goal?.phase === "active") {
    blocks.push([
      "【长期任务目标】",
      state.goal.objective,
      "请持续围绕该目标推进当前任务；不要因为单轮完成就丢失目标。若目标已经完成，明确说明完成依据。",
    ].join("\n"));
  }
  if (state.planMode) {
    blocks.push([
      "【计划模式】",
      "当前处于计划模式。先分析任务、约束和风险，给出可执行的分步计划并说明验收方式。",
      "在用户明确要求执行之前，不要修改文件、运行有副作用的命令或声称已经完成实现。",
    ].join("\n"));
  }
  return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}
