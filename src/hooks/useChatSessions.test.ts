import { renderHook, act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useChatSessions } from "./useChatSessions";

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
});
