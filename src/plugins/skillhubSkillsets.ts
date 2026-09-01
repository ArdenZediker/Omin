/**
 * SkillHub 专家团（skillsets）接入。
 *
 * 专家团是官方编排的 meta-skill 包，与单个技能的区别：
 *   - content 本身就是一份完整的 SKILL.md 原文，frontmatter 里
 *     package_type: meta-skill，orchestration.children 列出引用的子技能 slug，
 *     正文是按步骤串联的工作流。装一条即可用，子技能属于按需增强。
 *   - 详情接口额外给出子技能的精确 {slug, namespace} 映射，可批量取元数据。
 *
 * 为什么全部走 Rust 转发而不是前端 fetch：
 * skillsets / skills/batch 接口只在 Origin 为 https://www.skillhub.cn 时下发
 * Access-Control-Allow-Origin，WebView（tauri://localhost / http://tauri.localhost）
 * 直连拿不到该响应头，会被浏览器 CORS 拦截。因此与 listSkillhubSkills 保持一致，
 * 统一经 Rust 命令转发。
 *
 * 安装形态：content 直接落地为 skills_dir/<slug>/SKILL.md 并注册为**一条** skill
 * 插件（不是把子技能全部展开），保持「一个专家团 = 一个包」的心智。子技能可在详情
 * 抽屉里逐个或一键安装（走既有 installSkillhubSkill 闭环）。
 */

import { invoke } from "@tauri-apps/api/core";
import { pluginRegistry, parseSkillMarkdown } from "./registry";
import { uninstallSkillhubSkill } from "./skillhub";
import type { PluginManifest } from "./types";

/** 专家团场景分类 key → 中文展示名（与 /api/v1/skillsets 的 scene 字段对应）。 */
const SKILLSET_SCENE_MAP: Record<string, string> = {
  academic: "学术研究",
  "content-creation": "内容创作",
  design: "产品设计",
  ecommerce: "电商运营",
  education: "教育教学",
  finance: "金融财务",
  healthcare: "医疗健康",
  hr: "人力资源",
  legal: "法律法务",
  lifestyle: "生活健康",
  marketing: "市场营销",
  media: "影音传媒",
  mysticism: "传统文化",
  tech: "技术开发",
};

export function mapSkillsetScene(scene?: string): string {
  if (!scene) return "其他";
  return SKILLSET_SCENE_MAP[scene] ?? scene;
}

/** 列表项 + 详情共用的字段（详情多了 content / skills / iconUrl 等）。 */
export interface SkillhubSkillset {
  id: number;
  slug: string;
  displayName: string;
  displayNameEn?: string;
  summary: string;
  summaryEn?: string;
  scene?: string;
  subScene?: string;
  scope?: number;
  /** meta-skill 完整 SKILL.md 原文，仅详情接口返回。 */
  content?: string;
  contentEn?: string;
  iconUrl?: string;
  published?: number;
  createdAt?: number;
  updatedAt?: number;
  /** 子技能裸 slug 列表，仅详情接口返回。 */
  skillSlugs?: string[];
  /** 子技能精确映射（含 namespace），仅详情接口返回。 */
  skills?: Array<{ slug: string; namespace: string }>;
}

/** 子技能的展示用元数据（来自 POST /api/v1/skills/batch）。 */
export interface SkillsetChildDetail {
  slug: string;
  /** namespace 的 handle，如 clawhub_chenchen913。 */
  namespace: string;
  /** 规范名，如 @clawhub_chenchen913/healthfit-cn。 */
  canonicalName?: string;
  displayName?: string;
  ownerName?: string;
  iconUrl?: string;
  summary?: string;
  category?: string;
  version?: string;
  downloads?: number;
  installs?: number;
  requiresApiKey?: boolean;
  /** 安全扫描状态：benign 等。 */
  securityStatus?: string;
  securityReportUrl?: string;
  homepage?: string;
}

export interface SkillsetChildrenResult {
  items: SkillsetChildDetail[];
  /** 服务端查不到的子技能（已下架/改名），UI 需降级展示。 */
  missing: Array<{ slug: string; namespace: string }>;
}

/** 专家团列表。接口一次返回全量（59 条，无分页字段）。 */
export async function listSkillhubSkillsets(): Promise<SkillhubSkillset[]> {
  const raw = await invoke<unknown[]>("list_skillhub_skillsets");
  return (raw ?? [])
    .map((item) => normalizeSkillset(item))
    .filter((s) => Boolean(s.slug));
}

/** 专家团详情：content（meta-skill 原文）+ 子技能精确映射。 */
export async function getSkillhubSkillset(
  slug: string,
): Promise<SkillhubSkillset> {
  const raw = await invoke<unknown>("get_skillhub_skillset", { slug });
  return normalizeSkillset(raw);
}

/** 批量取子技能元数据。pairs 直接传详情接口的 skills 字段。 */
export async function fetchSkillsetChildren(
  pairs: Array<{ slug: string; namespace: string }>,
): Promise<SkillsetChildrenResult> {
  if (pairs.length === 0) return { items: [], missing: [] };
  const raw = await invoke<Record<string, unknown>>("batch_skillhub_skills", {
    skills: JSON.stringify(pairs),
  });
  const items = Array.isArray(raw?.items) ? raw.items : [];
  const missing = Array.isArray(raw?.missing) ? raw.missing : [];
  return {
    items: items.map(normalizeChild).filter((c) => Boolean(c.slug)),
    missing: missing.map(normalizeChild) as SkillsetChildrenResult["missing"],
  };
}

