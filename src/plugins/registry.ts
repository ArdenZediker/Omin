import { readSqliteBackedJson, saveSqliteBackedValue } from "../app/sqliteStorage";
import { modelRegistry } from "../adapters/registry";
import { BUILTIN_PLUGINS } from "./builtins";
import type {
  InstalledPlugin,
  PluginFilter,
  PluginKind,
  PluginManifest,
  PluginSkillContribution,
  PluginToolContribution,
} from "./types";

const INSTALLED_PLUGINS_STORAGE_KEY = "omni_installed_plugins";

class PluginRegistry {
  private builtins: Map<string, PluginManifest> = new Map();
  private installed: Map<string, InstalledPlugin> = new Map();
  private loaded = false;

  constructor() {
    for (const manifest of BUILTIN_PLUGINS) {
      this.builtins.set(manifest.id, manifest);
    }
  }

  load(): void {
    if (this.loaded) return;
    const snapshot = readSqliteBackedJson<Record<string, InstalledPlugin>>(INSTALLED_PLUGINS_STORAGE_KEY, {});
    for (const [id, entry] of Object.entries(snapshot)) {
      if (entry?.manifest?.id) {
        this.installed.set(id, entry);
      }
    }
    this.loaded = true;
    this.syncConnectors();
  }

  /**
   * 把已启用且有凭证的连接器插件注册进 modelRegistry，
   * 让「连接器」成为真正的插件扩展点（一切皆插件）。
   * 守卫：仅有 apiKey（或 ollama 这类本地服务有 baseUrl）时才注册，
   * 避免覆盖用户在「模型设置」里已有的配置（旧 omni_provider_configs 路径）。
   */
  private syncConnectors(): void {
    for (const manifest of this.listEnabledConnectors()) {
      if (!manifest.provider) continue;
      const config = (this.installed.get(manifest.id)?.config as Record<string, unknown>) ?? {};
      const apiKey = (config.apiKey as string) ?? "";
      const baseUrl = (config.baseUrl as string) || manifest.baseUrl || "";
      const needsApiKey = manifest.provider !== "ollama";
      if (!baseUrl) continue;
      if (needsApiKey && !apiKey) continue;
      modelRegistry.registerProvider(manifest.provider, {
        apiKey,
        baseUrl,
        name: manifest.name,
      });
    }
  }

  private save(): void {
    const snapshot: Record<string, InstalledPlugin> = {};
    for (const [id, entry] of this.installed.entries()) {
      snapshot[id] = entry;
    }
    saveSqliteBackedValue(INSTALLED_PLUGINS_STORAGE_KEY, JSON.stringify(snapshot));
  }

  /** 获取某个插件的 manifest（内置优先，其次已安装） */
  getManifest(id: string): PluginManifest | null {
    return this.builtins.get(id) ?? this.installed.get(id)?.manifest ?? null;
  }

  /** 内置插件不可卸载；已安装的 marketplace/local 插件可以卸载。 */
  isBuiltin(id: string): boolean {
    return this.builtins.has(id);
  }

  isInstalled(id: string): boolean {
    return this.installed.has(id);
  }

  isEnabled(id: string): boolean {
    if (this.builtins.has(id)) return true;
    return this.installed.get(id)?.enabled ?? false;
  }

  /** 列出所有可见插件（内置 + 已安装），支持筛选。 */
  list(filter: PluginFilter = {}): PluginManifest[] {
    const { kind, category, query, enabled } = filter;
    const normalizedQuery = query?.trim().toLowerCase();

    const all = new Map<string, PluginManifest>();
    for (const [id, manifest] of this.builtins) {
      all.set(id, manifest);
    }
    for (const [id, entry] of this.installed) {
      if (entry.enabled || enabled !== true) {
        all.set(id, entry.manifest);
      }
    }

    return Array.from(all.values()).filter((manifest) => {
      if (kind && manifest.kind !== kind) return false;
      if (category && category !== "全部" && manifest.category !== category) return false;
      if (enabled === true && !this.isEnabled(manifest.id)) return false;
      if (enabled === false && this.isEnabled(manifest.id)) return false;
      if (normalizedQuery) {
        const haystack = `${manifest.name} ${manifest.description} ${(manifest.tags ?? []).join(" ")}`.toLowerCase();
        if (!haystack.includes(normalizedQuery)) return false;
      }
      return true;
    });
  }

  listEnabledSkills(): PluginManifest[] {
    return this.list({ kind: "skill", enabled: true });
  }

  listEnabledTools(): PluginManifest[] {
    return this.list({ kind: "tool", enabled: true });
  }

  listEnabledConnectors(): PluginManifest[] {
    return this.list({ kind: "connector", enabled: true });
  }

  listExperts(): PluginManifest[] {
    return this.list({ kind: "expert" });
  }

  listTemplates(): PluginManifest[] {
    return this.list({ kind: "template" });
  }

  /** 安装插件（来自 marketplace 或本地路径）。 */
  install(manifest: PluginManifest, source: InstalledPlugin["source"]): InstalledPlugin {
    const entry: InstalledPlugin = {
      manifest,
      enabled: true,
      installedAt: Date.now(),
      source,
    };
    this.installed.set(manifest.id, entry);
    this.save();
    this.syncConnectors();
    return entry;
  }

