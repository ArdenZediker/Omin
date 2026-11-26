/**
 * Omni 统一插件系统（受 SkillHub / DeepSeek Harness 启发）
 * 「一切皆插件」：技能、工具、连接器与专家预设走同一套 manifest + registry。
 */

import type { InvocationPolicy } from "./invocation";

export type PluginKind = "skill" | "tool" | "connector" | "expert";

export type PluginSource =
  | { type: "builtin" }
  | { type: "local"; path: string }
  /**
   * 应用内自建、**不对应任何磁盘目录或外部来源**的项。
   *
   * 专家预设的「保存为专家预设」把当前项目指令存入注册表（SQLite 快照），
   * 不对应磁盘目录 —— 卸载时不该去删目录，
   * 所以不能复用 `local`（那个的语义是「磁盘上有个目录」，技能卸载要连目录一起删）。
   */
  | { type: "user" }
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
  /** 技能适用场景；与 description 分开，供模型目录做触发路由。 */
  whenToUse?: string;
  /** 目录型技能的相对资源根（references/scripts/assets 等从这里解析）。 */
  resourceBase?: string;
  /** 面向模型与面向用户的调用策略；缺省两边都允许。 */
  invocation?: InvocationPolicy;

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

  // ---- expert preset ----
  /** 由结构化 DSH 专家资料编译出的角色提示词；运行规则由运行时追加。 */
  templatePrompt?: string;
  /** DSH 专家档案的结构化角色资料，默认专家与用户创建的专家共用此形状。 */
  expertProfile?: ExpertProfile;
  /**
   * 专家项目应用指令。它是 Omni 的项目集成扩展，不属于 DSH 专家定义本体；
   * 新建专家不再填写此字段，历史数据仍保留以兼容已有项目。
   */
  instruction?: string;
  /** 一次性起手句，属于 Omni 输入框集成，不参与专家角色定义。 */
  starterPrompt?: string;
  /** 专家默认允许使用的工具。 */
  defaultToolIds?: string[];
  /** 专家默认注入的技能。 */
  defaultSkillIds?: string[];
  /** 专家绑定的 MCP 连接器。 */
  defaultMcpConnectorIds?: string[];
};

export type ExpertProfile = {
    role: string;
    methodology: string;
    boundaries: string;
    deliverables: string;
    examples: Array<{ id: string; title: string; prompt: string }>;
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
  whenToUse?: string;
  resourceBase?: string;
  invocation?: InvocationPolicy;
};

/** 从插件导出为旧版 ToolManifest（兼容 localTools） */
export type PluginToolContribution = {
  id: string;
  command?: string;
  title: string;
  description: string;
  promptContribution?: string;
  invocation?: InvocationPolicy;
};
