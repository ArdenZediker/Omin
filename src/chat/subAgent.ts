import type { ChatToolCall, ChatToolParam, Message } from "../adapters/types";
import { executeChatTurn, type ToolCallOutcome } from "./engine";
import type { ChatStep, Project } from "./types";
import type { PluginManifest } from "../plugins/types";
import { canDelegateExpert } from "./expertDelegation";
import { selectExpertTools } from "./expertTools";
import { headTailClip } from "./textClip";

/**
 * 子 Agent 调度（对齐 Codex/Claude Code 的 Task 工具形态）：
 * 主模型通过 `agent` 工具把独立、自包含的调研子任务委派给子 Agent。
 * 子 Agent 拥有全新上下文（不带主对话历史），跑完一轮 executeChatTurn 后
 * 把最终报告作为工具结果回填给主循环。
 *
 * 两种入参形态：
 * - 单任务：{task, expertId?}（缺省只读调研员；带 expertId 委派给专家）；
 * - 并行批量：{tasks: [{task, expertId?}, ...]}（上限 MAX_SUB_AGENT_BATCH），
 *   全部子任务 Promise.all 并行执行，汇总为分节报告 + 聚合用量。
 *
 * 安全边界：
 * - 工具集 = 白名单/专家声明 ∩ 父运行已启用工具——父会话没启用的子 Agent 也用不了；
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

/** 单次 agent 调用最多并行派发的子任务数（超出引导模型拆分为多次调用）。 */
export const MAX_SUB_AGENT_BATCH = 5;

/** 子 Agent 报告回填主循环的最大字符数（超出截断，保护主上下文预算）。 */
export const MAX_SUB_AGENT_OUTPUT_CHARS = 12000;

/** 子 Agent 强弱档：fast=轻量低成本（通用只读调研），capable=能力强（专家委派/复杂任务）。 */
export type SubAgentTier = "fast" | "capable";

/** 单个子任务规格。 */
export type SubAgentTaskSpec = { task: string; expertId?: string; tier?: SubAgentTier };

/** runSubAgent 的返回：报告文本 + 可选的用量/轮数（ToolCallOutcome.usage/toolRounds 透传）。 */
export type SubAgentResult = {
  outputText: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number; estimated?: boolean };
  toolRounds?: number;
};

const SUB_AGENT_RESEARCH_PROMPT = [
  "你是 Omni 的子 Agent（只读调研员），由主 Agent 通过 agent 工具派出，负责完成一个独立、自包含的调研任务。",
  "",
  "规则：",
  "- 你只能使用只读工具（搜索/读取文件、联网搜索/抓取、git 信息查看），没有任何写入或执行命令的能力。",
  "- 你看不到主对话的任何历史；任务的全部背景都在用户消息里。若任务描述信息不足，基于现有信息尽力完成，并在报告中注明所做假设。",
  "- 围绕任务目标直接行动：多用工具查证，不要反问、不要寒暄。",
  "- 最终输出一份紧凑的调查报告（Markdown，建议 2000 字以内）：结论先行，附关键证据（文件路径+行号、链接、命令输出摘录）。不要输出与任务无关的内容。",
].join("\n");

/** 专家子 Agent 的通用运行规则（叠加在专家 templatePrompt 之后）。 */
const SUB_AGENT_EXPERT_RULES = [
  "",
  "---",
  "",
  "子 Agent 运行规则（由 Omni 追加）：",
  "- 你由主 Agent 通过 agent 工具派出，看不到主对话历史；任务的全部背景都在用户消息里。若任务描述信息不足，基于现有信息尽力完成，并在报告中注明所做假设。",
  "- 你的能力以「可用工具/技能」为准：写入/导出类操作会由系统弹出用户确认，被拒绝时如实报告并继续其余工作。",
  "- 围绕任务目标直接行动：多用工具查证，不要反问、不要寒暄。",
  "- 最终输出一份紧凑的报告（Markdown，建议 2000 字以内）：结论先行，附关键证据；交付文件时报告文件路径。",
].join("\n");

/** 模块级深度计数：同一 JS 运行时内所有子 Agent 运行共享（防嵌套 + 便于测试）。 */
let activeSubAgentRuns = 0;

/** 当前是否有子 Agent 正在运行（测试与运行时诊断用）。 */
export function isSubAgentActive(): boolean {
  return activeSubAgentRuns > 0;
}

/**
 * 宽容解析 agent 工具入参（单任务形态）：
 * 1. {"task":"...","expertId":"..."} → 取 task / expertId；
 * 2. 纯 JSON 字符串 / 非 JSON 文本 → 整段作为任务（无专家）；
 * 缺失有效任务时返回 error。
 */
