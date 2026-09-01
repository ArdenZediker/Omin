/**
 * SkillHub 实时接入（参考 @cocofhu/skillhub —— DeepSeek Harness 的 SkillHub 插件）。
 *
 * 该 npm 包文档了 SkillHub 的公共 HTTP API 与安装机制：
 *   - 技能列表       GET /api/skills
 *   - 技能分类       GET /api/v1/categories
 *   - 技能详情       GET /api/v1/skills/{slug}
 *   - 技能下载       GET /api/v1/download?slug={slug}&source=dsh  (zip)
 *   - DSH 插件       GET /api/v1/plugins
 *   - DSH 插件分类   GET /api/v1/plugins/categories
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
  namespace?: { canonicalName: string; displayName: string; handle?: string; publicSlug?: string };
  ownerName?: string;
  source?: string;
  labels?: Record<string, string>;
  homepage?: string;
  /** 实际仓库地址（区别于 SkillHub 上展示页）。 */
  upstream_url?: string;
  /** 服务端时间戳（毫秒）。 */
  updated_at?: number;
  created_at?: number;
  /** 发布版本号，缺省时安装器用 0.0.0 占位。 */
  version?: string;
  /** 是否经官方认证发布。 */
  verified?: boolean;
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
 * 数据来自 SkillHub 官方 /api/v1/categories（2026-08-30 共 13 个），
 * 必须与服务端真实 category key 严格对应，避免传中文名或别名导致 400。
 */
const SKILLHUB_CATEGORY_MAP: Record<string, string> = {
  "pay-skill": "Pay Skill",
  "office-efficiency": "办公效率",
  "content-creation": "内容创作",
  "dev-programming": "开发编程",
  "data-analysis": "数据分析",
  "design-media": "设计多媒体",
  "ai-agent": "AI Agent",
  "knowledge-management": "知识管理",
  "business-ops": "商业运营",
  "education": "教育学习",
  "professional": "行业专业",
  "it-ops-security": "IT 运维与安全",
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
  labels?: string;
  source?: string;
} = {}): Promise<SkillhubSkillSummary[]> {
  // /api/skills 服务端支持英文 category key，前端传中文时反向映射成 key。
  // 不合法的 category 会被服务端 400 拒绝，所以空/全部/未知分类时不传该参数。
  // sortBy 真实取值（对齐官网）：downloads / score(默认) / updated_at / stars。
  // labels 用于服务端 label 过滤（如 requires_api_key:true，Rust 侧做 URL 编码）。
  // source 用于筛选来源：空(全部) / clawhub / skillhub。
  const categoryKey = reverseSkillhubCategory(opts.category);
  const result = await invoke<{ skills: SkillhubSkillSummary[] }>("list_skillhub_skills", {
    query: opts.query ?? null,
    category: categoryKey ?? null,
    page: opts.page ?? 1,
    limit: opts.limit ?? 60,
    sortBy: opts.sortBy ?? null,
    labels: opts.labels ?? null,
    source: opts.source ?? null,
  });
  // 搜索已由服务端 keyword 参数完成，这里不再做前端过滤。
  return result.skills ?? [];
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

/** 从 SkillHub 实时下载并安装一个技能到 Omni（落地为 skill 插件）。
 *  id = `${namespace}/${slug}`：与 SkillhubBrowser 的 skillUniqueKey 完全对齐，
 *  不同 namespace 下同名 slug 也能正确区分；斜杠命令仍用 `/slug` 保持简短。
 *
 *  可选 summary 是 SkillHub 列表/详情返回的元数据，用于补全 SKILL.md frontmatter
 *  里缺失的视觉信息（尤其是 `iconUrl` —— SKILL.md 里通常没有这一行，
 *  不补的话已安装技能的图标会走 kind 兜底，显示成所有技能同款的占位 Wand2）。 */
export async function installSkillhubSkill(
  slug: string,
  namespace?: string,
  summary?: SkillhubSkillSummary,
): Promise<SkillhubInstallOutcome> {
  const res = await invoke<{ slug: string; path: string; skill_md: string }>(
    "install_skillhub_skill",
    { slug },
  );
  const parsed = parseSkillMarkdown(res.skill_md);
  if (!parsed) throw new Error("SKILL.md 解析失败");
  const id = namespace ? `${namespace}/${res.slug}` : res.slug;
  parsed.id = id;
  parsed.kind = "skill";
  // 命令保持简短（不带 namespace），便于用户斜杠输入
  parsed.command = parsed.command || `/${res.slug}`;
  parsed.sourceUrl = `https://skillhub.cn/skill/${res.slug}`;
  // 用 SkillHub summary 补全 SKILL.md 里没有的视觉信息。
  // SKILL.md frontmatter 通常只有 slug/name/version/description 等元数据，
  // iconUrl/avatar 等纯展示字段只存在于列表 API，补到 manifest.icon 才能在
  // 「我的技能」tab 渲染对应图标。
  if (summary) {
    if (!parsed.icon && summary.iconUrl) parsed.icon = summary.iconUrl;
    if (!parsed.author && summary.ownerName) parsed.author = summary.ownerName;
    if (!parsed.category && summary.category) {
      parsed.category = mapSkillhubCategory(summary.category);
    }
  }
  pluginRegistry.install(parsed, {
    type: "marketplace",
    repository: `skillhub/${id}`,
  });
  return { slug: res.slug, path: res.path, manifest: parsed };
}

export async function uninstallSkillhubSkill(
  slug: string,
  namespace?: string,
): Promise<void> {
  await invoke("uninstall_skillhub_skill", { slug });
  const id = namespace ? `${namespace}/${slug}` : slug;
  pluginRegistry.uninstall(id);
}
