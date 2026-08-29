export const CODEX_PET_CELL_SIZE = {
  width: 192,
  height: 208,
} as const;

export const PET_WINDOW_SAFE_MARGIN_X = 8;
export const PET_WINDOW_SAFE_MARGIN_Y = 12;
export const PET_WINDOW_DECORATION_MARGIN_RIGHT = 28;
export const PET_WINDOW_DECORATION_MARGIN_TOP = 16;

/**
 * 想法气泡 / 菜单展开时，宠物会被 --pet-viewport-offset-y 推到放大后视口的中间，
 * 此时「窗口顶边贴住屏幕顶边」并不等于「宠物贴住屏幕顶边」。
 * 拖动的上边界必须按宠物本体的视觉顶边来算，并额外多给几个像素
 * （.compact-shell 还有一圈内边距），宠物才能真正贴到屏幕最上方。
 */
export const PET_WINDOW_TOP_OVERSCROLL = 8;

/**
 * 防御性下限：气泡/菜单把视口撑大后，窗口顶边需要整体上移到屏幕上方，
 * 这里只防止异常坐标把宠物窗口彻底移出屏幕，不参与正常拖动边界计算。
 */
export const PET_WINDOW_NATIVE_TOP_LIMIT = -640;

const PET_VIEWPORT_HORIZONTAL_INSET = 18 + PET_WINDOW_SAFE_MARGIN_X + PET_WINDOW_DECORATION_MARGIN_RIGHT;
const PET_VIEWPORT_VERTICAL_INSET = 24 + PET_WINDOW_SAFE_MARGIN_Y + PET_WINDOW_DECORATION_MARGIN_TOP;
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
