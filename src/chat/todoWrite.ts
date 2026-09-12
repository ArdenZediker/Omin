/**
 * 会话级任务清单（/todo_write）。
 *
 * 定位：**只跟踪执行进度**，不做计划拆解（那是 `/plan` 技能的职责）。
 * 与 codex 的 `update_plan` 同语义 —— 清单活在对话上下文里，**不落盘**，
 * 应用重启即清空；跨轮次的一致性由会话级内存 store 保证。
 *
 * 之所以单独抽成纯函数模块：解析/校验/渲染都不依赖 Tauri 与注册表，
 * 可以脱离 mock 直接单测；`localTools.ts` 里的执行器只负责接参数与取会话 id。
 */

export type TodoStatus = "pending" | "in_progress" | "completed";

export type TodoItem = {
  id: string;
  content: string;
  status: TodoStatus;
};

/** 单条上限：防止模型把整篇计划塞进来撑爆上下文。 */
export const TODO_MAX_ITEMS = 20;
export const TODO_MAX_CONTENT_CHARS = 200;

const VALID_STATUS: TodoStatus[] = ["pending", "in_progress", "completed"];

export type ParseTodosResult =
  | { ok: true; todos: TodoItem[]; warnings: string[] }
  | { ok: false; error: string };

/**
 * 解析并规范化模型传来的 todos 数组。
 *
 * 契约：
 * - `todos` 必须是数组，缺字段 / 非法 status / 超限一律**报错**（模型可控，报错比静默修正更能收敛行为）；
 * - 唯一的例外是「多个 in_progress」：它有唯一合理修法（保留第一个，其余降级 pending），
 *   降级并通过 warnings 明说，而不是让调用失败。
 */
export function parseTodos(raw: unknown): ParseTodosResult {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "参数错误：todos 必须是数组（如 [{\"id\":\"1\",\"content\":\"...\",\"status\":\"pending\"}]）" };
  }
  if (raw.length > TODO_MAX_ITEMS) {
    return { ok: false, error: `任务过多：${raw.length} 条，上限 ${TODO_MAX_ITEMS} 条。请合并步骤。` };
  }

  const warnings: string[] = [];
  const todos: TodoItem[] = [];
  const seenIds = new Set<string>();
  let inProgressKept = false;

  for (const [index, entry] of raw.entries()) {
    const where = `第 ${index + 1} 条`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: `参数错误：${where}必须是对象 {id, content, status}` };
    }
    const { id, content, status } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !id.trim()) {
      return { ok: false, error: `参数错误：${where}缺少 id（字符串，跨次调用保持稳定）` };
    }
    if (typeof content !== "string" || !content.trim()) {
      return { ok: false, error: `参数错误：${where}缺少 content（本步要做什么）` };
    }
    if (content.length > TODO_MAX_CONTENT_CHARS) {
      return {
        ok: false,
        error: `参数错误：${where}content 过长（${content.length} 字符，上限 ${TODO_MAX_CONTENT_CHARS}）。请精简为一句可验证的话。`,
      };
    }
    if (typeof status !== "string" || !VALID_STATUS.includes(status as TodoStatus)) {
      return {
        ok: false,
        error: `参数错误：${where}status 非法：${String(status)}（可选 pending / in_progress / completed）`,
      };
    }

    if (seenIds.has(id)) warnings.push(`id 重复：${id}`);
    seenIds.add(id);

    let finalStatus = status as TodoStatus;
    if (finalStatus === "in_progress") {
      if (inProgressKept) {
        finalStatus = "pending";
        warnings.push(`同时进行中的任务超过 1 个，已把「id=${id}」降级为 pending`);
      } else {
        inProgressKept = true;
      }
    }
    todos.push({ id, content: content.trim(), status: finalStatus });
  }

  return { ok: true, todos, warnings };
}

/** 把清单渲染成模型与用户都好读的文本（含进度统计）。 */
export function renderTodoList(todos: TodoItem[]): string {
  if (todos.length === 0) return "任务清单已清空。";

  const completed = todos.filter((item) => item.status === "completed").length;
  const inProgress = todos.filter((item) => item.status === "in_progress").length;
  const pending = todos.length - completed - inProgress;

  const lines = todos.map((item, index) => {
    const mark = item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[>]" : "[ ]";
    return `${index + 1}. ${mark} ${item.content}`;
  });

  return [
    `任务清单（${completed}/${todos.length} 已完成 · 进行中 ${inProgress} · 待办 ${pending}）`,
    ...lines,
  ].join("\n");
}

/**
 * 会话级清单存储。
 * 只在内存里：与 codex 的 plan 一样随会话走，重启即空 —— 刻意不落盘，
 * 避免为「临时进度」引入一条新的写盘路径与 HITL 确认门。
 */
const sessionTodos = new Map<string, TodoItem[]>();

/** 无会话上下文时的兜底 key（例如用户手敲斜杠命令）。 */
export const TODO_FALLBACK_SESSION_KEY = "__no_session__";

export function setSessionTodos(sessionKey: string, todos: TodoItem[]): void {
  if (todos.length === 0) {
    sessionTodos.delete(sessionKey);
    return;
  }
  sessionTodos.set(sessionKey, todos);
}

export function getSessionTodos(sessionKey: string): TodoItem[] {
  return sessionTodos.get(sessionKey) ?? [];
}

/** 清空全部会话的清单（测试与会话切换兜底用）。 */
export function clearAllSessionTodos(): void {
  sessionTodos.clear();
}
