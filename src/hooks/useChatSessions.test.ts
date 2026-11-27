import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useChatSessions } from "./useChatSessions";

// 删除会话要过破坏性确认门；测试里直接放行，否则会走「无监听器默认拒绝」分支。
vi.mock("../chat/confirmationGate", () => ({
  requestConfirmation: vi.fn(async () => true),
}));

describe("useChatSessions", () => {
  it("同一事件内连续调用 updateChatSessionMessages 应基于最新状态链式叠加，而不是相互覆盖", () => {
    const { result } = renderHook(() => useChatSessions({ persist: false }));

    act(() => {
      result.current.createSessionFromMessages([{ role: "user", content: "hi" }]);
    });

    const sessionId = result.current.activeChatId;
    expect(sessionId).not.toBeNull();
    if (!sessionId) {
      throw new Error("会话创建失败：activeChatId 为空");
    }

    // 模拟流式期间工具调用：同一事件内先追加 running 步骤，再追加完成步骤
    act(() => {
      result.current.updateChatSessionMessages(sessionId, (messages) => {
        const last = messages[messages.length - 1];
        if (last.role !== "project") {
          return [...messages, { role: "project", content: "", steps: [] }];
        }
        return messages;
      });

      result.current.updateChatSessionMessages(sessionId, (messages) => {
        const last = messages[messages.length - 1];
        if (last.role !== "project") return messages;
        return [
          ...messages.slice(0, -1),
          {
            ...last,
            steps: [{ type: "tool_call" as const, name: "read_file", arguments: '{"path":"a.md"}', result: "", status: "running" as const }],
          },
        ];
      });

      result.current.updateChatSessionMessages(sessionId, (messages) => {
        const last = messages[messages.length - 1];
        if (last.role !== "project" || !last.steps) return messages;
        return [
          ...messages.slice(0, -1),
          {
            ...last,
            steps: last.steps.map((step) =>
              step.type === "tool_call" && step.name === "read_file"
                ? { type: "tool_call" as const, name: "read_file", arguments: step.arguments, result: "文件内容" }
                : step
            ),
          },
        ];
      });
    });

    const session = result.current.chatSessions.find((s) => s.id === sessionId);
    expect(session).toBeDefined();
    const lastMessage = session!.messages[session!.messages.length - 1];
    expect(lastMessage.role).toBe("project");
    expect(lastMessage.steps).toHaveLength(1);
    expect(lastMessage.steps?.[0]).toMatchObject({
      type: "tool_call",
      name: "read_file",
      result: "文件内容",
    });
    // 关键断言：status 不是 running/interrupted，说明链式更新成功，没有因旧 ref 覆盖导致 running 残留
    expect((lastMessage.steps?.[0] as { status?: string }).status).toBeUndefined();
  });

  it("会话不存在时 updateChatSessionMessages 不得凭空重建会话（复活路径之一）", () => {
    const { result } = renderHook(() => useChatSessions({ persist: false }));

    act(() => {
      result.current.createSessionFromMessages([{ role: "user", content: "hi" }]);
    });
    const sessionId = result.current.activeChatId;
    expect(sessionId).not.toBeNull();
    if (!sessionId) throw new Error("会话创建失败：activeChatId 为空");

    // 模拟「删除后仍有在飞的流式回调」：先删掉会话，再让回调写入。
    act(() => {
      result.current.setChatSessions([]);
    });
    act(() => {
      result.current.updateChatSessionMessages(sessionId, (messages) => [
        ...messages,
        { role: "project", content: "迟到的流式内容" },
      ]);
    });

    expect(result.current.chatSessions.find((session) => session.id === sessionId)).toBeUndefined();
    expect(result.current.chatSessions).toHaveLength(0);
  });

  it("没有项目时仍保存会话摘要，并且不创建项目记忆", () => {
    const { result } = renderHook(() => useChatSessions({ persist: false }));
    let sessionId = "";

    act(() => {
      sessionId = result.current.createSessionFromMessages([{ role: "user", content: "继续这个话题" }]).id;
      result.current.setProjects([]);
    });
    act(() => {
      result.current.commitConversationContext(sessionId, [
        { role: "user", content: "继续这个话题" },
        { role: "project", content: "这是回答" },
      ], {
        content: "这是回答",
        suggestedSummary: { title: "话题进展", summary: "已讨论到回答内容" },
        suggestedMemories: [{ content: "用户偏好中文", reason: "稳定偏好" }],
      } as never);
    });

    expect(result.current.getRelatedContextForProject("已讨论到回答内容").summaries).toContainEqual(expect.objectContaining({
      sessionId,
      projectId: null,
      title: "话题进展",
      summary: "已讨论到回答内容",
    }));
  });

  it("项目记忆范围关闭时仍更新会话摘要，但不写入自动记忆", () => {
    const { result } = renderHook(() => useChatSessions({ persist: false }));
    let sessionId = "";
    act(() => {
      sessionId = result.current.createSessionFromMessages([{ role: "user", content: "继续项目工作" }]).id;
    });
    const project = result.current.projects[0];

    act(() => {
      result.current.setProjects([{ ...project, memoryScope: "off" }]);
    });
    act(() => {
      result.current.commitConversationContext(sessionId, [
        { role: "user", content: "继续项目工作" },
        { role: "project", content: "回答" },
      ], {
        content: "回答",
        suggestedSummary: { summary: "项目会话摘要" },
        suggestedMemories: [{ content: "项目内部约定", reason: null }],
      } as never);
    });

    act(() => {
      result.current.setProjects([{ ...project, memoryScope: "session" }]);
    });
    const context = result.current.getRelatedContextForProject("项目会话摘要");
    expect(context.summaries).toContainEqual(expect.objectContaining({ summary: "项目会话摘要" }));
    expect(result.current.getProjectMemories(project.id)).toHaveLength(0);
  });
});
