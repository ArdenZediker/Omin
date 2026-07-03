import { describe, expect, it } from "vitest";
import {
  COMPACT_MENU_EDGE_PADDING,
  COMPACT_MENU_GAP,
  COMPACT_MENU_HEIGHT,
  COMPACT_MENU_SUBMENU_HEIGHT,
  COMPACT_MENU_SUBMENU_WIDTH,
  COMPACT_MENU_WIDTH,
  getCompactMenuViewportMinWidth,
  resolveCompactMenuPositionFromViewport,
  resolveCompactMenuSidesFromSpace,
  resolvePetMenuAnchorX,
  resolvePetMenuAnchorY,
  resolvePetMenuViewportOffset,
} from "./compactMenuGeometry";

function getMenuBounds(
  position: { x: number; y: number },
  sides: { menuSide: "left" | "right"; submenuSide: "left" | "right" }
) {
  const submenuLeft =
    sides.submenuSide === "left"
      ? position.x - COMPACT_MENU_GAP - COMPACT_MENU_SUBMENU_WIDTH
      : position.x + COMPACT_MENU_WIDTH + COMPACT_MENU_GAP;
  const submenuRight = submenuLeft + COMPACT_MENU_SUBMENU_WIDTH;

  return {
    left: Math.min(position.x, submenuLeft),
    right: Math.max(position.x + COMPACT_MENU_WIDTH, submenuRight),
    top: position.y,
    bottom: position.y + Math.max(COMPACT_MENU_HEIGHT, COMPACT_MENU_SUBMENU_HEIGHT),
  };
}

