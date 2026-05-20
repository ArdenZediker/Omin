export const CODEX_PET_CELL_SIZE = {
  width: 192,
  height: 208,
} as const;

export const PET_WINDOW_SAFE_MARGIN_X = 8;
export const PET_WINDOW_SAFE_MARGIN_Y = 12;

const PET_VIEWPORT_HORIZONTAL_INSET = 18 + PET_WINDOW_SAFE_MARGIN_X;
const PET_VIEWPORT_VERTICAL_INSET = 24 + PET_WINDOW_SAFE_MARGIN_Y;
const PET_VIEWPORT_MIN_EDGE = 48;

export function getCodexPetViewportSize(compactSize: { width: number; height: number }) {
  const availableWidth = Math.max(PET_VIEWPORT_MIN_EDGE, Math.round(compactSize.width - PET_VIEWPORT_HORIZONTAL_INSET));
  const availableHeight = Math.max(PET_VIEWPORT_MIN_EDGE, Math.round(compactSize.height - PET_VIEWPORT_VERTICAL_INSET));

  return fitCodexPetToBounds({
    width: availableWidth,
    height: availableHeight,
  });
}

export function fitCodexPetToBounds(bounds: { width: number; height: number }) {
  const safeWidth = Number.isFinite(bounds.width) ? Math.max(0, bounds.width) : 0;
  const safeHeight = Number.isFinite(bounds.height) ? Math.max(0, bounds.height) : 0;
  const scale = Math.min(safeWidth / CODEX_PET_CELL_SIZE.width, safeHeight / CODEX_PET_CELL_SIZE.height);
  const safeScale = Number.isFinite(scale) ? Math.max(0, scale) : 0;

  return {
    width: Math.round(CODEX_PET_CELL_SIZE.width * safeScale),
    height: Math.round(CODEX_PET_CELL_SIZE.height * safeScale),
    scale: safeScale,
  };
}
