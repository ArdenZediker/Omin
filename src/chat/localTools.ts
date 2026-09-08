import { invoke } from "@tauri-apps/api/core";
import type { Message } from "../adapters/types";
import { ALWAYS_ALLOWED_LOCAL_TOOL_IDS, getToolManifestById } from "../config/manifests/tools";
import type { PluginManifest } from "../plugins/types";
import { pluginRegistry, parseSkillMarkdown } from "../plugins/registry";
import type { Project, PersonaConfig } from "./types";
import { ToolRegistry, type ToolExecutionResult } from "./toolRegistry";
import type { FileDiff } from "./fileDiff";
import { requestConfirmation } from "./confirmationGate";
import { buildSessionOutputDir, getEffectiveOutputRoot } from "../app/outputStorage";
import { loadBasicSettings } from "../app/settings";
import { BASIC_SETTINGS_STORAGE_KEY, DEFAULT_BASIC_SETTINGS } from "../app/constants";

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
 * 只读命令快通道（对齐 Codex is_known_safe_command）：明确只读的命令跳过 HITL 确认门直接执行。
 * 仅当命令是「单一、不含可疑 shell 元字符、可执行在只读白名单」时才判定为安全；
 * 任何复合命令（管道/重定向/后台/子shell/命令替换）或非白名单可执行都保守回落到确认门。
 * 注意：powershell/cmd/sh/bash 等外壳包装器、python/node/npm/pip 等可执码的运行时、
 * 以及 tee/sed(-i)/find(-delete) 等带写入变体的命令一律不在此列，需人工确认。
 */
const SAFE_READONLY_COMMANDS = new Set<string>([
  "ls", "dir", "cat", "type", "echo", "pwd", "cd", "wc", "head", "tail",
  "grep", "rg", "sort", "uniq", "cut", "tr", "nl", "which", "where", "file",
  "stat", "readlink", "realpath", "date", "whoami", "uname", "hostname", "id",
  "git", "tree", "less", "more", "basename", "dirname", "xxd", "od", "strings", "diff",
]);
const READONLY_GIT_SUBCOMMANDS = new Set<string>([
  "status", "log", "diff", "branch", "show", "remote", "tag", "stash", "ls-files",
  "ls-remote", "rev-parse", "rev-list", "blame", "shortlog", "reflog", "cat-file", "grep",
]);

/** 判定路径是否落在项目工作区之外（决定 write_file/edit_file 是否触发确认门；
 *  相对路径由 Rust 端拼接工作区解析，视为域内；未绑定工作区时绝对路径一律需确认）。 */