describe("compactMenuGeometry", () => {
  it("一级菜单和二级菜单使用一致宽度", () => {
    expect(COMPACT_MENU_WIDTH).toBe(COMPACT_MENU_SUBMENU_WIDTH);
  });

  it("为向左展开的二级菜单预留左侧空间", () => {
    const position = resolveCompactMenuPositionFromViewport(120, 24, "right", "left", getCompactMenuViewportMinWidth(), 560);

    expect(position.x).toBeGreaterThanOrEqual(
      COMPACT_MENU_EDGE_PADDING + COMPACT_MENU_SUBMENU_WIDTH + COMPACT_MENU_GAP
    );
  });

  it("为向右展开的二级菜单预留右侧空间", () => {
    const viewportWidth = getCompactMenuViewportMinWidth();
    const position = resolveCompactMenuPositionFromViewport(420, 24, "left", "right", viewportWidth, 560);

    expect(position.x + COMPACT_MENU_WIDTH + COMPACT_MENU_GAP + COMPACT_MENU_SUBMENU_WIDTH).toBeLessThanOrEqual(
      viewportWidth - COMPACT_MENU_EDGE_PADDING
    );
  });

  it("宠物菜单锚点跟随宠物在扩展视口中的偏移", () => {
    const compactSize = { width: 156, height: 170 };
    const viewportSize = { width: getCompactMenuViewportMinWidth(), height: 560 };

    expect(resolvePetMenuViewportOffset(compactSize, viewportSize)).toEqual({ x: 153, y: 195 });
    expect(resolvePetMenuAnchorX(compactSize, viewportSize)).toBe(231);
  });

  it("左侧二级菜单给窗口裁剪和阴影留出安全边距", () => {
    const compactSize = { width: 156, height: 170 };
    const viewportSize = { width: getCompactMenuViewportMinWidth(), height: 560 };
    const anchorX = resolvePetMenuAnchorX(compactSize, viewportSize);
    const position = resolveCompactMenuPositionFromViewport(anchorX, 42, "right", "left", viewportSize.width, viewportSize.height);

    expect(position.x - COMPACT_MENU_SUBMENU_WIDTH - COMPACT_MENU_GAP).toBeGreaterThanOrEqual(COMPACT_MENU_EDGE_PADDING);
  });

  it("二级菜单与主菜单的整体视觉宽度保持在窗口安全区内", () => {
    const viewportWidth = getCompactMenuViewportMinWidth();
    const leftPosition = resolveCompactMenuPositionFromViewport(120, 42, "right", "left", viewportWidth, 560);
    const rightPosition = resolveCompactMenuPositionFromViewport(520, 42, "left", "right", viewportWidth, 560);

    expect(leftPosition.x - COMPACT_MENU_SUBMENU_WIDTH - COMPACT_MENU_GAP).toBe(COMPACT_MENU_EDGE_PADDING);
    expect(rightPosition.x + COMPACT_MENU_WIDTH + COMPACT_MENU_GAP + COMPACT_MENU_SUBMENU_WIDTH).toBe(
      viewportWidth - COMPACT_MENU_EDGE_PADDING
    );
  });

  it("屏幕右侧空间不够时主菜单自动换到左侧", () => {
    expect(resolveCompactMenuSidesFromSpace(420, 120)).toEqual({
      menuSide: "left",
      submenuSide: "left",
    });
  });

  it("主菜单右侧够放但二级菜单右侧不够时，二级菜单换到左侧", () => {
    expect(resolveCompactMenuSidesFromSpace(240, 220)).toEqual({
      menuSide: "right",
      submenuSide: "left",
    });
  });

  it("透明窗口内部左侧不够时，二级菜单自动避开左侧", () => {
    const sides = resolveCompactMenuSidesFromSpace(300, 300, {
        viewportLeftSpace: 140,
        viewportRightSpace: 390,
      });

    expect(sides.submenuSide).toBe("right");
  });

  it("宠物菜单默认保持宠物在扩展窗口原点，避免开关菜单时乱动", () => {
    const compactSize = { width: 156, height: 170 };
    const viewportSize = { width: getCompactMenuViewportMinWidth(), height: 560 };

    expect(resolvePetMenuViewportOffset(compactSize, viewportSize, {
      menuSide: "right",
      submenuSide: "right",
    })).toEqual({ x: 0, y: 0 });
    expect(
      resolvePetMenuAnchorX(compactSize, viewportSize, {
        menuSide: "left",
        submenuSide: "left",
      })
    ).toBeGreaterThan(resolvePetMenuAnchorX(compactSize, viewportSize));
  });

  it("宠物位于屏幕中心偏右但右侧空间够用时，不按中心线切到左侧", () => {
    const compactSize = { width: 156, height: 170 };
    const viewportSize = { width: getCompactMenuViewportMinWidth(), height: 560 };
    const sides = resolveCompactMenuSidesFromSpace(980, 940, {
      petCompactSize: compactSize,
      petViewportSize: viewportSize,
    });
    const anchorX = resolvePetMenuAnchorX(compactSize, viewportSize, sides);
    const position = resolveCompactMenuPositionFromViewport(
      anchorX,
      42,
      sides.menuSide,
      sides.submenuSide,
      viewportSize.width,
      viewportSize.height
    );
    const bounds = getMenuBounds(position, sides);

    expect(sides).toEqual({ menuSide: "right", submenuSide: "right" });
    expect(bounds.left).toBeGreaterThanOrEqual(COMPACT_MENU_EDGE_PADDING);
    expect(bounds.right).toBeLessThanOrEqual(viewportSize.width - COMPACT_MENU_EDGE_PADDING);
    expect(bounds.top).toBeGreaterThanOrEqual(COMPACT_MENU_EDGE_PADDING);
    expect(bounds.bottom).toBeLessThanOrEqual(viewportSize.height - COMPACT_MENU_EDGE_PADDING);
  });

  it("宠物菜单移出宠物容器后，纵向锚点不再把菜单推到扩展窗口中部", () => {
    const compactSize = { width: 156, height: 170 };
    const viewportSize = { width: getCompactMenuViewportMinWidth(), height: 560 };
    const sides = { menuSide: "right" as const, submenuSide: "right" as const };

    expect(resolvePetMenuAnchorY(compactSize, viewportSize, 85, sides)).toBe(85);
  });

  it("宠物右侧只够主菜单时，只翻转二级菜单而不是让菜单消失", () => {
    const compactSize = { width: 156, height: 170 };
    const viewportSize = { width: getCompactMenuViewportMinWidth(), height: 560 };
    const sides = resolveCompactMenuSidesFromSpace(360, 220, {
      petCompactSize: compactSize,
      petViewportSize: viewportSize,
    });
    const anchorX = resolvePetMenuAnchorX(compactSize, viewportSize, sides);
    const position = resolveCompactMenuPositionFromViewport(
      anchorX,
      42,
      sides.menuSide,
      sides.submenuSide,
      viewportSize.width,
      viewportSize.height
    );
    const bounds = getMenuBounds(position, sides);

    expect(sides).toEqual({ menuSide: "right", submenuSide: "left" });
    expect(bounds.left).toBeGreaterThanOrEqual(COMPACT_MENU_EDGE_PADDING);
    expect(bounds.right).toBeLessThanOrEqual(viewportSize.width - COMPACT_MENU_EDGE_PADDING);
  });
});
