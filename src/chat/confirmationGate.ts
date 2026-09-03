/**
 * 危险操作前置确认门（HITL：Human-In-The-Loop）。
 *
 * 设计要点（对齐「Warn + List + Confirm」铁律）：
 * - 纯 TS 模块，不依赖 React，工具执行层（src/chat/localTools.ts）与 UI 层都能调用；
 * - 执行前必须展示：① 要做什么 ② 影响哪些对象 ③ 参数预览 ④ 风险说明；
 * - 同一时刻只允许一个待确认请求（队列无意义：用户必须逐个看清）；
 * - 无 UI 监听器时**默认拒绝**而非静默放行——宁可失败也不能绕过确认；
 * - 超时自动拒绝，避免工具循环永久挂起导致会话卡死。
 */

/** 风险等级：决定弹窗配色与措辞强度。 */
import { isFullAccess } from "./permissionMode";

export type RiskLevel =
  /** 读取越界：工作区外读文件，仅信息泄露风险，副作用可控 */
  | "read"
  /** 不可逆：推到远端、发布、删除远端资源等，撤不回来 */
  | "irreversible"
  /** 破坏性：本地删除、覆盖、仓库状态变更，理论可撤销但代价高 */
  | "destructive"
  /** 写入：新建文件、写配置等，副作用可控 */
  | "write";

/** 参数预览的一行（label/value 均需在展示前脱敏）。 */
export type ConfirmationDetail = {
  label: string;
  value: string;
};

export type ConfirmationRequest = {
  /** 标识来源：工具 id（git_pr）或 UI 动作（ui:delete_project） */
  source: string;
  /** 弹窗标题，如「推送分支并创建 PR」 */
  title: string;
  /** 一句话说明本次操作要做什么 */
  summary: string;
  riskLevel: RiskLevel;
  /** 参数预览（给用户看清实际传了什么） */
  details: ConfirmationDetail[];
  /** 影响对象清单（文件、分支、会话名等） */
  targets: string[];
  /** 风险说明（为什么需要你确认） */
  warning: string;
  /** 确认按钮文案，默认「确认执行」 */
  confirmLabel?: string;
};

type PendingRequest = ConfirmationRequest & {
  id: string;
  createdAt: number;
  resolve: (approved: boolean) => void;
};

/** 无响应时的自动拒绝时限（5 分钟）：防止工具循环永久挂起。 */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

let pending: PendingRequest | null = null;
let timeoutMs = DEFAULT_TIMEOUT_MS;
const listeners = new Set<(request: (ConfirmationRequest & { id: string }) | null) => void>();

let idSeed = 0;
const nextId = () => `confirm-${Date.now()}-${++idSeed}`;

function notify() {
  const snapshot = pending
    ? { ...pending, resolve: undefined as unknown as PendingRequest["resolve"] }
    : null;
  for (const listener of listeners) {
    listener(snapshot as (ConfirmationRequest & { id: string }) | null);
  }
}

/** 当前是否挂着待确认请求。 */
export function getPendingConfirmation(): (ConfirmationRequest & { id: string }) | null {
  return pending ? { ...pending } : null;
}

/** 是否已有 UI 在监听确认请求（无监听时 requestConfirmation 会直接拒绝）。 */
export function hasConfirmationListener(): boolean {
  return listeners.size > 0;
}

/**
 * 订阅待确认请求的变化。返回取消订阅函数。
 * React 侧用它在根组件弹出确认对话框。
 */
export function subscribeConfirmation(
  listener: (request: (ConfirmationRequest & { id: string }) | null) => void,
): () => void {
  listeners.add(listener);
  listener(pending ? { ...pending } : null);
  return () => {
    listeners.delete(listener);
  };
}

/** 结算某个待确认请求。approved=true 放行，false 拒绝。 */
export function resolveConfirmation(id: string, approved: boolean): void {
  if (!pending || pending.id !== id) return;
  const current = pending;
  pending = null;
  notify();
  current.resolve(approved);
}

/** 测试用：调整自动拒绝超时。 */
export function setConfirmationTimeout(ms: number): void {
  timeoutMs = ms;
}

/**
 * 发起一次确认请求。
 *
 * - 已存在未处理的请求时，新的请求直接被拒绝（不排队，避免用户连点一串看不清的弹窗）；
 * - 无 UI 监听器时直接拒绝（安全优先于可用性）；
 * - 超过 timeoutMs 未响应自动拒绝。
 */
export function requestConfirmation(request: ConfirmationRequest): Promise<boolean> {
  if (isFullAccess()) return Promise.resolve(true);
  if (pending) return Promise.resolve(false);
  if (listeners.size === 0) return Promise.resolve(false);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (approved: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (pending?.id === id) {
        pending = null;
        notify();
      }
      resolve(approved);
    };

    const id = nextId();
    pending = { ...request, id, createdAt: Date.now(), resolve: finish };
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    notify();
  });
}
