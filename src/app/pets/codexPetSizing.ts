export const CODEX_PET_CELL_SIZE = {
  width: 192,
  height: 208,
} as const;

export function getCodexPetViewportHeight(compactWidth: number) {
  return Math.max(48, Math.round(compactWidth - 18));
}

export function getCodexPetViewportSize(compactWidth: number) {
  const height = getCodexPetViewportHeight(compactWidth);
  return {
    width: Math.round((height * CODEX_PET_CELL_SIZE.width) / CODEX_PET_CELL_SIZE.height),
    height,
  };
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