export interface SkillsetInstallOutcome {
  slug: string;
  path: string;
  manifest: PluginManifest;
}

/**
 * 安装专家团：把 content 落地为一条 meta-skill 插件。
 * 不走 zip 下载——详情接口的 content 已经是完整 SKILL.md 原文。
 */
export async function installSkillhubSkillset(
  set: SkillhubSkillset,
): Promise<SkillsetInstallOutcome> {
  if (!set.content) {
    throw new Error("专家团内容缺失，请先加载详情");
  }
  const res = await invoke<{ slug: string; path: string; skill_md: string }>(
    "install_skillhub_meta_skill",
    { slug: set.slug, content: set.content },
  );
  const parsed = parseSkillMarkdown(res.skill_md);
  if (!parsed) throw new Error("专家团 SKILL.md 解析失败");
  parsed.id = res.slug;
  parsed.kind = "skill";
  parsed.command = parsed.command || `/${res.slug}`;
  if (!parsed.icon && set.iconUrl) parsed.icon = set.iconUrl;
  if (!parsed.category) parsed.category = mapSkillsetScene(set.scene);
  parsed.sourceUrl = setSourceUrl(res.slug);
  pluginRegistry.install(parsed, {
    type: "marketplace",
    repository: `skillset/${res.slug}`,
  });
  return { slug: res.slug, path: res.path, manifest: parsed };
}

/** 卸载专家团：与单个技能共用同一目录与卸载命令。 */
export async function uninstallSkillhubSkillset(slug: string): Promise<void> {
  await uninstallSkillhubSkill(slug);
}

function setSourceUrl(slug: string): string {
  return `https://www.skillhub.cn/skillsets/${slug}`;
}

// ---- 归一化：Rust 侧返回的是 serde_json::Value，字段名与服务端一致 ----

/** 从任意 JSON 值里安全取字段（非对象一律返回 undefined）。 */
function pick(o: unknown, key: string): unknown {
  if (typeof o !== "object" || o === null) return undefined;
  return (o as Record<string, unknown>)[key];
}

function normalizeSkillset(raw: unknown): SkillhubSkillset {
  const rawSkills = pick(raw, "skills");
  const skills = Array.isArray(rawSkills)
    ? (rawSkills as unknown[])
        .map((s) => ({
          slug: String(pick(s, "slug") ?? ""),
          namespace: String(pick(s, "namespace") ?? ""),
        }))
        .filter((s) => s.slug)
    : undefined;
  const rawSlugs = pick(raw, "skillSlugs");
  const skillSlugs = Array.isArray(rawSlugs)
    ? (rawSlugs as unknown[]).map((s) => String(s))
    : undefined;
  return {
    id: numOrUndef(pick(raw, "id")) ?? 0,
    slug: String(pick(raw, "slug") ?? ""),
    displayName: String(pick(raw, "displayName") ?? pick(raw, "slug") ?? ""),
    displayNameEn: strOrUndef(pick(raw, "displayNameEn")),
    summary: String(pick(raw, "summary") ?? ""),
    summaryEn: strOrUndef(pick(raw, "summaryEn")),
    scene: strOrUndef(pick(raw, "scene")),
    subScene: strOrUndef(pick(raw, "subScene")),
    scope: numOrUndef(pick(raw, "scope")),
    content: strOrUndef(pick(raw, "content")),
    contentEn: strOrUndef(pick(raw, "contentEn")),
    iconUrl: strOrUndef(pick(raw, "iconUrl")),
    published: numOrUndef(pick(raw, "published")),
    createdAt: numOrUndef(pick(raw, "createdAt")),
    updatedAt: numOrUndef(pick(raw, "updatedAt")),
    skillSlugs,
    skills,
  };
}

function normalizeChild(raw: unknown): SkillsetChildDetail {
  const o = raw;
  const ns = pick(o, "namespace");
  const nsHandle =
    typeof ns === "string"
      ? ns
      : strOrUndef(pick(ns, "handle")) ?? strOrUndef(pick(ns, "displayName")) ?? "";
  const canonical = typeof ns === "object" ? strOrUndef(pick(ns, "canonicalName")) : undefined;
  const skill = pick(o, "skill") ?? {};
  const stats = pick(skill, "stats") ?? {};
  const labels = pick(skill, "labels") ?? {};
  const security = pick(o, "securityReports");
  const keen = pick(security, "keen") ?? {};
  return {
    slug: String(pick(o, "slug") ?? ""),
    namespace: String(nsHandle ?? ""),
    canonicalName: canonical,
    displayName: strOrUndef(pick(skill, "displayName")) ?? String(pick(o, "slug") ?? ""),
    ownerName: strOrUndef(pick(pick(o, "owner"), "displayName")),
    iconUrl: strOrUndef(pick(skill, "iconUrl")),
    summary: strOrUndef(pick(skill, "summary_zh")) ?? strOrUndef(pick(skill, "summary")),
    category: strOrUndef(pick(skill, "category")),
    version: strOrUndef(pick(pick(o, "latestVersion"), "version")),
    downloads: numOrUndef(pick(stats, "downloads")),
    installs: numOrUndef(pick(stats, "installs")),
    requiresApiKey: String(pick(labels, "requires_api_key") ?? "") === "true",
    securityStatus: strOrUndef(pick(keen, "status")),
    securityReportUrl: strOrUndef(pick(keen, "reportUrl")),
    homepage: strOrUndef(pick(skill, "sourceUrl")),
  };
}

function strOrUndef(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length === 0) return undefined;
  return v;
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
