import { BUILTIN_SKILL_PLUGINS, BUILTIN_TOOL_PLUGINS } from "../plugins/builtins";
import { pluginRegistry } from "../plugins/registry";
import type { PluginSkillContribution, PluginToolContribution } from "../plugins/types";

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

/** 内置工具命令（保留导出用于兼容旧代码）。 */
export const LOCAL_TOOL_COMMANDS: LocalSlashCommand[] = BUILTIN_TOOL_PLUGINS.map((manifest) =>
  toolToLocalCommand({
    id: manifest.id,
    command: manifest.command,
    title: manifest.name,
    description: manifest.description,
    promptContribution: manifest.promptContribution,
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

export const ALL_LOCAL_COMMANDS = [...LOCAL_TOOL_COMMANDS, ...LOCAL_SKILL_COMMANDS];

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

  const toolSuggestions = getAllToolCommands().filter((item) => {
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
  const definition = getAllSkillCommands().find((item) => item.command === command.toLowerCase());
  if (!definition) return null;

  return {
    ...definition,
    args: rest.join(" ").trim(),
  };
}

export function buildSlashDraft(suggestion: { command: string }) {
  return `${suggestion.command} `;
}