export function parseSubAgentArgs(raw: string): { task: string; expertId?: string; tier?: SubAgentTier } | { error: string } {
  const parsed = parseSubAgentBatchArgs(raw);
  if ("error" in parsed) return parsed;
  const first = parsed.tasks[0];
  return { task: first.task, expertId: first.expertId, tier: first.tier };
}

/**
 * 宽容解析 agent 工具入参（支持并行批量形态）：
 * 1. {"tasks":[{task, expertId?}, ...]} → 并行派发多个子任务（上限 MAX_SUB_AGENT_BATCH）；
 * 2. {"task":"...","expertId":"..."} / 纯 JSON 字符串 / 非 JSON 文本 → 包装为单任务。
 */
export function parseSubAgentBatchArgs(raw: string): { tasks: SubAgentTaskSpec[] } | { error: string } {
  const missing = "缺少 task 参数：请传入完整、自包含的子任务描述，或用 tasks 数组并行派发多个子任务";
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { error: missing };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // 非 JSON：整段文本当作任务描述（宽容解析）
    return { tasks: [{ task: trimmed }] };
  }

  if (typeof parsed === "string") {
    const text = parsed.trim();
    return text ? { tasks: [{ task: text }] } : { error: missing };
  }

  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    // 并行批量形态：{tasks: [...]}
    if (Array.isArray(record.tasks)) {
      const specs: SubAgentTaskSpec[] = [];
      for (const item of record.tasks) {
        if (typeof item === "string" && item.trim()) {
          specs.push({ task: item.trim() });
          continue;
        }
        if (item && typeof item === "object") {
          const entry = item as Record<string, unknown>;
          const task = entry.task;
          if (typeof task === "string" && task.trim()) {
            const expertId = typeof entry.expertId === "string" && entry.expertId.trim() ? entry.expertId.trim() : undefined;
            const tier = parseSubAgentTier(entry.tier);
            specs.push({ task: task.trim(), expertId, tier });
            continue;
          }
        }
        return { error: "tasks 数组中存在无效条目：每项需为任务描述字符串或 {task, expertId?} 对象" };
      }
      if (specs.length === 0) return { error: missing };
      if (specs.length > MAX_SUB_AGENT_BATCH) {
        return { error: `单次最多并行派发 ${MAX_SUB_AGENT_BATCH} 个子任务（当前 ${specs.length} 个），请拆分为多次调用。` };
      }
      return { tasks: specs };
    }
    // 单任务形态 {task, expertId?, tier?}
    const task = record.task;
    if (typeof task === "string" && task.trim()) {
      const expertId = typeof record.expertId === "string" && record.expertId.trim() ? record.expertId.trim() : undefined;
      const tier = parseSubAgentTier(record.tier);
      return { tasks: [{ task: task.trim(), expertId, tier }] };
    }
  }
  return { error: missing };
}

/** 过滤出子 Agent 可用工具：只读白名单 ∩ 父运行已启用工具（MCP 与写类工具一律排除）。 */
export function filterSubAgentTools(parentTools: ChatToolParam[]): ChatToolParam[] {
  const whitelist = new Set<string>(SUB_AGENT_TOOL_IDS);
  return parentTools.filter((tool) => whitelist.has(tool.name));
}

/**
 * 报告超长截断（保护主循环上下文预算）。
 *
 * 采用 head + tail 而不是只留开头：子 Agent 的报告结构是「过程在前、**结论与建议在后**」，
 * 只留 head 恰好把主 Agent 最需要的结论砍掉，回填的是一份没有答案的调研过程。
 */
export function truncateSubAgentOutput(text: string): string {
  const { text: clipped, clipped: didClip, omitted } = headTailClip(text, MAX_SUB_AGENT_OUTPUT_CHARS);
  if (!didClip) return text;
  return `${clipped}\n\n（报告过长，已省略中间 ${omitted} 字符，保留开头与结尾；如需完整内容请让子 Agent 分节输出）`;
}

/**
 * 解析 agent 工具入参里的 tier 字段（宽容）：仅接受 "fast" / "capable"，
 * 其余（缺失、大小写/空白异常、未知值）一律视为 undefined（走自动路由）。
 */
export function parseSubAgentTier(value: unknown): SubAgentTier | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "fast") return "fast";
  if (normalized === "capable") return "capable";
  return undefined;
}

