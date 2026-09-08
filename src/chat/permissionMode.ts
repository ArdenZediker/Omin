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
  // 权限模式切换时清空临时授权，避免 full-access → default 残留旧的免确认项。
  sessionGrantedSources.clear();
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

// ---------------------------------------------------------------------------
// 会话临时授权（对齐清单「会话临时授权：本次会话允许某一类操作，不用每一步点确认」）。
//
// - 粒度 = 确认来源（requestConfirmation 的 source，如 bash / write_file / edit_file）；
// - 只允许低风险类别授予（write / read，且排除 ui: 动作）——destructive / irreversible
//   （删除对话、git push、越界导出等）永远逐次确认，不提供免打扰选项；
// - 作用域 = 当前应用运行期（与 full-access 一致不持久化，重启自动清空，避免忘记关闭）；
// - 权限模式切换时全部清空（full-access → default 不会残留旧授权）。
// ---------------------------------------------------------------------------

const sessionGrantedSources = new Set<string>();

/** 放行某个确认来源：此后该来源的 requestConfirmation 直接通过（直至重启或清空）。 */
export function grantSessionPermission(source: string): void {
  sessionGrantedSources.add(source);
}

/** 该来源当前是否已被会话临时授权。 */
export function isSessionGranted(source: string): boolean {
  return sessionGrantedSources.has(source);
}

/** 当前已放行的来源清单（供设置/状态展示）。 */
export function listSessionGrantedSources(): string[] {
  return [...sessionGrantedSources];
}

/** 清空全部会话临时授权。 */
export function clearSessionPermissions(): void {
  sessionGrantedSources.clear();
}

/** 该确认请求是否允许出现「本次会话不再询问」选项（保守白名单）。 */
export function canGrantSessionPermission(request: { source: string; riskLevel: string }): boolean {
  return (
    (request.riskLevel === "write" || request.riskLevel === "read") &&
    !request.source.startsWith("ui:")
  );
}
