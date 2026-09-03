/**
 * 会话级权限模式。
 *
 * - default：默认权限，所有越界/危险操作都经过 HITL 确认门。
 * - full-access：完全访问，跳过所有确认弹窗直接放行（仍然受 Rust 工作区/No-Go 围栏约束）。
 *
 * 当前实现为全局运行时开关（不持久化），重启后自动回到 default，避免用户忘记关闭导致长期误操作。
 */

export type PermissionMode = "default" | "full-access";

let currentMode: PermissionMode = "default";
const listeners = new Set<(mode: PermissionMode) => void>();

export function getPermissionMode(): PermissionMode {
  return currentMode;
}

export function isFullAccess(): boolean {
  return currentMode === "full-access";
}

export function setPermissionMode(mode: PermissionMode): void {
  if (mode === currentMode) return;
  currentMode = mode;
  for (const listener of listeners) {
    listener(mode);
  }
}

export function subscribePermissionMode(listener: (mode: PermissionMode) => void): () => void {
  listeners.add(listener);
  listener(currentMode);
  return () => {
    listeners.delete(listener);
  };
}