/**
 * 按强弱路由解析子 Agent 实际使用的模型 id（对齐 atomcode SubagentProvider 的 fast/capable 分层）：
 * - 自动路由（tier 未指定）：专家委派（expertId 存在）→ capable 档；通用只读调研 → fast 档；
 * - capable 档：优先用 context.capableModel，未配置则回落本轮主运行模型；
 * - fast 档：优先用 context.fastModel，未配置则回落 capableModel，再回落主运行模型。
 * 任何档位最终都保证返回一个可用模型（主运行模型是兜底层）。
 */
export function resolveSubAgentModel(
  context: Pick<SubAgentRunContext, "model"> & Partial<Pick<SubAgentRunContext, "capableModel" | "fastModel">>,
  spec: SubAgentTaskSpec
): string {
  const tier: SubAgentTier = spec.tier ?? (spec.expertId ? "capable" : "fast");
  if (tier === "capable") {
    return context.capableModel?.trim() || context.model;
  }
  return context.fastModel?.trim() || context.capableModel?.trim() || context.model;
}

/** 子 Agent 运行所需的父运行上下文（由运行时在每轮任务开始时注入）。 */
export type SubAgentRunContext = {
  /** 本轮主运行模型：tier 未单独配置时的最终兜底。 */
  model: string;
  /** 能力强档模型（专家委派 / tier=capable）。留空回落 model。 */
  capableModel?: string;
  /** 轻量档模型（通用只读调研 / tier=fast）。留空回落 capableModel → model。 */
  fastModel?: string;
  project?: Project | null;
  /** 父运行的完整工具声明集（runSubAgent 内部按白名单或专家声明过滤） */
  tools: ChatToolParam[];
  /** 父运行的工具执行器（子 Agent 复用同一执行器，写类操作仍走 HITL 确认门） */
  executeToolCall: (toolCall: ChatToolCall) => Promise<string | ToolCallOutcome>;
  /** 按 id 解析专家 manifest（非专家 kind 返回 null）；由运行时注入以隔离 pluginRegistry */
  resolveExpert?: (id: string) => PluginManifest | null;
  /**
   * 全局放宽开关（设置 → 子 Agent 模型 → 允许模型指派任意专家）。
   * 缺省 false = 只允许委派**当前项目绑定**的专家 —— 专家是项目级工作角色，
   * 与技能/MCP 的「安装 + 开启即可用」口径刻意不同（见 chat/expertDelegation.ts）。
   */
  allowAnyExpertDelegation?: boolean;
  signal?: AbortSignal;
  onToolStep?: (step: ChatStep) => void;
};

function summarizeTask(task: string): string {
  return task.length > 80 ? `${task.slice(0, 77)}...` : task;
}

/** 专家子 Agent 的派发动作标签 */
function expertActionDetail(expert: PluginManifest, task: string): string {
  return `${expert.name} ← ${summarizeTask(task)}`;
}

/**
 * 运行单个子 Agent（不含深度计数——由 runSubAgent 统一预留）：
 * 独立上下文 + 工具集执行委派任务，返回回填给主循环的报告文本与用量。
 * 永不抛异常（除中止信号透传外），失败以错误文本返回。
 */
