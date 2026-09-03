import { describe, expect, it } from "vitest";
import type { Message } from "../adapters/types";
import {
  countIncompleteToolSteps,
  hasIncompleteToolStep,
  isResolvedAsSuccess,
  settleInterruptedSteps,
  settleMessageSteps,
} from "./stepSettlement";

const runningStep = {
  type: "tool_call" as const,
  name: "export_xlsx",
  arguments: JSON.stringify({ path: "D:/out/表.xlsx" }),
  result: "",
  status: "running" as const,
};

const completedStep = {
  type: "tool_call" as const,
  name: "read_file",
  arguments: JSON.stringify({ path: "src/index.tsx" }),
  result: "文件内容",
};

/** 工具其实已经成功完成但因 race 仍留在 status="running" 的步骤——result 非空 + ！isError */
const runningButResolved = {
  type: "tool_call" as const,
  name: "export_md",
  arguments: JSON.stringify({ path: "D:/SpringBoot介绍.md" }),
  result: "Markdown 已生成：D:/SpringBoot介绍.md（3.2 KB）",
  status: "running" as const,
};

describe("stepSettlement", () => {
  it("settleMessageSteps：把 running 定案为 interrupted，其余步骤原样保留", () => {
    const settled = settleMessageSteps([
      runningStep,
      completedStep,
      { type: "reasoning", text: "思考…" },
      { type: "artifact", artifactId: "art-1", title: "表.xlsx" },
    ]);
    expect(settled).not.toBeUndefined();
    expect(settled?.[0]).toEqual({ ...runningStep, status: "interrupted" });
    expect(settled?.[1]).toBe(completedStep);
    expect(settled?.[2]).toEqual({ type: "reasoning", text: "思考…" });
  });

  it("settleMessageSteps：无 running 步骤时返回原数组引用（幂等不触发重渲染）", () => {
    const steps = [completedStep];
    expect(settleMessageSteps(steps)).toBe(steps);
    expect(settleMessageSteps(undefined)).toBeUndefined();
  });

  it("settleInterruptedSteps：把消息数组里的 running 步骤定案，并保留其它字段", () => {
    const messages: Message[] = [
      { role: "user", content: "做一张表" },
      {
        role: "project",
        content: "开始导出",
        steps: [runningStep, { type: "reasoning", text: "先想一下" }],
      },
    ];
    const settled = settleInterruptedSteps(messages);
    expect(settled[0]).toBe(messages[0]);
    expect(settled[1]).not.toBe(messages[1]);
    expect(settled[1].content).toBe("开始导出");
    const steps = settled[1].steps ?? [];
    expect(steps[0]).toEqual({ ...runningStep, status: "interrupted" });
    expect(steps[1]).toEqual({ type: "reasoning", text: "先想一下" });
  });

  it("settleInterruptedSteps：全部已完成时返回原引用；空数组原样返回", () => {
    const done: Message[] = [{ role: "project", content: "完成", steps: [completedStep] }];
    expect(settleInterruptedSteps(done)).toBe(done);
    expect(settleInterruptedSteps([])).toEqual([]);
  });

  it("settleInterruptedSteps：对多条消息仅改动含 running 的那条（幂等可重入）", () => {
    const messages: Message[] = [
      { role: "user", content: "hi" },
      { role: "project", content: "", steps: [runningStep] },
    ];
    const once = settleInterruptedSteps(messages);
    const twice = settleInterruptedSteps(once);
    expect(twice).toBe(once); // 第二次无变化，引用一致
    expect((twice[1].steps?.[0] as { status?: string }).status).toBe("interrupted");
  });

  it("hasIncompleteToolStep / countIncompleteToolSteps：识别 running 与 interrupted，忽略完成步骤", () => {
    expect(hasIncompleteToolStep([runningStep])).toBe(true);
    expect(hasIncompleteToolStep([{ ...runningStep, status: "interrupted" as const }])).toBe(true);
    expect(hasIncompleteToolStep([completedStep])).toBe(false);
    expect(hasIncompleteToolStep(undefined)).toBe(false);
    expect(
      countIncompleteToolSteps([runningStep, { ...runningStep, status: "interrupted" as const }, completedStep])
    ).toBe(2);
    expect(countIncompleteToolSteps([completedStep])).toBe(0);
  });

  it("isResolvedAsSuccess：result 非空且 ！isError 的步骤（无论 status）算成功", () => {
    expect(isResolvedAsSuccess(completedStep)).toBe(true);
    expect(isResolvedAsSuccess(runningButResolved)).toBe(true);
    expect(isResolvedAsSuccess(runningStep)).toBe(false);
    expect(isResolvedAsSuccess({ ...runningStep, isError: true })).toBe(false);
  });

  it("settleMessageSteps：跳过「带回成功 result」的 running 步骤——它们其实已完成", () => {
    // 静态 running（result 空）会被定案 interrupted；而带回成功 result 的 running 步骤原样保留
    const settled = settleMessageSteps([runningStep, runningButResolved, completedStep]);
    expect(settled).not.toBeUndefined();
    expect(settled?.[0]).toEqual({ ...runningStep, status: "interrupted" });
    // 关键断言：runningButResolved 不会被改成 interrupted——避免「已生成并保存完成」却被标「已中断」
    expect(settled?.[1]).toBe(runningButResolved);
    expect(settled?.[2]).toBe(completedStep);
  });

  it("hasIncompleteToolStep / countIncompleteToolSteps：running 但 result 已带回不算未完成", () => {
    // 不应把带回成功 result 的 running 步骤算入「未完成」——渲染层据此避免显示「已中断」
    expect(hasIncompleteToolStep([runningButResolved])).toBe(false);
    expect(countIncompleteToolSteps([runningButResolved])).toBe(0);
    expect(countIncompleteToolSteps([runningButResolved, runningStep])).toBe(1);
    // 即使被打上 status="interrupted" 的留底步骤，只要 result 非空 + ！isError，依然按完成态渲染
    expect(
      countIncompleteToolSteps([runningButResolved, { ...runningButResolved, status: "interrupted" as const }]),
    ).toBe(0);
  });
});
