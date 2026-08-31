import { describe, expect, it } from "vitest";
import { LOCAL_SKILL_COMMANDS, getMatchingSlashSuggestions, resolveLocalSlashCommand } from "./skills";

describe("skills", () => {
  it("每个技能命令都有场景系统提示词", () => {
    expect(LOCAL_SKILL_COMMANDS.length).toBeGreaterThan(0);
    expect(LOCAL_SKILL_COMMANDS.every((skill) => Boolean(skill.systemPrompt?.trim()))).toBe(true);
  });

  it("解析技能命令并保留技能系统提示词", () => {
    const command = resolveLocalSlashCommand("/expert-manager 帮我创建一个专家");

    expect(command?.kind).toBe("skill");
    expect(command?.args).toBe("帮我创建一个专家");
    expect(command?.systemPrompt).toContain("专家");
  });

  it("按权限过滤技能建议", () => {
    const suggestions = getMatchingSlashSuggestions("/e", [], ["expert-manager"]);

    expect(suggestions.map((item) => item.command)).toEqual(["/expert-manager"]);
  });
});
