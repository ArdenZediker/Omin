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
 * 只暴露「只读/分析类」工具给模型（搜索会话、读取文件、搜索文件等），
 * 避免模型擅自执行有 UI 副作用的命令（切模型/清空对话/开关设置等）。
 */
export function buildChatTools(project: Project | null): ChatToolParam[] {
  if (!project) return [];
  const SAFE_TOOL_IDS = new Set([
    "search_sessions",
    "read_session",
    "list_files",
    "read_file",
    "search_files",
    "analyze_files",
  ]);
  const tools: ChatToolParam[] = [];
  for (const toolId of new Set(project.allowedToolIds)) {
    if (!SAFE_TOOL_IDS.has(toolId)) continue;
    const manifest = getToolManifestById(toolId);
    if (!manifest) continue;
    tools.push({
      name: manifest.id,
      description: manifest.promptContribution ?? manifest.description,
      parameters: { type: "object", properties: {} },
    });
  }
  // 专家管理闭环：install_expert 无条件暴露（不依赖项目 allowedToolIds），
  // 让「创建专家 → 一键注册」在任何项目下都可用。
  const installExpertManifest = getToolManifestById("install_expert");
  if (installExpertManifest) {
    tools.push({
      name: installExpertManifest.id,
      description: installExpertManifest.promptContribution ?? installExpertManifest.description,
      parameters: {
        type: "object",
        properties: {
          manifest: {
            type: "object",
            description:
              "符合 Omni 规范的专家 PluginManifest 定义：id（kebab-case 唯一标识）、name（展示名）、description（一句话描述）、version、kind（固定 expert）、category（行业分类）、icon（lucide 图标名）、tags（3 个擅长领域标签）、templatePrompt（专家系统提示词，可直接执行、不含占位符）、defaultToolIds（推荐工具 id）、defaultSkillIds（推荐技能 id）",
          },
        },
        required: ["manifest"],
      },
    });
  }
  return tools;
}

/**
 * 把模型发起的工具调用 arguments（JSON 字符串）宽容解析为本地命令的 args 文本。
 * 支持 {args}/{query}/{input}/{text}/{content}/{keyword} 字段，或纯字符串/拼接。
 */
export function extractToolCallArgs(raw: string): string {
  if (!raw || raw === "{}") return "";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const directKeys = ["args", "query", "input", "text", "content", "keyword"];
      for (const key of directKeys) {
        if (typeof record[key] === "string") return record[key];
      }
      // 专家安装：模型传 { manifest: {...} } 时保留完整 JSON，供 /install_expert 自行解析。
      if (record.manifest && typeof record.manifest === "object") {
        return JSON.stringify(record.manifest);
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

export const SILENT_LOCAL_TOOL_IDS = new Set([
  "model",
  "pet",
]);

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
