/**
 * WorkBuddy 技能库外部服务接入型技能市场。
 *
 * 数据源：GitHub 仓库 zhizhunbao/workbuddy 的 skills-marketplace
 * （.codebuddy-skill/marketplace.json，90 个技能）。其中「外部服务接入型」
 * 技能封装了外部服务的 CLI/OpenAPI/SDK 接入能力，本质就是连接器，
 * 安装后注册为 kind=connector 的插件，出现在扩展中心「连接器」分类。
 *
 * 安装由 Rust 命令 install_connectorhub_skill 完成：下载仓库 zip、抽取
 * skills-marketplace/skills/<source>/ 子树到 ~/.dsh/skills，返回 SKILL.md
 * 原文；这里解析并注册为 connector 插件。
 */

import { invoke } from "@tauri-apps/api/core";
import { pluginRegistry, parseSkillMarkdown } from "./registry";
import type { PluginManifest } from "./types";
import { uninstallSkillhubSkill } from "./skillhub";

/** 外部服务接入型技能白名单：source（skills/ 下的目录名）→ 中文名。 */
const CONNECTOR_SOURCE_WHITELIST: Record<string, string> = {
  // —— 腾讯系 ——
  "tencent-docs": "腾讯文档",
  "tencent-meeting-skill": "腾讯会议",
  "ima-skills": "ima 笔记",
  "qq-email": "QQ 邮箱",
  "cnb-skill": "cnb.cool",
  "tapd-openapi": "TAPD",
  "lexiang-knowledge-base": "腾讯乐享",
  "tencentcloud-cos": "腾讯云 COS",
  "cos-vectors": "腾讯云 COS 向量",
  "lark-unified": "飞书/Lark",
  "tencent-ssv-techforgood": "腾讯技术公益",
  "tencent-survey": "腾讯问卷",
  "tencent-news": "腾讯新闻",
  "zenstudio": "ZenStudio",
  "andonq": "AndonQ",
  "cloudbase": "腾讯云 CloudBase",
  "cloudq": "CloudQ",
  "tencent-cloud-migration": "CMG 云迁移",
  "skyline": "Skyline 渲染引擎",
  "tdesign-miniprogram": "TDesign 小程序",
  "wechat-miniprogram": "微信小程序",
  "workbuddy-channel-setup": "IM 渠道接入",
  // —— 外部服务 ——
  github: "GitHub",
  trello: "Trello",
  gog: "Google 全家桶",
  "imap-smtp-email": "IMAP/SMTP 邮件",
  "email-skill": "邮件管理",
  "multi-search-engine": "多引擎搜索",
  mcporter: "MCP 管理器",
  "mcp-builder": "MCP 开发",
  obsidian: "Obsidian",
  "things-mac": "Things 3",
  wacli: "WhatsApp",
  himalaya: "Himalaya 邮件",
  imsg: "iMessage",
  "apple-notes": "Apple 备忘录",
  "apple-reminders": "Apple 提醒事项",
  "agent-mail": "智能体邮箱",
  sag: "文字转语音",
  "openai-whisper-api": "Whisper API",
  "openai-image-gen": "批量绘图",
  "nano-banana-pro": "AI 绘图",
  blogwatcher: "博客监控",
  xurl: "Twitter 分析",
  "github-trending-cn": "GitHub 热门",
  "github-ai-trends": "GitHub AI 趋势",
  "arxiv-reader": "ArXiv 论文精读",
  "arxiv-watcher": "ArXiv 论文追踪",
  "macro-monitor": "宏观数据监控",
  "news-summary": "新闻摘要",
  "note-organizer": "Joplin 笔记",
  "citation-manager": "学术引用管理",
  "earnings-tracker": "财报追踪",
  xiaohongshu: "小红书",
  weather: "天气查询",
  "browser-use": "浏览器自动化",
};

/** 外部服务接入型技能的中文名（白名单缺失时回退）。 */
export function connectorDisplayName(source: string): string {
  return CONNECTOR_SOURCE_WHITELIST[source] ?? source;
}

/** 判断一个 source 是否在外部服务接入型白名单内。 */
export function isConnectorSource(source: string): boolean {
  return source in CONNECTOR_SOURCE_WHITELIST;
}

/**
 * 现成可 npx 拉起的 MCP 服务器命令模板（source → 启动配置）。
 * 仅收录确定存在官方/知名 npm 包的服务器；其余连接器是 CLI/OpenAPI
 * 接入型技能，需用户自行填写启动命令。
 */
