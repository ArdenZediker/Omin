import { describe, expect, it } from "vitest";
import {
  dedupeLocalCommands,
  getAllSkillCommands,
  getAllLocalCommands,
  getMatchingSlashSuggestions,
  getSlashTrigger,
  resolveLocalSlashCommand,
  type LocalSlashCommand,
} from "./skills";
import { findBuiltinSlashCommand } from "./builtinCommands";

describe("skills", () => {
  it("每个技能命令都有场景系统提示词", () => {
    const skills = getAllSkillCommands();
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.every((skill) => Boolean(skill.systemPrompt?.trim()))).toBe(true);
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

    expect(commands).toEqual(expect.arrayContaining([
      "/file",
      "/goal",
      "/plan",
      "/compact",
      "/permission",
      "/model",
    ]));
    expect(commands).toContain("/read_file");
    expect(commands).toContain("/export_docx");
    expect(commands).toContain("/git_commit");
  });

  it("内置指令接管同名技能，且不再展示反馈和下载日志", () => {
    const plan = getMatchingSlashSuggestions("/pl").find((item) => item.command === "/plan");
    const allCommands = getMatchingSlashSuggestions("/").map((item) => item.command);

    expect(plan).toMatchObject({
      kind: "builtin",
      builtinId: "plan",
      commandKind: "command",
      title: "计划",
    });
    expect(allCommands).not.toContain("/feedback");
    expect(allCommands).not.toContain("/export");
  });

  it("内置指令支持 DSH 式中文输入别名", () => {
    expect(findBuiltinSlashCommand("/计划 分析需求")?.id).toBe("plan");
    expect(findBuiltinSlashCommand("/目标 完成发布")?.id).toBe("goal");
    expect(findBuiltinSlashCommand("/压缩")?.id).toBe("compact");
  });

  it("没有本地执行器的命令既不补全也不解析：agent 交给模型 function calling", () => {
    // agent 由 useChatRuntime 对 toolCall.name === "agent" 特判走 runSubAgent，
    // 不进本地工具注册表 —— 若解析出来，用户敲 /agent 只会得到「暂不支持命令」。
    // 补全与解析必须共用同一判据（isRunnableLocalCommand），否则又会分裂成两套口径。
    expect(resolveLocalSlashCommand("/agent 调研一下这个仓库")).toBeNull();
    expect(getMatchingSlashSuggestions("/").map((item) => item.command)).not.toContain("/agent");
  });

  it("斜杠菜单跟随 caret，并支持行内、空白和标点后的触发", () => {
    expect(getSlashTrigger("/rea", 4)).toMatchObject({ start: 0, end: 4, query: "rea", leading: true });
    expect(getSlashTrigger("请分析 /rea 这个文件", 8)).toMatchObject({
      start: 4,
      end: 8,
      query: "rea",
      leading: false,
    });
    expect(getSlashTrigger("继续，/rea", 7)).toMatchObject({ start: 3, end: 7, query: "rea" });
  });

  it("URL、路径和命令参数不会误触发斜杠菜单", () => {
    expect(getSlashTrigger("https://example.com", 19)).toBeNull();
    expect(getSlashTrigger("C:/Users/PengY", 14)).toBeNull();
    expect(getSlashTrigger("word/rea", 8)).toBeNull();
    expect(getSlashTrigger("/read_file src/App.tsx", 21)).toBeNull();
  });

  it("current-token query 与旧 `/query` 调用方式返回一致结果", () => {
    expect(getMatchingSlashSuggestions("rea").map((item) => item.command)).toEqual(
      getMatchingSlashSuggestions("/rea").map((item) => item.command),
    );
  });

  it("重复命令只保留最合适的定义，技能优先于通用工具", () => {
    const base = {
      id: "duplicate",
      command: "/duplicate",
      title: "Duplicate",
      description: "duplicate command",
    };
    const tool: LocalSlashCommand = { ...base, id: "duplicate-tool", kind: "tool" };
    const skill: LocalSlashCommand = { ...base, id: "duplicate-skill", kind: "skill" };

    expect(dedupeLocalCommands([tool, skill])).toEqual([skill]);
    expect(dedupeLocalCommands([skill, tool])).toEqual([skill]);
  });

  it("不同命令但展示名重复时也只保留最合适的一项", () => {
    const tool: LocalSlashCommand = {
      id: "export-word-tool",
      command: "/export_docx",
      title: "Word",
      description: "export a Word file",
      kind: "tool",
    };
    const skill: LocalSlashCommand = {
      id: "word-design-skill",
      command: "/word-design",
      title: " Word ",
      description: "design a Word document",
      kind: "skill",
    };

    expect(dedupeLocalCommands([tool, skill])).toEqual([skill]);
  });

  it("当前命令目录与补全结果都没有重复命令", () => {
    const allCommands = getAllLocalCommands().map((item) => item.command.toLowerCase());
    const allTitles = getAllLocalCommands().map((item) => item.title.trim().toLowerCase());
    const suggestions = getMatchingSlashSuggestions("/").map((item) => item.command.toLowerCase());

    expect(new Set(allCommands).size).toBe(allCommands.length);
    expect(new Set(allTitles).size).toBe(allTitles.length);
    expect(new Set(suggestions).size).toBe(suggestions.length);
  });
});
