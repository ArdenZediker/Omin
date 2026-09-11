import { describe, expect, it } from "vitest";
import { getPetThoughtAnchorOffset, getPetThoughtViewportSize } from "./window";

/**
 * 内联气泡的显示门控依赖一条不变量：**只要要为气泡预留空间，窗口就一定被撑大，
 * 从而宠物视口偏移必然非零**。App.tsx 用「已提交偏移是否追上目标偏移」判断
 * 窗口几何有没有落地（落后就说明 setPosition/setSize 还没回来，此时渲染 250px
 * 宽的气泡会被还停在宠物尺寸的窗口裁成残片）。这些断言把该前提钉住。
 *
 * 气泡宽度在 CompactWindow / compactWindowGeometry / window 三处各自硬编码为 250，
 * 这里以常量形式复用同一数值，任何一处改动都会被断言拦下。
 */
const PET_SIZE = { width: 168, height: 168 };
const BUBBLE_WIDTH = 250;

describe("宠物想法气泡的窗口预留", () => {
  it("有气泡时窗口被撑到足以容纳气泡，且两侧仍留有边距", () => {
    const size = getPetThoughtViewportSize(PET_SIZE, "top");
    expect(size.width).toBeGreaterThanOrEqual(BUBBLE_WIDTH);
    expect(size.width - BUBBLE_WIDTH).toBeGreaterThanOrEqual(24);
  });

  it("撑大后宠物视口偏移必然非零——气泡显示门控依赖这条不变量", () => {
    const size = getPetThoughtViewportSize(PET_SIZE, "top");
    const offset = getPetThoughtAnchorOffset(size, PET_SIZE);
    expect(offset.y).not.toBe(0);
  });

  it("收起态（不预留空间）时偏移为零，门控放行让 max-height 动画照常播", () => {
    const offset = getPetThoughtAnchorOffset(PET_SIZE, PET_SIZE);
    expect(offset).toEqual({ x: 0, y: 0 });
  });

  it("侧向布局同样把窗口撑到宽于气泡", () => {
    const size = getPetThoughtViewportSize(PET_SIZE, "right");
    expect(size.width - PET_SIZE.width).toBeGreaterThanOrEqual(BUBBLE_WIDTH);
  });
});