export function isOutsideWorkspace(path: string, workspacePath: string): boolean {
  const trimmed = path.trim();
  const isAbsolute = /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("\\\\");
  if (!isAbsolute) return false;
  if (!workspacePath) return true;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const t = norm(trimmed);
  const w = norm(workspacePath);
  return t !== w && !t.startsWith(`${w}/`);
}
export function isKnownSafeCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  // 含 shell 元字符（复合/管道/重定向/后台/子shell/命令替换）→ 保守回落确认门
  if (/[;&|<>()`$]/.test(cmd)) return false;
  const tokens = cmd.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  // 取可执行名：去掉前导 ./ 与路径，再去掉扩展名，小写化
  let exe = tokens[0].replace(/^[./\\]+/, "");
  exe = exe.includes("/") || exe.includes("\\") ? exe.split(/[\\/]/).pop()! : exe;
  exe = exe.replace(/\.(exe|cmd|bat|ps1|sh|bash)$/i, "").toLowerCase();

  if (exe === "git") {
    const sub = (tokens[1] || "").toLowerCase().replace(/^-+/, "");
    if (sub === "config") {
      // git config 仅 --get/--list 等只读查询放行，--global/--system 写值需确认
      return tokens.slice(2).some((t) => /^(--get|--get-all|--get-regexp|--list|-l|-h|--help)$/.test(t));
    }
    return READONLY_GIT_SUBCOMMANDS.has(sub);
  }
  return SAFE_READONLY_COMMANDS.has(exe);
}

/** 「命令未找到」类报错模式：cmd（中/英）与 POSIX shell 两种形态，捕获缺失的命令名。 */
const NOT_FOUND_PATTERNS: RegExp[] = [
  /'([^']+)'\s*(?:不是内部或外部命令|is not recognized as an internal or external command)/i,
  /(?:^|\n)[^\n]*?(?:bash|sh|zsh)\s*:\s*([\w.\-/]+)\s*:\s*command not found/i,
];

/** 从命令输出里识别「命令未找到」并提取缺失的命令名（方案C：报错引导自修正）。 */
export function missingCommandFrom(output: string): string | null {
  for (const re of NOT_FOUND_PATTERNS) {
    const m = output.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** 命令未找到时给模型的改用引导（单段文本同时覆盖 cmd 与 POSIX 两种环境）。 */
function buildMissingCommandHint(missing: string): string {
  return (
    `\n（提示：未找到命令「${missing}」。` +
    "请改用当前环境的等价命令——Windows cmd 用 dir/findstr/type，" +
    "或跨平台 CLI（rg/node/python/bun）；若确属 POSIX 工具，请确认已安装（如 Git Bash/WSL）并加入 PATH。）"
  );
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

function boolArg(record: Record<string, unknown> | null, key: string): boolean | undefined {
  const value = record?.[key];
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/** 把列表/搜索的裸字符串参数转成 glob：含通配符则原样，否则当作「包含」子串（*x*）。 */
function toGlobArg(raw: string | undefined): string | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  const hasGlobMeta = text.includes("*") || text.includes("?") || text.includes("[");
  return hasGlobMeta ? text : `*${text}*`;
}

/** Tauri read_workspace_file 返回值（与 src-tauri/src/workspace_files.rs::ReadFileResult 对齐）。 */
interface ReadFileResult {
  content: string;
  total_chars: number;
  returned_chars: number;
  offset_chars: number;
  truncated: boolean;
  /** 窗口首/末行号（1-based），与 /search_files 的 line_number 同一坐标系。 */
  start_line?: number;
  end_line?: number;
}

/** 把 [file-meta ...] 块定长渲染出来，便于模型识别 + 视觉扫读。 */
function formatFileMetaLine(result: ReadFileResult): string {
  const lines =
    typeof result.start_line === "number" && typeof result.end_line === "number"
      ? ` lines=${result.start_line}-${result.end_line}`
      : "";
  return `[file-meta total=${result.total_chars} offset=${result.offset_chars} returned=${result.returned_chars}${lines} truncated=${result.truncated}]`;
}

/** 给读文件内容加「行号 | 内容」前缀（cat -n 风格），与 /search_files 的行号对齐。 */
function numberLines(content: string, startLine?: number): string {
  if (typeof startLine !== "number" || !content) return content;
  const lines = content.split("\n");
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((line, index) => `${String(startLine + index).padStart(width, " ")} | ${line.replace(/\r$/, "")}`)
    .join("\n");
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
      const json = parseToolJsonArgs(resolvedCommand.args);
      // JSON 优先用 glob；裸字符串兼容旧用法（含通配符当 glob，否则当「包含」子串 *x*）。
      const glob = strArg(json, "glob") ?? toGlobArg(resolvedCommand.args.trim());
      const entries = await invoke<Array<{ path: string; is_dir: boolean }>>("list_workspace_files", {
        projectPath: runtime.activeProject?.workspacePath || null,
        glob: glob ?? null,
        limit: 80,
      });

      if (entries.length === 0) {
        return {
          ok: true,
          outputText: glob ? `没有匹配「${glob}」的文件。` : "当前工作区没有文件。",
          data: [],
        };
      }

      const lines = entries.slice(0, 20).map((entry, index) => `${index + 1}. ${entry.is_dir ? "[目录]" : "[文件]"} ${entry.path}`);
      return { ok: true, outputText: [`找到 ${entries.length} 个匹配项（glob=${glob ?? "*"}）：`, ...lines].join("\n"), data: entries };
    },
  });

  registry.register({
    id: readFileTool.id,
    command: readFileTool.command,
    title: readFileTool.title,
    execute: async (resolvedCommand) => {
      // 支持 JSON 入参（推荐：{"path":"...","maxChars":20000,"offsetChars":0,"limitChars":16000}），
      // 也兼容旧的「仅路径」用法（如 /read_file C:/Users/...）。
      const json = parseToolJsonArgs(resolvedCommand.args);
      const rawTextPath = resolvedCommand.args.trim();
      const path = strArg(json, "path") ?? (rawTextPath.startsWith("{") ? null : rawTextPath) ?? "";
      if (!path) {
        return { ok: false, error: "用法：/read_file <path>，或 /read_file {\"path\":\"...\",\"maxChars\":N,\"offsetChars\":N,\"limitChars\":N}" };
      }
      const maxChars = numArg(json, "maxChars");
      const offsetChars = numArg(json, "offsetChars");
      const limitChars = numArg(json, "limitChars");

      // 读取不限制范围：绝对路径直接读（用户本机文件，无需确认门）；
      // 相对路径落在工作区（无项目时全局 workspace_root）内解析。
      // 只有写入/导出才需要围栏与确认门。
      const ws = runtime.activeProject?.workspacePath ?? "";
      const result = await invoke<ReadFileResult>("read_workspace_file", {
        projectPath: ws || null,
        path,
        maxChars: maxChars ?? null,
        offsetChars: offsetChars ?? null,
        limitChars: limitChars ?? null,
      });

      return {
        ok: true,
        outputText: [`文件：${path}`, "", numberLines(result.content, result.start_line), "", formatFileMetaLine(result)].join("\n"),
        data: {
          path,
          totalChars: result.total_chars,
          returnedChars: result.returned_chars,
          offsetChars: result.offset_chars,
          truncated: result.truncated,
        },
      };
    },
  });

  registry.register({
    id: searchFilesTool.id,
    command: searchFilesTool.command,
    title: searchFilesTool.title,
    execute: async (resolvedCommand) => {
      const json = parseToolJsonArgs(resolvedCommand.args);
      const pattern = strArg(json, "pattern") ?? resolvedCommand.args.trim();
      if (!pattern) {
        return {
          ok: false,
          error:
            "用法：/search_files <pattern> 或 /search_files {\"pattern\":\"...\",\"glob\":\"**/*.ts\",\"literal\":true,\"ignoreCase\":true,\"context\":2,\"limit\":50}",
        };
      }

      const matches = await invoke<
        Array<{ path: string; line_number: number; line: string; before: string[]; after: string[] }>
      >("search_workspace_files", {
        projectPath: runtime.activeProject?.workspacePath || null,
        pattern,
        path: strArg(json, "path") ?? null,
        glob: strArg(json, "glob") ?? null,
        literal: boolArg(json, "literal") ?? null,
        ignoreCase: boolArg(json, "ignoreCase") ?? null,
        context: numArg(json, "context") ?? null,
        limit: numArg(json, "limit") ?? 50,
      });

      if (matches.length === 0) {
        return { ok: true, outputText: `没有文件内容匹配「${pattern}」。`, data: [] };
      }

      const lines = matches.slice(0, 20).map((m, index) => {
        const ctx = [
          ...m.before.map((l) => `  ${l}`),
          `${m.path}:${m.line_number} ${m.line}`,
          ...m.after.map((l) => `  ${l}`),
        ].join("\n");
        return `${index + 1}.\n${ctx}`;
      });
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
      const approved = await requestConfirmation({
        source: "update_persona",
        title: "更新个性化配置？",
        summary: "模型请求修改你的个性化字段配置。",
        riskLevel: "write",
        details: [
          { label: "字段", value: key },
          { label: "内容", value: content },
        ],
        targets: [key],
        warning: "该字段将覆盖你已有的个性化配置，影响 Omni 的回答风格。",
        confirmLabel: "确认更新",
      });
      if (!approved) {
        return { ok: false, error: "已取消：未确认更新个性化配置" };
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
        const approved = await requestConfirmation({
          source: "install_expert",
          title: "安装专家插件？",
          summary: "模型请求安装一个专家插件（含可执行指令）。",
          riskLevel: "write",
          details: [
            { label: "专家", value: `${manifest.name}（${manifest.id}）` },
            { label: "操作", value: existed ? "更新已有" : "新安装" },
          ],
          targets: [manifest.id],
          warning: "专家插件含指令，安装后可在对话中被调用执行。确认来源可信后再安装。",
          confirmLabel: "确认安装",
        });
        if (!approved) {
          return { ok: false, error: "已取消：未确认安装专家插件" };
        }
        pluginRegistry.install(manifest, { type: "local", path: "expert-created" });
        return {
          ok: true,
          outputText: existed
            ? `专家「${manifest.name}」（${manifest.id}）已更新，可在「专家分类 → 我的专家」查看。`
            : `专家「${manifest.name}」（${manifest.id}）已安装，可在「专家分类 → 我的专家」查看。`,
          data: { id: manifest.id, name: manifest.name, existed },
          artifact: { type: "expert", title: `专家：${manifest.name}（${manifest.id}）`, path: null },
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
    title: "Web Search",
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
          artifact: { type: "web", title: `搜索「${query}」`, url: results[0]?.url ?? null, content: outputText },
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  registry.register({
    id: "web_fetch",
    command: "/web_fetch",
    title: "Web Fetch",
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
          artifact: { type: "web", title: result.title || result.final_url, url: result.final_url, content: outputText },
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
    title: "Git Info",
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
    title: "Git Commit",
    // 会改动仓库状态：addAll 时还会把未跟踪文件一并纳入暂存，需用户过目。
    confirm: (resolvedCommand) => {
      const json = parseToolJsonArgs(resolvedCommand.args);
      const message = strArg(json, "message", "msg");
      if (!message) return null;
      const addAll =
        typeof json?.add_all === "boolean"
          ? json.add_all
          : typeof json?.addAll === "boolean"
            ? json.addAll
            : null;
      const paths = Array.isArray(json?.paths)
        ? json.paths.filter((p): p is string => typeof p === "string")
        : null;
      return {
        title: "提交 Git 改动",
        summary: addAll === true ? "暂存全部改动后创建一次提交" : "按指定范围创建一次提交",
        riskLevel: "destructive",
        details: [
          { label: "提交信息", value: message },
          {
            label: "暂存范围",
            value: paths?.length ? paths.join("、") : addAll === true ? "全部改动（含未跟踪文件）" : "已暂存内容",
          },
        ],
        targets: [resolveGitPath(json) ?? "当前项目工作区"],
        warning:
          addAll === true
            ? "提交会改动本地仓库状态。addAll 会把未跟踪文件一并纳入，可能包含你不打算提交的临时文件。"
            : "提交会改动本地仓库状态。撤销需 reset/revert，请先确认提交信息与暂存范围。",
        confirmLabel: "确认提交",
      };
    },
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
    title: "Git PR",
    // 全项目唯一**不可逆**操作：会 git push 到远端，推上去就撤不回来了。
    confirm: (resolvedCommand) => {
      const json = parseToolJsonArgs(resolvedCommand.args);
      const title = strArg(json, "title");
      if (!title) return null;
      const base = strArg(json, "base") ?? "仓库默认分支";
      return {
        title: "推送分支并创建 PR",
        summary: "把当前分支推送到远端仓库，然后创建 Pull Request",
        riskLevel: "irreversible",
        details: [
          { label: "PR 标题", value: title },
          { label: "目标分支（base）", value: base },
          {
            label: "PR 描述",
            value: strArg(json, "body", "description")
              ? `${String(strArg(json, "body", "description")).slice(0, 120)}${String(strArg(json, "body", "description")).length > 120 ? "…" : ""}`
              : "（未填写）",
          },
        ],
        targets: [resolveGitPath(json) ?? "当前项目工作区"],
        warning:
          "这一步包含 git push，代码会离开本机到远端仓库——推送后无法从本地撤销。请确认分支、目标 base 与提交内容都已就绪。",
        confirmLabel: "确认推送并创建",
      };
    },
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

  const EXPORT_FALLBACK_NAMES: Record<string, string> = {
    docx: "导出文档",
    xlsx: "导出表格",
    pptx: "导出演示",
    md: "文档",
  };

  /** 判断字符串是否为绝对路径（Windows 盘符、/ 开头或 UNC）。 */
  const isAbsolutePath = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");

  /** 拼接目录与文件名（统一 / 分隔符）。 */
  const joinPath = (dir: string, fileName: string) => `${dir.replace(/[\\/]+$/, "")}/${fileName}`;

  /** child 是否落在 parent 之内（大小写不敏感；Windows 路径统一 / 分隔符）。 */
  const isWithin = (child: string, parent: string): boolean => {
    const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    const c = norm(child);
    const p = norm(parent);
    return c === p || c.startsWith(`${p}/`);
  };

  /** 确保文件名带正确扩展名（小写后缀判断，不破坏原大小写）。 */
  const ensureExtension = (fileName: string, ext: string) =>
    fileName.toLowerCase().endsWith(`.${ext}`) ? fileName : `${fileName}.${ext}`;

  /** 清洗文件名中的非法字符并截断，空则用兜底名，保证带扩展名。 */
  const sanitizeFileName = (raw: string, ext: string) =>
    ensureExtension(
      raw
        .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80) || (EXPORT_FALLBACK_NAMES[ext] ?? "导出"),
      ext
    );

  /** 解析产出根目录：项目会话优先用项目工作区；否则用「产出根目录」设置（未设则回退系统文档/Omni）。 */
  const resolveOutputBase = async (workspacePath: string): Promise<string> => {
    if (workspacePath) return workspacePath;
    return getEffectiveOutputRoot();
  };

  /** 解析导出输出路径：显式绝对路径直接用；否则自动落到项目目录或默认产物目录，并避免与已有文件冲突。 */
  const resolveExportPath = async (options: {
    pathArg?: string;
    ext: "docx" | "xlsx" | "pptx" | "md";
    specRaw: unknown;
    overwrite: boolean;
    workspacePath: string;
  }): Promise<string> => {
    const { pathArg, ext, specRaw, overwrite, workspacePath } = options;

    // ① 显式传了绝对路径：原样使用（仅补扩展名）
    if (pathArg && isAbsolutePath(pathArg)) {
      // 项目会话下，越界写入需用户确认（对齐 WorkBuddy「写操作围栏 + 提权确认」）。
      // 工作区内绝对路径或「无项目会话」（workspacePath 为空）直接放行。
      if (workspacePath && !isWithin(pathArg, workspacePath)) {
        const approved = await requestConfirmation({
          source: "export_out_of_workspace",
          title: "导出到工作区之外？",
          summary: "模型请求把文件写入项目工作区之外的位置。",
          riskLevel: "destructive",
          details: [
            { label: "目标路径", value: pathArg },
            { label: "项目工作区", value: workspacePath },
          ],
          targets: [pathArg],
          warning:
            "越界写入不受工作区围栏保护，文件将保存到项目目录之外。确认后 Omni 才会执行；取消则改用工作区内的自动路径。",
          confirmLabel: "仍要导出到此处",
        });
        if (!approved) {
          throw new Error("已取消：输出路径位于项目工作区之外且未获确认");
        }
      }
      return ensureExtension(pathArg, ext);
    }

    // 目录：项目会话优先用项目工作区；否则用「产出根目录」设置（未设则回退系统文档/Omni）。
    // 再自动按「项目 / 会话」分子目录，避免不同会话产物平铺混在一起。
    const base = await resolveOutputBase(workspacePath);
    let dir = base;
    if (base) {
      const session =
        runtime.activeChatId
          ? runtime.getChatSessionById(runtime.activeChatId)
          : null;
      dir = buildSessionOutputDir(base, runtime.activeProject?.title, session?.title ?? "", session?.id ?? "");
    }

    // ② 传了相对路径/纯文件名：拼到默认目录
    if (pathArg) {
      const file = sanitizeFileName(pathArg, ext);
      return dir ? joinPath(dir, file) : file;
    }

    // ③ 未传 path：从 spec 提取标题自动命名
    const spec = (specRaw && typeof specRaw === "object" ? specRaw : {}) as Record<string, unknown>;
    let name = "";
    if (ext === "docx") {
      name = String(spec.title ?? "");
    } else if (ext === "xlsx") {
      const sheets = (spec as { sheets?: Array<{ name?: unknown }> }).sheets;
      name = String(sheets?.[0]?.name ?? spec.title ?? "");
    } else {
      const slides = (spec as { slides?: Array<{ title?: unknown }> }).slides;
      name = String(spec.title ?? slides?.[0]?.title ?? "");
    }
    let file = sanitizeFileName(name, ext);
    if (!dir) return file;

    // 冲突避免：overwrite=false 且目标已存在时追加 -1、-2……
    if (!overwrite) {
      let candidate = joinPath(dir, file);
      let n = 1;
      while (await invoke<boolean>("path_exists", { path: candidate })) {
        const dot = file.lastIndexOf(".");
        const stem = dot > 0 ? file.slice(0, dot) : file;
        const suffix = dot > 0 ? file.slice(dot) : "";
        file = `${stem}-${n}${suffix}`;
        candidate = joinPath(dir, file);
        n += 1;
      }
      return candidate;
    }
    return joinPath(dir, file);
  };

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
        const pathArg = strArg(json, "path", "output", "file");
        const specRaw = json?.spec ?? json?.document ?? json?.data;
        if (specRaw === undefined || specRaw === null) {
          return { ok: false, error: `缺少 spec：请按 schema 提供${title}的结构化内容对象` };
        }
        const overwrite =
          typeof json?.overwrite === "boolean"
            ? json.overwrite
            : json?.overwrite === true || json?.overwrite === "true";
        try {
          const ext = tauriCommand === "export_docx" ? "docx" : tauriCommand === "export_xlsx" ? "xlsx" : "pptx";
          const ws = runtime.activeProject?.workspacePath ?? "";
          const path = await resolveExportPath({
            pathArg,
            ext,
            specRaw,
            overwrite,
            workspacePath: ws,
          });
          const outcome = await invoke<{ path: string; size: number }>(tauriCommand, {
            path,
            specJson: JSON.stringify(specRaw),
            overwrite,
            workspacePath: ws || null,
          });
          return {
            ok: true,
            outputText: `${title}已生成：${outcome.path}（${(outcome.size / 1024).toFixed(1)} KB）`,
            data: outcome,
            path: outcome.path,
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

  registerExportTool("export_docx", "Export Word", "/export_docx", "export_docx");
  registerExportTool("export_xlsx", "Export Excel", "/export_xlsx", "export_xlsx");
  registerExportTool("export_pptx", "Export PPT", "/export_pptx", "export_pptx");

  // ---- Markdown 导出：把正文直接落盘为 .md 文件（不渲染 OOXML） ----
  registry.register({
    id: "export_md",
    command: "/export_md",
    title: "Export Markdown",
    execute: async (resolvedCommand) => {
      const json = parseToolJsonArgs(resolvedCommand.args);
      const pathArg = strArg(json, "path", "output", "file");
      const content = strArg(json, "content", "markdown", "md", "text");
      if (!content || !content.trim()) {
        return { ok: false, error: "缺少 content：请提供要写入文件的 Markdown 正文" };
      }
      const overwrite =
        typeof json?.overwrite === "boolean"
          ? json.overwrite
          : json?.overwrite === true || json?.overwrite === "true";
      try {
        const ws = runtime.activeProject?.workspacePath ?? "";
        // 未给 title 时，用正文首行（去掉 #/标记）作为缺省文件名
        const rawTitle = String(json?.title ?? "");
        let title = rawTitle.trim();
        if (!title) {
          const firstLine =
            content
              .split(/\r?\n/)
              .map((l) => l.trim())
              .find((l) => l.length > 0) ?? "";
          title = firstLine.replace(/^#+\s*/, "").replace(/[*_`]/g, "").trim();
        }
        const path = await resolveExportPath({
          pathArg,
          ext: "md",
          specRaw: { title },
          overwrite,
          workspacePath: ws,
        });
        const outcome = await invoke<{ path: string; size: number; diff: FileDiff | null }>("write_text_file", {
          path,
          content,
          overwrite,
          workspacePath: ws || null,
        });
        return {
          ok: true,
          outputText: `Markdown 已生成：${outcome.path}（${(outcome.size / 1024).toFixed(1)} KB）`,
          data: outcome,
          path: outcome.path,
          artifact: {
            type: "file",
            title: outcome.path.split(/[\\/]/).pop() || "文档.md",
            path: outcome.path,
            size: outcome.size,
            content,
          },
          // 写前读基线、内存算出的 unified-diff（Rust 返回；超大文件为 null）
          fileDiff: outcome.diff ?? undefined,
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  // ---- 文件修改工具（Rust：filemod.rs write_file_tool / edit_file_tool）----
  // Codex 风格代码工作台核心：原子粒度写入 + 定点搜索替换，全部 diff 追踪、可在变更面板撤销。
  // 安全策略：工作区内静默执行；工作区外（绝对路径越界或未绑定工作区）走 HITL 确认门；
  // No-Go Zone（.ssh/AppData/Windows/Program Files）由 Rust 端无条件拒绝。

  function formatBytes(size: number): string {
    return size >= 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`;
  }

  function truncateForDisplay(text: string, max = 160): string {
    const single = text.replace(/\r?\n/g, "\\n");
    return single.length > max ? `${single.slice(0, max)}…` : single;
  }

  registry.register({
    id: "write_file",
    command: "/write_file",
    title: "Write File",
    execute: async (resolvedCommand) => {
      const json = parseToolJsonArgs(resolvedCommand.args);
      const path = strArg(json, "path", "file");
      const content = strArg(json, "content", "text", "body");
      const overwrite = json?.overwrite === true || json?.overwrite === "true";
      if (!path) return { ok: false, error: "用法：/write_file JSON{path, content, overwrite?}" };
      if (!content) return { ok: false, error: "缺少 content：请提供要写入的完整文件内容" };

      const ws = runtime.activeProject?.workspacePath || "";
      const outside = isOutsideWorkspace(path, ws);
      if (outside) {
        const approved = await requestConfirmation({
          source: "write_file",
          title: "写入工作区外的文件？",
          summary: "模型请求在项目工作区之外创建/覆盖文件。",
          riskLevel: "write",
          details: [{ label: "路径", value: path }],
          targets: [path],
          warning: "该路径不在项目工作区内。请确认文件位置符合预期；系统/密钥目录（AppData、.ssh 等）会被无条件拒绝。",
          confirmLabel: "确认写入",
        });
        if (!approved) {
          return { ok: false, error: "已取消：未确认写入工作区外的文件" };
        }
      }

      try {
        const outcome = await invoke<{
          path: string;
          size: number;
          created: boolean;
          replacements: number;
          diff: FileDiff | null;
          snapshotAvailable: boolean;
        }>("write_file_tool", {
          path,
          content,
          overwrite,
          workspacePath: ws || null,
          confirmedOutside: outside,
        });
        return {
          ok: true,
          outputText:
            `${outcome.created ? "已创建文件" : "已覆盖文件"}：${outcome.path}（${formatBytes(outcome.size)}）` +
            `。可在「变更」面板查看 diff 并撤销本次修改。`,
          data: outcome,
          path: outcome.path,
          artifact: { type: "file", title: outcome.path.split(/[\\/]/).pop() || "文件", path: outcome.path, size: outcome.size },
          fileDiff: outcome.diff ?? undefined,
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  registry.register({
    id: "edit_file",
    command: "/edit_file",
    title: "Edit File",
    execute: async (resolvedCommand) => {
      const json = parseToolJsonArgs(resolvedCommand.args);
      const path = strArg(json, "path", "file");
      const find = strArg(json, "find", "old_string", "search");
      const replace = strArg(json, "replace", "new_string");
      const replaceAll = json?.replace_all === true || json?.replace_all === "true" || json?.replaceAll === true;
      if (!path || find == null) {
        return { ok: false, error: "用法：/edit_file JSON{path, find, replace, replace_all?}。find 必须是从文件中精确复制的原文" };
      }
      if (replace == null) return { ok: false, error: "缺少 replace：请提供替换后的文本（删除内容可传空字符串）" };

      const ws = runtime.activeProject?.workspacePath || "";
      const outside = isOutsideWorkspace(path, ws);
      if (outside) {
        const approved = await requestConfirmation({
          source: "edit_file",
          title: "修改工作区外的文件？",
          summary: "模型请求对项目工作区之外的文件做定点替换。",
          riskLevel: "write",
          details: [
            { label: "路径", value: path },
            { label: "替换", value: `${truncateForDisplay(find)} → ${truncateForDisplay(replace)}` },
          ],
          targets: [path],
          warning: "该路径不在项目工作区内。请确认修改目标符合预期；系统/密钥目录会被无条件拒绝。",
          confirmLabel: "确认修改",
        });
        if (!approved) {
          return { ok: false, error: "已取消：未确认修改工作区外的文件" };
        }
      }

      try {
        const outcome = await invoke<{
          path: string;
          size: number;
          created: boolean;
          replacements: number;
          diff: FileDiff | null;
          snapshotAvailable: boolean;
        }>("edit_file_tool", {
          path,
          find,
          replace,
          replaceAll,
          workspacePath: ws || null,
          confirmedOutside: outside,
        });
        return {
          ok: true,
          outputText:
            `已修改文件：${outcome.path}（替换 ${outcome.replacements} 处，${formatBytes(outcome.size)}）` +
            `。可在「变更」面板查看 diff 并撤销本次修改。`,
          data: outcome,
          path: outcome.path,
          artifact: { type: "file", title: outcome.path.split(/[\\/]/).pop() || "文件", path: outcome.path, size: outcome.size },
          fileDiff: outcome.diff ?? undefined,
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  // ---- 自造技能安装（Rust：skillhub.rs install_local_skill） ----

  registry.register({
    id: "install_skill",
    command: "/install_skill",
    title: "Install Skill",
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
        const approved = await requestConfirmation({
          source: "install_skill",
          title: "安装技能插件？",
          summary: "模型请求安装一个技能插件（含可执行指令）。",
          riskLevel: "write",
          details: [
            { label: "技能", value: `${strArg(json, "name", "title") ?? id}（${id}）` },
          ],
          targets: [id],
          warning: "技能插件含指令，安装后会被注册并可能被执行。确认来源可信后再安装。",
          confirmLabel: "确认安装",
        });
        if (!approved) {
          return { ok: false, error: "已取消：未确认安装技能插件" };
        }
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

  registry.register({
    id: "bash",
    command: "/bash",
    title: "运行 Shell 命令",
    execute: async (resolvedCommand) => {
      const json = parseToolJsonArgs(resolvedCommand.args);
      const command = strArg(json, "command") ?? resolvedCommand.args.trim();
      if (!command) return { ok: false, error: "用法：/bash JSON{\"command\":\"...\"}" };

      // 危险命令黑名单：直接拦截，不弹确认（对齐「Warn + List + Confirm」铁律）。
      const DANGEROUS_PATTERNS = [
        /\brm\s+-rf?\b/i,
        /\brm\b.*-r.*-f/i,
        /\brd\b.*\/s/i,
        /\bdel\b.*\/[sq]/i,
        /\bformat\s+[a-z]:/i,
        /\bshutdown\b/i,
        /\bhalt\b/i,
        /\breboot\b/i,
        /\bmkfs\b/i,
        /:\s*\(\)\s*\{.*\}\s*;/, // fork bomb
        /\bdd\s+if=.*of=\/dev\//i,
        /\bchmod\s+-r\s+777\s+\//i,
        /\bcurl\b.*\|\s*(sudo\s+)?(ba)?sh\b/i,
        /\bwget\b.*\|\s*(sudo\s+)?(ba)?sh\b/i,
        // Windows / PowerShell 高危补充：账号/网络配置/注册表/持久化/系统状态破坏。
        /\bnet\s+(user|localgroup)\b/i,                          // 账号与用户组操作
        /\bnetsh\b/i,                                            // 防火墙/代理/接口配置
        /\breg\s+(add|delete|import)\b/i,                        // 注册表写入/删除
        /\bschtasks\b/i,                                         // 计划任务（持久化惯用）
        /\bdiskpart\b/i,                                         // 磁盘分区
        /\bbcdedit\b/i,                                          // 启动配置
        /\bvssadmin\b[\s\S]*\bdelete\b/i,                        // 删卷影副本（勒索软件惯用）
        /\bwevtutil\b\s+cl\b/i,                                  // 清空事件日志
        /\bcipher\b\s+\/w\b/i,                                   // 擦除空闲空间
        /\bwmic\b[\s\S]*\bdelete\b/i,                            // WMI 对象删除
        /\bremove-item\b(?=[\s\S]*-recurse)(?=[\s\S]*-force)/i,  // PowerShell 版 rm -rf
        /\|\s*(iex|invoke-expression)\b/i,                       // 管道注入执行
        /\biex\b\s*\(|\binvoke-expression\b/i,                   // 直接执行表达式
        /(^|\s)-enc(odedcommand)?\b/i,                           // 编码命令混淆执行
        /\b(irm|invoke-restmethod|iwr|invoke-webrequest)\b[\s\S]*\|\s*(iex|invoke-expression)\b/i, // PS 下载即执行
      ];
      if (DANGEROUS_PATTERNS.some((re) => re.test(command))) {
        return {
          ok: false,
          error: "该命令被安全策略拦截（疑似破坏性/高危操作）：" + command,
        };
      }

      // 工作目录锁定到项目工作区（缺省回落由 Rust 端处理）。
      const cwd = runtime.activeProject?.workspacePath || null;

      // 自定义 Shell 路径（设置 → 命令执行）：非空时覆盖 Rust 端的自动探测。
      let shellPath: string | null = null;
      try {
        shellPath = loadBasicSettings(BASIC_SETTINGS_STORAGE_KEY, DEFAULT_BASIC_SETTINGS).shellPath?.trim() || null;
      } catch {
        shellPath = null;
      }

      // 只读命令快通道：对齐 Codex is_known_safe_command —— 明确只读的命令跳过确认门直接执行；
      // 其余（含可疑 shell 元字符、非白名单可执行）仍走 HITL 确认（保守默认）。
      const autoApproved = isKnownSafeCommand(command);

      try {
        let approved = true;
        if (!autoApproved) {
          approved = await requestConfirmation({
            source: "bash",
            title: "执行本地命令？",
            summary: "模型请求在本机运行一条 shell 命令（腾讯新闻等 CLI 技能需要）。",
            riskLevel: "write",
            details: [
              { label: "命令", value: command },
              ...(cwd ? [{ label: "工作目录", value: cwd }] : []),
            ],
            targets: [command],
            warning: "命令将在你的本机执行。请确认来源可信、命令符合预期后再允许；高危命令将被自动拦截。",
            confirmLabel: "确认执行",
          });
        }
        if (!approved) {
          return { ok: false, error: "已取消：未确认执行本地命令" };
        }

        const result = await invoke<{
          exitCode: number;
          output: string;
          timedOut: boolean;
        }>("execute_command", {
          command,
          cwd,
          shellPath,
          timeoutMs: 120_000,
        });

        if (result.timedOut) {
          return {
            ok: true,
            outputText: `（命令超时，已被终止）\n${result.output}`,
            data: { exitCode: result.exitCode, timedOut: true },
          };
        }
        if (result.exitCode !== 0) {
          // 方案C：识别「命令未找到」类报错，附加改用引导，减少模型在 Windows 下无效重试。
          const missing = missingCommandFrom(result.output);
          const hint = missing ? buildMissingCommandHint(missing) : "";
          return {
            ok: true,
            outputText: `（退出码 ${result.exitCode}）\n${result.output}${hint}`,
            data: { exitCode: result.exitCode },
          };
        }
        return {
          ok: true,
          outputText: result.output || "（命令执行成功，无输出）",
          data: { exitCode: 0 },
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
