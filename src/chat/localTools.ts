import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { Message, ModelConfig } from "../adapters/types";
import { COMPACT_WINDOW_LABEL } from "../app/constants";
import { getPetWindowScale } from "../app/compactPetScale";
import { isCompactPetHidden, setCompactPetHidden } from "../app/compactVisibility";
import { saveSqliteBackedValue } from "../app/sqliteStorage";
import { showCompactWindow, showSettingsWindow } from "../app/window";
import { ALWAYS_ALLOWED_LOCAL_TOOL_IDS, getToolManifestById } from "../config/manifests/tools";
import type { PluginManifest } from "../plugins/types";
import { pluginRegistry } from "../plugins/registry";
import type { ProjectMemorySourceType, Project, PersonaConfig } from "./types";
import { ToolRegistry, type ToolExecutionResult } from "./toolRegistry";

export type LocalToolSession = {
  id: string;
  title: string;
  messages: Message[];
};

export type LocalToolRuntime = {
  activeProject: Project | null;
  activeChatId: string | null;
  addProjectMemory: (projectId: string, content: string, sourceSessionId?: string | null, sourceType?: ProjectMemorySourceType) => boolean;
  availableModels: ModelConfig[];
  getChatSessionById: (sessionId: string) => LocalToolSession | null;
  handleModelChange: (modelId: string) => void;
  renameChatSession: (sessionId: string, title: string) => boolean;
  searchChatSessions: (query: string) => LocalToolSession[];
  setActiveChatId: (chatId: string | null) => void;
  setEditingMessageIndex: (index: number | null) => void;
  setError: (error: string | null) => void;
  setMessages: (messages: Message[]) => void;
  setOpenChatMenu: (menu: { id: string; x: number; y: number } | null) => void;
  togglePinnedChatSession: (sessionId: string) => boolean;
  updateProjectProfile?: (projectId: string, patch: Partial<Project>) => Project | null;
};

export const ALWAYS_ALLOWED_LOCAL_TOOL_ID_SET = new Set(ALWAYS_ALLOWED_LOCAL_TOOL_IDS);

function requireTool(id: string) {
  const manifest = getToolManifestById(id);
  if (!manifest?.command) {
    throw new Error(`缺少工具定义：${id}`);
  }
  return manifest as typeof manifest & { command: string };
}

function canUseTauriEvents() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function getMessageRoleLabel(role: Message["role"]) {
  if (role === "user") return "用户";
  if (role === "project") return "项目";
  return "系统";
}

async function showDesktopPet() {
  setCompactPetHidden(false);
  saveSqliteBackedValue("omni_compact_appearance", "pet");
  await emit("omni-compact-appearance-changed", { appearance: "pet" });
  await showCompactWindow("pet", getPetWindowScale(), COMPACT_WINDOW_LABEL);
}

/**
 * 宽容解析 /install_expert 的参数为专家 manifest。
 * 支持：裸 JSON、```json 代码围栏包裹、字符串二次编码、{ manifest: {...} } 包装。
 */
export function parseExpertManifestFromArgs(raw: string): PluginManifest {
  let text = (raw ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("无法解析专家定义：请传入完整的专家 manifest JSON（对象）");
  }
  if (typeof parsed === "string") {
    parsed = JSON.parse(parsed);
  }
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    if (record.manifest && typeof record.manifest === "object") {
      return record.manifest as PluginManifest;
    }
    return parsed as PluginManifest;
  }
  throw new Error("专家定义必须是 JSON 对象");
}

/** 校验并补全专家 manifest 的必填字段与默认值。 */
export function normalizeExpertManifest(input: PluginManifest): PluginManifest {
  if (!input || typeof input !== "object") {
    throw new Error("专家定义格式错误：应为 JSON 对象");
  }
  if (input.kind && input.kind !== "expert") {
    throw new Error(`install_expert 只接受 kind 为 expert 的专家定义，收到「${input.kind}」`);
  }
  const id = String(input.id ?? "").trim();
  const name = String(input.name ?? "").trim();
  const description = String(input.description ?? "").trim();
  const templatePrompt = String(input.templatePrompt ?? "").trim();
  if (!id) throw new Error("缺少必填字段 id（kebab-case 唯一标识，如 dev-expert）");
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error(`id「${id}」不是合法 kebab-case：只能小写字母开头，包含小写字母、数字、连字符`);
  }
  if (pluginRegistry.isBuiltin(id)) {
    throw new Error(`id「${id}」与内置插件冲突，请换一个 id`);
  }
  if (!name) throw new Error("缺少必填字段 name（专家展示名）");
  if (!description) throw new Error("缺少必填字段 description（一句话描述）");
  if (!templatePrompt) throw new Error("缺少必填字段 templatePrompt（专家系统提示词，应可直接执行、不含占位符）");
  return {
    ...input,
    id,
    name,
    description,
    templatePrompt,
    kind: "expert",
    version: String(input.version ?? "1.0.0"),
    author: input.author ?? "Omni",
    category: input.category ?? "AI Agent",
    tags: Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === "string") : [],
  };
}

