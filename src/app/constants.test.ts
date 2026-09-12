import { describe, expect, it } from "vitest";
import * as constants from "./constants";

/**
 * 回归锁：空态「推荐起步方式」卡片的**标签与起手句必须同源**。
 *
 * 曾经标题取 `RECOMMENDED_PROJECT_PRESETS[index]`、点击插入的文本取
 * `EMPTY_CHAT_PROMPTS[index]` —— 两个互不相关的数组按下标 join，
 * 4 张卡错了 3 张（「代码排查助手」点下去插入「把这个问题拆成可执行步骤」）。
 * 现在合并成 `EMPTY_CHAT_STARTERS` 一条记录，这个 bug 类在结构上消失。
 */
describe("EMPTY_CHAT_STARTERS", () => {
  it("每条记录自带标题/说明/起手句，且标题唯一（可直接用作 React key）", () => {
    const starters = constants.EMPTY_CHAT_STARTERS;
    expect(starters.length).toBeGreaterThan(0);

    for (const starter of starters) {
      expect(starter.title.trim()).not.toBe("");
      expect(starter.description.trim()).not.toBe("");
      expect(starter.prompt.trim()).not.toBe("");
    }

    expect(new Set(starters.map((s) => s.title)).size).toBe(starters.length);
  });

  it("不存在第二份起手句数组（防回归：跨数组按下标对齐即必然分叉）", () => {
    expect(
      (constants as unknown as Record<string, unknown>).EMPTY_CHAT_PROMPTS,
    ).toBeUndefined();
  });
});
