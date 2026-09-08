import { emit, emitTo } from "@tauri-apps/api/event";
import { BUILTIN_TOOL_IDS, getToolManifestById } from "../config/manifests/tools";
import type { ChatToolParam, Message } from "../adapters/types";
import type { Project } from "../chat/types";
import { buildShellEnvHint } from "../chat/shellEnv";
import { pluginRegistry } from "../plugins/registry";
import type { PetThoughtState } from "../app/types";

export type SessionLite = {
  id: string;
  projectId?: string;
  title: string;
  messages: Message[];
};

/** 专家名册上限：避免专家装太多时把 agent 工具描述撑爆（超出部分提示用户去扩展中心看）。 */
const EXPERT_ROSTER_LIMIT = 12;

/**
 * agent 工具的动态专家名册（仿 bash 的 buildShellEnvHint 动态描述模式）：
 * 列出可委派的专家（id + 名称 + 一句话描述），主模型据此决定是否带 expertId 派发。
 * 项目绑定专家（boundExpertIds 非空）时只暴露绑定集；无可用专家时给出兜底说明。
 */
export function buildExpertAgentHint(project: Project | null): string {
  const allExperts = pluginRegistry
    .listExperts()
    .filter((manifest) => manifest.templatePrompt?.trim());
  const bound = (project?.boundExpertIds ?? []).filter(Boolean);
  const experts = bound.length > 0 ? allExperts.filter((m) => bound.includes(m.id)) : allExperts;
  if (experts.length === 0) {
    return "\nEXPERTS: none available right now — delegate generic read-only research (omit expertId)." +
      (bound.length > 0 ? " (This project has bound experts that are not installed/enabled.)" : "");
  }
  const lines = experts.slice(0, EXPERT_ROSTER_LIMIT).map((m) => {
    const desc = (m.description ?? "").trim();
    const skills = (m.defaultSkillIds ?? []).length;
    return `- ${m.id}: ${m.name}${desc ? ` — ${desc}` : ""}${skills ? `（绑定 ${skills} 个技能）` : ""}`;
  });
  const more = experts.length > EXPERT_ROSTER_LIMIT ? `\n（另有 ${experts.length - EXPERT_ROSTER_LIMIT} 位专家未列出）` : "";
  return [
    "\nAVAILABLE EXPERTS (pass expertId to delegate to one; the expert's own prompt/tools/skills apply):",
    ...lines,
    more,
  ]
    .filter(Boolean)
    .join("\n");
}

// 内置工具是所有模型/会话的公用工具：无条件纳入系统提示与可用工具集。
export function resolveEnabledToolNames(project: Project | null) {
  const sourceToolIds = new Set<string>([
    ...BUILTIN_TOOL_IDS,
    ...(project?.allowedToolIds ?? []),
  ]);
  const toolNames: string[] = [];
  const toolDescriptions: Record<string, string> = {};
  for (const toolId of new Set(sourceToolIds)) {
    const manifest = getToolManifestById(toolId);
    if (!manifest?.title) continue;
    toolNames.push(manifest.title);
    // 仿 deepseek「插件自带指令」：优先使用 manifest 的声明式提示贡献。
    // /bash 额外追加当前 Shell 环境的动态提示（方案B：用户自定义 Shell 时引导模型用对应语法）。
    // /agent 额外追加专家名册（主模型据此选择委派对象）。
    const base = manifest.promptContribution ?? manifest.description;
    let contribution = base;
    if (toolId === "bash") contribution += buildShellEnvHint();
    if (toolId === "agent") contribution += buildExpertAgentHint(project);
    if (contribution) {
      toolDescriptions[manifest.title] = contribution;
    }
  }
  return { toolNames, toolDescriptions };
}

/**
 * function calling 用的工具声明：把模型可调用的工具转为工具定义。
 *
 * 内置工具为所有模型/会话的公用工具，无条件暴露；项目额外启用的非内置工具与之取并集。
 * 有副作用的写操作（git 提交/PR、改档案、装插件等）仍受运行时确认门（HITL）保护，
 * 不会因工具可见就自动执行。
 * 参数 schema 以 config/manifests/tools.ts 的 manifest.parameters 为数据源。
 */
export function buildChatTools(project: Project | null): ChatToolParam[] {
  // 内置工具为所有模型/会话的公用工具：无条件暴露，不受项目绑定或只读/写分类限制。
  // 项目启用的非内置工具（用户安装/自定义）与内置工具取并集，仍按 manifest 存在性过滤。
  const sourceToolIds = new Set<string>([
    ...BUILTIN_TOOL_IDS,
    ...(project?.allowedToolIds ?? []),
  ]);
  const tools: ChatToolParam[] = [];
  for (const toolId of new Set(sourceToolIds)) {
    const manifest = getToolManifestById(toolId);
    if (!manifest) continue;
    // /bash 额外追加当前 Shell 环境的动态提示（方案B），/agent 追加专家名册；与 resolveEnabledToolNames 保持一致。
    const base = manifest.promptContribution ?? manifest.description;
    let description = base;
    if (toolId === "bash") description += buildShellEnvHint();
    if (toolId === "agent") description += buildExpertAgentHint(project);
    tools.push({
      name: manifest.id,
      description,
      parameters: manifest.parameters ?? { type: "object", properties: {} },
    });
  }
  return tools;
}

