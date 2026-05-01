import { SKILL_MANIFESTS } from "../config/manifests/skills";
import { TOOL_MANIFESTS } from "../config/manifests/tools";
import type { AssistantKind, SlashSkill } from "./types";

export type LocalSlashCommand = {
  id: string;
  command: string;
  title: string;
  description: string;
};

export type ResolvedLocalSlashCommand = LocalSlashCommand & {
  args: string;
};

export const PROMPT_SLASH_SKILLS: SlashSkill[] = SKILL_MANIFESTS.map((skill) => ({
  id: skill.id,
  command: skill.command,
  title: skill.title,
  description: skill.description,
  promptPrefix: skill.promptPrefix,
  systemPrompt: skill.systemPrompt,
}));

export const LOCAL_SLASH_COMMANDS: LocalSlashCommand[] = TOOL_MANIFESTS.filter((tool) => tool.command).map((tool) => ({
  id: tool.id,
  command: tool.command as string,
  title: tool.title,
  description: tool.description,
}));

export type SlashSuggestion =
  | { kind: "skill"; id: string; command: string; title: string; description: string }
  | { kind: "local"; id: string; command: string; title: string; description: string };

export function getMatchingSlashSuggestions(input: string, options?: { assistantKind?: AssistantKind | null }): SlashSuggestion[] {
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
        return item.command.startsWith(normalized) || item.title.toLowerCase().includes(query) || item.description.toLowerCase().includes(query);
      })
      .map((item) => ({ kind, ...item }) as SlashSuggestion);

  const allowedSkillIds =
    options?.assistantKind == null
      ? null
      : SKILL_MANIFESTS.filter(
          (skill) => !skill.supportedAssistantKinds || skill.supportedAssistantKinds.includes(options.assistantKind as AssistantKind)
        ).map((skill) => skill.id);

  const skillCandidates =
    allowedSkillIds == null ? PROMPT_SLASH_SKILLS : PROMPT_SLASH_SKILLS.filter((skill) => allowedSkillIds.includes(skill.id));

  return [...matches(LOCAL_SLASH_COMMANDS, "local"), ...matches(skillCandidates, "skill")];
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
