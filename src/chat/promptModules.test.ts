import { describe, expect, it } from "vitest";
import type { Message } from "../adapters/types";
import type { Project } from "./types";
import { buildOmniSystemPrompt, TOOL_PROTOCOL_MAX_CHARS } from "./promptModules";

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

  // 回归：记忆协议原本只指向隐藏结构块，而那个块落在**项目级**存储、无项目时还会被静默丢弃，
  // 于是 persona 长期记忆文件（截图里那 4 张卡片）永远没人写。协议里必须写明分流。
  it("记忆协议把跨项目的长期偏好分流到 /update_persona", () => {
    const prompt = buildOmniSystemPrompt({ messages });

    expect(prompt).toContain("记忆协议");
    expect(prompt).toContain("/update_persona");
    expect(prompt).toContain("跨项目");
    // 隐藏结构块仍然保留（项目内事实的落点）
    expect(prompt).toContain("<omni_memory>");
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

  // 渐进式披露：具备工具的运行只注入「目录条目」，正文改由 /use_skill 按需载入。
  it("catalogOnly 技能只注入目录并指明 /use_skill 载入路径", () => {
    const prompt = buildOmniSystemPrompt({
      messages,
      enabledSkillPrompts: [
        {
          id: "weather",
          name: "weather",
          command: "/weather",
          description: "查询天气预报，无需 API 密钥",
          prompt: "",
          catalogOnly: true,
        },
      ],
    });

    // 目录信息仍在：名 / 命令 / 适用场景——模型据此判断要不要载入。
    expect(prompt).toContain("### 技能：weather（/weather）");
    expect(prompt).toContain("适用场景：查询天气预报，无需 API 密钥");
    // 正文未预载，改为显式指路。
    expect(prompt).toContain("正文：需先调用 /use_skill weather 载入");
    expect(prompt).toContain("必须先调用 /use_skill <技能 id> 载入该技能正文");
    expect(prompt).toContain("同一个技能本轮载入一次即可");
  });

  // 紧凑窗快速问答那条链不传工具，没有 /use_skill 可用，必须退回内联正文。
  it("非 catalogOnly 技能仍内联正文，且不出现按需载入的措辞", () => {
    const prompt = buildOmniSystemPrompt({
      messages,
      enabledSkillPrompts: [
        {
          id: "weather",
          name: "weather",
          command: "/weather",
          description: "查询天气预报，无需 API 密钥",
          prompt: "curl -s \"wttr.in/London?format=3\"",
        },
      ],
    });

    expect(prompt).toContain("wttr.in/London");
    expect(prompt).not.toContain("/use_skill");
    expect(prompt).toContain("必须按该技能正文给出的方法与命令执行");
  });

  it("没有启用技能时不注入技能分片", () => {
    const prompt = buildOmniSystemPrompt({ messages });
    expect(prompt).not.toContain("已启用技能");
  });

  /** 从整份系统提示里取回「工具清单」那一个分片（装配器用 `\n\n---\n\n` 分隔）。 */
  function findToolFragment(prompt: string) {
    const fragment = prompt.split("\n\n---\n\n").find((part) => part.includes("当前助手已启用工具："));
    expect(fragment).toBeTruthy();
    return fragment as string;
  }

  // 回归：旧实现是 `compactList(..., 16)` 先把清单砍到 16 条、再由 capFragment 硬切 4000 字符。
  // 实测 25 个内置工具的完整描述合计 13627 字符 ⇒ 模型只拿到前 8 个工具加半条，
  // Sub Agent / Shell / 4 个导出工具等 17 个**整条丢失**，而清单看起来还是完整的。
  // 修法：超预算时逐级收紧「单条描述」，工具条目一个都不丢。
  it("工具清单超预算时逐级缩短描述，不丢任何工具条目", () => {
    const enabledToolNames = Array.from({ length: 30 }, (_, index) => `Tool-${String(index + 1).padStart(2, "0")}`);
    const enabledToolDescriptions = Object.fromEntries(
      enabledToolNames.map((name) => [name, `使用说明：${"细节".repeat(600)}`]),
    );

    const prompt = buildOmniSystemPrompt({
      messages,
      includeToolProtocol: true,
      enabledToolNames,
      enabledToolDescriptions,
    });
    const toolFragment = findToolFragment(prompt);

    // 要害：每一个工具名都必须在场
    for (const name of enabledToolNames) {
      expect(toolFragment).toContain(name);
    }
    // 描述被压缩（head+tail），而不是整条工具被丢掉
    expect(toolFragment).toContain("中间省略");
    // 既没走到「点名省略工具」的兜底，也没触发分片的硬截断
    expect(toolFragment).not.toContain("个工具未列出");
    expect(toolFragment).not.toContain("字符上限");
    // 「保持上下文有界」的不变式仍然成立
    expect(toolFragment.length).toBeLessThanOrEqual(TOOL_PROTOCOL_MAX_CHARS);
  });

  // 工具数极端多（连「只列名字」都放不下）时的兜底：按序保住前若干条，并**显式点名**省略了谁。
  // 绝不允许出现「清单看起来完整、其实少了工具」——那正是这次要修的缺陷。
  it("工具数极端多时点名被省略的工具，且提示本身也有界", () => {
    const enabledToolNames = Array.from(
      { length: 1200 },
      (_, index) => `Tool-${String(index + 1).padStart(4, "0")}-long`,
    );

    const prompt = buildOmniSystemPrompt({ messages, includeToolProtocol: true, enabledToolNames });
    const toolFragment = findToolFragment(prompt);

    expect(toolFragment).toContain("Tool-0001-long");
    expect(toolFragment).toContain("个工具未列出");
    // 被省略的工具不在 10 条点名预览里 ⇒ 不出现
    expect(toolFragment).not.toContain("Tool-1200-long");
    // 兜底分支同样不能把分片顶穿
    expect(toolFragment.length).toBeLessThanOrEqual(TOOL_PROTOCOL_MAX_CHARS);
  });

  // 模板字符串里直接写 Windows 绝对路径时，单反斜杠会被当转义序列吃掉（`\n` → 真换行），
  // 模型看到的示例路径会变成「C:UsersPengYDesktop 换行 otes.md」。必须写双反斜杠。
  it("本地能力提示里的 Windows 示例路径原样保留", () => {
    const prompt = buildOmniSystemPrompt({ messages });

    expect(prompt).toContain("C:\\Users\\PengY\\Desktop\\notes.md");
  });

  // 分片截断一律 head+tail：只留开头会把「尾部才是结论」的内容（人设的长期记忆、AGENTS.md 收尾约定）砍掉。
  it("分片超预算时保留尾部内容，且不截出半个代理项", () => {
    const prompt = buildOmniSystemPrompt({
      messages,
      persona: {
        style: "default",
        customInstruction: "",
        userName: "",
        assistantName: "",
        personaDescription: "",
        longTermMemory: `🦊${"头".repeat(7000)}尾巴标记END`,
        agentsMd: "",
      },
    });

    expect(prompt).toContain("尾巴标记END");
    expect(prompt).toContain("已省略中间");
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(prompt)).toBe(false);
  });
});