async function runSingleSubAgent(spec: SubAgentTaskSpec, context: SubAgentRunContext): Promise<SubAgentResult> {
  const { task, expertId } = spec;

  // 专家模式：expertId 指向已安装/内置专家时，用专家的提示词/工具/技能驱动子 Agent。
  let expert: PluginManifest | null = null;
  if (expertId && context.resolveExpert) {
    const resolved = context.resolveExpert(expertId);
    if (!resolved || resolved.kind !== "expert") {
      return { outputText: `专家「${expertId}」不存在或不是有效的专家定义，请改用通用只读调研（省略 expertId）。` };
    }
    // 委派准入：默认只放行**当前项目绑定**的专家（手动 @专家 不走这条路径）。
    // 拒绝时把原因说清楚，避免模型换个 id 反复重试。
    if (
      !canDelegateExpert({
        expertId: resolved.id,
        project: context.project,
        allowAnyExpert: context.allowAnyExpertDelegation === true,
      })
    ) {
      return {
        outputText:
          `专家「${expertId}」未绑定到当前项目，无法委派。` +
          "请改用通用只读调研（省略 expertId），或让用户在项目设置里绑定该专家。",
      };
    }
    expert = resolved;
  }

  let tools: ChatToolParam[];
  let systemPrompt: string;
  let skillIds: string[] | undefined;
  if (expert) {
    // 工具按专家声明给：本地工具按 id 精确匹配 + 绑定连接器暴露的 mcp__* 工具
    //（写类工具允许，HITL 确认门在执行器里照常生效）；两类声明皆空 = 纯文本专家。
    tools = selectExpertTools(context.tools, expert);
    systemPrompt = [expert.templatePrompt?.trim() || `你是「${expert.name}」专家。`, SUB_AGENT_EXPERT_RULES].join("\n");
    skillIds = expert.defaultSkillIds;
  } else {
    tools = filterSubAgentTools(context.tools);
    if (tools.length === 0) {
      return {
        outputText:
          "子 Agent 无可用工具：当前会话未启用任何只读工具（list_files/read_file/search_files/web_search 等），无法委派任务。",
      };
    }
    systemPrompt = SUB_AGENT_RESEARCH_PROMPT;
  }

  const { project, executeToolCall, signal, onToolStep } = context;
  const model = resolveSubAgentModel(context, spec);
  onToolStep?.({
    type: "action",
    label: expert ? "委派专家" : "派出子Agent",
    title: expert?.name ?? "Sub Agent",
    icon: "Bot",
    detail: expert ? expertActionDetail(expert, task) : `${summarizeTask(task)} · ${model}`,
  });

  try {
    const result = await executeChatTurn({
      model,
      messages: [{ role: "user", content: task } satisfies Message],
      signal,
      systemPrompt,
      project: project ?? null,
      tools,
      executeToolCall,
      onToolStep,
      // 子 Agent 保持精简：无知识检索、无记忆/摘要抽取、无结构化输出协议
      enableKnowledgeContext: false,
      enableMemoryExtraction: false,
      enableSummaryExtraction: false,
      enableToolProtocol: false,
      // 专家模式按专家绑定过滤技能提示；通用调研子 Agent 不注入任何技能
      enabledSkillIds: skillIds ?? [],
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
    return {
      outputText: `子 Agent 报告（${rounds} 轮工具调用）：\n\n${truncateSubAgentOutput(report)}`,
      // 子 Agent 用量并入主会话统计：token 累加 + estimated 徽标透传
      usage: {
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        totalTokens: result.usage.totalTokens,
        estimated: Boolean(result.estimated),
      },
      toolRounds: rounds,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    return {
      outputText: `子 Agent 执行失败：${error instanceof Error ? error.message : String(error)}。请直接自行完成该子任务。`,
    };
  }
}

/**
 * 运行一次子 Agent 调度：单任务（{task, expertId?}）串行返回；批量（{tasks: [...]}）
 * 并行派发全部子任务（上限 MAX_SUB_AGENT_BATCH），汇总为分节报告 + 聚合用量回填主循环。
 * 永不抛异常（除中止信号透传外），失败以错误文本返回，保证主工具循环收敛。
 */
export async function runSubAgent(options: {
  args: string;
  context: SubAgentRunContext;
}): Promise<SubAgentResult> {
  const { args, context } = options;
  if (activeSubAgentRuns >= MAX_SUB_AGENT_DEPTH) {
    return { outputText: "嵌套调用被拒绝：子 Agent 内不能再派出子 Agent。请直接完成调研并汇报。" };
  }

  const parsed = parseSubAgentBatchArgs(args);
  if ("error" in parsed) {
    return { outputText: parsed.error };
  }
  const specs = parsed.tasks;

  // 深度计数按批量整体预留：嵌套的 agent 调用（内层 runSubAgent）会被拒绝
  activeSubAgentRuns += specs.length;
  try {
    if (specs.length === 1) {
      return await runSingleSubAgent(specs[0], context);
    }

    // 并行派发：Promise.all 同时跑全部子任务，单个失败不影响其余
    const results = await Promise.all(specs.map((spec) => runSingleSubAgent(spec, context)));

    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let estimated = false;
    let toolRounds = 0;
    const sections = results.map((result, index) => {
      if (result.usage) {
        promptTokens += result.usage.promptTokens;
        completionTokens += result.usage.completionTokens;
        totalTokens += result.usage.totalTokens;
        if (result.usage.estimated) estimated = true;
      }
      if (typeof result.toolRounds === "number") {
        toolRounds += result.toolRounds;
      }
      return `## 子任务 ${index + 1}：${summarizeTask(specs[index].task)}\n\n${result.outputText}`;
    });

    context.onToolStep?.({
      type: "action",
      label: "子Agent完成",
      title: "Sub Agent",
      icon: "Bot",
      detail: `${specs.length} 个并行子任务完成（共 ${toolRounds} 轮工具调用）`,
    });

    return {
      outputText: sections.join("\n\n---\n\n"),
      usage: { promptTokens, completionTokens, totalTokens, estimated },
      toolRounds,
    };
  } finally {
    activeSubAgentRuns -= specs.length;
  }
}
