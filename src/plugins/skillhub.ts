/**
 * SkillHub 实时接入（参考 @cocofhu/skillhub —— DeepSeek Harness 的 SkillHub 插件）。
 *
 * 该 npm 包文档了 SkillHub 的公共 HTTP API 与安装机制：
 *   - 技能列表   GET /api/skills
 *   - 技能详情   GET /api/v1/skills/{slug}
 *   - 技能下载   GET /api/v1/download?slug={slug}&source=dsh  (zip)
 *   - DSH 插件   GET /api/v1/plugins  /  GET /api/v1/plugins/categories
 *
 * 我们复用同一套公开 API，并把「技能」落地为 Omni 的 skill 插件：
 * 由 Rust 命令 install_skillhub_skill 下载 zip、解压（带路径穿越防护）、
 * 校验 SKILL.md，再交给 pluginRegistry.parseSkillMarkdown 解析注册，
 * 从而补全「一切皆插件」的真实市场安装闭环。
 */

import { invoke } from "@tauri-apps/api/core";
import { pluginRegistry, parseSkillMarkdown } from "./registry";
import type { PluginManifest } from "./types";

export interface SkillhubSkillSummary {
  slug: string;
  name: string;
  description: string;
  description_zh?: string;
  category?: string;
  subCategories?: Array<{ key: string; name: string }>;
  downloads?: number;
  installs?: number;
  stars?: number;
  score?: number;
  iconUrl?: string;
  namespace?: { canonicalName: string; displayName: string };
  ownerName?: string;
  source?: string;
  labels?: Record<string, string>;
  homepage?: string;
}

export interface SkillhubPluginSummary {
  fullName: string;
  name: string;
  owner: string;
  description?: string;
  categoryKey?: string;
  avatarUrl?: string;
  stars?: number;
  forks?: number;
  openIssues?: number;
  license?: string;
  repositoryUrl?: string;
  installability?: string;
  topics?: string[];
}

/** SkillHub 分类 key → Omni 中文分类（PLUGIN_CATEGORIES）。 */
const SKILLHUB_CATEGORY_MAP: Record<string, string> = {
  "pay-skill": "Pay Skill",
  "office-efficiency": "办公效率",
  office: "办公效率",
  productivity: "办公效率",
  "content-creation": "内容创作",
  content: "内容创作",
  dev: "开发编程",
  "dev-programming": "开发编程",
  development: "开发编程",
  "data-analysis": "数据分析",
  data: "数据分析",
  "design-multimedia": "设计多媒体",
  design: "设计多媒体",
  multimedia: "设计多媒体",
  agent: "AI Agent",
  "ai-agent": "AI Agent",
  "agent-workflow": "AI Agent",
  workflow: "AI Agent",
  "web-tools": "AI Agent",
  tools: "AI Agent",
  knowledge: "知识管理",
  "knowledge-management": "知识管理",
  business: "商业运营",
  "business-operations": "商业运营",
  education: "教育学习",
  "education-learning": "教育学习",
  industry: "行业专业",
  "industry-professional": "行业专业",
  "it-ops": "IT 运维与安全",
  "it-operations-security": "IT 运维与安全",
  "admin-security": "IT 运维与安全",
  security: "IT 运维与安全",
  system: "IT 运维与安全",
  life: "生活服务",
  "life-services": "生活服务",
  memory: "生活服务",
};

export function mapSkillhubCategory(key?: string): string {
  if (!key) return "知识管理";
  return SKILLHUB_CATEGORY_MAP[key] ?? "知识管理";
}

export function skillUniqueKey(s: SkillhubSkillSummary): string {
  // SkillHub 不同 namespace 下可能出现同名 slug，用 namespace + slug 作为唯一键
  const ns = s.namespace?.canonicalName ?? s.ownerName ?? "";
  return ns ? `${ns}/${s.slug}` : s.slug;
}

export async function listSkillhubSkills(opts: {
  query?: string;
  category?: string;
  page?: number;
  limit?: number;
} = {}): Promise<SkillhubSkillSummary[]> {
  // /api/skills 服务端不支持 category 参数，传了会 400，所以只拉全量后前端过滤；支持 page 翻页
  const result = await invoke<{ skills: SkillhubSkillSummary[] }>("list_skillhub_skills", {
    query: opts.query ?? null,
    page: opts.page ?? 1,
    limit: opts.limit ?? 60,
  });
  let skills: SkillhubSkillSummary[] = result.skills ?? [];

  const q = opts.query?.trim().toLowerCase();
  if (q) {
    skills = skills.filter((s) =>
      `${s.name} ${s.description} ${s.description_zh ?? ""} ${s.slug}`.toLowerCase().includes(q),
    );
  }

  const zhCategory = opts.category?.trim();
  if (zhCategory && zhCategory !== "全部") {
    skills = skills.filter((s) => mapSkillhubCategory(s.category) === zhCategory);
  }
  return skills;
}

export async function listSkillhubPlugins(opts: {
  query?: string;
  category?: string;
  limit?: number;
} = {}): Promise<SkillhubPluginSummary[]> {
  const result = await invoke<SkillhubPluginSummary[]>("list_skillhub_plugins", {
    query: opts.query ?? null,
    category: opts.category ?? "全部",
    limit: opts.limit ?? 60,
  });
  return result ?? [];
}

export function mapSkillToManifest(s: SkillhubSkillSummary): PluginManifest {
  const requiresApiKey = s.labels?.requires_api_key === "true";
  return {
    id: s.slug,
    name: s.name,
    description: s.description_zh || s.description || "",
    version: "0.0.0",
    author: s.ownerName,
    kind: "skill",
    category: mapSkillhubCategory(s.category),
    icon: s.iconUrl,
    tags: [s.category ?? "", ...(s.subCategories?.map((x) => x.name) ?? [])].filter(Boolean),
    command: `/${s.slug}`,
    body: "",
    systemPrompt: s.description_zh || s.description,
    sourceUrl: s.homepage || `https://skillhub.cn/skill/${s.slug}`,
    // 标注是否需要 API Key，便于 UI 提示
    ...(requiresApiKey ? { promptPrefix: "（该技能可能需要 API Key）" } : {}),
  };
}

export interface SkillhubInstallOutcome {
  slug: string;
  path: string;
  manifest: PluginManifest;
}

/** 从 SkillHub 实时下载并安装一个技能到 Omni（落地为 skill 插件）。 */
export async function installSkillhubSkill(slug: string): Promise<SkillhubInstallOutcome> {
  const res = await invoke<{ slug: string; path: string; skill_md: string }>(
    "install_skillhub_skill",
    { slug },
  );
  const parsed = parseSkillMarkdown(res.skill_md);
  if (!parsed) throw new Error("SKILL.md 解析失败");
  parsed.id = res.slug;
  parsed.kind = "skill";
  parsed.command = parsed.command || `/${res.slug}`;
  parsed.sourceUrl = `https://skillhub.cn/skill/${res.slug}`;
  pluginRegistry.install(parsed, {
    type: "marketplace",
    repository: `skillhub/${res.slug}`,
  });
  return { slug: res.slug, path: res.path, manifest: parsed };
}

export async function uninstallSkillhubSkill(slug: string): Promise<void> {
  await invoke("uninstall_skillhub_skill", { slug });
  pluginRegistry.uninstall(slug);
}