/**
 * 把模型发起的工具调用 arguments（JSON 字符串）宽容解析为本地命令的 args 文本。
 *
 * 解析规则（按序）：
 * 1. 纯字符串直接返回；
 * 2. {manifest:{...}} → 返回 manifest 的 JSON（/install_expert 自行解析）；
 * 3. 多字段或含对象/数组等复杂值 → 保留原始 JSON（多参数工具 execute 自行解析）；
 * 4. 单字段命中 directKeys → 返回该字符串（老工具单参数形态）；
 * 5. 其余对象兜底拼接 key=value。
 */
export function extractToolCallArgs(raw: string): string {
  if (!raw || raw === "{}") return "";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      // 专家安装：模型传 { manifest: {...} } 时保留完整 JSON，供 /install_expert 自行解析。
      if (record.manifest && typeof record.manifest === "object") {
        return JSON.stringify(record.manifest);
      }
      const hasComplexValue = Object.values(record).some(
        (v) => v !== null && typeof v === "object",
      );
      // 多参数工具（web_fetch / export_* / git_* / install_skill 等）：
      // 保留原始 JSON，execute 侧按 manifest.parameters 自行解析。
      if (Object.keys(record).length > 1 || hasComplexValue) {
        return raw.trim();
      }
      const directKeys = [
        "args",
        "query",
        "input",
        "text",
        "content",
        "keyword",
        "path",
        "sessionId",
        "field",
      ];
      for (const key of directKeys) {
        if (typeof record[key] === "string") return record[key];
      }
      const parts = Object.entries(record)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([key, value]) => `${key}=${value}`);
      return parts.join(" ");
    }
    return String(parsed);
  } catch {
    return raw;
  }
}

/** 工具调用名（如 search_files）还原为本地 slash 命令（/search_files）。 */
export function toolCallNameToCommand(name: string): string {
  return name.startsWith("/") ? name : `/${name}`;
}

/** 执行结果统一转成回填给模型的文本。 */
export function formatToolCallResult(
  result: { ok: boolean; error?: string; outputText?: string; data?: unknown; artifact?: import("../chat/artifacts").ArtifactSpec } | void
): string {
  if (!result) return "工具执行完成（无输出）";
  if (result.ok === false) return result.error || "工具执行失败";
  if (result.outputText) return result.outputText;
  if (result.data !== undefined) {
    try {
      return typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2);
    } catch {
      return String(result.data);
    }
  }
  return "工具执行完成（无输出）";
}

export const PET_THOUGHT_QUEUE_LIMIT = 12;
export const PET_THOUGHT_DISMISS_DELAY_MS = 900;

export type PetThoughtSyncRequestPayload = {
  requesterLabel?: string;
  requestId?: string;
};

export type PetThoughtSyncResponsePayload = {
  requestId?: string;
  queue: PetThoughtState[];
  currentThought: PetThoughtState | null;
};

export function createPreviewThrottler(intervalMs: number, update: () => void) {
  let lastUpdateAt = 0;
  return (force = false) => {
    const now = performance.now();
    if (!force && now - lastUpdateAt < intervalMs) {
      return;
    }
    lastUpdateAt = now;
    update();
  };
}

/**
 * 流式正文过滤器：实时剥离模型可能输出的 <omni_memory> / <omni_summary> 结构化标签块。
 * 这些标签是系统提示要求模型追加的内部结构，不应展示给用户。
 * 实现策略：检测到 `<omni_` 起始即停止向可见文本追加（标签通常位于回复末尾），
 * 保证即使标签跨多个 chunk 到达，也不会把标签内容闪现在界面上。
 */
export function createStructuredOutputFilter() {
  let visibleText = "";
  let hasEnteredStructuredBlock = false;
  return {
    append(chunk: string): string {
      if (hasEnteredStructuredBlock) {
        return visibleText;
      }
      const combined = visibleText + chunk;
      const structuredStart = combined.search(/<omni_(memory|summary)>/i);
      if (structuredStart >= 0) {
        visibleText = combined.slice(0, structuredStart).trimEnd();
        hasEnteredStructuredBlock = true;
      } else {
        visibleText = combined;
      }
      return visibleText;
    },
    getVisibleText(): string {
      return visibleText;
    },
  };
}

export function canUseTauriEvents() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function safelyEmitPetThoughtEvent(event: string, payload: unknown) {
  if (!canUseTauriEvents()) {
    return;
  }

  try {
    void emit(event, payload).catch(() => undefined);
  } catch {
    // Pet bubble sync must never interrupt the model response stream.
  }
}

export function safelyEmitPetThoughtEventTo(windowLabel: string, event: string, payload: unknown) {
  if (!canUseTauriEvents()) {
    return;
  }

  try {
    void emitTo(windowLabel, event, payload).catch(() => undefined);
  } catch {
    // A missing/closing auxiliary window should not affect chat execution.
  }
}
