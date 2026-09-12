import { describe, expect, it } from "vitest";
import { createChatSession, createCustomProject } from "./storage";
import {
  collectOwnedSessionUpdates,
  diffSyncCollection,
  isProjectSynced,
  isSessionSynced,
  mergeRemoteCollection,
  shouldAdoptRemoteProject,
  shouldAdoptRemoteSession,
} from "./crossWindowSync";
import type { ChatSession, Project } from "./types";

function makeSession(title: string, updatedAt: number): ChatSession {
  const session = createChatSession([{ role: "user" as const, content: title }], "project-a");
  return { ...session, id: `session-${title}`, title, updatedAt };
}

function makeProject(title: string, updatedAt: number): Project {
  const project = createCustomProject({ title });
  return { ...project, id: `project-${title}`, title, updatedAt };
}

describe("会话/项目同步判据", () => {
  it("内容一致时认定已同步（否则会把相同数据反复 setState 成新对象，形成回声）", () => {
    const before = makeSession("a", 100);
    expect(isSessionSynced(before, { ...before })).toBe(true);
    expect(isSessionSynced(before, { ...before, updatedAt: 101 })).toBe(false);
    expect(isSessionSynced(before, { ...before, title: "b" })).toBe(false);
    expect(isSessionSynced(before, { ...before, pinned: true })).toBe(false);
    expect(
      isSessionSynced(before, {
        ...before,
        messages: [...before.messages, { role: "project", content: "x" }],
      })
    ).toBe(false);
  });

  it("项目判据比对 id 白名单内容，而不是长度（同长度换成员必须能识别）", () => {
    const before = makeProject("p", 100);
    expect(isProjectSynced(before, { ...before })).toBe(true);
    expect(
      isProjectSynced(before, { ...before, allowedToolIds: [...before.allowedToolIds, "extra"] })
    ).toBe(false);
    expect(
      isProjectSynced(before, {
        ...before,
        allowedToolIds: ["only-one"],
      })
    ).toBe(false);
  });
});

describe("远端版本采纳判据", () => {
  it("updatedAt 更大者胜，更小者不采纳", () => {
    const local = makeSession("a", 100);
    expect(shouldAdoptRemoteSession(local, { ...local, updatedAt: 101 })).toBe(true);
    expect(shouldAdoptRemoteSession(local, { ...local, updatedAt: 99 })).toBe(false);
  });

  it("updatedAt 相等且字段一致时不采纳 —— 这是打断回声循环的关键", () => {
    const local = makeSession("a", 100);
    expect(shouldAdoptRemoteSession(local, { ...local })).toBe(false);
    // 相等但字段不同（改名 / 置顶 / 收藏这些不递增 updatedAt 的操作）要采纳。
    expect(shouldAdoptRemoteSession(local, { ...local, title: "b" })).toBe(true);
    expect(shouldAdoptRemoteProject(makeProject("p", 100), { ...makeProject("p", 100), title: "q" })).toBe(true);
  });
});

describe("diffSyncCollection", () => {
  it("首个游标为 null 时全部视为新增，且没有删除", () => {
    const a = makeSession("a", 1);
    const b = makeSession("b", 2);
    expect(diffSyncCollection(null, [a, b], isSessionSynced)).toEqual({
      upserts: [a, b],
      deletes: [],
    });
  });

  it("只报变化过的条目，消失的条目报删除", () => {
    const a1 = makeSession("a", 1);
    const b1 = makeSession("b", 1);
    const a2 = makeSession("a", 2);
    const delta = diffSyncCollection([a1, b1], [a2], isSessionSynced);
    expect(delta.upserts.map((session) => session.id)).toEqual(["session-a"]);
    expect(delta.deletes).toEqual(["session-b"]);
  });

  it("完全没变时不出增量", () => {
    const a = makeSession("a", 1);
    expect(diffSyncCollection([a], [{ ...a }], isSessionSynced)).toEqual({ upserts: [], deletes: [] });
  });
});

describe("mergeRemoteCollection", () => {
  it("远端与本地一致时返回 null（调用方据此跳过 setState，回声在此终止）", () => {
    const local = makeSession("a", 5);
    expect(
      mergeRemoteCollection([local], { upserts: [{ ...local }], deletes: [] }, shouldAdoptRemoteSession)
    ).toBeNull();
    expect(mergeRemoteCollection([local], { upserts: [], deletes: [] }, shouldAdoptRemoteSession)).toBeNull();
  });

  it("并入远端新建的会话（紧凑窗的宠物对话就是这样被主窗接管的）", () => {
    const local = makeSession("a", 1);
    const remote = makeSession("pet", 2);
    const merged = mergeRemoteCollection(
      [local],
      { upserts: [remote], deletes: [] },
      shouldAdoptRemoteSession
    );
    expect(merged?.map((session) => session.id)).toEqual(["session-a", "session-pet"]);
  });

  it("删除是终态：本地陈旧副本被移除后不会再被写回来", () => {
    const local = makeSession("a", 1);
    const merged = mergeRemoteCollection(
      [local],
      { upserts: [], deletes: ["session-a"] },
      shouldAdoptRemoteSession
    );
    expect(merged).toEqual([]);
  });

  it("更新的远端版本覆盖本地，更旧的远端版本被忽略（活跃流式会话不会被回退）", () => {
    const local = makeSession("a", 10);
    const newer = makeSession("a", 11);
    const older = makeSession("a", 9);
    expect(
      mergeRemoteCollection([local], { upserts: [newer], deletes: [] }, shouldAdoptRemoteSession)?.[0].updatedAt
    ).toBe(11);
    expect(
      mergeRemoteCollection([local], { upserts: [older], deletes: [] }, shouldAdoptRemoteSession)
    ).toBeNull();
  });

  it("多轮合并后收敛：第二轮必为 null（不会 A→B→A 无限回声）", () => {
    const ownerSessions = [makeSession("a", 1), makeSession("b", 2)];
    let follower: ChatSession[] = [makeSession("a", 1)];

    const first = mergeRemoteCollection(
      follower,
      { upserts: ownerSessions, deletes: [] },
      shouldAdoptRemoteSession
    );
    expect(first).not.toBeNull();
    follower = first!;

    const second = mergeRemoteCollection(
      follower,
      { upserts: ownerSessions, deletes: [] },
      shouldAdoptRemoteSession
    );
    expect(second).toBeNull();
  });
});

describe("collectOwnedSessionUpdates", () => {
  it("只广播自己拥有的会话，且内容没变时不重复广播", () => {
    const owned = makeSession("pet", 1);
    const foreign = makeSession("main-chat", 1);
    const last = new Map<string, ChatSession>();

    const first = collectOwnedSessionUpdates(new Set([owned.id]), [owned, foreign], last);
    expect(first.map((session) => session.id)).toEqual(["session-pet"]);

    const second = collectOwnedSessionUpdates(new Set([owned.id]), [{ ...owned }, foreign], last);
    expect(second).toEqual([]);

    const updated = { ...owned, updatedAt: 2, messages: [...owned.messages, { role: "project" as const, content: "hi" }] };
    const third = collectOwnedSessionUpdates(new Set([owned.id]), [updated, foreign], last);
    expect(third.map((session) => session.id)).toEqual(["session-pet"]);
  });

  it("自己拥有的会话被删除后，广播记录同步清理", () => {
    const owned = makeSession("pet", 1);
    const last = new Map<string, ChatSession>();
    collectOwnedSessionUpdates(new Set([owned.id]), [owned], last);
    expect(last.size).toBe(1);
    collectOwnedSessionUpdates(new Set([owned.id]), [], last);
    expect(last.size).toBe(0);
  });
});
