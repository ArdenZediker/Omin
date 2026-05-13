export function isOutsidePinnedCharacterMenu(target: HTMLElement) {
  return !target.closest(".compact-menu") && !target.closest(".compact-menu-anchor");
}

export function shouldCloseCharacterReplyPanel(target: HTMLElement) {
  return !target.closest(".compact-menu-anchor") && !target.closest(".compact-query") && !target.closest(".compact-reply");
}

export function isNoDragTarget(target: HTMLElement) {
  return Boolean(target.closest(".no-drag"));
}

export function clearPendingDragTimer(timerId: number | null) {
  if (timerId !== null) {
    window.clearTimeout(timerId);
  }
}
