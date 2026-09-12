import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ChatSession, Project } from "./types";

/**
 * 跨窗口聊天状态同步。
 *
 * **背景（根因）**：主窗与紧凑窗是两个独立 webview，各自跑一份 `useChatSessions`，
 * 各自持有「整份会话快照」并整快照回写。而 `save_structured_chat_storage` 是
 * **整表覆盖 + 删掉快照外的行** ⇒ 后写者覆盖先写者：主窗删掉的会话，会被紧凑窗
 * 内存里的陈旧快照重新 INSERT 回来（反向则是「新建的会话被幽灵清理删掉」）。
 * 这就是「删掉的会话自己又回来」的根因。
 *
 * **修法**：整快照写权收归单一写者 —— `owner`（主窗）。紧凑窗降级为 `follower`：
 *   1. follower 只**窄写**自己创建的会话（宠物对话），绝不整快照覆盖；
 *   2. follower 把自己拥有的会话**广播**给 owner，owner 并入内存后再整快照落盘，
 *      这样 owner 的幽灵清理不会把宠物会话当垃圾删掉；
 *   3. owner 把「会话/项目的增量 + 删除」广播给 follower，follower 并入内存 ——
 *      关键是**让 follower 知道某会话已被删除**，否则它内存里的陈旧副本还会被窄写回去。
 *
 * **回声抑制**：follower 从不广播 owner 的会话（只广播自己拥有的），owner 的广播也
 * 不会被 follower 转发回去，因此不存在 A→B→A 的无限回声。`shouldAdopt*` 的判据是
 * 对称且严格的（`updatedAt` 相等且字段一致时**不采纳**），所以即便出现一轮回声也会
 * 立即收敛，不会自我循环。
 */

export const CHAT_STORAGE_SYNC_EVENT = "omni:chat-storage-sync";

/** 广播者角色。`owner` 持有整快照写权；`follower` 只窄写自己拥有的会话。 */
export type ChatStorageSyncRole = "owner" | "follower";

export type ChatStorageSyncPayload = {
  /** 广播者标识（窗口 label），接收方据此过滤自己的回声。 */
  source: string;
  role: ChatStorageSyncRole;
  sessionUpserts: ChatSession[];
  /** 仅 owner 会带：follower 没有会话列表、从不删除会话。 */
  sessionDeletes: string[];
  projectUpserts: Project[];
  projectDeletes: string[];
};

type SyncCollection<T> = {
  upserts: T[];
  deletes: string[];
};

