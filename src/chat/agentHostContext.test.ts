import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { KnowledgeContextResult } from "./knowledgeTypes";
import type { Project } from "./types";
import { buildKnowledgeContextBlock } from "./knowledgeContext";
import { loadPersonaConfig } from "./storage";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("./knowledgeContext", () => ({
  buildKnowledgeContextBlock: vi.fn(),
}));

vi.mock("./storage", () => ({
  loadPersonaConfig: vi.fn(),
}));

import { buildAgentHostContext } from "./agentHostContext";

const project: Project = {
  id: "project-1",
  kind: "basic",
  title: "Project",
  description: "",
  workspacePath: "C:/workspace",
  systemPrompt: "PROJECT RULE",
  allowedToolIds: [],
  allowedSkillIds: [],
  memoryScope: "project",
  createdAt: 1,
  updatedAt: 1,
};

describe("buildAgentHostContext", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(buildKnowledgeContextBlock).mockReset();
    vi.mocked(loadPersonaConfig).mockReset();
  });

  it("assembles knowledge, project instructions, memory, and persona", async () => {
    vi.mocked(invoke).mockResolvedValue("AGENTS RULE");
    vi.mocked(loadPersonaConfig).mockResolvedValue({
      style: "efficient",
      customInstruction: "",
      userName: "Peng",
      assistantName: "Omni",
      personaDescription: "",
      longTermMemory: "LONG TERM RULE",
      agentsMd: "",
    });
    const knowledge = {
      query: "question",
      block: "KNOWLEDGE BLOCK",
      sources: [],
      documentInventory: {
        collectionName: "Docs",
        documents: [],
      },
    } as KnowledgeContextResult;
    vi.mocked(buildKnowledgeContextBlock).mockResolvedValue(knowledge);

    const result = await buildAgentHostContext({
      model: "test-model",
      messages: [{ role: "user", content: "question" }],
      baseSystemPrompt: "BASE",
      project,
      relatedContext: {
        memories: [{
          id: "memory-1",
          projectId: project.id,
          content: "MEMORY RULE",
          createdAt: 1,
          updatedAt: 1,
        }],
      },
      knowledgeCollectionId: "docs",
      tools: [{
        name: "read_file",
        description: "Read",
        parameters: { type: "object" },
      }],
    });

    expect(result.knowledgeContext).toBe(knowledge);
    expect(result.steps).toEqual([
      expect.objectContaining({
        type: "action",
        title: "Knowledge Search",
      }),
    ]);
    expect(result.system).toContain("BASE");
    expect(result.system).toContain("PROJECT RULE");
    expect(result.system).toContain("AGENTS RULE");
    expect(result.system).toContain("MEMORY RULE");
    expect(result.system).toContain("LONG TERM RULE");
    expect(result.system).toContain("KNOWLEDGE BLOCK");
  });
});
