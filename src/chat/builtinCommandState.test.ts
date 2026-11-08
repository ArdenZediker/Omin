import { beforeEach, describe, expect, it } from "vitest";
import {
  BUILTIN_SESSION_STATE_KEY,
  buildBuiltinSessionContext,
  clearBuiltinGoal,
  migrateBuiltinSessionState,
  readBuiltinSessionState,
  setBuiltinGoal,
  setBuiltinGoalPhase,
  setBuiltinPlanMode,
} from "./builtinCommandState";

describe("builtinCommandState", () => {
  beforeEach(() => {
    localStorage.removeItem(BUILTIN_SESSION_STATE_KEY);
  });

  it("目标与计划模式按会话持久化，并能暂停、恢复和清除", () => {
    setBuiltinGoal("session-a", "完成企业版发布");
    setBuiltinPlanMode("session-a", true);

    expect(readBuiltinSessionState("session-a")).toMatchObject({
      goal: { objective: "完成企业版发布", phase: "active" },
      planMode: true,
    });

    setBuiltinGoalPhase("session-a", "paused");
    expect(readBuiltinSessionState("session-a").goal?.phase).toBe("paused");

    clearBuiltinGoal("session-a");
    expect(readBuiltinSessionState("session-a")).toEqual({
      goal: null,
      planMode: true,
    });
  });

  it("新会话建立后把临时草稿状态迁移到真实会话", () => {
    setBuiltinGoal("draft:project-a", "继续完成验收");
    migrateBuiltinSessionState("draft:project-a", "session-new");

    expect(readBuiltinSessionState("session-new").goal?.objective).toBe("继续完成验收");
    expect(readBuiltinSessionState("draft:project-a").goal).toBeNull();
  });

  it("只把进行中的目标与计划模式注入模型上下文", () => {
    setBuiltinGoal("session-b", "完成发布");
    setBuiltinPlanMode("session-b", true);
    expect(buildBuiltinSessionContext(readBuiltinSessionState("session-b"))).toContain("完成发布");
    expect(buildBuiltinSessionContext(readBuiltinSessionState("session-b"))).toContain("【计划模式】");

    setBuiltinGoalPhase("session-b", "paused");
    const pausedContext = buildBuiltinSessionContext(readBuiltinSessionState("session-b"));
    expect(pausedContext).not.toContain("完成发布");
    expect(pausedContext).toContain("【计划模式】");
  });
});
