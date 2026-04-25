import type { SlashSkill } from "./types";

export type LocalSlashCommand = {
  id: string;
  command: string;
  title: string;
  description: string;
};

export const PROMPT_SLASH_SKILLS: SlashSkill[] = [
  {
    id: "summarize",
    command: "/summarize",
    title: "总结",
    description: "提炼重点、结论和待办",
    promptPrefix: "请总结下面的内容，输出重点、结论和后续行动建议：\n\n",
  },
  {
    id: "translate",
    command: "/translate",
    title: "翻译",
    description: "翻译为更自然的中文",
    promptPrefix: "请把下面的内容翻译成自然、准确的中文：\n\n",
  },
  {
    id: "rewrite",
    command: "/rewrite",
    title: "改写",
    description: "润色成更专业清晰的表达",
    promptPrefix: "请在不改变原意的前提下，重写下面的内容，让它更专业、清晰、简洁：\n\n",
  },
  {
    id: "explain",
    command: "/explain",
    title: "解释",
    description: "解释概念、代码或报错",
    promptPrefix: "请解释下面的内容，并补充关键背景与注意事项：\n\n",
  },
  {
    id: "compare",
    command: "/compare",
    title: "对比",
    description: "比较两种方案的优劣",
    promptPrefix: "请对比下面提到的方案，输出优点、缺点、适用场景和建议：\n\n",
  },
];

export const LOCAL_SLASH_COMMANDS: LocalSlashCommand[] = [
  {
    id: "new",
    command: "/new",
    title: "新对话",
    description: "立即开始一个空白会话",
  },
  {
    id: "clear",
    command: "/clear",
    title: "清空消息",
    description: "清空当前消息区内容",
  },
  {
    id: "settings",
    command: "/settings",
    title: "打开设置",
    description: "切到设置页面",
  },
];

export type SlashSuggestion =
  | { kind: "skill"; id: string; command: string; title: string; description: string }
  | { kind: "local"; id: string; command: string; title: string; description: string };

export function getMatchingSlashSuggestions(input: string): SlashSuggestion[] {
  const normalized = input.trim().toLowerCase();
  if (!normalized.startsWith("/")) {
    return [];
  }

  const matches = <T extends { id: string; command: string; title: string; description: string }>(
    items: T[],
    kind: SlashSuggestion["kind"]
  ) =>
    items
      .filter((item) => item.command.startsWith(normalized) || item.title.toLowerCase().includes(normalized.slice(1)))
      .map((item) => ({ kind, ...item }) as SlashSuggestion);

  return [...matches(LOCAL_SLASH_COMMANDS, "local"), ...matches(PROMPT_SLASH_SKILLS, "skill")];
}

export function resolveSlashSkillPrompt(input: string): { content: string; skill: SlashSkill | null } {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return { content: input, skill: null };
  }

  const [command, ...rest] = trimmed.split(/\s+/);
  const skill = PROMPT_SLASH_SKILLS.find((item) => item.command === command.toLowerCase());
  if (!skill) {
    return { content: input, skill: null };
  }

  const payload = rest.join(" ").trim();
  if (!payload) {
    return { content: input, skill };
  }

  return {
    content: `${skill.promptPrefix ?? ""}${payload}`.trim(),
    skill,
  };
}

export function resolveLocalSlashCommand(input: string): LocalSlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const [command] = trimmed.split(/\s+/);
  return LOCAL_SLASH_COMMANDS.find((item) => item.command === command.toLowerCase()) ?? null;
}

export function buildSlashDraft(suggestion: { command: string }) {
  return `${suggestion.command} `;
}
