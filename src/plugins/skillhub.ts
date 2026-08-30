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

/** SkillHub 技能分类 key → Omni 中文分类。
 * 仅保留 SkillHub /api/skills 实际接受的合法 category key，
 * 避免反向映射时选到一个服务端不认识的别名而报 400。 */
const SKILLHUB_CATEGORY_MAP: Record<string, string> = {
  "ai-agent": "AI Agent",
  "business-ops": "商业运营",
  "content-creation": "内容创作",
  "data-analysis": "数据分析",
  "design-media": "设计多媒体",
  "dev-programming": "开发编程",
  "knowledge-management": "知识管理",
  "life-service": "生活服务",
};

/** 中文分类 → SkillHub 英文 key（取第一个匹配的 key）。 */
const REVERSE_SKILLHUB_CATEGORY_MAP: Record<string, string> = {};
for (const [key, value] of Object.entries(SKILLHUB_CATEGORY_MAP)) {
  if (!REVERSE_SKILLHUB_CATEGORY_MAP[value]) {
    REVERSE_SKILLHUB_CATEGORY_MAP[value] = key;
  }
}

export function mapSkillhubCategory(key?: string): string {
  if (!key) return "其他";
  return SKILLHUB_CATEGORY_MAP[key] ?? "其他";
}

export function reverseSkillhubCategory(zh?: string): string | undefined {
  if (!zh || zh === "全部") return undefined;
  return REVERSE_SKILLHUB_CATEGORY_MAP[zh];
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
  sortBy?: string;
} = {}): Promise<SkillhubSkillSummary[]> {
  // /api/skills 服务端支持英文 category key，前端传中文时反向映射成 key。
  // 不合法的 category 会被服务端 400 拒绝，所以空/全部/未知分类时不传该参数。
  // sortBy 为服务端排序：downloads / updated / score / stars / installs。
  const categoryKey = reverseSkillhubCategory(opts.category);
  const result = await invoke<{ skills: SkillhubSkillSummary[] }>("list_skillhub_skills", {
    query: opts.query ?? null,
    category: categoryKey ?? null,
    page: opts.page ?? 1,
    limit: opts.limit ?? 60,
    sortBy: opts.sortBy ?? null,
  });
  let skills: SkillhubSkillSummary[] = result.skills ?? [];

  const q = opts.query?.trim().toLowerCase();
  if (q) {
    skills = skills.filter((s) =>
      `${s.name} ${s.description} ${s.description_zh ?? ""} ${s.slug}`.toLowerCase().includes(q),
    );
  }
  return skills;
}

/** 从 SkillHub 获取技能分类列表（用于前端 tabs）。 */
export async function listSkillhubSkillCategories(): Promise<{ key: string; displayName: string }[]> {
  const result = await invoke<{ categories: { key: string; displayName: string }[] }>("list_skillhub_skill_categories");
  return result.categories ?? [];
}

export async function listSkillhubPlugins(opts: {
  query?: string;
  category?: string;
  limit?: number;
} = {}): Promise<SkillhubPluginSummary[]> {
  const result = await invoke<SkillhubPluginSummary[]>("list_skillhub_plugins", {
    query: opts.query ?? null,
    category: opts.category && opts.category !== "全部" ? opts.category : null,
    limit: opts.limit ?? 60,
  });
  return result ?? [];
}

/** 从 SkillHub 获取 DSH 插件分类列表。 */
export async function listSkillhubPluginCategories(): Promise<{ key: string; displayName: string }[]> {
  const result = await invoke<{ categories: { key: string; displayName: string }[] }>("list_skillhub_plugin_categories");
  return result.categories ?? [];
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
