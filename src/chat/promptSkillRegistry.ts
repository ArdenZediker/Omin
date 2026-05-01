import type { SlashSkill } from "./types";
import { SKILL_MANIFESTS } from "../config/manifests/skills";

export type ResolvedPromptSkill = {
  skill: SlashSkill;
  payload: string;
  content: string;
};

export class PromptSkillRegistry {
  private skills = new Map<string, SlashSkill>();

  register(skill: SlashSkill) {
    this.skills.set(skill.command, skill);
  }

  get(command: string) {
    return this.skills.get(command) ?? null;
  }

  list() {
    return Array.from(this.skills.values());
  }

  resolve(input: string): ResolvedPromptSkill | null {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) {
      return null;
    }

    const [command, ...rest] = trimmed.split(/\s+/);
    const skill = this.get(command.toLowerCase());
    if (!skill) {
      return null;
    }

    const payload = rest.join(" ").trim();
    if (!payload) {
      return {
        skill,
        payload,
        content: input,
      };
    }

    return {
      skill,
      payload,
      content: `${skill.promptPrefix ?? ""}${payload}`.trim(),
    };
  }
}

export function createPromptSkillRegistry() {
  const registry = new PromptSkillRegistry();
  for (const skill of SKILL_MANIFESTS) {
    registry.register({
      id: skill.id,
      command: skill.command,
      title: skill.title,
      description: skill.description,
      promptPrefix: skill.promptPrefix,
      systemPrompt: skill.systemPrompt,
    });
  }
  return registry;
}
