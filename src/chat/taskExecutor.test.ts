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
});
