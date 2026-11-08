import { pluginRegistry } from "../plugins/registry";
import type { PluginToolContribution } from "../plugins/types";
import { isUserInvocable, type InvocationPolicy } from "../plugins/invocation";
import { isLocalSlashCommand } from "./localTools";
import { assembleSkillCatalog, type SkillCatalogEntry } from "./skillCatalog";
import {
  getMatchingBuiltinCommands,
  type BuiltinCommandId,
  type BuiltinCommandKind,
} from "./builtinCommands";

export type LocalSlashCommand = {
  id: string;
  command: string;
  title: string;
  description: string;
  kind: "tool" | "skill";
  systemPrompt?: string;
  promptPrefix?: string;
  whenToUse?: string;
  resourceBase?: string;
  invocation?: InvocationPolicy;
};

export type ResolvedLocalSlashCommand = LocalSlashCommand & {
  args: string;
};

function skillToLocalCommand(skill: SkillCatalogEntry): LocalSlashCommand {
  return {
    id: skill.id,
    command: skill.command,
    title: skill.name,
    description: skill.description,
    kind: "skill",
    systemPrompt: skill.body,
    promptPrefix: skill.manifest.promptPrefix,
    whenToUse: skill.whenToUse,
    resourceBase: skill.resourceBase,
    invocation: skill.invocation,
  };
}

function toolToLocalCommand(tool: PluginToolContribution): LocalSlashCommand {
  return {
    id: tool.id,
    command: tool.command ?? `/${tool.id}`,
    title: tool.title,
    description: tool.description,
    kind: "tool",
    invocation: tool.invocation,
  };
}

/** 全部可用技能命令 = 内置 + 插件市场已安装且启用。 */
export function getAllSkillCommands(): LocalSlashCommand[] {
  return assembleSkillCatalog().entries.map(skillToLocalCommand);
}

/** 全部可用工具命令 = 内置 + 插件市场已安装且启用。 */
export function getAllToolCommands(): LocalSlashCommand[] {
  return pluginRegistry.toToolManifests().map(toolToLocalCommand);
}

/**
 * 同一命令或同一展示名只保留一个定义。
 *
 * 任务型技能比通用工具更具体，因此命令冲突时优先技能；同来源保持原有顺序。
 * 补全、模式识别和实际执行都从这里取结果，避免 UI 留一个、执行走另一个。
 */
export function dedupeLocalCommands(commands: LocalSlashCommand[]): LocalSlashCommand[] {
  const winners = new Map<string, { command: LocalSlashCommand; index: number; priority: number }>();

  commands.forEach((command, index) => {
    const key = command.command.trim().toLowerCase();
    const priority = command.kind === "skill" ? 0 : 1;
    const current = winners.get(key);
    if (!current || priority < current.priority) {
      winners.set(key, { command, index, priority });
    }
  });

  const titleWinners = new Map<string, { command: LocalSlashCommand; index: number; priority: number }>();
  [...winners.values()]
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .forEach((winner) => {
      const titleKey = winner.command.title.trim().replace(/\s+/g, " ").toLowerCase()
        || winner.command.id.trim().toLowerCase();
      if (!titleWinners.has(titleKey)) {
        titleWinners.set(titleKey, winner);
      }
    });

  return [...titleWinners.values()]
    .sort((left, right) => left.index - right.index)
    .map((winner) => winner.command);
}

/** 全部本地命令 = 工具 + 技能（含已安装插件）。 */
export function getAllLocalCommands(): LocalSlashCommand[] {
  return dedupeLocalCommands([...getAllToolCommands(), ...getAllSkillCommands()]);
}

/**
 * 这条命令能不能被用户手敲执行？**补全与解析必须共用这一个判据。**
 *
 * - 技能：能 —— `taskExecutor` 的技能分支直接用它的 systemPrompt 驱动一轮对话。
 * - 工具：只有 `localTools` 里真有执行器的才行。`agent` 是例外 —— 它由模型
 *   function calling 触发（`useChatRuntime` 对 `toolCall.name === "agent"` 特判走
 *   `runSubAgent`），没有本地执行器，手敲只会得到「暂不支持命令」。
 *
 * 曾经这里只按 `getAllSkillCommands()` 找，把**工具那半个斜杠体系整体掐断**：
 * 21 个带 `/命令` 的执行器（`/bash`、`/write_file`、`/git_commit`…）全都不再可达，
 * 而 `taskExecutor` 里处理工具命令的分支成了死代码。所以判据只允许有一处。
 */
export function isRunnableLocalCommand(item: Pick<LocalSlashCommand, "kind" | "command">): boolean {
  return item.kind === "skill" || isLocalSlashCommand(item.command);
}

export type SlashSuggestion = {
  kind: "builtin" | "local";
  commandKind: BuiltinCommandKind | "tool" | "skill";
  builtinId?: BuiltinCommandId;
  id: string;
  command: string;
  title: string;
  description: string;
};

