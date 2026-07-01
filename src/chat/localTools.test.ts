import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, ModelConfig } from "../adapters/types";
import type { AssistantProfile } from "./types";
import { executeLocalTool, type LocalToolRuntime, type LocalToolSession } from "./localTools";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: {
    getByLabel: vi.fn(),
  },
}));

vi.mock("../app/window", () => ({
  showCompactWindow: vi.fn(),
  showSettingsWindow: vi.fn(),
}));

const baseMessages: Message[] = [
  { role: "user", content: "你好" },
  { role: "assistant", content: "你好，有什么可以帮你？" },
];

const availableModels: ModelConfig[] = [
  {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    provider: "openai",
    maxTokens: 128000,
    supportsVision: true,
    supportsStreaming: true,
  },
  {
    id: "deepseek-chat",
    name: "DeepSeek V3",
    provider: "deepseek",
    maxTokens: 65536,
    supportsVision: false,
    supportsStreaming: true,
  },
];

function createAssistant(patch: Partial<AssistantProfile> = {}): AssistantProfile {
  return {
    id: "assistant-1",
    kind: "custom",
    title: "测试助手",
    description: "",
    allowedToolIds: ["search_sessions", "read_session"],
    allowedSkillIds: [],
    memoryScope: "assistant",
    autoSaveMemories: true,
    autoSaveSummaries: true,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function createRuntime(patch: Partial<LocalToolRuntime> = {}): LocalToolRuntime {
  const sessions: LocalToolSession[] = [
    { id: "session-1", title: "当前会话", messages: baseMessages },
    { id: "session-2", title: "项目计划", messages: [{ role: "user", content: "项目优化方案" }] },
  ];

  return {
    activeAssistant: createAssistant(),
    activeChatId: "session-1",
    addAssistantMemory: vi.fn(() => true),
    availableModels,
    getChatSessionById: vi.fn((sessionId) => sessions.find((session) => session.id === sessionId) ?? null),
    handleModelChange: vi.fn(),
    renameChatSession: vi.fn(() => true),
    searchChatSessions: vi.fn((query) =>
      query ? sessions.filter((session) => session.title.includes(query) || session.messages.some((message) => message.content.includes(query))) : sessions
    ),
    setActiveChatId: vi.fn(),
    setEditingMessageIndex: vi.fn(),
    setError: vi.fn(),
    setMessages: vi.fn(),
    setOpenChatMenu: vi.fn(),
    togglePinnedChatSession: vi.fn(() => true),
    updateAssistantProfile: vi.fn(),
    ...patch,
  };
}

describe("localTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("按当前助手权限拦截未启用的工具", async () => {
    const runtime = createRuntime({
      activeAssistant: createAssistant({ allowedToolIds: ["read_session"] }),
    });

    const result = await executeLocalTool(runtime, { command: "/search_files", args: "memory" });

    expect(result).toEqual({ ok: false, error: "当前助手未启用工具：搜索文件" });
  });

  it("始终允许基础本地命令并把模型切换保存到当前助手", async () => {
    const handleModelChange = vi.fn();
    const updateAssistantProfile = vi.fn();
    const runtime = createRuntime({
      activeAssistant: createAssistant({ allowedToolIds: [] }),
      handleModelChange,
      updateAssistantProfile,
    });

    const result = await executeLocalTool(runtime, { command: "/model", args: "deepseek" });

    expect(result).toEqual({ ok: true, outputText: "已将当前助手默认模型切换为：DeepSeek V3" });
    expect(updateAssistantProfile).toHaveBeenCalledWith("assistant-1", { defaultModelId: "deepseek-chat" });
    expect(handleModelChange).not.toHaveBeenCalled();
  });

  it("没有当前助手时 /model 只切换当前模型", async () => {
    const handleModelChange = vi.fn();
    const runtime = createRuntime({
      activeAssistant: null,
      handleModelChange,
      updateAssistantProfile: vi.fn(),
    });

    const result = await executeLocalTool(runtime, { command: "/model", args: "deepseek" });

    expect(result).toEqual({ ok: true, outputText: "已切换当前模型：DeepSeek V3" });
    expect(handleModelChange).toHaveBeenCalledWith("deepseek-chat");
  });

  it("把记忆写入当前助手并携带当前会话 ID", async () => {
    const addAssistantMemory = vi.fn(() => true);
    const runtime = createRuntime({ addAssistantMemory });

    const result = await executeLocalTool(runtime, { command: "/remember", args: "以后全部使用中文" });

    expect(result).toEqual({ ok: true, outputText: "已保存到当前助手记忆库。" });
    expect(addAssistantMemory).toHaveBeenCalledWith("assistant-1", "以后全部使用中文", "session-1", "command");
  });

  it("搜索会话时标记当前会话并输出中文摘要", async () => {
    const runtime = createRuntime();

    const result = await executeLocalTool(runtime, { command: "/search_sessions", args: "当前" });

    expect(result?.ok).toBe(true);
    expect(result?.outputText).toContain("找到 1 个相关会话：");
    expect(result?.outputText).toContain("当前会话 [当前]");
    expect(result?.outputText).toContain("2 条消息");
  });

  it("读取会话时使用中文角色标签", async () => {
    const runtime = createRuntime();

    const result = await executeLocalTool(runtime, { command: "/read_session", args: "session-1" });

    expect(result?.ok).toBe(true);
    expect(result?.outputText).toContain("会话：当前会话");
    expect(result?.outputText).toContain("1. 用户：你好");
    expect(result?.outputText).toContain("2. 助手：你好，有什么可以帮你？");
  });
});
