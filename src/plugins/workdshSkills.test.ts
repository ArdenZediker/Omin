import { describe, expect, it } from "vitest";
import { BUILTIN_SKILL_PLUGINS } from "./builtins";
import {
  DEFAULT_WORKDSH_SKILL_IDS,
  WORKDSH_ALIGNED_SKILL_PLUGINS,
} from "./workdshSkills";

describe("WorkDSH 对齐的默认技能", () => {
  it("提供六个独立技能，并与新项目默认集一致", () => {
    expect(WORKDSH_ALIGNED_SKILL_PLUGINS).toHaveLength(6);
    expect(DEFAULT_WORKDSH_SKILL_IDS).toEqual(
      WORKDSH_ALIGNED_SKILL_PLUGINS.map((manifest) => manifest.id),
    );
    expect(new Set(DEFAULT_WORKDSH_SKILL_IDS).size).toBe(6);
  });

  it("重复的技能创作只保留 WorkDSH 对齐版", () => {
    const skillCreator = BUILTIN_SKILL_PLUGINS.filter(
      (manifest) => manifest.id === "skill-creator" || manifest.id === "workdsh-skill-creator",
    );
    expect(skillCreator.map((manifest) => manifest.id)).toEqual(["workdsh-skill-creator"]);
  });

  it("旧的内置技能仍保留为手动可选项", () => {
    const ids = new Set(BUILTIN_SKILL_PLUGINS.map((manifest) => manifest.id));
    expect(ids.has("plan")).toBe(true);
    expect(ids.has("code-review")).toBe(true);
    expect(ids.has("expert-manager")).toBe(true);
  });

  it("技能只引用 Omni 真实可用的执行器", () => {
    const prompts = WORKDSH_ALIGNED_SKILL_PLUGINS.map(
      (manifest) => manifest.systemPrompt ?? "",
    ).join("\n");

    expect(prompts).toContain("export_docx");
    expect(prompts).toContain("export_xlsx");
    expect(prompts).toContain("export_pptx");
    expect(prompts).toContain("install_skill");
    expect(prompts).toContain("read_file");
    expect(prompts).toContain("bash");

    // WorkDSH 专属运行时只能作为“不可用边界”出现，不能被写成执行指令。
    for (const unavailable of [
      "调用 content_open",
      "调用 content_read",
      "调用 content_edit",
      "调用 content_export",
      "使用 html.replaceDocument",
      "使用 plugin_manager install_bundle",
    ]) {
      expect(prompts).not.toContain(unavailable);
    }
  });

  it("六个技能都有稳定命令与可路由描述", () => {
    for (const manifest of WORKDSH_ALIGNED_SKILL_PLUGINS) {
      expect(manifest.command).toBe(`/${manifest.id}`);
      expect(manifest.description.length).toBeGreaterThan(20);
      expect(manifest.systemPrompt?.trim().length).toBeGreaterThan(200);
    }
  });
});
