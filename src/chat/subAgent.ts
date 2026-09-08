import type { ChatToolCall, ChatToolParam, Message } from "../adapters/types";
import { executeChatTurn, type ToolCallOutcome } from "./engine";
import type { ChatStep, Project } from "./types";

/**
 * 子 Agent 调度（对齐 Codex/Claude Code 的 Task 工具形态）：
 * 主模型通过 `agent` 工具把一个独立、自包含的只读调研子任务委派给子 Agent。
 * 子 Agent 拥有全新上下文（不带主对话历史）+ 只读工具白名单，跑完一轮
 * executeChatTurn 后把最终报告作为工具结果回填给主循环。
 *
 * 安全边界：
 * - 工具白名单只含只读工具（搜索/读取/联网/git 查看），无写文件、无 bash、无安装类；
 * - 白名单与父运行已启用工具取交集——父会话没启用的只读工具子 Agent 也用不了；
 * - 深度守卫：子 Agent 内再发起 agent 调用会被拒绝（MAX_SUB_AGENT_DEPTH=1）；
 * - 回填报告超长时截断，保护主循环上下文预算。
 */

/** 子 Agent 可用的只读工具白名单（按工具名匹配，不含任何写操作）。 */
export const SUB_AGENT_TOOL_IDS = [
  "search_sessions",
  "read_session",
  "list_files",
  "read_file",
  "search_files",
  "web_search",
  "web_fetch",
  "git_info",
] as const;

/** 子 Agent 最大嵌套深度：只允许主循环派出一层。 */
export const MAX_SUB_AGENT_DEPTH = 1;

/** 子 Agent 报告回填主循环的最大字符数（超出截断，保护主上下文预算）。 */
export const MAX_SUB_AGENT_OUTPUT_CHARS = 12000;

const SUB_AGENT_SYSTEM_PROMPT = [
  "你是 Omni 的子 Agent（只读调研员），由主 Agent 通过 agent 工具派出，负责完成一个独立、自包含的调研任务。",
  "",
  "规则：",
  "- 你只能使用只读工具（搜索/读取文件、联网搜索/抓取、git 信息查看），没有任何写入或执行命令的能力。",
  "- 你看不到主对话的任何历史；任务的全部背景都在用户消息里。若任务描述信息不足，基于现有信息尽力完成，并在报告中注明所做假设。",
  "- 围绕任务目标直接行动：多用工具查证，不要反问、不要寒暄。",
  "- 最终输出一份紧凑的调查报告（Markdown，建议 2000 字以内）：结论先行，附关键证据（文件路径+行号、链接、命令输出摘录）。不要输出与任务无关的内容。",
].join("\n");

/** 模块级深度计数：同一 JS 运行时内所有子 Agent 运行共享（防嵌套 + 便于测试）。 */
let activeSubAgentRuns = 0;

/** 当前是否有子 Agent 正在运行（测试与运行时诊断用）。 */
export function isSubAgentActive(): boolean {
  return activeSubAgentRuns > 0;
}

/**
 * 宽容解析 agent 工具入参：
 * 1. {"task": "..."} → 取 task；
 * 2. 纯 JSON 字符串 → 整段作为任务；
 * 3. 非 JSON 文本 → 整段作为任务描述；
 * 缺失有效任务时返回 error。
 */
export function parseSubAgentArgs(raw: string): { task: string } | { error: string } {
  const missing = "缺少 task 参数：请传入完整、自包含的子任务描述";
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { error: missing };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "string") {
      const text = parsed.trim();
      return text ? { task: text } : { error: missing };
    }
    if (parsed && typeof parsed === "object") {
      const task = (parsed as Record<string, unknown>).task;
      if (typeof task === "string" && task.trim()) {
        return { task: task.trim() };
      }
    }
    return { error: missing };
  } catch {
    // 非 JSON：整段文本当作任务描述（宽容解析）
    return { task: trimmed };
  }
}

/** 过滤出子 Agent 可用工具：只读白名单 ∩ 父运行已启用工具（MCP 与写类工具一律排除）。 */
export function filterSubAgentTools(parentTools: ChatToolParam[]): ChatToolParam[] {
  const whitelist = new Set<string>(SUB_AGENT_TOOL_IDS);
  return parentTools.filter((tool) => whitelist.has(tool.name));
}