const MCP_COMMAND_TEMPLATES: Record<
  string,
  { command: string; args: string; env: string }
> = {
  github: {
    command: "npx",
    args: "-y @modelcontextprotocol/server-github",
    env: "GITHUB_PERSONAL_ACCESS_TOKEN=",
  },
  trello: {
    command: "npx",
    args: "-y @kiberty/trello-mcp",
    env: "TRELLO_API_KEY=\nTRELLO_API_TOKEN=",
  },
};

/** 取 MCP 命令模板；无模板返回 null（用户需自行填写）。 */
export function getMcpCommandTemplate(source: string): {
  command: string;
  args: string;
  env: string;
} | null {
  return MCP_COMMAND_TEMPLATES[source] ?? null;
}

/** 接入型技能分组（用于浏览面板分类 tab）。 */
export function connectorCategory(source: string): string {
  const tencent = [
    "tencent-docs",
    "tencent-meeting-skill",
    "ima-skills",
    "qq-email",
    "cnb-skill",
    "tapd-openapi",
    "lexiang-knowledge-base",
    "tencentcloud-cos",
    "cos-vectors",
    "lark-unified",
    "tencent-ssv-techforgood",
    "tencent-survey",
    "tencent-news",
    "zenstudio",
    "andonq",
    "cloudbase",
    "cloudq",
    "tencent-cloud-migration",
    "skyline",
    "tdesign-miniprogram",
    "wechat-miniprogram",
    "workbuddy-channel-setup",
  ];
  if (tencent.includes(source)) return "腾讯系";
  const dev = [
    "github",
    "trello",
    "gog",
    "mcporter",
    "mcp-builder",
    "browser-use",
    "cloudbase",
    "cloudq",
    "cnb-skill",
    "tencent-cloud-migration",
  ];
  if (dev.includes(source)) return "开发";
  const mail = [
    "qq-email",
    "imap-smtp-email",
    "email-skill",
    "himalaya",
    "agent-mail",
    "imsg",
    "wacli",
    "workbuddy-channel-setup",
  ];
  if (mail.includes(source)) return "通信";
  const productivity = [
    "obsidian",
    "things-mac",
    "apple-notes",
    "apple-reminders",
    "note-organizer",
    "tencent-docs",
    "tencent-meeting-skill",
    "lark-unified",
    "xiaohongshu",
  ];
  if (productivity.includes(source)) return "效率";
  return "其他";
}

export interface ConnectorhubSkill {
  name: string;
  source: string;
  description: string;
  descriptionZh: string;
  version: string;
  /** 白名单映射的中文展示名 */
  displayName: string;
  /** 分类（腾讯系/开发/通信/效率/其他） */
  category: string;
}

export async function listConnectorhubSkills(): Promise<ConnectorhubSkill[]> {
  const items = await invoke<Record<string, unknown>[]>("list_connectorhub_skills");
  return items
    .map((raw) => {
      const source = String(raw.source ?? "");
      return {
        name: String(raw.name ?? ""),
        source,
        description: String(raw.description ?? ""),
        descriptionZh: String(raw.descriptionZh ?? ""),
        version: String(raw.version ?? ""),
        displayName: connectorDisplayName(source),
        category: connectorCategory(source),
      };
    })
    .filter((s) => isConnectorSource(s.source));
}

/** 安装一个外部服务接入型技能，注册为 connector 插件。 */
export async function installConnectorhubSkill(
  source: string,
): Promise<PluginManifest> {
  const result = await invoke<{ slug: string; path: string; skill_md: string }>(
    "install_connectorhub_skill",
    { source },
  );
  const parsed = parseSkillMarkdown(result.skill_md);
  if (!parsed) {
    throw new Error("SKILL.md 解析失败，无法注册为连接器");
  }
  parsed.id = result.slug;
  parsed.kind = "connector";
  parsed.name = connectorDisplayName(result.slug);
  parsed.category = connectorCategory(result.slug);
  parsed.sourceUrl =
    `https://github.com/zhizhunbao/workbuddy/tree/main/skills-marketplace/skills/${result.slug}`;
  pluginRegistry.install(parsed, {
    type: "marketplace",
    repository: `connectorhub/${result.slug}`,
  });
  return parsed;
}

/** 卸载连接器：删除本地技能目录并从注册表移除。 */
export async function uninstallConnectorhubSkill(source: string): Promise<void> {
  try {
    await uninstallSkillhubSkill(source);
  } catch {
    // 本地目录可能已被手动清理；仍继续从注册表移除
  }
  pluginRegistry.uninstall(source);
}
