import { TOOL_MANIFESTS } from "../config/manifests/tools";

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

export const LOCAL_SLASH_COMMANDS: LocalSlashCommand[] = TOOL_MANIFESTS.filter((tool) => tool.command).map((tool) => ({
  id: tool.id,
  command: tool.command as string,
  title: tool.title,
  description: tool.description,
  kind: "tool",
}));

export const LOCAL_SKILL_COMMANDS: LocalSlashCommand[] = [
  {
    id: "summarize",
    command: "/summarize",
    title: "总结",
    description: "总结当前输入或最近对话",
    kind: "skill",
    promptPrefix: "请总结下面内容，保留关键结论、约束和待办：",
  },
  {
    id: "rewrite",
    command: "/rewrite",
    title: "改写",
    description: "改写当前输入，使表达更清晰自然",
    kind: "skill",
    promptPrefix: "请改写下面内容，让表达更清晰、自然、可直接使用：",
  },
  {
    id: "translate",
    command: "/translate",
    title: "翻译",
    description: "翻译当前输入，未指定语言时默认翻译成中文",
    kind: "skill",
    promptPrefix: "请翻译下面内容；如果用户没有指定目标语言，默认翻译成中文：",
  },
  {
    id: "explain",
    command: "/explain",
    title: "解释",
    description: "解释概念、代码或文本",
    kind: "skill",
    promptPrefix: "请解释下面内容，说明背景、关键点和容易误解的地方：",
  },
  {
    id: "compare",
    command: "/compare",
    title: "比较",
    description: "比较多个方案、概念或文本差异",
    kind: "skill",
    promptPrefix: "请比较下面内容，给出差异、优缺点和推荐结论：",
  },
];

export const ALL_LOCAL_COMMANDS = [...LOCAL_SLASH_COMMANDS, ...LOCAL_SKILL_COMMANDS];

export type SlashSuggestion =
  | { kind: "local"; commandKind: "tool" | "skill"; id: string; command: string; title: string; description: string };

export function getMatchingSlashSuggestions(input: string, allowedToolIds?: string[] | null, allowedSkillIds?: string[] | null): SlashSuggestion[] {
  const normalized = input.trim().toLowerCase();
  if (!normalized.startsWith("/")) {
    return [];
  }

  const query = normalized.slice(1);
  const allowedToolIdSet = allowedToolIds ? new Set(allowedToolIds) : null;
  const allowedSkillIdSet = allowedSkillIds ? new Set(allowedSkillIds) : null;
  return ALL_LOCAL_COMMANDS.filter((item) => {
    if (item.kind === "tool" && allowedToolIdSet && !allowedToolIdSet.has(item.id)) {
      return false;
    }
    if (item.kind === "skill" && allowedSkillIdSet && !allowedSkillIdSet.has(item.id)) {
      return false;
    }
    return item.command.startsWith(normalized) || item.title.toLowerCase().includes(query) || item.description.toLowerCase().includes(query);
  }).map((item) => ({
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
  const definition = ALL_LOCAL_COMMANDS.find((item) => item.command === command.toLowerCase());
  if (!definition) return null;

  return {
    ...definition,
    args: rest.join(" ").trim(),
  };
}

export function buildSlashDraft(suggestion: { command: string }) {
  return `${suggestion.command} `;
}