  uninstall(id: string): boolean {
    if (this.builtins.has(id)) return false;
    const removed = this.installed.delete(id);
    if (removed) {
      this.save();
      this.syncConnectors();
    }
    return removed;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const entry = this.installed.get(id);
    if (!entry) return false;
    entry.enabled = enabled;
    this.save();
    this.syncConnectors();
    return true;
  }

  setConnectorConfig(id: string, config: Record<string, unknown>): boolean {
    let entry = this.installed.get(id);
    if (!entry) {
      // 内置连接器默认不在 installed 表里，配置时自动安装覆盖。
      const manifest = this.builtins.get(id);
      if (!manifest || manifest.kind !== "connector") return false;
      entry = { manifest, enabled: true, installedAt: Date.now(), source: { type: "builtin" } };
      this.installed.set(id, entry);
    }
    entry.config = { ...(entry.config ?? {}), ...config };
    this.save();
    this.syncConnectors();
    return true;
  }

  getConnectorConfig(id: string): Record<string, unknown> | null {
    return (this.installed.get(id)?.config as Record<string, unknown>) ?? null;
  }

  /** 导出兼容旧版 SlashSkill 的技能列表。 */
  toSkillCommands(): PluginSkillContribution[] {
    return this.listEnabledSkills().map((manifest) => ({
      id: manifest.id,
      command: manifest.command ?? `/${manifest.id}`,
      title: manifest.name,
      description: manifest.description,
      systemPrompt: manifest.systemPrompt,
      promptPrefix: manifest.promptPrefix,
    }));
  }

  /** 导出兼容旧版 ToolManifest 的工具列表。 */
  toToolManifests(): PluginToolContribution[] {
    return this.listEnabledTools().map((manifest) => ({
      id: manifest.id,
      command: manifest.command,
      title: manifest.name,
      description: manifest.description,
      promptContribution: manifest.promptContribution,
    }));
  }

  getCategories(): string[] {
    const set = new Set<string>();
    for (const manifest of this.list()) {
      if (manifest.category) set.add(manifest.category);
    }
    return Array.from(set);
  }

  /** 统计各类插件数量。 */
  stats(): Record<PluginKind | "total", number> {
    const all = this.list();
    return {
      skill: all.filter((m) => m.kind === "skill").length,
      tool: all.filter((m) => m.kind === "tool").length,
      connector: all.filter((m) => m.kind === "connector").length,
      expert: all.filter((m) => m.kind === "expert").length,
      template: all.filter((m) => m.kind === "template").length,
      total: all.length,
    };
  }
}

export const pluginRegistry = new PluginRegistry();

/** 初始化调用一次；可在 App 启动时执行。 */
export function initializePluginRegistry(): void {
  pluginRegistry.load();
}

/** 解析一个 DeepSeek Harness 风格的 SKILL.md 内容（YAML frontmatter + Markdown body）。 */
export function parseSkillMarkdown(content: string): PluginManifest | null {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!frontmatterMatch) return null;

  const lines = frontmatterMatch[1].split("\n");
  const body = frontmatterMatch[2].trim();
  const meta: Record<string, string> = {};

  for (const line of lines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim().replace(/^["'](.*)["']$/, "$1");
      meta[key] = value;
    }
  }

  const id = meta.name?.trim();
  if (!id) return null;

  return {
    id,
    name: meta.title || id,
    description: meta.description || "",
    version: meta.version || "0.0.1",
    author: meta.author,
    kind: (meta.kind as PluginManifest["kind"]) || "skill",
    category: meta.category,
    icon: meta.icon,
    body,
    command: meta.command || `/${id}`,
    systemPrompt: body,
    promptPrefix: meta.promptPrefix,
  };
}

/** 生成一个 SkillHub 风格的“复制给 AI 安装”提示词。 */
export function buildPluginInstallPrompt(manifest: PluginManifest, source?: string): string {
  const lines = [
    `请在 Omni 中安装以下插件：`,
    `- ID: ${manifest.id}`,
    `- 名称: ${manifest.name}`,
    `- 类型: ${manifest.kind}`,
    `- 描述: ${manifest.description}`,
    manifest.author ? `- 作者: ${manifest.author}` : "",
    manifest.category ? `- 分类: ${manifest.category}` : "",
    source ? `- 来源: ${source}` : "",
    "",
    "插件正文如下（请按 DeepSeek Harness SKILL.md 格式保存并加载）：",
    "---",
    `name: ${manifest.id}`,
    `title: ${manifest.name}`,
    `description: ${manifest.description}`,
    `version: ${manifest.version}`,
    `kind: ${manifest.kind}`,
    manifest.category ? `category: ${manifest.category}` : "",
    manifest.command ? `command: ${manifest.command}` : "",
    "---",
    manifest.body || manifest.systemPrompt || manifest.templatePrompt || "",
  ];
  return lines.filter(Boolean).join("\n");
}
