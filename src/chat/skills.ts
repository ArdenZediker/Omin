import type { SlashSkill } from "./types";

export type LocalSlashCommand = {
  id: string;
  command: string;
  title: string;
  description: string;
};

export type ResolvedLocalSlashCommand = LocalSlashCommand & {
  args: string;
};

export const PROMPT_SLASH_SKILLS: SlashSkill[] = [
  {
    id: "summarize",
    command: "/summarize",
    title: "总结",
    description: "总结重点、结论和后续行动",
    promptPrefix: "请总结下面的内容，输出重点、结论和后续行动建议：\n\n",
  },
  {
    id: "translate",
    command: "/translate",
    title: "翻译",
    description: "翻译成自然、准确的中文",
    promptPrefix: "请把下面的内容翻译成自然、准确的中文：\n\n",
  },
  {
    id: "rewrite",
    command: "/rewrite",
    title: "改写",
    description: "改写为更清晰、更专业的表达",
    promptPrefix: "请在不改变原意的前提下，重写下面的内容，让它更专业、清晰、简洁：\n\n",
  },
  {
    id: "explain",
    command: "/explain",
    title: "解释",
    description: "解释概念、代码或报错内容",
    promptPrefix: "请解释下面的内容，并补充关键背景与注意事项：\n\n",
  },
  {
    id: "compare",
    command: "/compare",
    title: "对比",
    description: "对比方案并说明取舍",
    promptPrefix: "请对比下面提到的方案，输出优点、缺点、适用场景和建议：\n\n",
  },
];

export const LOCAL_SLASH_COMMANDS: LocalSlashCommand[] = [
  { id: "new", command: "/new", title: "新对话", description: "新建一个空白对话" },
  { id: "clear", command: "/clear", title: "清空消息", description: "清空当前对话中的消息" },
  { id: "settings", command: "/settings", title: "打开设置", description: "打开设置页面" },
  { id: "model", command: "/model", title: "切换模型", description: "按模型 ID 或名称切换模型" },
  { id: "rename", command: "/rename", title: "重命名对话", description: "重命名当前对话" },
  { id: "pin", command: "/pin", title: "置顶对话", description: "置顶或取消置顶当前对话" },
  { id: "search_sessions", command: "/search_sessions", title: "搜索会话", description: "按标题或消息内容搜索本地会话" },
  { id: "read_session", command: "/read_session", title: "读取会话", description: "按会话 ID 读取本地会话内容" },
  { id: "list_files", command: "/list_files", title: "列出文件", description: "列出当前工作区文件和目录" },
  { id: "read_file", command: "/read_file", title: "读取文件", description: "按相对路径读取当前工作区文件内容" },
  { id: "search_files", command: "/search_files", title: "搜索文件", description: "在当前工作区文件内容中搜索关键字" },
  { id: "analyze_files", command: "/analyze_files", title: "分析文件", description: "搜索相关文件后读取并让模型总结结果" },
];

export type SlashSuggestion =
  | { kind: "skill"; id: string; command: string; title: string; description: string }
  | { kind: "local"; id: string; command: string; title: string; description: string };

export function getMatchingSlashSuggestions(input: string): SlashSuggestion[] {
  const normalized = input.trim().toLowerCase();
  if (!normalized.startsWith("/")) {
    return [];
  }

  const query = normalized.slice(1);
  const matches = <T extends { id: string; command: string; title: string; description: string }>(
    items: T[],
    kind: SlashSuggestion["kind"]
  ) =>
    items
      .filter((item) => {
        return (
          item.command.startsWith(normalized) ||
          item.title.toLowerCase().includes(query) ||
          item.description.toLowerCase().includes(query)
        );
      })
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

export function resolveLocalSlashCommand(input: string): ResolvedLocalSlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const [command, ...rest] = trimmed.split(/\s+/);
  const definition = LOCAL_SLASH_COMMANDS.find((item) => item.command === command.toLowerCase());
  if (!definition) return null;

  return {
    ...definition,
    args: rest.join(" ").trim(),
  };
}

export function buildSlashDraft(suggestion: { command: string }) {
  return `${suggestion.command} `;
}
