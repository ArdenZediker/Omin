import { TOOL_MANIFESTS } from "../config/manifests/tools";

export type LocalSlashCommand = {
  id: string;
  command: string;
  title: string;
  description: string;
};

export type ResolvedLocalSlashCommand = LocalSlashCommand & {
  args: string;
};

export const LOCAL_SLASH_COMMANDS: LocalSlashCommand[] = TOOL_MANIFESTS.filter((tool) => tool.command).map((tool) => ({
  id: tool.id,
  command: tool.command as string,
  title: tool.title,
  description: tool.description,
}));

export type SlashSuggestion =
  | { kind: "local"; id: string; command: string; title: string; description: string };

export function getMatchingSlashSuggestions(input: string): SlashSuggestion[] {
  const normalized = input.trim().toLowerCase();
  if (!normalized.startsWith("/")) {
    return [];
  }

  const query = normalized.slice(1);
  return LOCAL_SLASH_COMMANDS.filter((item) => {
    return item.command.startsWith(normalized) || item.title.toLowerCase().includes(query) || item.description.toLowerCase().includes(query);
  }).map((item) => ({ kind: "local", ...item }));
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
