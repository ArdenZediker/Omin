/**
 * Omni 统一插件系统（受 SkillHub / DeepSeek Harness 启发）
 * 「一切皆插件」：技能、工具、连接器、专家、项目预设都走同一套 manifest + registry。
 */

export type PluginKind = "skill" | "tool" | "connector" | "expert" | "template";

export type PluginSource =
  | { type: "builtin" }
  | { type: "local"; path: string }
  | {
      type: "marketplace";
      repository: string;
      commit?: string;
      /**
       * 该技能是从哪个专家团（skillset）里装进来的，值为 skillset slug。
       *
       * 为什么记在子技能自己身上：「我的技能」要求子技能收在套件卡片内、不平铺，
       * 而 Grouping 必须能在**离线、同步**的渲染里完成 —— 反查「哪些技能属于这个套件」
       * 若靠再请求一次 skillset 详情接口，每次渲染都要发网络请求，装了什么就得看到什么
       * 的语义也会被网络抖动破坏。记在 source 里则随注册表一起持久化，读一次即可。
       *
       * 只有 installSkillhubSkill 带上 skillsetSlug 时才会写入；单独安装的技能没有它。
       */
      skillsetSlug?: string;
    };

export type PluginConfigFieldType = "string" | "password" | "number" | "boolean" | "select";

export type PluginConfigField = {
  id: string;
  label: string;
  type: PluginConfigFieldType;
  required?: boolean;
  placeholder?: string;
  defaultValue?: string | number | boolean;
  options?: Array<{ value: string; label: string }>;
};

export type PluginManifest = {
  /** kebab-case 唯一标识 */
  id: string;
  /** 展示名称 */
  name: string;
  /** 一句话描述（模型/用户靠它判断是否匹配） */
  description: string;
  version: string;
  /** 作者或组织，例如 liustack、omdsh-dev */
  author?: string;
  kind: PluginKind;
  /** SkillHub 风格分类：开发编程、内容创作、数据分析、知识管理、商业运营、设计多媒体 */
  category?: string;
  /** 工具在 Marketplace 中的功能分组（如会话、文件、Git、导出等），仅 kind === "tool" 时使用 */
  group?: string;
  /** emoji 或 lucide icon name */
  icon?: string;
  /** 来源页（如 SkillHub 技能详情页），用于「在来源查看」 */
  sourceUrl?: string;
  tags?: string[];
  /** 该插件自带的详细指令/正文（DeepSeek Harness SKILL.md 正文） */
  body?: string;

  // ---- skill ----
  command?: string;
  systemPrompt?: string;
  promptPrefix?: string;

  // ---- tool ----
  /** 工具对系统提示词的声明式贡献 */
  promptContribution?: string;

  // ---- connector ----
  provider?: string;
  baseUrl?: string;
  configFields?: PluginConfigField[];

  // ---- expert / template ----
  /** 专家系统提示词（角色定义，长文；子 Agent 运行规则由 `chat/subAgent.ts` 运行时追加）。 */
  templatePrompt?: string;
  /**
   * `kind:"template"` 专用：**持久项目指令**，新建项目时写进 `project.systemPrompt`。
   *
   * 与 `starterPrompt` 必须分开 —— 两者曾经挤在 `templatePrompt` 一个字段里，
   * 结果那句「请帮我梳理当前问题的背景…」这种**一次性用户问句**被当成**每轮都生效的
   * 项目系统指令**写进了项目。这里放的是"这个项目该怎么干活"，不是"这次想问什么"。
   */
  instruction?: string;
  /**
   * `kind:"template"` 专用：**起手一句**，点「插入输入框」时写进输入框草稿（不直接发送）。
   * 语义等同空态推荐卡（`app/constants.ts::EMPTY_CHAT_STARTERS.prompt`），只是来源不同。
   */
  starterPrompt?: string;
  /** 项目预设推荐默认 allowedToolIds */
  defaultToolIds?: string[];
  /** 项目预设推荐默认 allowedSkillIds */
  defaultSkillIds?: string[];
  /**
   * 专家绑定的 MCP 连接器 id（连接器 manifest id 即 MCP 的 serverId，
   * 其工具名形如 `mcp__{连接器id}__{工具}`）。
   *
   * 为什么 MCP 要单独声明：`buildChatTools()` 只产出内置 + 项目工具，**永远不含 `mcp__*`**，
   * 所以专家的 `defaultToolIds` 勾不到任何 MCP 工具。不单列这一项，专家在场时 MCP 只能被整体摘掉。
   */
  defaultMcpConnectorIds?: string[];
};

export type InstalledPlugin = {
  manifest: PluginManifest;
  enabled: boolean;
  installedAt: number;
  source: PluginSource;
  /** 连接器类插件的运行时配置（API Key 等） */
  config?: Record<string, unknown>;
};

export type PluginFilter = {
  kind?: PluginKind;
  category?: string;
  query?: string;
  enabled?: boolean;
};

/** 从插件导出为旧版 SlashSkill（兼容 composer / skills.ts） */
export type PluginSkillContribution = {
  id: string;
  command: string;
  title: string;
  description: string;
  systemPrompt?: string;
  promptPrefix?: string;
};

/** 从插件导出为旧版 ToolManifest（兼容 localTools） */
export type PluginToolContribution = {
  id: string;
  command?: string;
  title: string;
  description: string;
  promptContribution?: string;
};