export type SlashTrigger = {
  start: number;
  end: number;
  query: string;
  leading: boolean;
};

const SLASH_BOUNDARY_PATTERN = /[\s,，.。!?！？;；:：、([{"'`“”‘’「」『』【】]/u;
const URL_SCHEME_PATTERN = /[A-Za-z][A-Za-z0-9+.-]*:$/;

/**
 * 找出当前光标所在位置的斜杠命令 token。
 *
 * DSH 的触发点跟着 caret 走，而不是要求整段草稿以 `/` 开头：
 * - `/` 必须位于开头、空白或常见标点之后；
 * - `/` 与 caret 之间不能出现空白，避免命令已经有参数时菜单还挂着；
 * - `https://`、`//`、`C:/` 等路径/URL 不触发。
 */
export function getSlashTrigger(value: string, caretIndex: number): SlashTrigger | null {
  const safeCaretIndex = Math.max(0, Math.min(caretIndex, value.length));
  const prefix = value.slice(0, safeCaretIndex);
  const slashIndex = prefix.lastIndexOf("/");
  if (slashIndex < 0) {
    return null;
  }

  const query = prefix.slice(slashIndex + 1);
  if (/\s/.test(query)) {
    return null;
  }

  const beforeSlash = value.slice(0, slashIndex);
  if (beforeSlash.endsWith("/") || URL_SCHEME_PATTERN.test(beforeSlash)) {
    return null;
  }

  if (beforeSlash.length > 0 && !SLASH_BOUNDARY_PATTERN.test(beforeSlash.slice(-1))) {
    return null;
  }

  return {
    start: slashIndex,
    end: safeCaretIndex,
    query,
    leading: slashIndex === 0,
  };
}

export function getMatchingSlashSuggestions(
  input: string,
  allowedToolIds?: string[] | null,
  allowedSkillIds?: string[] | null
): SlashSuggestion[] {
  const normalized = input.trim().toLowerCase();
  // 参数既兼容旧的 `/rea` 形式，也接受 ChatInput 传进来的当前 token query `rea`。
  const query = normalized.startsWith("/") ? normalized.slice(1) : normalized;
  const allowedToolIdSet = allowedToolIds ? new Set(allowedToolIds) : null;
  const allowedSkillIdSet = allowedSkillIds ? new Set(allowedSkillIds) : null;

  const builtinSuggestions = getMatchingBuiltinCommands(query).map((item) => ({
    kind: "builtin" as const,
    commandKind: item.commandKind,
    builtinId: item.id,
    id: item.id,
    command: item.command,
    title: item.title,
    description: item.description,
  }));
  const reservedCommands = new Set(builtinSuggestions.map((item) => item.command.toLocaleLowerCase()));
  const reservedTitles = new Set(
    builtinSuggestions.map((item) => item.title.trim().replace(/\s+/g, " ").toLocaleLowerCase())
  );

  const localSuggestions = getAllLocalCommands().filter((item) => {
    if (!isRunnableLocalCommand(item) || !isUserInvocable(item.invocation)) {
      return false;
    }
    if (
      reservedCommands.has(item.command.toLocaleLowerCase())
      || reservedTitles.has(item.title.trim().replace(/\s+/g, " ").toLocaleLowerCase())
    ) {
      return false;
    }
    if (item.kind === "tool" && allowedToolIdSet && !allowedToolIdSet.has(item.id)) {
      return false;
    }
    if (item.kind === "skill" && allowedSkillIdSet && !allowedSkillIdSet.has(item.id)) {
      return false;
    }
    return (
      (!query || item.command.slice(1).toLowerCase().startsWith(query)) ||
      item.title.toLowerCase().includes(query) ||
      item.description.toLowerCase().includes(query)
    );
  }).map((item) => ({
    kind: "local" as const,
    commandKind: item.kind,
    id: item.id,
    command: item.command,
    title: item.title,
    description: item.description,
  }));

  return [...builtinSuggestions, ...localSuggestions];
}

export function resolveLocalSlashCommand(input: string): ResolvedLocalSlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const [command, ...rest] = trimmed.split(/\s+/);
  // 与补全共用同一个判据：技能与有本地执行器的工具都可手敲执行；
  // 无本地执行器的（`agent`）返回 null，让这句话照常走模型那一轮。
  const definition = getAllLocalCommands().find(
    (item) =>
      item.command === command.toLowerCase() &&
      isRunnableLocalCommand(item) &&
      isUserInvocable(item.invocation)
  );
  if (!definition) return null;

  return {
    ...definition,
    args: rest.join(" ").trim(),
  };
}

export function buildSlashDraft(suggestion: { command: string }) {
  return `${suggestion.command} `;
}
