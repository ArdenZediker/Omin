import type { PluginManifest } from "./types";

/**
 * Omni 插件市场示例目录（SkillHub 风格）。
 * 真实场景下可从远端索引或 GitHub topic 拉取；这里内置精选示例，
 * 演示「复制给 AI 安装」与一键安装的 UX。
 */

export const MARKETPLACE_PLUGINS: PluginManifest[] = [
  {
    id: "dev-expert-pro",
    name: "编程专家 Pro",
    description: "P8 级编程助手，覆盖代码生成、审查、重构、测试、技术选型和项目知识图谱。",
    version: "1.2.0",
    author: "user_741dc82b",
    kind: "expert",
    category: "开发编程",
    icon: "Code2",
    tags: ["coding", "review", "architecture", "testing"],
    templatePrompt:
      "你是一名 P8 级工程师。任务包括：软件/网站项目总控、API 设计、Bug 诊断、代码生成、代码审查、重构、测试用例、性能基准、技术选型、文档生成、任务拆解、Spec 驱动、威胁建模/供应链安全。支持 @标识 显式调用跳过路由。",
    defaultToolIds: ["list_files", "read_file", "search_files", "analyze_files"],
    defaultSkillIds: [],
  },
  {
    id: "modlens",
    name: "ModLens",
    description: "粘贴图片，提取 OCR、布局与语义证据。",
    version: "3.8.0",
    author: "liustack",
    kind: "skill",
    category: "设计多媒体",
    icon: "ScanEye",
    tags: ["ocr", "image", "layout"],
    command: "/modlens",
    systemPrompt:
      "当用户粘贴图片并需要提取文字、布局或语义信息时，调用 /modlens。请描述图片中的文本、结构、元素关系，并给出可用于后续分析的结论。",
  },
  {
    id: "smart-charts",
    name: "Smart Charts",
    description: "把数据或文本快速转换成图表、看板与可视化结论。",
    version: "2.1.0",
    author: "user_5b28ea14",
    kind: "skill",
    category: "数据分析",
    icon: "BarChart3",
    tags: ["chart", "data-viz", "dashboard"],
    command: "/smart-charts",
    systemPrompt:
      "当用户需要把数据、表格或文本转化为图表时，调用 /smart-charts。优先推荐可直接渲染的图表类型，给出数据映射方案，并指出可能的误导风险。",
  },
  {
    id: "multi-search-engine",
    name: "多搜索引擎",
    description: "聚合多个搜索引擎结果，给出更全面的信息摘要。",
    version: "1.5.0",
    author: "zcwl",
    kind: "skill",
    category: "知识管理",
    icon: "Globe",
    tags: ["search", "web", "summary"],
    command: "/multi-search",
    systemPrompt:
      "当用户需要搜索实时信息或跨来源验证时，调用 /multi-search。请同时给出多个来源的关键结论、一致性判断和可信度提示。",
  },
  {
    id: "1688-diagnosis",
    name: "1688 店铺诊断",
    description: "诊断 1688 店铺运营问题，给出优化建议。",
    version: "1.0.0",
    author: "daze",
    kind: "expert",
    category: "商业运营",
    icon: "Store",
    tags: ["e-commerce", "1688", "diagnosis"],
    templatePrompt:
      "你是一名 1688 运营顾问。请从店铺装修、商品标题/主图/详情页、关键词布局、流量结构、转化漏斗和竞品对比等维度给出可落地的诊断与优化建议。",
  },
  {
    id: "ai-toolbox",
    name: "电商工具箱",
    description: "电商场景常用技能合集：标题优化、卖点提炼、客服话术、活动页文案。",
    version: "1.0.0",
    author: "daze",
    kind: "skill",
    category: "商业运营",
    icon: "Briefcase",
    tags: ["e-commerce", "copywriting"],
    command: "/ecom-toolbox",
    systemPrompt:
      "当用户任务涉及电商运营（标题、卖点、客服话术、活动页、详情页）时，调用 /ecom-toolbox。给出可直接上架/使用的文案，并说明优化逻辑。",
  },
  {
    id: "video-creator",
    name: "短视频创作助手",
    description: "视频、图片、音乐、音频、配音、口播、数字人全能创作辅助。",
    version: "2.0.0",
    author: "beatra-ai",
    kind: "expert",
    category: "设计多媒体",
    icon: "Video",
    tags: ["video", "short-video", "creator"],
    templatePrompt:
      "你是一名短视频创作教练。请从选题、脚本结构、镜头语言、节奏、口播稿、字幕样式和平台适配（抖音/快手/B 站/视频号）给出可执行方案。",
  },
];

export type MarketplaceSort = "trending" | "newest" | "downloads";

export function listMarketplacePlugins(options: { kind?: PluginManifest["kind"]; category?: string; query?: string } = {}): PluginManifest[] {
  const { kind, category, query } = options;
  const normalizedQuery = query?.trim().toLowerCase();

  return MARKETPLACE_PLUGINS.filter((manifest) => {
    if (kind && manifest.kind !== kind) return false;
    if (category && category !== "全部" && manifest.category !== category) return false;
    if (normalizedQuery) {
      const haystack = `${manifest.name} ${manifest.description} ${(manifest.tags ?? []).join(" ")}`.toLowerCase();
      if (!haystack.includes(normalizedQuery)) return false;
    }
    return true;
  });
}

export function getFeaturedPlugins(limit = 6): PluginManifest[] {
  return MARKETPLACE_PLUGINS.slice(0, limit);
}
