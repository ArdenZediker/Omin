import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Project } from "./types";
import type { PluginManifest } from "../plugins/types";
import { executeInputTask } from "./taskExecutor";
import { executeChatTurn } from "./engine";
import { pluginRegistry } from "../plugins/registry";

vi.mock("./engine", () => ({
  executeChatTurn: vi.fn(async () => ({ reply: "ok" })),
}));

// 轻量替身：直接执行 model 步骤，把 executeChatTurn 的结果塞回 finalResult。
vi.mock("./taskRunner", () => ({
  runTaskPlan: vi.fn(async (options: {
    plan: { taskId: string; intent: string; steps: unknown[] };
    executeStep: (args: {
      step: { kind: string; title?: string };
      api: {
        appendTrace: (s: string) => void;
        setFinalResult: (r: unknown) => void;
        setToolResult: (r: unknown) => void;
      };
    }) => Promise<void>;
  }) => {
    const state: {
      conversationMessages: unknown[];
      finalResult?: unknown;
      toolResult?: unknown;
      error?: unknown;
    } = { conversationMessages: [] };
    await options.executeStep({
      step: { kind: "model", title: "model" },
      api: {
        appendTrace: () => {},
        setFinalResult: (r) => {
          state.finalResult = r;
        },
        setToolResult: (r) => {
          state.toolResult = r;
        },
      },
    });
    return {
      status: "completed" as const,
      plan: options.plan,
      trace: [] as string[],
      state,
    };
  }),
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

async function runSlash(input: string, project: Project | null) {
  return executeInputTask({
    input,
    images: [],
    currentMessages: [{ role: "user", content: input }],
    model: "gpt-test",
    project,
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
    const project = makeProject(["plan", "code-review", "skill-creator"]);

    await runSlash("/weather 北京", project);

    expect(mockedTurn).toHaveBeenCalledTimes(1);
    const options = mockedTurn.mock.calls[0][0];
    // 技能正文以 systemPrompt 形式拼接进请求
    expect(String(options.systemPrompt)).toContain("curl wttr.in");
    // 最后一条用户消息是斜杠命令剥离后的参数
    const last = options.messages[options.messages.length - 1];
    expect(last.role).toBe("user");
    expect(String(last.content)).toContain("北京");
  });

  it("内置技能不在项目白名单里仍然拒绝", async () => {
    installUserSkill();
    const project = makeProject(["plan", "code-review", "skill-creator"]);

    await expect(runSlash("/expert-manager 创建专家", project)).rejects.toThrow(
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
    // 本地确定性执行，不该再走一轮模型
    expect(mockedTurn).not.toHaveBeenCalled();
    expect(result.intent).toBe("local_command");
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
