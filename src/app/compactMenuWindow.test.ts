import { describe, expect, it } from "vitest";
import {
  COMPACT_MENU_EDGE_PADDING,
  COMPACT_MENU_GAP,
  COMPACT_MENU_WIDTH,
  getCompactMenuTotalWidth,
} from "../hooks/compactMenuGeometry";
import { resolveCompactMenuWindowLayout } from "./compactMenuWindow";

const WORK_AREA = {
  left: 0,
  top: 0,
  right: 1920,
  bottom: 1080,
  width: 1920,
  height: 1080,
};

describe("compact menu window geometry", () => {
  it("把独立窗口放在悬浮球右侧，并让一级菜单保持固定间距", () => {
    const layout = resolveCompactMenuWindowLayout({ x: 300, y: 300 }, WORK_AREA, 1);
    const menuScreenX = layout.x + layout.menuPosition.x;

    expect(layout.side).toBe("right");
    expect(menuScreenX).toBe(300 + COMPACT_MENU_GAP);
    expect(layout.x).toBeGreaterThanOrEqual(WORK_AREA.left);
    expect(layout.x + layout.width).toBeLessThanOrEqual(WORK_AREA.right);
  });

  it("靠近右边缘时整体翻到左侧，而不是移动悬浮球宿主窗口", () => {
    const layout = resolveCompactMenuWindowLayout({ x: 1900, y: 300 }, WORK_AREA, 1);
    const menuScreenRight =
      layout.x + layout.menuPosition.x + COMPACT_MENU_WIDTH;

    expect(layout.side).toBe("left");
    expect(menuScreenRight).toBe(1900 - COMPACT_MENU_GAP);
    expect(layout.x).toBeGreaterThanOrEqual(WORK_AREA.left);
    expect(layout.x + layout.width).toBeLessThanOrEqual(WORK_AREA.right);
  });

  it("纵向越界时只钳制菜单窗口，不把菜单裁出工作区", () => {
    const layout = resolveCompactMenuWindowLayout({ x: 300, y: 1060 }, WORK_AREA, 1);

    expect(layout.y).toBeGreaterThanOrEqual(WORK_AREA.top);
    expect(layout.y + layout.height).toBeLessThanOrEqual(WORK_AREA.bottom);
    expect(layout.menuPosition.y).toBe(COMPACT_MENU_EDGE_PADDING);
  });

  it("高 DPI 下按物理像素定位，并按比例换算菜单内边距", () => {
    const scaledWorkArea = {
      left: 0,
      top: 0,
      right: 3840,
      bottom: 2160,
      width: 3840,
      height: 2160,
    };
    const layout = resolveCompactMenuWindowLayout({ x: 600, y: 600 }, scaledWorkArea, 2);

    expect(layout.side).toBe("right");
    expect(layout.width).toBe((getCompactMenuTotalWidth() + COMPACT_MENU_EDGE_PADDING * 2) * 2);
    expect(layout.x + layout.menuPosition.x * 2).toBe(600 + COMPACT_MENU_GAP * 2);
  });

  it("按悬浮窗完整边界展开，不覆盖球体", () => {
    const host = { x: 1200, y: 600, width: 162, height: 84 };
    const layout = resolveCompactMenuWindowLayout(
      { x: 1218, y: 630 },
      WORK_AREA,
      1.5,
      host
    );
    const menuScreenLeft = layout.x + layout.menuPosition.x * 1.5;

    expect(layout.side).toBe("right");
    expect(menuScreenLeft).toBeGreaterThan(host.x + host.width);
  });
});
