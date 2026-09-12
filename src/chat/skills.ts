import { BUILTIN_SKILL_PLUGINS } from "../plugins/builtins";
import { pluginRegistry } from "../plugins/registry";
import type { PluginSkillContribution, PluginToolContribution } from "../plugins/types";
import { isLocalSlashCommand } from "./localTools";

export type LocalSlashCommand = {
  id: string;
  command: string;
  title: string;
  description: string;
  kind: "tool" | "skill";
  systemPrompt?: string;
  promptPrefix?: string;
};

export type ResolvedLocalSlashCommand = LocalSlashCommand & {
  args: string;
};

function skillToLocalCommand(skill: PluginSkillContribution): LocalSlashCommand {
  return {
    id: skill.id,
    command: skill.command,
    title: skill.title,
    description: skill.description,
    kind: "skill",
    systemPrompt: skill.systemPrompt,
    promptPrefix: skill.promptPrefix,
  };
}

function toolToLocalCommand(tool: PluginToolContribution): LocalSlashCommand {
  return {
    id: tool.id,
    command: tool.command ?? `/${tool.id}`,
    title: tool.title,
    description: tool.description,
    kind: "tool",
  };
}

/** 内置技能命令（保留导出用于兼容旧代码与测试）。 */
export const LOCAL_SKILL_COMMANDS: LocalSlashCommand[] = BUILTIN_SKILL_PLUGINS.map((manifest) =>
  skillToLocalCommand({
    id: manifest.id,
    command: manifest.command ?? `/${manifest.id}`,
    title: manifest.name,
    description: manifest.description,
    systemPrompt: manifest.systemPrompt,
    promptPrefix: manifest.promptPrefix,
  })
);

/** 全部可用技能命令 = 内置 + 插件市场已安装且启用。 */
export function getAllSkillCommands(): LocalSlashCommand[] {
  return pluginRegistry.toSkillCommands().map(skillToLocalCommand);
}

/** 全部可用工具命令 = 内置 + 插件市场已安装且启用。 */
export function getAllToolCommands(): LocalSlashCommand[] {
  return pluginRegistry.toToolManifests().map(toolToLocalCommand);
}

/** 全部本地命令 = 工具 + 技能（含已安装插件）。 */
export function getAllLocalCommands(): LocalSlashCommand[] {
  return [...getAllToolCommands(), ...getAllSkillCommands()];
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
  kind: "local";
  commandKind: "tool" | "skill";
  id: string;
  command: string;
  title: string;
  description: string;
};

export function getMatchingSlashSuggestions(
  input: string,
  allowedToolIds?: string[] | null,
  allowedSkillIds?: string[] | null
): SlashSuggestion[] {
  const normalized = input.trim().toLowerCase();
  if (!normalized.startsWith("/")) {
    return [];
  }

  const query = normalized.slice(1);
  const allowedToolIdSet = allowedToolIds ? new Set(allowedToolIds) : null;
  const allowedSkillIdSet = allowedSkillIds ? new Set(allowedSkillIds) : null;

  // 无本地执行器的工具（`agent`）不进补全：敲出来只会是「暂不支持命令」，
  // 而它真正的用法是由模型自己 function calling 触发。
  const toolSuggestions = getAllToolCommands()
    .filter((item) => isRunnableLocalCommand(item))
    .filter((item) => {
      if (allowedToolIdSet && !allowedToolIdSet.has(item.id)) {
        return false;
      }
      return (
        item.command.startsWith(normalized) ||
        item.title.toLowerCase().includes(query) ||
        item.description.toLowerCase().includes(query)
      );
    });

  const skillSuggestions = getAllSkillCommands().filter((item) => {
    if (allowedSkillIdSet && !allowedSkillIdSet.has(item.id)) {
      return false;
    }
    return (
      item.command.startsWith(normalized) ||
      item.title.toLowerCase().includes(query) ||
      item.description.toLowerCase().includes(query)
    );
  });

  return [...toolSuggestions, ...skillSuggestions].map((item) => ({
    kind: "local",
    commandKind: item.kind,
    id: item.id,
    command: item.command,
    title: item.title,
    description: item.description,
  }));
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
    (item) => item.command === command.toLowerCase() && isRunnableLocalCommand(item)
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
