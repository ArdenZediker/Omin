/**
 * Omni 统一插件系统（受 SkillHub / DeepSeek Harness 启发）
 * 「一切皆插件」：技能、工具、连接器、专家、项目模板都走同一套 manifest + registry。
 */

export type PluginKind = "skill" | "tool" | "connector" | "expert" | "template";

export type PluginSource =
  | { type: "builtin" }
  | { type: "local"; path: string }
  | { type: "marketplace"; repository: string; commit?: string };

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
  /** 专家系统提示词或项目模板完整指令 */
  templatePrompt?: string;
  /** 项目模板推荐默认 allowedToolIds */
  defaultToolIds?: string[];
  /** 项目模板推荐默认 allowedSkillIds */
  defaultSkillIds?: string[];
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
