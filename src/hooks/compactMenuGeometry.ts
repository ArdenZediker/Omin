export const COMPACT_MENU_HEIGHT = 280;
export const COMPACT_MENU_EDGE_PADDING = 18;
export const COMPACT_MENU_WIDTH = 136;
export const COMPACT_MENU_GAP = 6;
export const COMPACT_MENU_SUBMENU_WIDTH = 136;
export const COMPACT_MENU_SUBMENU_HEIGHT = 420;
export const COMPACT_MENU_VIEWPORT_BASE_WIDTH = 462;

type CompactMenuSide = "left" | "right";

type CompactMenuSides = {
  menuSide: CompactMenuSide;
  submenuSide: CompactMenuSide;
};

type CompactMenuSideSpaceOptions = {
  viewportLeftSpace?: number;
  viewportRightSpace?: number;
  petCompactSize?: { width: number; height: number };
  petViewportSize?: { width: number; height: number };
  preferredMenuSide?: CompactMenuSide;
  preferredSubmenuSide?: CompactMenuSide;
};

export function getCompactMenuTotalWidth() {
  return COMPACT_MENU_WIDTH + COMPACT_MENU_GAP + COMPACT_MENU_SUBMENU_WIDTH;
}

export function getCompactMenuViewportMinWidth() {
  return Math.max(COMPACT_MENU_VIEWPORT_BASE_WIDTH, getCompactMenuTotalWidth() + COMPACT_MENU_EDGE_PADDING * 2);
}

