import { describe, expect, it } from "vitest";
import type { Message } from "../adapters/types";
import type { Project } from "./types";
import { buildOmniSystemPrompt } from "./promptModules";

const messages: Message[] = [{ role: "user", content: "帮我优化这个项目" }];

function createProject(patch: Partial<Project> = {}): Project {
  return {
    id: "project-1",
    kind: "custom",
    title: "工程助手",
    description: "",
    workspacePath: "",
    allowedToolIds: [],
    allowedSkillIds: [],
    memoryScope: "project",
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

describe("promptModules", () => {
  it("构建默认 Codex 风格的分层系统提示词", () => {
    const prompt = buildOmniSystemPrompt({ messages });

    expect(prompt).toContain("核心身份");
    expect(prompt).toContain("协作方式");
    expect(prompt).toContain("执行纪律");
    expect(prompt).toContain("<omni_memory>");
    expect(prompt).toContain("<omni_summary>");
  });

  it("按场景追加助手、历史上下文、知识库和工具协议", () => {
    const prompt = buildOmniSystemPrompt({
      messages,
      project: createProject({ systemPrompt: "你是偏工程审查的助手。" }),
      relatedContext: {
        memories: [{ id: "memory-1", projectId: "project-1", content: "用户要求全部使用中文", createdAt: 1, updatedAt: 1 }],
        summaries: [{ sessionId: "session-1", projectId: "project-1", title: "优化", summary: "正在优化提示词系统", updatedAt: 1 }],
      },
      knowledgeContext: {
        query: "提示词",
        block: "知识库内容",
        sources: [],
      },
      enabledToolNames: ["Search Files", "Read File"],
      includeToolProtocol: true,
    });

    expect(prompt).toContain("你是偏工程审查的助手。");
    expect(prompt).toContain("长期记忆：");
    expect(prompt).toContain("用户要求全部使用中文");
    expect(prompt).toContain("会话摘要：");
    expect(prompt).toContain("知识库回答协议");
    expect(prompt).toContain("当前助手已启用工具：Search Files、Read File");
  });

  it("可按任务类型关闭记忆与摘要结构块", () => {
    const prompt = buildOmniSystemPrompt({
      messages,
      includeMemoryExtraction: false,
      includeSummaryExtraction: false,
      includeToolProtocol: true,
    });

    expect(prompt).toContain("工具协议");
    expect(prompt).not.toContain("<omni_memory>");
    expect(prompt).not.toContain("<omni_summary>");
  });

  // 回归：技能只注入正文时，模型看不到「这个技能什么时候用」，
  // 「今天宜宾天气」这类请求会被 /web_search 抢走。
  it("已启用技能注入身份、适用场景与「优先于通用工具」的路由规则", () => {
    const prompt = buildOmniSystemPrompt({
      messages,
      enabledSkillPrompts: [
        {
          id: "weather",
          name: "weather",
          command: "/weather",
          description: "查询天气预报，无需 API 密钥",
          prompt: "# Weather\n\ncurl -s \"wttr.in/London?format=3\"",
        },
      ],
    });

    expect(prompt).toContain("### 技能：weather（/weather）");
    expect(prompt).toContain("适用场景：查询天气预报，无需 API 密钥");
    expect(prompt).toContain("wttr.in/London");
    // 路由优先级：必须显式声明技能胜过通用工具，否则模型会继续选 /web_search。
    expect(prompt).toContain("优先于通用工具");
    expect(prompt).toContain("不要用 /web_search");
  });

  it("没有启用技能时不注入技能分片", () => {
    const prompt = buildOmniSystemPrompt({ messages });
    expect(prompt).not.toContain("已启用技能");
  });
});
