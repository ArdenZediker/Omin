import { describe, expect, it } from "vitest";
import { headTailClip } from "./textClip";

/**
 * head + tail 截断的行为契约（与 Rust 侧 `tool_output_spill::head_tail_preview` 对齐）。
 * 关键不变量：不超限不动、超限必须两头都留、代理对不被切坏。
 */
describe("headTailClip", () => {
  it("未超限时原样返回，omitted=0、clipped=false", () => {
    const result = headTailClip("短文本", 100);
    expect(result.text).toBe("短文本");
    expect(result.omitted).toBe(0);
    expect(result.clipped).toBe(false);
  });

  it("恰好等于上限时不截断（边界无偏差）", () => {
    const text = "a".repeat(50);
    const result = headTailClip(text, 50);
    expect(result.text).toBe(text);
    expect(result.clipped).toBe(false);
  });

  it("超限时保留开头约 60% 与结尾约 40%，中间有省略标记", () => {
    const head = "HEAD";
    const tail = "TAIL";
    const text = head + "m".repeat(1000) + tail;

    const result = headTailClip(text, 100);

    expect(result.clipped).toBe(true);
    expect(result.text.startsWith(head)).toBe(true);
    expect(result.text.endsWith(tail)).toBe(true);
    expect(result.text).toContain("中间省略");
    // head 60 / tail 40：取到的字符数应与 maxChars 一致（标记本身不计入预算）
    const body = result.text.split("\n").filter((line) => !line.startsWith("…["));
    expect(body.join("").length).toBe(100);
    expect(result.omitted).toBe(text.length - 100);
  });

  it("省略字符数 = 总长 − head − tail", () => {
    const result = headTailClip("x".repeat(200), 100);
    expect(result.omitted).toBe(100);
    expect(result.text).toContain("中间省略 100 字符");
  });

  it("按字符计数，代理对（emoji）不会被切成半个", () => {
    // 每个 emoji 是 2 个 UTF-16 code unit；按 length 切会切出孤立代理项。
    const text = "😀".repeat(100);
    const result = headTailClip(text, 10);

    expect(Array.from(result.text).filter((char) => char === "😀")).toHaveLength(10);
    expect(result.text).not.toContain("\uFFFD");
    // 不应残留孤立代理项
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(result.text)).toBe(false);
  });

  it("maxChars<=0 时返回空串并如实记账", () => {
    const result = headTailClip("abc", 0);
    expect(result.text).toBe("");
    expect(result.clipped).toBe(true);
    expect(result.omitted).toBe(3);
  });

  it("空文本不视为截断", () => {
    expect(headTailClip("", 10)).toEqual({ text: "", omitted: 0, clipped: false });
  });
});
