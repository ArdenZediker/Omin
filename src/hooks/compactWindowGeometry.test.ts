import { describe, expect, it, vi } from "vitest";

vi.mock("../app/window", () => ({ PET_THOUGHT_WINDOW_SIZE: { width: 300, height: 278 } }));
vi.mock("../app/pets/codexPetSizing", () => ({
  PET_WINDOW_DECORATION_MARGIN_TOP: 16,
  PET_WINDOW_NATIVE_TOP_LIMIT: -640,
}));

import {
  clampDragTargetToWorkArea,
  resolveAnchoredCompactWindowX,
  resolveCompactBallEdge,
} from "./compactWindowGeometry";

const bounds = { left: 0, top: 0, right: 1920, bottom: 1080 };
const baseOptions = {
  scaleFactor: 1,
  petSize: { width: 160, height: 170 },
  petViewportOffset: { x: 0, y: 0 },
  topOverscroll: 8,
};

describe("clampDragTargetToWorkArea 拖动边界钳制", () => {
  it("向右越界时贴住右边缘", () => {
    expect(clampDragTargetToWorkArea({ x: 5000, y: 40 }, bounds, baseOptions)).toEqual({
      x: 1920 - 160,
      y: 40,
    });
  });

  it("向左越界时贴住左边缘", () => {
    expect(clampDragTargetToWorkArea({ x: -5000, y: 40 }, bounds, baseOptions)).toEqual({ x: 0, y: 40 });
  });

  it("向下越界时贴住下边缘（窗口底边不出工作区）", () => {
    expect(clampDragTargetToWorkArea({ x: 100, y: 5000 }, bounds, baseOptions)).toEqual({
      x: 100,
      y: 1080 - 170,
    });
  });

  it("向上越界时允许贴顶多出一个 overscroll，但不许整块移出", () => {
    expect(clampDragTargetToWorkArea({ x: 100, y: -5000 }, bounds, baseOptions)).toEqual({ x: 100, y: -8 });
  });

  it("工作区不在原点（副屏在主屏上方）时按工作区顶算上界", () => {
    // 旧实现把「屏幕顶 = 0」写死在公式里，副屏（top = -1080）会被算错，
    // 宠物能一路被推到主屏上方的不可见区。
    const upperMonitor = { left: 0, top: -1080, right: 1920, bottom: 0 };
    expect(clampDragTargetToWorkArea({ x: 100, y: -5000 }, upperMonitor, baseOptions)).toEqual({
      x: 100,
      y: -1088,
    });
  });

  it("宠物被视口偏移推开时按宠物本体矩形钳制，而不是按窗口矩形", () => {
    // 想法气泡撑大窗口后宠物被 --pet-viewport-offset-x/y 推离左上角，
    // 可行区间要整体减掉这个偏移。
    expect(
      clampDragTargetToWorkArea({ x: 5000, y: 40 }, bounds, {
        ...baseOptions,
        petViewportOffset: { x: 40, y: 90 },
      })
    ).toEqual({ x: 1920 - 160 - 40, y: 40 });
  });

  it("拿不到边界或宠物尺寸时原样放行（不误伤）", () => {
    expect(clampDragTargetToWorkArea({ x: 5000, y: 40 }, null, baseOptions)).toEqual({ x: 5000, y: 40 });
    expect(clampDragTargetToWorkArea({ x: 5000, y: 40 }, bounds, { ...baseOptions, petSize: null })).toEqual({
      x: 5000,
      y: 40,
    });
  });
});

// ── 悬浮球贴边不变量 ────────────────────────────────────────────────────────
// 回归「悬浮球在最边上把菜单展开时拖动悬浮球，球直接瞬移很长一段距离」。
// 展开态窗口宽 = getExpandedCompactViewportSize 的 width = max(round(136*4.2*1.4)+12, 360) = 812。
const COLLAPSED_WIDTH = 120;
const EXPANDED_WIDTH = 812;
const BALL_WIDTH = 104;
const BALL_INSET = 6;
const MENU_SIDES: Array<"left" | "right"> = ["left", "right"];

/** 球在窗口内的贴边模型：对应 .compact-shell 的 flex 对齐 + padding。 */
function ballScreenX(windowX: number, windowWidth: number, ballEdge: "left" | "right") {
  return windowX + (ballEdge === "right" ? windowWidth - BALL_INSET - BALL_WIDTH : BALL_INSET);
}

describe("紧凑窗口贴边不变量", () => {
  it("窗口锚边与球的贴边必须取同一个判据", () => {
    // 判据只有一个来源（resolveCompactBallEdge），所以「保哪条边」永远等于「球贴哪条边」。
    // 两者一旦不同边，窗口尺寸变化就会把球画到窗口的另一侧 —— 这就是本次修的 bug。
    for (const menuSide of MENU_SIDES) {
      const ballEdge = resolveCompactBallEdge(menuSide);
      expect(ballEdge).toBe(menuSide === "left" ? "right" : "left");

      const anchoredX = resolveAnchoredCompactWindowX(1000, COLLAPSED_WIDTH, EXPANDED_WIDTH, ballEdge);
      if (ballEdge === "right") {
        expect(anchoredX + EXPANDED_WIDTH).toBe(1000 + COLLAPSED_WIDTH); // 右边缘保持不动
      } else {
        expect(anchoredX).toBe(1000); // 左边缘保持不动
      }
    }
  });

  it.each(MENU_SIDES)("菜单在 %s 侧：展开再收起后球回到原屏幕位置", (menuSide) => {
    const ballEdge = resolveCompactBallEdge(menuSide);
    const collapsedX = 900;
    const before = ballScreenX(collapsedX, COLLAPSED_WIDTH, ballEdge);

    const expandedX = resolveAnchoredCompactWindowX(collapsedX, COLLAPSED_WIDTH, EXPANDED_WIDTH, ballEdge);
    expect(ballScreenX(expandedX, EXPANDED_WIDTH, ballEdge)).toBe(before);

    const restoredX = resolveAnchoredCompactWindowX(expandedX, EXPANDED_WIDTH, COLLAPSED_WIDTH, ballEdge);
    expect(ballScreenX(restoredX, COLLAPSED_WIDTH, ballEdge)).toBe(before);
  });

  it("对照：贴边随开关态翻转（旧实现）会在补偿落地前把球甩出一个窗口宽", () => {
    // 旧代码把 class 挂在 `isCompactMenuOpen && compactMenuSide === "left"` 上，而锚边只看
    // compactMenuSide：收起菜单时 class 先掉（球改贴窗口左边），窗口 x 的补偿还要等数个
    // IPC 往返才落地，中间那几帧球就被画在窗口左边 —— 位移 = 窗口宽 - 球宽 - 两侧 padding。
    const expandedX = 200;
    const correctBallX = ballScreenX(expandedX, EXPANDED_WIDTH, resolveCompactBallEdge("left")); // 展开态贴右
    const staleBallX = ballScreenX(expandedX, EXPANDED_WIDTH, "left"); // 旧实现收起瞬间贴左

    expect(correctBallX - staleBallX).toBe(EXPANDED_WIDTH - BALL_WIDTH - BALL_INSET * 2);
    expect(correctBallX - staleBallX).toBe(696);
  });
});
