/**
 * CB Teams 套件市场接入。
 *
 * 数据源：GitHub 仓库 zhizhunbao/workbuddy 内的 CodeBuddy Teams Marketplace
 * （plugins/marketplaces/cb_teams_marketplace），27 个「套件」——每个套件是
 * 一个包含多个 DSH 风格技能（SKILL.md）的插件包，如 document-skills（xlsx/
 * docx/pptx/pdf）、financial-analysis（DCF/LBO/三张表）等。
 *
 * 安装由 Rust 命令 install_cbteams_suite 完成：下载仓库 zip、抽取套件下
 * 全部技能目录到 ~/.dsh/skills（与 SkillHub 同布局），返回每个 SKILL.md
 * 原文；这里解析并注册为 skill 插件，复用「一切皆插件」的安装闭环。
 */

import { invoke } from "@tauri-apps/api/core";
import { pluginRegistry, parseSkillMarkdown } from "./registry";
import type { PluginManifest } from "./types";
import { uninstallSkillhubSkill } from "./skillhub";

/** 套件分类 key → 中文展示名。 */
const CBTEAMS_CATEGORY_MAP: Record<string, string> = {
  productivity: "生产力",
  finance: "金融",
  development: "开发",
  research: "研究",
  "content-creation": "内容创作",
  utility: "通用工具",
};

export function mapCbteamsCategory(key?: string): string {
  if (!key) return "其他";
  return CBTEAMS_CATEGORY_MAP[key] ?? "其他";
}

export interface CbteamsSuite {
  name: string;
  description: string;
  descriptionEn: string;
  category: string;
  categoryZh: string;
  version: string;
  author: string;
  homepage: string;
  /** 清单里声明的技能相对路径（./plugins/<suite>/skills/<skill>） */
  skills: string[];
  /** 从 skills 路径推出的技能 slug 列表（用于安装态判断） */
  skillSlugs: string[];
}

function toSkillSlug(path: string): string {
  // ./plugins/document-skills/skills/xlsx → xlsx；套件根路径（无 /skills/）→ 套件名
  const segs = path.split("/");
  const idx = segs.indexOf("skills");
  if (idx >= 0 && segs[idx + 1]) return segs[idx + 1];
  return segs[segs.length - 1] ?? path;
}

export async function listCbteamsSuites(): Promise<CbteamsSuite[]> {
  const items = await invoke<Record<string, unknown>[]>("list_cbteams_suites");
  return items.map((raw) => {
    const skills = Array.isArray(raw.skills) ? (raw.skills as string[]) : [];
    return {
      name: String(raw.name ?? ""),
      description: String(raw.description ?? ""),
      descriptionEn: String(raw.descriptionEn ?? ""),
      category: String(raw.category ?? ""),
      categoryZh: mapCbteamsCategory(String(raw.category ?? "")),
      version: String(raw.version ?? ""),
      author: String(raw.author ?? ""),
      homepage: String(raw.homepage ?? ""),
      skills,
      skillSlugs: skills.map(toSkillSlug),
    };
  });
}

export interface CbteamsInstallOutcome {
  suite: string;
  manifests: PluginManifest[];
}

/** 安装一个套件：其下全部技能落地并注册为 Omni skill 插件。 */
export async function installCbteamsSuite(suite: string): Promise<CbteamsInstallOutcome> {
  const results = await invoke<
    { slug: string; path: string; skill_md: string }[]
  >("install_cbteams_suite", { name: suite });

  const manifests: PluginManifest[] = [];
  for (const item of results) {
    const parsed = parseSkillMarkdown(item.skill_md);
    if (!parsed) continue; // 单个技能解析失败不阻断整包
    parsed.id = item.slug;
    parsed.kind = "skill";
    parsed.command = parsed.command || `/${item.slug}`;
    parsed.sourceUrl = `https://github.com/zhizhunbao/workbuddy/tree/main/plugins/marketplaces/cb_teams_marketplace/plugins/${suite}`;
    pluginRegistry.install(parsed, {
      type: "marketplace",
      repository: `cbteams/${suite}/${item.slug}`,
    });
    manifests.push(parsed);
  }
  if (manifests.length === 0) {
    throw new Error("套件内没有可注册的技能（SKILL.md 解析全部失败）");
  }
  return { suite, manifests };
}

/** 卸载套件：逐个技能删除本地目录并从注册表移除。 */
export async function uninstallCbteamsSuite(
  suite: string,
  skillSlugs: string[],
): Promise<void> {
  for (const slug of skillSlugs) {
    try {
      await uninstallSkillhubSkill(slug);
    } catch {
      // 本地目录可能已被手动清理；仍继续从注册表移除
    }
    pluginRegistry.uninstall(slug);
  }
  void suite;
}
