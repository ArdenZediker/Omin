import { describe, expect, it } from "vitest";
import { canDelegateExpert, isExpertBound, resolveDelegatableExperts } from "./expertDelegation";
import type { Project } from "./types";

function project(boundExpertIds?: string[]): Project {
  return { id: "project-1", boundExpertIds } as unknown as Project;
}

describe("专家委派策略（expertDelegation）", () => {
  it("默认口径：只放行项目绑定的专家", () => {
    const p = project(["dev-expert"]);
    expect(canDelegateExpert({ expertId: "dev-expert", project: p, allowAnyExpert: false })).toBe(true);
    expect(canDelegateExpert({ expertId: "writer-expert", project: p, allowAnyExpert: false })).toBe(false);
  });

  it("无项目 / 未绑定 / 空绑定数组一律不放行", () => {
    const opts = { allowAnyExpert: false };
    expect(canDelegateExpert({ expertId: "dev-expert", project: null, ...opts })).toBe(false);
    expect(canDelegateExpert({ expertId: "dev-expert", project: undefined, ...opts })).toBe(false);
    expect(canDelegateExpert({ expertId: "dev-expert", project: project([]), ...opts })).toBe(false);
    expect(canDelegateExpert({ expertId: "dev-expert", project: project(undefined), ...opts })).toBe(false);
  });

  it("打开「允许模型指派任意专家」后不再受绑定约束", () => {
    expect(canDelegateExpert({ expertId: "writer-expert", project: null, allowAnyExpert: true })).toBe(true);
    expect(
      canDelegateExpert({ expertId: "writer-expert", project: project(["dev-expert"]), allowAnyExpert: true }),
    ).toBe(true);
  });

  it("isExpertBound 忽略空串等脏值（历史数据可能写入空 id）", () => {
    expect(isExpertBound(project(["", "dev-expert"]), "dev-expert")).toBe(true);
    expect(isExpertBound(project([""]), "")).toBe(false);
  });

  it("resolveDelegatableExperts 保持入参顺序；放宽档原样返回", () => {
    const experts = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(resolveDelegatableExperts(experts, project(["b", "c"]), false).map((e) => e.id)).toEqual(["b", "c"]);
    expect(resolveDelegatableExperts(experts, project(["b"]), true).map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(resolveDelegatableExperts(experts, null, false)).toEqual([]);
  });
});