function canUseTauriEvents(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 当前窗口的同步标识。窗口 label 天然唯一（`main` / `compact`），
 * 非 Tauri 环境（含测试）回落到固定串 —— 此时 emit/listen 本身就是空操作。
 */
export function getChatSyncSource(): string {
  try {
    return getCurrentWindow().label || "unknown-window";
  } catch {
    return "unknown-window";
  }
}

/**
 * 「两个会话是否已同步」的判据。刻意只比对**廉价字段**（跳过 messages 内容）：
 * 本函数同时用于「相对游标是否变了」与「是否采纳远端」，两条路径都只需要
 * 「有没有变化」这个布尔，而会话内容任何变化都必然伴随 `updatedAt` 递增
 * （`updateChatSessionMessages` / 90ms 同步 effect / `applyUsageToSession` 都写 now），
 * 不递增的字段（title / pinned / favorite）在这里显式比对。
 */
export function isSessionSynced(before: ChatSession, after: ChatSession): boolean {
  return (
    before.updatedAt === after.updatedAt &&
    before.title === after.title &&
    Boolean(before.pinned) === Boolean(after.pinned) &&
    Boolean(before.favorite) === Boolean(after.favorite) &&
    before.messages.length === after.messages.length
  );
}

/** 项目的同步判据。id 数组按内容比对（只比长度会漏掉「同长度换成员」）。 */
export function isProjectSynced(before: Project, after: Project): boolean {
  return (
    before.updatedAt === after.updatedAt &&
    before.title === after.title &&
    before.description === after.description &&
    before.workspacePath === after.workspacePath &&
    (before.systemPrompt ?? "") === (after.systemPrompt ?? "") &&
    (before.allowedToolIds ?? []).join("\u0000") === (after.allowedToolIds ?? []).join("\u0000") &&
    (before.allowedSkillIds ?? []).join("\u0000") === (after.allowedSkillIds ?? []).join("\u0000") &&
    (before.allowedConnectorIds ?? []).join("\u0000") === (after.allowedConnectorIds ?? []).join("\u0000") &&
    (before.boundExpertIds ?? []).join("\u0000") === (after.boundExpertIds ?? []).join("\u0000")
  );
}

/**
 * 是否采纳远端版本。
 * `updatedAt` 更大者胜；相等且字段一致时**不采纳**（否则会把同样的数据反复
 * setState 成新对象，触发新一轮广播，形成回声死循环）。
 */
export function shouldAdoptRemoteSession(local: ChatSession, incoming: ChatSession): boolean {
  if (incoming.updatedAt < local.updatedAt) return false;
  if (incoming.updatedAt > local.updatedAt) return true;
  return !isSessionSynced(local, incoming);
}

export function shouldAdoptRemoteProject(local: Project, incoming: Project): boolean {
  if (incoming.updatedAt < local.updatedAt) return false;
  if (incoming.updatedAt > local.updatedAt) return true;
  return !isProjectSynced(local, incoming);
}

/** 相对上一轮游标，算出需要广播的新增/变更与删除。 */
export function diffSyncCollection<T extends { id: string }>(
  previous: T[] | null,
  next: T[],
  isSynced: (before: T, after: T) => boolean
): SyncCollection<T> {
  const pending = new Map((previous ?? []).map((item) => [item.id, item]));
  const upserts: T[] = [];

  for (const item of next) {
    const before = pending.get(item.id);
    if (!before || !isSynced(before, item)) {
      upserts.push(item);
    }
    pending.delete(item.id);
  }

  return { upserts, deletes: [...pending.keys()] };
}

/**
 * 把远端增量并入本地集合。**无变化时返回 `null`** —— 调用方据此跳过 setState，
 * 这是打断回声循环的关键（`null` 表示「数据已一致，别再 setState 出新对象」）。
 */
export function mergeRemoteCollection<T extends { id: string }>(
  local: T[],
  remote: SyncCollection<T>,
  shouldAdopt: (local: T, incoming: T) => boolean
): T[] | null {
  const deleted = new Set(remote.deletes);
  const pending = new Map(remote.upserts.map((item) => [item.id, item]));
  let changed = false;
  const next: T[] = [];

  for (const item of local) {
    if (deleted.has(item.id)) {
      changed = true;
      continue;
    }
    const incoming = pending.get(item.id);
    if (!incoming) {
      next.push(item);
      continue;
    }
    pending.delete(item.id);
    if (shouldAdopt(item, incoming)) {
      next.push(incoming);
      changed = true;
    } else {
      next.push(item);
    }
  }

  // 远端新建、本地还没有的条目。
  for (const incoming of pending.values()) {
    next.push(incoming);
    changed = true;
  }

  return changed ? next : null;
}

/**
 * 收集 follower「自己拥有」且相对上次广播有变化的会话。
 * follower 只广播这部分 —— 它内存里的其余会话都是 owner 的副本，
 * 转发回去只会制造回声。
 */
export function collectOwnedSessionUpdates(
  ownedIds: Set<string>,
  sessions: ChatSession[],
  lastBroadcast: Map<string, ChatSession>
): ChatSession[] {
  const upserts: ChatSession[] = [];
  const seen = new Set<string>();

  for (const session of sessions) {
    if (!ownedIds.has(session.id)) continue;
    seen.add(session.id);
    const before = lastBroadcast.get(session.id);
    if (!before || !isSessionSynced(before, session)) {
      upserts.push(session);
    }
    lastBroadcast.set(session.id, session);
  }

  for (const id of [...lastBroadcast.keys()]) {
    if (!seen.has(id)) lastBroadcast.delete(id);
  }

  return upserts;
}

/** 广播一次同步增量。失败绝不打断调用方的状态流。 */
export function broadcastChatStorageSync(payload: ChatStorageSyncPayload) {
  if (!canUseTauriEvents()) return;
  try {
    void emit(CHAT_STORAGE_SYNC_EVENT, payload).catch(() => undefined);
  } catch {
    // 同步失败只影响另一窗口的实时性，不影响本地写入。
  }
}

/** 订阅其他窗口广播的同步增量。非 Tauri 环境返回空 unlisten。 */
export async function subscribeToChatStorageSync(
  handler: (payload: ChatStorageSyncPayload) => void
): Promise<UnlistenFn> {
  if (!canUseTauriEvents()) {
    return () => undefined;
  }
  return listen<ChatStorageSyncPayload>(CHAT_STORAGE_SYNC_EVENT, (event) => {
    const payload = event.payload;
    if (!payload || typeof payload.source !== "string") return;
    handler(payload);
  });
}
