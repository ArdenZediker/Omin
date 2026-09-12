import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSessions } from "./useChatSessions";
import {
  loadPersistedChatState,
  savePersistedAutomationState,
  savePersistedChatSessions,
  savePersistedChatState,
  savePersistedMemoryState,
} from "../chat/persistence";
import type {
  ChatSession,
  Project,
  ProjectMemoryRecord,
  ScheduledTaskRecord,
  SessionSummaryRecord,
  UserPreferenceRecord,
} from "../chat/types";

/**
 * 持久化角色（owner / follower）的行为锁。
 *
 * 背景：主窗与紧凑窗是两个独立 webview，各自跑一份 useChatSessions。若两边都用整快照
 * 落盘（`save_chat_storage` 是整表覆盖 + 删掉快照外的行），后写者会覆盖先写者 ——
 * 表现为「删掉的会话自己又回来」。因此 follower 只允许**窄写自己拥有的会话**。
 */
vi.mock("../chat/persistence", () => ({
  loadPersistedChatState: vi.fn(async () => ({
    projects: [] as Project[],
    sessions: [] as ChatSession[],
    projectMemories: [] as ProjectMemoryRecord[],
    sessionSummaries: [] as SessionSummaryRecord[],
    userPreferences: [] as UserPreferenceRecord[],
    scheduledTasks: [] as ScheduledTaskRecord[],
  })),
  savePersistedChatState: vi.fn(async (_projects: Project[], _sessions: ChatSession[]) => undefined),
  savePersistedChatSessions: vi.fn(async (_sessions: ChatSession[]) => undefined),
  savePersistedMemoryState: vi.fn(
    async (
      _memories: ProjectMemoryRecord[],
      _summaries: SessionSummaryRecord[],
      _preferences: UserPreferenceRecord[]
    ) => undefined
  ),
  savePersistedAutomationState: vi.fn(async (_tasks: ScheduledTaskRecord[]) => undefined),
}));

vi.mock("../chat/confirmationGate", () => ({
  requestConfirmation: vi.fn(async () => true),
}));

/** 等过 260ms 防抖，让一次状态变更真正落盘。 */
async function settlePersist() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
}

describe("useChatSessions 持久化角色", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("follower（紧凑窗）只窄写自己拥有的会话，绝不整快照覆盖", async () => {
    const { result } = renderHook(() => useChatSessions({ persist: true, role: "follower" }));

    // 等 hydration 落地（follower 同样要读，否则重启后找不到自己的宠物会话）。
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      result.current.createSessionFromMessages([{ role: "user", content: "宠物对话" }]);
    });
    await settlePersist();

    expect(savePersistedChatSessions).toHaveBeenCalledTimes(1);
    const [narrowSessions] = vi.mocked(savePersistedChatSessions).mock.calls[0];
    expect(narrowSessions.map((session) => session.id)).toEqual([result.current.chatSessions[0].id]);

    expect(savePersistedChatState).not.toHaveBeenCalled();
    expect(savePersistedMemoryState).not.toHaveBeenCalled();
    expect(savePersistedAutomationState).not.toHaveBeenCalled();
  });

  it("owner（主窗）走整快照落盘，不调窄写命令", async () => {
    const { result } = renderHook(() => useChatSessions({ persist: true }));

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      result.current.createSessionFromMessages([{ role: "user", content: "主窗对话" }]);
    });
    await settlePersist();

    expect(savePersistedChatState).toHaveBeenCalledTimes(1);
    expect(savePersistedMemoryState).toHaveBeenCalledTimes(1);
    expect(savePersistedAutomationState).toHaveBeenCalledTimes(1);
    expect(savePersistedChatSessions).not.toHaveBeenCalled();
  });

  it("删除会话时一并清掉它的摘要记录（否则摘要会继续被当作上下文喂回模型）", async () => {
    const { result } = renderHook(() => useChatSessions({ persist: false, role: "owner" }));

    let sessionId = "";
    act(() => {
      sessionId = result.current.createSessionFromMessages([{ role: "user", content: "hi" }]).id;
    });
    act(() => {
      result.current.setSessionSummaries([
        { sessionId, projectId: "project-a", title: "t", summary: "该删的摘要", updatedAt: 1 },
        { sessionId: "other-session", projectId: "project-a", title: "t2", summary: "该留的摘要", updatedAt: 2 },
      ]);
    });

    await act(async () => {
      await result.current.deleteChatSession(sessionId);
    });

    expect(result.current.chatSessions.find((session) => session.id === sessionId)).toBeUndefined();

    const memoryCalls = vi.mocked(savePersistedMemoryState).mock.calls;
    expect(memoryCalls.length).toBeGreaterThan(0);
    const persistedSummaries = memoryCalls[memoryCalls.length - 1][1];
    expect(persistedSummaries.map((summary) => summary.sessionId)).toEqual(["other-session"]);
  });

  it("hydration 失败时不得把空回退状态写回（否则会清空库里已有的会话）", async () => {
    vi.mocked(loadPersistedChatState).mockRejectedValueOnce(new Error("load failed"));

    const { result } = renderHook(() => useChatSessions({ persist: true }));

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      result.current.createSessionFromMessages([{ role: "user", content: "hi" }]);
    });
    await settlePersist();

    expect(savePersistedChatState).not.toHaveBeenCalled();
    expect(savePersistedChatSessions).not.toHaveBeenCalled();
  });
});
