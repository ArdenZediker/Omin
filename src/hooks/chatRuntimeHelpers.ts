import { emit, emitTo } from "@tauri-apps/api/event";
import { getToolManifestById } from "../config/manifests/tools";
import type { ChatToolParam, Message } from "../adapters/types";
import type { Project } from "../chat/types";
import type { PetThoughtState } from "../app/types";

export type SessionLite = {
  id: string;
  projectId?: string;
  title: string;
  messages: Message[];
};

export function resolveEnabledToolNames(project: Project | null) {
  if (!project) {
    return { toolNames: [], toolDescriptions: {} };
  }
  const toolNames: string[] = [];
  const toolDescriptions: Record<string, string> = {};
  for (const toolId of new Set(project.allowedToolIds)) {
    const manifest = getToolManifestById(toolId);
    if (!manifest?.title) continue;
    toolNames.push(manifest.title);
    // 仿 deepseek「插件自带指令」：优先使用 manifest 的声明式提示贡献。
    const contribution = manifest.promptContribution ?? manifest.description;
    if (contribution) {
      toolDescriptions[manifest.title] = contribution;
    }
  }
  return { toolNames, toolDescriptions };
}

/**
 * function calling 用的工具声明：把项目已允许的工具转为模型可调用的工具定义。
 *
 * 只暴露「只读/分析类」工具给模型（搜索会话、读取文件、搜索文件、读档案等），
 * 避免模型擅自执行有副作用的命令（update_persona / 切模型 / 清空对话等）。
 * 参数 schema 以 config/manifests/tools.ts 的 manifest.parameters 为数据源。
 */
export function buildChatTools(project: Project | null): ChatToolParam[] {
  if (!project) return [];
  // 只读/分析类：搜索、读取、联网检索、git 只读查看。
  const SAFE_TOOL_IDS = new Set([
    "search_sessions",
    "read_session",
    "list_files",
    "read_file",
    "search_files",
    "read_persona",
    "web_search",
    "web_fetch",
    "git_info",
  ]);
  // 写操作类：文件导出与 git 写操作——不放进无条件面，但项目启用后即对模型可见。
  const OFFERED_TOOL_IDS = new Set([
    "export_docx",
    "export_xlsx",
    "export_pptx",
    "git_commit",
    "git_pr",
  ]);
  const tools: ChatToolParam[] = [];
  for (const toolId of new Set(project.allowedToolIds)) {
    if (!SAFE_TOOL_IDS.has(toolId) && !OFFERED_TOOL_IDS.has(toolId)) continue;
    const manifest = getToolManifestById(toolId);
    if (!manifest) continue;
    tools.push({
      name: manifest.id,
      description: manifest.promptContribution ?? manifest.description,
      parameters: manifest.parameters ?? { type: "object", properties: {} },
    });
  }
  // 管理闭环：install_expert / install_skill 无条件暴露（不依赖项目 allowedToolIds），
  // 让「创建专家/技能 → 一键注册」在任何项目下都可用。
  for (const alwaysOnId of ["install_expert", "install_skill"]) {
    const manifest = getToolManifestById(alwaysOnId);
    if (manifest) {
      tools.push({
        name: manifest.id,
        description: manifest.promptContribution ?? manifest.description,
        parameters: manifest.parameters ?? { type: "object", properties: {} },
      });
    }
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
  result: { ok: boolean; error?: string; outputText?: string; data?: unknown } | void
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
