export const COMPACT_MENU_HEIGHT = 280;
export const COMPACT_MENU_EDGE_PADDING = 8;
export const COMPACT_MENU_WIDTH = 200;
export const COMPACT_MENU_GAP = 6;
export const COMPACT_MENU_SUBMENU_WIDTH = 176;

export function clampToRange(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function resolveCompactMenuSidesFromSpace(leftSpace: number, rightSpace: number) {
  const menuFootprint = COMPACT_MENU_WIDTH + COMPACT_MENU_GAP;
  const submenuFootprint = COMPACT_MENU_SUBMENU_WIDTH + COMPACT_MENU_GAP;

  const menuSide =
    rightSpace >= menuFootprint
      ? ("right" as const)
      : leftSpace >= menuFootprint
        ? ("left" as const)
        : leftSpace > rightSpace
          ? ("left" as const)
          : ("right" as const);

  const submenuSide =
    menuSide === "right"
      ? rightSpace - menuFootprint >= submenuFootprint
        ? ("right" as const)
        : ("left" as const)
      : leftSpace - menuFootprint >= submenuFootprint
        ? ("left" as const)
        : ("right" as const);

  return { menuSide, submenuSide };
}

export function resolveCompactMenuPositionFromViewport(
  anchorX: number,
  anchorY: number,
  side: "left" | "right",
  viewportWidth: number,
  viewportHeight: number
) {
  const minLeft =
    side === "left"
      ? COMPACT_MENU_SUBMENU_WIDTH + COMPACT_MENU_GAP + COMPACT_MENU_EDGE_PADDING
      : COMPACT_MENU_EDGE_PADDING;
  const maxLeft =
    side === "right"
      ? Math.max(
          COMPACT_MENU_EDGE_PADDING,
          viewportWidth -
            COMPACT_MENU_WIDTH -
            COMPACT_MENU_SUBMENU_WIDTH -
            COMPACT_MENU_GAP -
            COMPACT_MENU_EDGE_PADDING
        )
      : Math.max(minLeft, viewportWidth - COMPACT_MENU_WIDTH - COMPACT_MENU_EDGE_PADDING);
  const minTop = COMPACT_MENU_EDGE_PADDING;
  const maxTop = Math.max(minTop, viewportHeight - COMPACT_MENU_HEIGHT - COMPACT_MENU_EDGE_PADDING);

  return {
    x: Math.round(
      clampToRange(
        side === "left" ? anchorX - COMPACT_MENU_WIDTH - COMPACT_MENU_GAP : anchorX + COMPACT_MENU_GAP,
        minLeft,
        maxLeft
      )
    ),
    y: Math.round(clampToRange(anchorY - 16, minTop, maxTop)),
  };
}