export function clampToRange(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getCompactMenuFootprint({ menuSide, submenuSide }: CompactMenuSides) {
  if (menuSide === "right") {
    return submenuSide === "right"
      ? { left: 0, right: COMPACT_MENU_WIDTH + COMPACT_MENU_GAP * 2 + COMPACT_MENU_SUBMENU_WIDTH }
      : { left: COMPACT_MENU_SUBMENU_WIDTH, right: COMPACT_MENU_WIDTH + COMPACT_MENU_GAP };
  }

  return submenuSide === "left"
    ? { left: COMPACT_MENU_WIDTH + COMPACT_MENU_GAP * 2 + COMPACT_MENU_SUBMENU_WIDTH, right: 0 }
    : { left: COMPACT_MENU_WIDTH + COMPACT_MENU_GAP, right: COMPACT_MENU_SUBMENU_WIDTH };
}

function getSpaceOverflow(leftSpace: number, rightSpace: number, sides: CompactMenuSides) {
  const footprint = getCompactMenuFootprint(sides);
  return (
    Math.max(0, footprint.left + COMPACT_MENU_EDGE_PADDING - leftSpace) +
    Math.max(0, footprint.right + COMPACT_MENU_EDGE_PADDING - rightSpace)
  );
}

export function resolveCompactMenuSidesFromSpace(
  leftSpace: number,
  rightSpace: number,
  options: CompactMenuSideSpaceOptions = {}
) {
  const preferredMenuSide: CompactMenuSide = options.preferredMenuSide ?? "right";
  const preferredSubmenuSide: CompactMenuSide = options.preferredSubmenuSide ?? preferredMenuSide;
  const candidates: CompactMenuSides[] = [
    { menuSide: "right", submenuSide: "right" },
    { menuSide: "right", submenuSide: "left" },
    { menuSide: "left", submenuSide: "left" },
    { menuSide: "left", submenuSide: "right" },
  ];

  return candidates
    .map((candidate, index) => {
      const screenOverflow = getSpaceOverflow(leftSpace, rightSpace, candidate);
      const petViewportOffset =
        options.petCompactSize && options.petViewportSize
          ? resolvePetMenuViewportOffset(options.petCompactSize, options.petViewportSize, candidate)
          : null;
      let candidateViewportLeftSpace = options.viewportLeftSpace;
      let candidateViewportRightSpace = options.viewportRightSpace;

      if (petViewportOffset && options.petCompactSize && options.petViewportSize) {
        const petAnchorX = petViewportOffset.x + options.petCompactSize.width / 2;
        candidateViewportLeftSpace = petAnchorX;
        candidateViewportRightSpace = options.petViewportSize.width - petAnchorX;
      }

      let viewportOverflow = 0;
      if (typeof candidateViewportLeftSpace === "number" && typeof candidateViewportRightSpace === "number") {
        viewportOverflow = getSpaceOverflow(candidateViewportLeftSpace, candidateViewportRightSpace, candidate);
      }
      const menuSidePenalty = candidate.menuSide === preferredMenuSide ? 0 : 2;
      const submenuSidePenalty = candidate.submenuSide === preferredSubmenuSide ? 0 : 0.35;
      const splitSidePenalty = candidate.submenuSide === candidate.menuSide ? 0 : 0.1;

      return {
        candidate,
        score:
          viewportOverflow * 1000 +
          screenOverflow * 100 +
          menuSidePenalty +
          submenuSidePenalty +
          splitSidePenalty +
          index * 0.01,
      };
    })
    .sort((a, b) => a.score - b.score)[0].candidate;
}

export function resolveCompactMenuPositionFromViewport(
  anchorX: number,
  anchorY: number,
  side: "left" | "right",
  submenuSide: "left" | "right",
  viewportWidth: number,
  viewportHeight: number
) {
  const leftOverflow =
    submenuSide === "left" ? COMPACT_MENU_SUBMENU_WIDTH + COMPACT_MENU_GAP : 0;
  const rightOverflow =
    submenuSide === "right" ? COMPACT_MENU_SUBMENU_WIDTH + COMPACT_MENU_GAP : 0;
  const minLeft = COMPACT_MENU_EDGE_PADDING + leftOverflow;
  const maxLeft = Math.max(
    minLeft,
    viewportWidth - COMPACT_MENU_WIDTH - rightOverflow - COMPACT_MENU_EDGE_PADDING
  );
  const minTop = COMPACT_MENU_EDGE_PADDING;
  const maxTop = Math.max(
    minTop,
    viewportHeight -
      Math.max(COMPACT_MENU_HEIGHT, COMPACT_MENU_SUBMENU_HEIGHT) -
      COMPACT_MENU_EDGE_PADDING
  );

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

export function resolvePetMenuViewportOffset(
  compactSize: { width: number; height: number },
  viewportSize: { width: number; height: number } | null,
  sides?: CompactMenuSides
) {
  if (!viewportSize) {
    return { x: 0, y: 0 };
  }

  const centeredX = Math.max(0, Math.round((viewportSize.width - compactSize.width) / 2));
  const maxX = Math.max(0, viewportSize.width - compactSize.width);
  const footprint = sides ? getCompactMenuFootprint(sides) : null;
  const minOffsetForMenu = footprint
    ? footprint.left + COMPACT_MENU_EDGE_PADDING - compactSize.width / 2
    : COMPACT_MENU_EDGE_PADDING;
  const maxOffsetForMenu = footprint
    ? viewportSize.width - footprint.right - COMPACT_MENU_EDGE_PADDING - compactSize.width / 2
    : maxX - COMPACT_MENU_EDGE_PADDING;
  const preferredX = footprint ? 0 : centeredX;
  const minViewportOffset = footprint ? 0 : COMPACT_MENU_EDGE_PADDING;
  const maxViewportOffset = footprint ? maxX : Math.max(COMPACT_MENU_EDGE_PADDING, maxX - COMPACT_MENU_EDGE_PADDING);
  const minOffset = Math.max(minViewportOffset, minOffsetForMenu);
  const maxOffset = Math.min(maxViewportOffset, maxOffsetForMenu);

  return {
    x: Math.round(clampToRange(preferredX, minOffset, Math.max(minOffset, maxOffset))),
    y: footprint ? 0 : Math.max(0, Math.round((viewportSize.height - compactSize.height) / 2)),
  };
}

export function resolvePetMenuAnchorX(
  compactSize: { width: number; height: number },
  viewportSize: { width: number; height: number } | null,
  sides?: CompactMenuSides
) {
  const offset = resolvePetMenuViewportOffset(compactSize, viewportSize, sides);
  return Math.round(offset.x + compactSize.width / 2);
}

export function resolvePetMenuAnchorY(
  compactSize: { width: number; height: number },
  viewportSize: { width: number; height: number } | null,
  anchorY: number,
  sides?: CompactMenuSides
) {
  const offset = resolvePetMenuViewportOffset(compactSize, viewportSize, sides);
  return Math.round(offset.y + anchorY);
}
