import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../adapters/types";
import type { Project } from "./types";
import { executeLocalTool, type LocalToolRuntime, type LocalToolSession } from "./localTools";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("./confirmationGate", () => ({
  requestConfirmation: vi.fn().mockResolvedValue(true),
}));

const baseMessages: Message[] = [
  { role: "user", content: "你好" },
  { role: "project", content: "你好，有什么可以帮你？" },
];

function createProject(patch: Partial<Project> = {}): Project {
  return {
    id: "project-1",
    kind: "custom",
    title: "测试助手",
    description: "",
    workspacePath: "",
    allowedToolIds: ["search_sessions", "read_session"],
    allowedSkillIds: [],
    memoryScope: "project",
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
    activeProject: createProject(),
    activeChatId: "session-1",
    getChatSessionById: vi.fn((sessionId) => sessions.find((session) => session.id === sessionId) ?? null),
    searchChatSessions: vi.fn((query) =>
      query ? sessions.filter((session) => session.title.includes(query) || session.messages.some((message) => message.content.includes(query))) : sessions
    ),
    ...patch,
  };
}

describe("localTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("按当前助手权限拦截未启用的工具", async () => {
    const runtime = createRuntime({
      activeProject: createProject({ allowedToolIds: ["read_session"] }),
    });

    const result = await executeLocalTool(runtime, { command: "/search_files", args: "memory" });

    expect(result).toEqual({ ok: false, error: "当前项目未启用工具：搜索文件" });
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
    expect(result?.outputText).toContain("2. 项目：你好，有什么可以帮你？");
  });

  it("install_expert 安装专家并允许在任意助手调用", async () => {
    const runtime = createRuntime({
      activeProject: createProject({ allowedToolIds: [] }),
    });
    const manifest = {
      id: "test-expert",
      name: "测试专家",
      description: "用于验证专家安装闭环的测试专家",
      version: "1.0.0",
      kind: "expert",
      category: "开发编程",
      icon: "Code2",
      tags: ["代码", "测试", "审查"],
      templatePrompt: "你是测试专家，负责验证专家安装流程。",
    };

    const result = await executeLocalTool(runtime, {
      command: "/install_expert",
      args: JSON.stringify(manifest),
    });

    expect(result?.ok).toBe(true);
    expect(result?.outputText).toContain("测试专家");
    expect(result?.outputText).toContain("已安装");
    expect(result?.outputText).toContain("我的专家");
  });

  it("install_expert 宽容解析代码围栏与 manifest 包装", async () => {
    const runtime = createRuntime();
    const manifest = {
      id: "fenced-expert",
      name: "围栏专家",
      description: "验证围栏与包装解析",
      kind: "expert",
      templatePrompt: "你是围栏专家。",
    };

    const wrapped = await executeLocalTool(runtime, {
      command: "/install_expert",
      args: JSON.stringify({ manifest }),
    });
    expect(wrapped?.ok).toBe(true);
    expect(wrapped?.outputText).toContain("fenced-expert");

    const fenced = await executeLocalTool(runtime, {
      command: "/install_expert",
      args: `\`\`\`json\n${JSON.stringify(manifest)}\n\`\`\``,
    });
    expect(fenced?.ok).toBe(true);
    expect(fenced?.outputText).toContain("fenced-expert");
  });

  it("install_expert 拒绝非法 id 与内置 id 冲突", async () => {
    const runtime = createRuntime();
    const base = {
      name: "坏专家",
      description: "用于校验失败场景",
      kind: "expert",
      templatePrompt: "你是坏专家。",
    };

    const badId = await executeLocalTool(runtime, {
      command: "/install_expert",
      args: JSON.stringify({ ...base, id: "Bad Expert!" }),
    });
    expect(badId?.ok).toBe(false);
    expect(badId?.error).toContain("kebab-case");

    const conflict = await executeLocalTool(runtime, {
      command: "/install_expert",
      args: JSON.stringify({ ...base, id: "expert-manager" }),
    });
    expect(conflict?.ok).toBe(false);
    expect(conflict?.error).toContain("内置插件冲突");

    const missingPrompt = await executeLocalTool(runtime, {
      command: "/install_expert",
      args: JSON.stringify({ id: "no-prompt-expert", name: base.name, description: base.description, kind: "expert" }),
    });
    expect(missingPrompt?.ok).toBe(false);
    expect(missingPrompt?.error).toContain("templatePrompt");
  });

  it("install_expert 对已安装专家做覆盖更新", async () => {
    const runtime = createRuntime();
    const manifest = {
      id: "update-me-expert",
      name: "待更新专家",
      description: "首次安装",
      kind: "expert",
      templatePrompt: "你是第一版。",
    };

    const first = await executeLocalTool(runtime, {
      command: "/install_expert",
      args: JSON.stringify(manifest),
    });
    expect(first?.ok).toBe(true);
    expect(first?.outputText).toContain("已安装");

    const second = await executeLocalTool(runtime, {
      command: "/install_expert",
      args: JSON.stringify({ ...manifest, name: "更新后专家" }),
    });
    expect(second?.ok).toBe(true);
    expect(second?.outputText).toContain("已更新");
  });

  it("导出工具未传 path 时自动落到项目目录并用标题命名", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke)
      .mockResolvedValueOnce(false) // path_exists：目标文件不存在
      .mockResolvedValueOnce({ path: "D:/proj/周报.docx", size: 2048 }); // export_docx 结果

    const runtime = createRuntime({
      activeProject: createProject({ workspacePath: "D:/proj", allowedToolIds: ["export_docx"] }),
    });

    const result = await executeLocalTool(runtime, {
      command: "/export_docx",
      args: JSON.stringify({ spec: { title: "周报", children: [{ type: "h1", text: "周报" }] } }),
    });

    expect(result?.ok).toBe(true);
    expect(result?.outputText).toContain("D:/proj/周报.docx");
    expect(invoke).toHaveBeenCalledWith("export_docx", expect.objectContaining({ path: "D:/proj/周报.docx" }));
  });

  it("导出工具缺省路径与已有文件冲突时自动追加序号", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke)
      .mockResolvedValueOnce(true) // path_exists：周报.docx 已存在
      .mockResolvedValueOnce(false) // path_exists：周报-1.docx 不存在
      .mockResolvedValueOnce({ path: "D:/proj/周报-1.docx", size: 1024 }); // export_docx 结果

    const runtime = createRuntime({
      activeProject: createProject({ workspacePath: "D:/proj", allowedToolIds: ["export_docx"] }),
    });

    const result = await executeLocalTool(runtime, {
      command: "/export_docx",
      args: JSON.stringify({ spec: { title: "周报", children: [] } }),
    });

    expect(result?.ok).toBe(true);
    expect(result?.outputText).toContain("D:/proj/周报-1.docx");
    expect(invoke).toHaveBeenCalledWith("export_docx", expect.objectContaining({ path: "D:/proj/周报-1.docx" }));
  });

  it("导出工具非项目会话时落到文档目录/Omni 兜底目录", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke)
      .mockResolvedValueOnce("C:/Users/Test/Documents") // default_artifact_dir
      .mockResolvedValueOnce(false) // path_exists
      .mockResolvedValueOnce({ path: "C:/Users/Test/Documents/Omni/数据.xlsx", size: 512 }); // export_xlsx 结果

    const runtime = createRuntime({
      activeProject: createProject({ workspacePath: "", allowedToolIds: ["export_xlsx"] }),
    });

    const result = await executeLocalTool(runtime, {
      command: "/export_xlsx",
      args: JSON.stringify({ spec: { sheets: [{ name: "数据", rows: [["a", 1]] }] } }),
    });

    expect(result?.ok).toBe(true);
    expect(result?.outputText).toContain("C:/Users/Test/Documents/Omni/数据.xlsx");
  });
});
