import { invoke } from "@tauri-apps/api/core";
import type { Message } from "../adapters/types";
import { ALWAYS_ALLOWED_LOCAL_TOOL_IDS, getToolManifestById } from "../config/manifests/tools";
import type { PluginManifest } from "../plugins/types";
import { pluginRegistry, parseSkillMarkdown } from "../plugins/registry";
import type { Project, PersonaConfig } from "./types";
import { ToolRegistry, type ToolExecutionResult } from "./toolRegistry";

export type LocalToolSession = {
  id: string;
  title: string;
  messages: Message[];
};

export type LocalToolRuntime = {
  activeProject: Project | null;
  activeChatId: string | null;
  getChatSessionById: (sessionId: string) => LocalToolSession | null;
  searchChatSessions: (query: string) => LocalToolSession[];
};

export const ALWAYS_ALLOWED_LOCAL_TOOL_ID_SET = new Set(ALWAYS_ALLOWED_LOCAL_TOOL_IDS);

function requireTool(id: string) {
  const manifest = getToolManifestById(id);
  if (!manifest?.command) {
    throw new Error(`缺少工具定义：${id}`);
  }
  return manifest as typeof manifest & { command: string };
}

function getMessageRoleLabel(role: Message["role"]) {
  if (role === "user") return "用户";
  if (role === "project") return "项目";
  return "系统";
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

/** 工具调用参数宽容解析为 JSON 对象（仅当整段 args 是 JSON 对象时成功）。 */
function parseToolJsonArgs(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  if (!text.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function strArg(record: Record<string, unknown> | null, ...keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function numArg(record: Record<string, unknown> | null, key: string): number | undefined {
  const value = record?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

export function createLocalToolRegistry(runtime: LocalToolRuntime) {
  const registry = new ToolRegistry();

  const searchSessionsTool = requireTool("search_sessions");
  const readSessionTool = requireTool("read_session");
  const listFilesTool = requireTool("list_files");
  const readFileTool = requireTool("read_file");
  const searchFilesTool = requireTool("search_files");
  const readPersonaTool = requireTool("read_persona");
  const updatePersonaTool = requireTool("update_persona");
  const installExpertTool = requireTool("install_expert");

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

  // ---- 联网工具（Rust：webtools.rs） ----

  registry.register({
    id: "web_search",
    command: "/web_search",
    title: "联网搜索",
    execute: async (resolvedCommand) => {
      const json = parseToolJsonArgs(resolvedCommand.args);
      const query = strArg(json, "query", "keyword", "q") ?? resolvedCommand.args.trim();
      if (!query) return { ok: false, error: "用法：/web_search 关键词" };
      try {
        const results = await invoke<Array<{ title: string; url: string; snippet: string }>>("web_search", {
          query,
          limit: numArg(json, "limit") ?? null,
        });
        if (results.length === 0) {
          return { ok: true, outputText: `没有找到与「${query}」相关的结果。`, data: [] };
        }
        const lines = results.map(
          (r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`,
        );
        const outputText = [`「${query}」搜索结果（${results.length} 条）：`, ...lines].join("\n");
        return {
          ok: true,
          outputText,
          data: results,
          artifact: { type: "web", title: `搜索「${query}」`, content: outputText },
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  registry.register({
    id: "web_fetch",
    command: "/web_fetch",
    title: "网页抓取",
    execute: async (resolvedCommand) => {
      const json = parseToolJsonArgs(resolvedCommand.args);
      const url = strArg(json, "url", "link") ?? resolvedCommand.args.trim();
      if (!url) return { ok: false, error: "用法：/web_fetch <url>" };
      try {
        const result = await invoke<{ final_url: string; title: string; text: string; links: Array<{ url: string; text: string }> }>(
          "web_fetch",
          { url, maxChars: numArg(json, "max_chars") ?? numArg(json, "maxChars") ?? null },
        );
        const linkLines = result.links.length
          ? ["", "页面主要链接：", ...result.links.slice(0, 10).map((l) => `- ${l.text || l.url}：${l.url}`)]
          : [];
        const outputText = [
          `标题：${result.title || "（无）"}`,
          `地址：${result.final_url}`,
          "",
          result.text,
          ...linkLines,
        ].join("\n");
        return {
          ok: true,
          outputText,
          data: { title: result.title, url: result.final_url, links: result.links },
          artifact: { type: "web", title: result.title || result.final_url, content: outputText },
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  // ---- Git 工作流（Rust：gittools.rs） ----

  const resolveGitPath = (json: Record<string, unknown> | null) =>
    strArg(json, "path", "repo") ?? runtime.activeProject?.workspacePath ?? null;

  registry.register({
    id: "git_info",
    command: "/git_info",
    title: "Git 查看",
    execute: async (resolvedCommand) => {
      const json = parseToolJsonArgs(resolvedCommand.args);
      const operation = strArg(json, "operation", "op") ?? resolvedCommand.args.trim().split(/\s+/)[0];
      if (!operation) return { ok: false, error: "用法：/git_info status|log|diff|diff-staged|branch" };
      try {
        const output = await invoke<string>("git_info", {
          projectPath: resolveGitPath(json),
          operation,
          limit: numArg(json, "limit") ?? null,
        });
        return { ok: true, outputText: output, data: { operation, output } };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  registry.register({
    id: "git_commit",
    command: "/git_commit",
    title: "Git 提交",
    execute: async (resolvedCommand) => {
      const json = parseToolJsonArgs(resolvedCommand.args);
      const message = strArg(json, "message", "msg");
      if (!message) return { ok: false, error: "用法：/git_commit <message>（或传 JSON {message, addAll?, paths?}）" };
      try {
        const output = await invoke<string>("git_commit", {
          projectPath: resolveGitPath(json),
          message,
          addAll: typeof json?.add_all === "boolean" ? json.add_all : typeof json?.addAll === "boolean" ? json.addAll : null,
          paths: Array.isArray(json?.paths) ? json.paths.filter((p): p is string => typeof p === "string") : null,
        });
        return { ok: true, outputText: output };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  registry.register({
    id: "git_pr",
    command: "/git_pr",
    title: "Git 创建 PR",
    execute: async (resolvedCommand) => {
      const json = parseToolJsonArgs(resolvedCommand.args);
      const title = strArg(json, "title");
      if (!title) return { ok: false, error: "用法：/git_pr <title>（或传 JSON {title, body?, base?}）" };
      try {
        const output = await invoke<string>("git_pr", {
          projectPath: resolveGitPath(json),
          title,
          body: strArg(json, "body", "description") ?? null,
          base: strArg(json, "base") ?? null,
        });
        return { ok: true, outputText: output };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  // ---- Office 导出（Rust：office_export.rs） ----

  const registerExportTool = (
    id: string,
    title: string,
    command: string,
    tauriCommand: "export_docx" | "export_xlsx" | "export_pptx",
  ) => {
    registry.register({
      id,
      command,
      title,
      execute: async (resolvedCommand) => {
        const json = parseToolJsonArgs(resolvedCommand.args);
        const path = strArg(json, "path", "output", "file");
        const specRaw = json?.spec ?? json?.document ?? json?.data;
        if (!path) return { ok: false, error: `用法：/${id} JSON{path, spec, overwrite?}（path 为输出文件绝对路径）` };
        if (specRaw === undefined || specRaw === null) {
          return { ok: false, error: `缺少 spec：请按 schema 提供${title}的结构化内容对象` };
        }
        try {
          const outcome = await invoke<{ path: string; size: number }>(tauriCommand, {
            path,
            specJson: JSON.stringify(specRaw),
            overwrite:
              typeof json?.overwrite === "boolean"
                ? json.overwrite
                : json?.overwrite === true || json?.overwrite === "true",
          });
          return {
            ok: true,
            outputText: `${title}已生成：${outcome.path}（${(outcome.size / 1024).toFixed(1)} KB）`,
            data: outcome,
            artifact: {
              type: tauriCommand === "export_docx" ? "docx" : tauriCommand === "export_xlsx" ? "xlsx" : "pptx",
              title: outcome.path.split(/[\\/]/).pop() || title,
              path: outcome.path,
              size: outcome.size,
            },
          };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
    });
  };

  registerExportTool("export_docx", "Word 文档", "/export_docx", "export_docx");
  registerExportTool("export_xlsx", "Excel 表格", "/export_xlsx", "export_xlsx");
  registerExportTool("export_pptx", "PPT 演示", "/export_pptx", "export_pptx");

  // ---- 自造技能安装（Rust：skillhub.rs install_local_skill） ----

  registry.register({
    id: "install_skill",
    command: "/install_skill",
    title: "安装自造技能",
    execute: async (resolvedCommand) => {
      const json = parseToolJsonArgs(resolvedCommand.args);
      const id = strArg(json, "id", "slug");
      const content = strArg(json, "content", "body", "markdown");
      if (!id) return { ok: false, error: "用法：/install_skill JSON{id, name?, description?, content}" };
      if (!content) return { ok: false, error: "缺少 content：技能正文（Markdown）" };
      if (!/^[a-z][a-z0-9-_]*$/i.test(id)) {
        return { ok: false, error: `技能 id「${id}」不合法：仅允许字母、数字、连字符、下划线` };
      }
      try {
        const res = await invoke<{ slug: string; path: string; skill_md: string }>("install_local_skill", {
          slug: id,
          name: strArg(json, "name", "title") ?? null,
          description: strArg(json, "description", "desc") ?? null,
          content,
        });
        const parsed = parseSkillMarkdown(res.skill_md);
        if (!parsed) return { ok: false, error: "SKILL.md 解析失败，技能已写入但未注册，请检查 frontmatter" };
        parsed.id = res.slug;
        parsed.kind = "skill";
        parsed.command = parsed.command || `/${res.slug}`;
        if (!parsed.category) parsed.category = "AI Agent";
        const tags = Array.isArray(json?.tags) ? json.tags.filter((t): t is string => typeof t === "string") : [];
        if (tags.length) parsed.tags = tags;
        const existed = pluginRegistry.isInstalled(res.slug);
        pluginRegistry.install(parsed, { type: "local", path: res.path });
        return {
          ok: true,
          outputText: `技能「${parsed.name}」（${res.slug}）已${existed ? "更新" : "安装"}：${res.path}`,
          data: { id: res.slug, path: res.path, existed },
          artifact: { type: "skill", title: `技能：${parsed.name}（${res.slug}）`, path: res.path },
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
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
