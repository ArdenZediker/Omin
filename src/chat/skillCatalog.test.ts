import { describe, expect, it } from "vitest";
import type { PluginManifest } from "../plugins/types";
import {
  assembleSkillCatalog,
  buildEnabledSkillPrompts,
  renderSkillContent,
  type SkillProvider,
} from "./skillCatalog";
import { createDefaultProject } from "./storage";
import type { Project } from "./types";

function skill(
  id: string,
  overrides: Partial<PluginManifest> = {},
): PluginManifest {
  return {
    id,
    name: id,
    description: `${id} description`,
    version: "1.0.0",
    kind: "skill",
    command: `/${id}`,
    systemPrompt: `${id} body`,
    ...overrides,
  };
}

function provider(
  name: string,
  rank: number,
  skills: PluginManifest[],
  projectScoped = false,
): SkillProvider {
  return {
    name,
    rank,
    projectScoped,
    list: () => skills,
  };
}

function project(allowedSkillIds: string[]): Project {
  return {
    id: "project",
    kind: "custom",
    title: "Project",
    description: "",
    workspacePath: "D:/project",
    createdAt: 0,
    updatedAt: 0,
    memoryScope: "project",
    allowedToolIds: [],
    allowedSkillIds,
    allowedConnectorIds: [],
    knowledgeCollectionId: null,
    systemPrompt: "",
  };
}

describe("assembleSkillCatalog", () => {
  it("exposes the six bundled WorkDSH skills in the default project", () => {
    const catalog = assembleSkillCatalog({ project: createDefaultProject() });

    expect(catalog.modelEntries.map((entry) => entry.id)).toEqual([
      "workdsh-excel-design",
      "workdsh-ppt-design",
      "workdsh-skill-creator",
      "workdsh-web-design",
      "workdsh-word-design",
      "workdsh-workbench-dev",
    ]);
  });

  it("merges providers by DSH-style rank; the installed skill shadows bundled", () => {
    const catalog = assembleSkillCatalog({
      providers: [
        provider("bundled", 600, [skill("weather", { systemPrompt: "bundled body" })], true),
        provider("installed", 300, [skill("weather", { systemPrompt: "installed body" })]),
      ],
    });

    expect(catalog.entries).toHaveLength(1);
    expect(catalog.entries[0]).toMatchObject({
      id: "weather",
      provider: "installed",
      body: "installed body",
    });
  });

  it("keeps installed skills global while curating bundled skills by project", () => {
    const catalog = assembleSkillCatalog({
      project: project([]),
      providers: [
        provider("installed", 300, [skill("custom")]),
        provider("bundled", 600, [skill("plan")], true),
      ],
    });

    expect(catalog.entries.map((entry) => entry.id)).toEqual(["custom"]);
  });

  it("narrows every provider through the active expert skill ids", () => {
    const catalog = assembleSkillCatalog({
      expertSkillIds: ["weather"],
      providers: [
        provider("installed", 300, [skill("custom")]),
        provider("bundled", 600, [skill("weather")]),
      ],
    });

    expect(catalog.entries.map((entry) => entry.id)).toEqual(["weather"]);
    expect(assembleSkillCatalog({ expertSkillIds: [], providers: [] }).entries).toEqual([]);
  });

  it("keeps model and user invocation surfaces separate", () => {
    const catalog = assembleSkillCatalog({
      providers: [
        provider("bundled", 600, [
          skill("model-only", { invocation: { modelInvocable: true, userInvocable: false } }),
          skill("user-only", { invocation: { modelInvocable: false, userInvocable: true } }),
        ]),
      ],
    });

    expect(catalog.modelEntries.map((entry) => entry.id)).toEqual(["model-only"]);
    expect(catalog.userEntries.map((entry) => entry.id)).toEqual(["user-only"]);
    expect(catalog.getModelSkill("user-only")).toBeUndefined();
    expect(catalog.getUserSkill("/model-only")).toBeUndefined();
  });

  it("projects a metadata-only catalog and keeps the body behind load", () => {
    const catalog = assembleSkillCatalog({
      providers: [provider("bundled", 600, [skill("weather", { systemPrompt: "curl wttr.in" })])],
    });
    const prompts = buildEnabledSkillPrompts(catalog, true);

    expect(prompts[0]).toMatchObject({ id: "weather", catalogOnly: true, prompt: "" });
    expect(JSON.stringify(prompts)).not.toContain("curl wttr.in");
    expect(catalog.getModelSkill("weather")?.body).toBe("curl wttr.in");
  });
});

describe("renderSkillContent", () => {
  it("uses the canonical skill_content envelope and resource guidance", () => {
    const rendered = renderSkillContent({
      id: 'weather"quoted',
      provider: "installed",
      resourceBase: "C:/skills/weather",
      body: "<instructions>",
    });

    expect(rendered).toContain('<skill_content name="weather&quot;quoted">');
    expect(rendered).toContain("Base directory for this skill: C:/skills/weather");
    expect(rendered).toContain("<skill_instructions>\n<instructions>\n</skill_instructions>");
  });
});