/** 报告超长截断（保护主循环上下文预算）。 */
export function truncateSubAgentOutput(text: string): string {
  if (text.length <= MAX_SUB_AGENT_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_SUB_AGENT_OUTPUT_CHARS)}\n\n（报告过长，已截断至 ${MAX_SUB_AGENT_OUTPUT_CHARS} 字符）`;
}

/** 子 Agent 运行所需的父运行上下文（由运行时在每轮任务开始时注入）。 */
export type SubAgentRunContext = {
  model: string;
  project?: Project | null;
  /** 父运行的完整工具声明集（runSubAgent 内部自行过滤白名单） */
  tools: ChatToolParam[];
  /** 父运行的工具执行器（子 Agent 复用同一执行器，只读工具天然免确认） */
  executeToolCall: (toolCall: ChatToolCall) => Promise<string | ToolCallOutcome>;
  signal?: AbortSignal;
  onToolStep?: (step: ChatStep) => void;
};

function summarizeTask(task: string): string {
  return task.length > 80 ? `${task.slice(0, 77)}...` : task;
}

/**
 * 运行一次子 Agent：独立上下文 + 只读工具白名单执行委派任务，返回回填给主循环的报告文本。
 * 永不抛异常（除中止信号透传外），失败以错误文本返回，保证主工具循环收敛。
 */
export async function runSubAgent(options: {
  args: string;
  context: SubAgentRunContext;
}): Promise<{ outputText: string }> {
  const { args, context } = options;
  if (activeSubAgentRuns >= MAX_SUB_AGENT_DEPTH) {
    return { outputText: "嵌套调用被拒绝：子 Agent 内不能再派出子 Agent。请直接完成调研并汇报。" };
  }

  const parsed = parseSubAgentArgs(args);
  if ("error" in parsed) {
    return { outputText: parsed.error };
  }

  const tools = filterSubAgentTools(context.tools);
  if (tools.length === 0) {
    return {
      outputText:
        "子 Agent 无可用工具：当前会话未启用任何只读工具（list_files/read_file/search_files/web_search 等），无法委派任务。",
    };
  }

  const { model, project, executeToolCall, signal, onToolStep } = context;
  activeSubAgentRuns += 1;
  onToolStep?.({
    type: "action",
    label: "派出子Agent",
    title: "Sub Agent",
    icon: "Bot",
    detail: summarizeTask(parsed.task),
  });

  try {
    const result = await executeChatTurn({
      model,
      messages: [{ role: "user", content: parsed.task } satisfies Message],
      signal,
      systemPrompt: SUB_AGENT_SYSTEM_PROMPT,
      project: project ?? null,
      tools,
      executeToolCall,
      onToolStep,
      // 子 Agent 保持精简：无知识检索、无记忆/摘要抽取、无结构化输出协议
      enableKnowledgeContext: false,
      enableMemoryExtraction: false,
      enableSummaryExtraction: false,
      enableToolProtocol: false,
    });

    const report = result.content?.trim() || "";
    if (!report) {
      onToolStep?.({ type: "action", label: "子Agent完成", title: "Sub Agent", icon: "Bot", detail: "未返回有效报告" });
      return { outputText: "子 Agent 未返回有效报告，请直接自行完成该子任务。" };
    }
    const rounds = typeof result.toolRounds === "number" ? result.toolRounds : 0;
    onToolStep?.({
      type: "action",
      label: "子Agent完成",
      title: "Sub Agent",
      icon: "Bot",
      detail: `${rounds} 轮工具调用，报告 ${truncateSubAgentOutput(report).length} 字符`,
    });
    return { outputText: `子 Agent 报告（${rounds} 轮工具调用）：\n\n${truncateSubAgentOutput(report)}` };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    return {
      outputText: `子 Agent 执行失败：${error instanceof Error ? error.message : String(error)}。请直接自行完成该子任务。`,
    };
  } finally {
    activeSubAgentRuns -= 1;
  }
}