export function createLocalToolRegistry(runtime: LocalToolRuntime) {
  const registry = new ToolRegistry();

  const newTool = requireTool("new");
  const clearTool = requireTool("clear");
  const settingsTool = requireTool("settings");
  const petTool = requireTool("pet");
  const rememberTool = requireTool("remember");
  const renameTool = requireTool("rename");
  const pinTool = requireTool("pin");
  const modelTool = requireTool("model");
  const searchSessionsTool = requireTool("search_sessions");
  const readSessionTool = requireTool("read_session");
  const listFilesTool = requireTool("list_files");
  const readFileTool = requireTool("read_file");
  const searchFilesTool = requireTool("search_files");
  const readPersonaTool = requireTool("read_persona");
  const updatePersonaTool = requireTool("update_persona");
  const installExpertTool = requireTool("install_expert");

  registry.register({
    id: newTool.id,
    command: newTool.command,
    title: newTool.title,
    execute: async () => {
      runtime.setActiveChatId(null);
      runtime.setMessages([]);
      runtime.setError(null);
      runtime.setOpenChatMenu(null);
      runtime.setEditingMessageIndex(null);
      return { ok: true };
    },
  });

  registry.register({
    id: clearTool.id,
    command: clearTool.command,
    title: clearTool.title,
    execute: async () => {
      runtime.setMessages([]);
      runtime.setError(null);
      runtime.setEditingMessageIndex(null);
      return { ok: true };
    },
  });

  registry.register({
    id: settingsTool.id,
    command: settingsTool.command,
    title: settingsTool.title,
    execute: async () => {
      await showSettingsWindow();
      return { ok: true };
    },
  });

  registry.register({
    id: petTool.id,
    command: petTool.command,
    title: petTool.title,
    execute: async (resolvedCommand) => {
      if (!canUseTauriEvents()) {
        return { ok: false, error: "桌面宠物仅在桌面应用中可用。" };
      }

      const action = resolvedCommand.args.trim().toLowerCase();
      const compactWindow = await WebviewWindow.getByLabel(COMPACT_WINDOW_LABEL);
      const isCompactWindowVisible = compactWindow ? await compactWindow.isVisible().catch(() => false) : false;
      const hideCompactPet = async () => {
        setCompactPetHidden(true);
        await compactWindow?.close().catch(() => undefined);
      };

      if (!action) {
        if (compactWindow && isCompactWindowVisible && !isCompactPetHidden()) {
          await hideCompactPet();
          return { ok: true, outputText: "已隐藏桌面宠物。" };
        }

        await showDesktopPet();
        return { ok: true, outputText: "已打开桌面宠物。" };
      }

      if (["wake", "open", "show", "on"].includes(action)) {
        await showDesktopPet();
        return { ok: true, outputText: "已打开桌面宠物。" };
      }

      if (["close", "hide", "off"].includes(action)) {
        await hideCompactPet();
        return { ok: true, outputText: "已隐藏桌面宠物。" };
      }

      return { ok: false, error: "用法：/pet、/pet wake 或 /pet close" };
    },
  });

  registry.register({
    id: rememberTool.id,
    command: rememberTool.command,
    title: rememberTool.title,
    execute: async (resolvedCommand, context) => {
      const content = resolvedCommand.args.trim();
      if (!runtime.activeProject) return { ok: false, error: "当前没有可写入记忆的项目" };
      if (!content) return { ok: false, error: "用法：/remember 要记住的长期偏好或约束" };
      const added = runtime.addProjectMemory(runtime.activeProject.id, content, context.activeChatId, "command");
      if (!added) return { ok: true, outputText: "这条记忆已经存在，未重复保存。" };
      return { ok: true, outputText: "已保存到当前项目记忆库。" };
    },
  });

  registry.register({
    id: renameTool.id,
    command: renameTool.command,
    title: renameTool.title,
    execute: async (resolvedCommand, context) => {
      if (!context.activeChatId) return { ok: false, error: "当前没有可重命名的会话。" };
      if (!resolvedCommand.args) return { ok: false, error: "用法：/rename 会话标题" };
      runtime.renameChatSession(context.activeChatId, resolvedCommand.args);
      runtime.setError(null);
      runtime.setOpenChatMenu(null);
      return { ok: true };
    },
  });

  registry.register({
    id: pinTool.id,
    command: pinTool.command,
    title: pinTool.title,
    execute: async (_, context) => {
      if (!context.activeChatId) return { ok: false, error: "当前没有可置顶的会话。" };
      runtime.togglePinnedChatSession(context.activeChatId);
      runtime.setError(null);
      runtime.setOpenChatMenu(null);
      return { ok: true };
    },
  });

  registry.register({
    id: modelTool.id,
    command: modelTool.command,
    title: modelTool.title,
    execute: async (resolvedCommand) => {
      const query = resolvedCommand.args.trim().toLowerCase();
      if (!query) return { ok: false, error: "用法：/model 模型 ID 或名称" };

      const matchedModel =
        runtime.availableModels.find((model) => model.id.toLowerCase() === query || model.name.toLowerCase() === query) ??
        runtime.availableModels.find((model) => model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query));

      if (!matchedModel) return { ok: false, error: `未找到匹配模型：${resolvedCommand.args}` };

      const updatedProjectModel = Boolean(runtime.activeProject && runtime.updateProjectProfile);
      if (runtime.activeProject && runtime.updateProjectProfile) {
        runtime.updateProjectProfile(runtime.activeProject.id, { defaultModelId: matchedModel.id });
      } else {
        runtime.handleModelChange(matchedModel.id);
      }
      runtime.setError(null);
      return {
        ok: true,
        outputText: updatedProjectModel ? `已将当前项目默认模型切换为：${matchedModel.name}` : `已切换当前模型：${matchedModel.name}`,
      };
    },
  });

  registry.register({
    id: searchSessionsTool.id,
    command: searchSessionsTool.command,
    title: searchSessionsTool.title,
    execute: async (resolvedCommand, context) => {
      const query = resolvedCommand.args.trim();
      if (!query) return { ok: false, error: "用法：/search_sessions 关键词" };

      const matchedSessions = runtime.searchChatSessions(query);
      if (matchedSessions.length === 0) {
        return { ok: true, outputText: `没有会话包含“${query}”。`, data: [] };
      }

      const lines = matchedSessions.slice(0, 8).map((session, index) => {
        const marker = context.activeChatId === session.id ? " [当前]" : "";
        return `${index + 1}. ${session.title}${marker} | ID=${session.id} | ${session.messages.length} 条消息`;
      });

      return {
        ok: true,
        outputText: [`找到 ${matchedSessions.length} 个相关会话：`, ...lines].join("\n"),
        data: matchedSessions.map((session) => ({ id: session.id, title: session.title })),
      };
    },
  });

  registry.register({
    id: readSessionTool.id,
    command: readSessionTool.command,
    title: readSessionTool.title,
    execute: async (resolvedCommand) => {
      const sessionId = resolvedCommand.args.trim();
      if (!sessionId) return { ok: false, error: "用法：/read_session 会话 ID" };
      const session = runtime.getChatSessionById(sessionId);
      if (!session) return { ok: false, error: `未找到会话：${sessionId}` };

      const preview = session.messages
        .slice(-8)
        .map((message, index) => {
          const content = message.content.trim() || "[空内容]";
          const clipped = content.length > 120 ? `${content.slice(0, 117)}...` : content;
          return `${index + 1}. ${getMessageRoleLabel(message.role)}：${clipped}`;
        })
        .join("\n");

      return {
        ok: true,
        outputText: [`会话：${session.title}`, `ID：${session.id}`, `消息数：${session.messages.length}`, "", preview].join("\n"),
        data: { id: session.id, title: session.title, messageCount: session.messages.length },
      };
    },
  });

  registry.register({
    id: listFilesTool.id,
    command: listFilesTool.command,
    title: listFilesTool.title,
    execute: async (resolvedCommand) => {
      const query = resolvedCommand.args.trim();
      const entries = await invoke<Array<{ path: string; is_dir: boolean }>>("list_workspace_files", {
        projectPath: runtime.activeProject?.workspacePath || null,
        query: query || null,
        limit: 80,
      });

      if (entries.length === 0) {
        return {
          ok: true,
          outputText: query ? `没有文件名包含“${query}”。` : "当前工作区没有文件。",
          data: [],
        };
      }

      const lines = entries.slice(0, 20).map((entry, index) => `${index + 1}. ${entry.is_dir ? "[目录]" : "[文件]"} ${entry.path}`);
      return { ok: true, outputText: [`找到 ${entries.length} 个项目：`, ...lines].join("\n"), data: entries };
    },
  });

  registry.register({
    id: readFileTool.id,
    command: readFileTool.command,
    title: readFileTool.title,
    execute: async (resolvedCommand) => {
      const relativePath = resolvedCommand.args.trim();
      if (!relativePath) return { ok: false, error: "用法：/read_file 相对路径" };

      const content = await invoke<string>("read_workspace_file", {
        projectPath: runtime.activeProject?.workspacePath || null,
        path: relativePath,
        maxChars: 6000,
      });

      return {
        ok: true,
        outputText: [`文件：${relativePath}`, "", content].join("\n"),
        data: { path: relativePath },
      };
    },
  });

  registry.register({
    id: searchFilesTool.id,
    command: searchFilesTool.command,
    title: searchFilesTool.title,
    execute: async (resolvedCommand) => {
      const query = resolvedCommand.args.trim();
      if (!query) return { ok: false, error: "用法：/search_files 关键词" };

      const matches = await invoke<Array<{ path: string; line_number: number; line_preview: string }>>("search_workspace_files", {
        projectPath: runtime.activeProject?.workspacePath || null,
        query,
        limit: 50,
      });

      if (matches.length === 0) {
        return { ok: true, outputText: `没有文件内容包含“${query}”。`, data: [] };
      }

      const lines = matches.slice(0, 20).map((match, index) => `${index + 1}. ${match.path}:${match.line_number} ${match.line_preview}`);
      return { ok: true, outputText: [`找到 ${matches.length} 个相关匹配：`, ...lines].join("\n"), data: matches };
    },
  });

  const PERSONA_FIELDS = [
    "style",
    "userName",
    "assistantName",
    "personaDescription",
    "customInstruction",
    "longTermMemory",
    "agentsMd",
  ];

  registry.register({
    id: readPersonaTool.id,
    command: readPersonaTool.command,
    title: readPersonaTool.title,
    execute: async (resolvedCommand) => {
      const key = resolvedCommand.args.trim();
      if (!key) return { ok: false, error: "用法：/read_persona <字段名>" };
      if (!PERSONA_FIELDS.includes(key)) {
        return { ok: false, error: `未知字段：${key}（可选：${PERSONA_FIELDS.join("、")}）` };
      }
      const config = await invoke<PersonaConfig>("read_persona_files");
      const value = (config as unknown as Record<string, string>)[key] ?? "";
      return {
        ok: true,
        outputText: value ? `【${key}】\n${value}` : `【${key}】暂无内容`,
        data: { field: key, value },
      };
    },
  });

  registry.register({
    id: updatePersonaTool.id,
    command: updatePersonaTool.command,
    title: updatePersonaTool.title,
    execute: async (resolvedCommand) => {
      const raw = resolvedCommand.args.trim();
      const spaceIndex = raw.indexOf(" ");
      if (spaceIndex < 0) {
        return { ok: false, error: "用法：/update_persona <字段名> <内容>" };
      }
      const key = raw.slice(0, spaceIndex).trim();
      const content = raw.slice(spaceIndex + 1).trim();
      if (!PERSONA_FIELDS.includes(key)) {
        return { ok: false, error: `未知字段：${key}（可选：${PERSONA_FIELDS.join("、")}）` };
      }
      if (!content) {
        return { ok: false, error: "内容不能为空" };
      }
      await invoke("write_persona_file", { key, content });
      return { ok: true, outputText: `已更新个性化字段【${key}】。` };
    },
  });

  registry.register({
    id: installExpertTool.id,
    command: installExpertTool.command,
    title: installExpertTool.title,
    execute: async (resolvedCommand) => {
      try {
        const manifest = normalizeExpertManifest(parseExpertManifestFromArgs(resolvedCommand.args));
        const existed = pluginRegistry.isInstalled(manifest.id);
        pluginRegistry.install(manifest, { type: "local", path: "expert-created" });
        return {
          ok: true,
          outputText: existed
            ? `专家「${manifest.name}」（${manifest.id}）已更新，可在「专家分类 → 我的专家」查看。`
            : `专家「${manifest.name}」（${manifest.id}）已安装，可在「专家分类 → 我的专家」查看。`,
          data: { id: manifest.id, name: manifest.name, existed },
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "专家定义校验失败" };
      }
    },
  });

  return registry;
}

export async function executeLocalTool(runtime: LocalToolRuntime, command: { command: string; args: string }): Promise<ToolExecutionResult | void> {
  const registry = createLocalToolRegistry(runtime);
  const tool = registry.get(command.command);
  if (!tool) {
    return { ok: false, error: `暂不支持命令：${command.command}` };
  }

  if (runtime.activeProject && !ALWAYS_ALLOWED_LOCAL_TOOL_ID_SET.has(tool.id) && !runtime.activeProject.allowedToolIds.includes(tool.id)) {
    return { ok: false, error: `当前项目未启用工具：${tool.title}` };
  }

  return registry.execute(command, {
    activeChatId: runtime.activeChatId,
    chatSessions: runtime.searchChatSessions(""),
  });
}
