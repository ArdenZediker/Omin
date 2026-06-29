import { describe, expect, it } from "vitest";
import type { Message } from "../adapters/types";
import type { AssistantProfile } from "./types";
import { buildOmniSystemPrompt } from "./promptModules";

const messages: Message[] = [{ role: "user", content: "帮我优化这个项目" }];

function createAssistant(patch: Partial<AssistantProfile> = {}): AssistantProfile {
  return {
    id: "assistant-1",
    kind: "custom",
    title: "工程助手",
    description: "",
    allowedToolIds: [],
    allowedSkillIds: [],
    memoryScope: "assistant",
    autoSaveMemories: true,
    autoSaveSummaries: true,
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
      assistant: createAssistant({ systemPrompt: "你是偏工程审查的助手。" }),
      relatedContext: {
        memories: [{ id: "memory-1", assistantId: "assistant-1", content: "用户要求全部使用中文", createdAt: 1, updatedAt: 1 }],
        summaries: [{ sessionId: "session-1", assistantId: "assistant-1", title: "优化", summary: "正在优化提示词系统", updatedAt: 1 }],
      },
      knowledgeContext: {
        query: "提示词",
        block: "知识库内容",
        sources: [],
      },
      enabledToolNames: ["搜索文件", "读取文件"],
      includeToolProtocol: true,
    });

    expect(prompt).toContain("你是偏工程审查的助手。");
    expect(prompt).toContain("长期记忆：");
    expect(prompt).toContain("用户要求全部使用中文");
    expect(prompt).toContain("会话摘要：");
    expect(prompt).toContain("知识库回答协议");
    expect(prompt).toContain("当前助手已启用工具：搜索文件、读取文件");
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
});
