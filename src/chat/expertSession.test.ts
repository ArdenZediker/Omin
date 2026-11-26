import { describe, expect, it } from "vitest";
import { createExpertSessionBinding } from "./expertSession";
import { parseChatSessionsSnapshot } from "./storage";

const manifest = {
  id: "review-expert",
  name: "评审专家",
  description: "评审交付物",
  version: "1.2.0",
  kind: "expert" as const,
  templatePrompt: "你是评审专家。",
  defaultToolIds: ["read_file"],
  defaultSkillIds: ["review"],
  defaultMcpConnectorIds: ["repo"],
};

describe("expert session binding", () => {
  it("固化专家提示词、技能、工具与连接器配置", () => {
    expect(createExpertSessionBinding(manifest)).toEqual({
      id: "review-expert",
      name: "评审专家",
      templatePrompt: "你是评审专家。",
      defaultToolIds: ["read_file"],
      defaultSkillIds: ["review"],
      defaultMcpConnectorIds: ["repo"],
    });
  });

  it("从会话快照恢复专家绑定", () => {
    const binding = createExpertSessionBinding(manifest);
    const sessions = parseChatSessionsSnapshot(JSON.stringify([{
      id: "session-1",
      projectId: "project-1",
      title: "专家任务",
      messages: [],
      createdAt: 1,
      updatedAt: 1,
      usage: {},
      expertBinding: binding,
    }]));

    expect(sessions[0]?.expertBinding).toEqual(binding);
  });
});
