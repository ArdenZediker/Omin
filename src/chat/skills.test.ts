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

  it("工具命令可手敲执行（曾整体失效）：解析出 kind=tool 与参数", () => {
    // 这里曾经只按 getSkillCommands() 找，导致内置工具的 /命令 全部不可达、
    // taskExecutor 里处理工具命令的分支成了死代码。
    const command = resolveLocalSlashCommand("/read_file src/App.tsx");

    expect(command?.kind).toBe("tool");
    expect(command?.command).toBe("/read_file");
    expect(command?.args).toBe("src/App.tsx");
  });

  it("补全里列出内置工具命令", () => {
    const commands = getMatchingSlashSuggestions("/").map((item) => item.command);

    expect(commands).toContain("/read_file");
    expect(commands).toContain("/export_docx");
    expect(commands).toContain("/git_commit");
  });

  it("没有本地执行器的命令既不补全也不解析：agent 交给模型 function calling", () => {
    // agent 由 useChatRuntime 对 toolCall.name === "agent" 特判走 runSubAgent，
    // 不进本地工具注册表 —— 若解析出来，用户敲 /agent 只会得到「暂不支持命令」。
    // 补全与解析必须共用同一判据（isRunnableLocalCommand），否则又会分裂成两套口径。
    expect(resolveLocalSlashCommand("/agent 调研一下这个仓库")).toBeNull();
    expect(getMatchingSlashSuggestions("/").map((item) => item.command)).not.toContain("/agent");
  });
});
