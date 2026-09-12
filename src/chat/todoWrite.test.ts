import { beforeEach, describe, expect, it } from "vitest";
import {
  TODO_FALLBACK_SESSION_KEY,
  TODO_MAX_CONTENT_CHARS,
  TODO_MAX_ITEMS,
  clearAllSessionTodos,
  getSessionTodos,
  parseTodos,
  renderTodoList,
  setSessionTodos,
} from "./todoWrite";

function todo(id: string, content: string, status = "pending") {
  return { id, content, status };
}

describe("parseTodos", () => {
  it("解析合法清单并保留顺序", () => {
    const result = parseTodos([todo("1", "读配置"), todo("2", "改逻辑", "in_progress")]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.todos).toHaveLength(2);
    expect(result.todos[1].status).toBe("in_progress");
    expect(result.warnings).toEqual([]);
  });

  it("空数组表示清空", () => {
    const result = parseTodos([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.todos).toEqual([]);
  });

  it("非数组 / 缺字段 / 非法 status 一律报错而不是静默修正", () => {
    expect(parseTodos("nope").ok).toBe(false);
    expect(parseTodos([{ content: "x", status: "pending" }]).ok).toBe(false);
    expect(parseTodos([todo("1", "")]).ok).toBe(false);
    expect(parseTodos([todo("1", "x", "done")]).ok).toBe(false);
    expect(parseTodos([1, 2]).ok).toBe(false);
    const missing = parseTodos([{ content: "x", status: "pending" }]);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("id");
  });

  it("超条目上限与超长 content 直接报错（模型可控，报错比截断更能收敛行为）", () => {
    const tooMany = parseTodos(
      Array.from({ length: TODO_MAX_ITEMS + 1 }, (_, i) => todo(String(i), `第 ${i} 步`)),
    );
    expect(tooMany.ok).toBe(false);

    const tooLong = parseTodos([todo("1", "x".repeat(TODO_MAX_CONTENT_CHARS + 1))]);
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.error).toContain("content 过长");
  });

  it("同时进行中超过一条时只保留第一条，其余降级为 pending 并给出警告", () => {
    const result = parseTodos([
      todo("1", "先做这个", "in_progress"),
      todo("2", "再偷偷做这个", "in_progress"),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.todos[0].status).toBe("in_progress");
    expect(result.todos[1].status).toBe("pending");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("降级");
  });

  it("id 重复只警告不报错（不擅自去重）", () => {
    const result = parseTodos([todo("1", "a"), todo("1", "b")]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings[0]).toContain("id 重复");
  });
});

describe("renderTodoList", () => {
  it("渲染进度统计与三种状态标记", () => {
    const text = renderTodoList([
      { id: "1", content: "读配置", status: "completed" },
      { id: "2", content: "改逻辑", status: "in_progress" },
      { id: "3", content: "跑测试", status: "pending" },
    ]);
    expect(text).toContain("任务清单（1/3 已完成 · 进行中 1 · 待办 1）");
    expect(text).toContain("1. [x] 读配置");
    expect(text).toContain("2. [>] 改逻辑");
    expect(text).toContain("3. [ ] 跑测试");
  });

  it("空清单给出明确的清空文案", () => {
    expect(renderTodoList([])).toBe("任务清单已清空。");
  });
});

describe("会话级存储", () => {
  beforeEach(() => {
    clearAllSessionTodos();
  });

  it("按会话隔离，互不影响", () => {
    const a = [{ id: "1", content: "A 的事", status: "pending" as const }];
    const b = [{ id: "1", content: "B 的事", status: "completed" as const }];
    setSessionTodos("session-a", a);
    setSessionTodos("session-b", b);
    expect(getSessionTodos("session-a")).toEqual(a);
    expect(getSessionTodos("session-b")).toEqual(b);
    expect(getSessionTodos("session-c")).toEqual([]);
  });

  it("写入空数组等于删除该会话的清单", () => {
    setSessionTodos(TODO_FALLBACK_SESSION_KEY, [{ id: "1", content: "临时", status: "pending" }]);
    expect(getSessionTodos(TODO_FALLBACK_SESSION_KEY)).toHaveLength(1);
    setSessionTodos(TODO_FALLBACK_SESSION_KEY, []);
    expect(getSessionTodos(TODO_FALLBACK_SESSION_KEY)).toEqual([]);
  });
});
