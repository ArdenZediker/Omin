import { describe, expect, it } from "vitest";
import { LOCAL_SKILL_COMMANDS, getMatchingSlashSuggestions, resolveLocalSlashCommand } from "./skills";

describe("skills", () => {
  it("每个技能命令都有场景系统提示词", () => {
    expect(LOCAL_SKILL_COMMANDS.length).toBeGreaterThan(0);
    expect(LOCAL_SKILL_COMMANDS.every((skill) => Boolean(skill.systemPrompt?.trim()))).toBe(true);
  });

  it("解析技能命令并保留技能系统提示词", () => {
    const command = resolveLocalSlashCommand("/translate hello");

    expect(command?.kind).toBe("skill");
    expect(command?.args).toBe("hello");
    expect(command?.systemPrompt).toContain("当前任务是翻译");
  });

  it("按权限过滤技能建议", () => {
    const suggestions = getMatchingSlashSuggestions("/t", [], ["translate"]);

    expect(suggestions.map((item) => item.command)).toEqual(["/translate"]);
  });
});
