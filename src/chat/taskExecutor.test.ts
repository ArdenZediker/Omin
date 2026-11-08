import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Project } from "./types";
import type { PluginManifest } from "../plugins/types";
import { executeInputTask, executeTask } from "./taskExecutor";
import { executeChatTurn } from "./engine";
import { pluginRegistry } from "../plugins/registry";

vi.mock("./engine", () => ({
  executeChatTurn: vi.fn(async () => ({ content: "ok" })),
}));

const mockedTurn = vi.mocked(executeChatTurn);

function makeProject(allowedSkillIds: string[]): Project {
  return {
    id: "project-test",
    kind: "custom",
    title: "测试助手",
    description: "",
    workspacePath: "",
    groupName: null,
    systemPrompt: "",
    defaultModelId: null,
    knowledgeCollectionId: null,
    allowedToolIds: [],
    allowedSkillIds,
    memoryScope: "project",
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Project;
}

function installUserSkill(overrides?: Partial<PluginManifest>) {
  pluginRegistry.install(
    {
      id: "weather",
      name: "天气查询",
      description: "Get current weather and forecasts (no API key required).",
      version: "0.0.1",
      kind: "skill",
      command: "/weather",
      body: "curl wttr.in",
      systemPrompt: "用 curl wttr.in 查询天气",
      ...overrides,
    },
    { type: "marketplace", repository: "skillhub/test/weather" }
  );
}

async function runSlash(
  input: string,
  project: Project | null,
  enabledSkillIds?: string[],
) {
  return executeInputTask({
    input,
    images: [],
    currentMessages: [{ role: "user", content: input }],
    model: "gpt-test",
    project,
    enabledSkillIds,
    onChunk: () => {},
    executeTool: vi.fn(async () => undefined),
  });
}

describe("executeInputTask 斜杠技能许可", () => {
  beforeEach(() => {
    mockedTurn.mockClear();
  });

  afterEach(() => {
    pluginRegistry.uninstall("weather");
  });

  it("用户安装的技能不在项目白名单里也能斜杠调用（安装即授权）", async () => {
    installUserSkill();
    const project = makeProject(["plan", "code-review", "workdsh-skill-creator"]);

    await runSlash("/weather 北京", project);

    expect(mockedTurn).toHaveBeenCalledTimes(1);
    const options = mockedTurn.mock.calls[0][0];
    // 技能正文以 systemPrompt 形式拼接进请求
    expect(String(options.systemPrompt)).toContain("curl wttr.in");
    expect(String(options.systemPrompt)).toContain('<skill_content name="weather">');
    // 最后一条用户消息是斜杠命令剥离后的参数
    const last = options.messages[options.messages.length - 1];
    expect(last.role).toBe("user");
    expect(String(last.content)).toContain("北京");
  });

  it("内置技能不在项目白名单里仍然拒绝", async () => {
    installUserSkill();
    const project = makeProject(["plan", "code-review", "workdsh-skill-creator"]);

    await expect(runSlash("/expert-manager 创建专家", project)).rejects.toThrow(
      "当前助手未启用技能"
    );
    expect(mockedTurn).not.toHaveBeenCalled();
  });

  it("专家技能范围同时约束用户显式斜杠调用", async () => {
    installUserSkill();

    await expect(runSlash("/weather 北京", null, ["plan"])).rejects.toThrow(
      "当前助手未启用技能"
    );
    expect(mockedTurn).not.toHaveBeenCalled();
  });

  it("技能全局开关关闭后斜杠命令无法解析（回到普通对话）", async () => {
    installUserSkill();
    pluginRegistry.setEnabled("weather", false);
    const project = makeProject([]);

    // 未启用的技能不再出现在命令表里 → 不按技能路径处理，走普通对话。
    await runSlash("/weather 北京", project);
    expect(mockedTurn).toHaveBeenCalledTimes(1);
    const options = mockedTurn.mock.calls[0][0];
    expect(String(options.systemPrompt ?? "")).not.toContain("curl wttr.in");
  });

  it("工具命令走本地执行，不发起模型对话（这段分支曾经不可达）", async () => {
    // resolveLocalSlashCommand 一度只找技能 → 本分支永不可达，工具那半个斜杠体系
    // （22 个内置工具的 /命令）整体失效。这条测试钉住「工具命令确实落到 executeTool」。
    const executeTool = vi.fn(async () => ({ ok: true, outputText: "文件内容" }));

    const result = await executeInputTask({
      input: "/read_file src/App.tsx",
      images: [],
      currentMessages: [{ role: "user", content: "/read_file src/App.tsx" }],
      model: "gpt-test",
      project: null,
      onChunk: () => {},
      executeTool,
    });

    expect(executeTool).toHaveBeenCalledWith(
      expect.objectContaining({ id: "read_file", command: "/read_file", args: "src/App.tsx" })
    );
    expect(executeTool).toHaveBeenCalledTimes(1);
    // 本地确定性执行，不该再走一轮模型
    expect(mockedTurn).not.toHaveBeenCalled();
    expect(result.intent).toBe("local_command");
  });
});

describe("executeInputTask 知识库上下文", () => {
  beforeEach(() => {
    mockedTurn.mockClear();
  });

  it("保留用户选择的知识库并把 collection id 传给检索引擎，即使问题很短", async () => {
    const prepared: import("../adapters/types").Message[] = [];

    await executeInputTask({
      input: "都有那些文件",
      currentMessages: [],
      model: "gpt-test",
      knowledgeCollectionId: "collection-new",
      selectedKnowledgeCollection: { id: "collection-new", name: "新知识库" },
      onPrepareConversation: (messages) => prepared.push(...messages),
      executeTool: vi.fn(async () => undefined),
    });

    expect(prepared[prepared.length - 1]).toMatchObject({
      role: "user",
      content: "都有那些文件",
      selectedKnowledgeCollection: { id: "collection-new", name: "新知识库" },
    });
    expect(mockedTurn).toHaveBeenCalledWith(expect.objectContaining({ knowledgeCollectionId: "collection-new" }));
  });
});

describe("真实任务阶段的失败和取消", () => {
  it("模型中断时，任务终态快照保留已经流出的文字、思考和工具步骤", async () => {
    const onTaskState = vi.fn();
    const streamedStep = { type: "tool_call" as const, name: "read_file", arguments: "{}", result: "片段" };
    mockedTurn.mockImplementationOnce(async (options) => {
      options.onChunk?.("已经输出的正文");
      options.onReasoning?.("已经输出的思考");
      options.onToolStep?.(streamedStep);
      throw new Error("network disconnected");
    });
    const result = await executeTask({ model: "test", messages: [], onTaskState });
    expect(result.status).toBe("failed");
    expect(result.partialText).toBe("已经输出的正文");
    expect(result.partialReasoning).toBe("已经输出的思考");
    expect(result.partialSteps).toContainEqual(streamedStep);
    expect(onTaskState).toHaveBeenLastCalledWith(expect.objectContaining({
      status: "failed", partialText: "已经输出的正文", partialReasoning: "已经输出的思考",
    }));
  });

  it("用户取消发生在流式文字之后时，终态是 aborted 且保留部分正文", async () => {
    const controller = new AbortController();
    const onTaskState = vi.fn();
    mockedTurn.mockImplementationOnce(async (options) => {
      options.onChunk?.("取消前的内容");
      controller.abort();
      throw new Error("request stopped");
    });
    const result = await executeTask({ model: "test", messages: [], signal: controller.signal, onTaskState });
    expect(result).toMatchObject({ status: "aborted", partialText: "取消前的内容" });
    expect(onTaskState).toHaveBeenLastCalledWith(expect.objectContaining({ status: "aborted", partialText: "取消前的内容" }));
  });

  it("空模型输出不能通过结果校验", async () => {
    mockedTurn.mockResolvedValueOnce({ content: "  " } as Awaited<ReturnType<typeof executeChatTurn>>);
    const result = await executeTask({ model: "test", messages: [] });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("空");
    expect(result.plan.steps.find((step) => step.kind === "review")?.status).toBe("failed");
  });

  it("失败工具保留输出但不标记整轮成功", async () => {
    mockedTurn.mockResolvedValueOnce({ content: "文件读取失败", steps: [
      { type: "tool_call", name: "read_file", arguments: "{}", result: "拒绝访问", isError: true },
    ] } as Awaited<ReturnType<typeof executeChatTurn>>);
    const result = await executeTask({ model: "test", messages: [] });
    expect(result.status).toBe("failed");
    expect(result.finalResult?.content).toBe("文件读取失败");
    expect(result.error).toContain("read_file");
  });

  it("已取消的本地命令不会执行工具", async () => {
    const controller = new AbortController();
    controller.abort();
    const executeTool = vi.fn(async () => ({ ok: true }));
    const result = await executeInputTask({ input: "/read_file a.txt", currentMessages: [], model: "test", signal: controller.signal, executeTool });
    expect(result.status).toBe("aborted");
    expect(executeTool).not.toHaveBeenCalled();
  });
});

/**
 * `onPrepareConversation` 是整条发送链路上**唯一的会话创建口**（调用方在回调里
 * `createSessionFromMessages` + 写入用户消息）。斜杠命令的两个分支曾经都绕过它，
 * 于是 `/命令` 在新会话下既不建会话、用户消息也不上屏，工具输出还被写回「发送前」
 * 的数组 —— 看上去就是「发出去没反应，窗口里什么都没有」。
 */
describe("executeInputTask 斜杠命令必须先准备会话", () => {
  beforeEach(() => {
    mockedTurn.mockClear();
  });

  afterEach(() => {
    pluginRegistry.uninstall("weather");
  });

  it("技能命令：把「送给模型的同一份数组」交给调用方上屏/落库", async () => {
    installUserSkill();
    const onPrepareConversation = vi.fn();

    await executeInputTask({
      input: "/weather 北京",
      images: [],
      currentMessages: [{ role: "user", content: "之前的消息" }],
      model: "gpt-test",
      project: null,
      onChunk: () => {},
      onPrepareConversation,
      executeTool: vi.fn(async () => undefined),
    });

    expect(onPrepareConversation).toHaveBeenCalledTimes(1);
    const prepared = onPrepareConversation.mock.calls[0][0];
    // 必须是同一份数组（上屏/落库 与 送给模型 共用一个基底，改动其一即失效）
    expect(prepared).toBe(mockedTurn.mock.calls[0][0].messages);
    // 末条是技能展开后的用户消息，含参数
    const last = prepared[prepared.length - 1];
    expect(last.role).toBe("user");
    expect(String(last.content)).toContain("北京");
  });

  it("工具命令：用户敲下的 /命令 原样成为这一轮的用户消息", async () => {
    const onPrepareConversation = vi.fn();

    await executeInputTask({
      input: "/read_file src/App.tsx",
      images: [],
      currentMessages: [{ role: "user", content: "之前的消息" }],
      model: "gpt-test",
      project: null,
      onChunk: () => {},
      onPrepareConversation,
      executeTool: vi.fn(async () => ({ ok: true, outputText: "文件内容" })),
    });

    expect(onPrepareConversation).toHaveBeenCalledTimes(1);
    const prepared = onPrepareConversation.mock.calls[0][0];
    expect(prepared).toHaveLength(2);
    expect(prepared[0]).toMatchObject({ role: "user", content: "之前的消息" });
    // 缺了这条，「发送的聊天信息在窗口不显示」
    expect(prepared[1]).toMatchObject({ role: "user", content: "/read_file src/App.tsx" });
  });

  it("调用方自带 preparedMessages 时不再重复准备（约定：调用方已经准备好了）", async () => {
    installUserSkill();
    const onPrepareConversation = vi.fn();
    const preparedMessages = [{ role: "user" as const, content: "调用方准备的消息" }];

    await executeInputTask({
      input: "/weather 北京",
      images: [],
      currentMessages: preparedMessages,
      preparedMessages,
      model: "gpt-test",
      project: null,
      onChunk: () => {},
      onPrepareConversation,
      executeTool: vi.fn(async () => undefined),
    });

    expect(onPrepareConversation).not.toHaveBeenCalled();
  });
});
