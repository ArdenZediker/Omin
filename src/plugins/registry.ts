import { readSqliteBackedJson, saveSqliteBackedValue } from "../app/sqliteStorage";
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
  /**
   * 内容版本号：每次写入（安装/卸载/开关/配置/更新 manifest）自增。
   * 供 `useSyncExternalStore` 做快照比较 —— 必须是「变了才变」的原始值，
   * 不能拿 `list()` 返回的新数组当快照（每次调用都是新引用，会无限重渲染）。
   */
  private version = 0;
  /** 变更订阅者（渲染进程内）。 */
  private listeners = new Set<() => void>();

  constructor() {
    for (const manifest of BUILTIN_PLUGINS) {
      this.builtins.set(manifest.id, manifest);
    }
  }

  /** 当前内容版本号（配 `subscribe` 做 React 订阅）。 */
  getVersion(): number {
    return this.version;
  }

  /**
   * 订阅注册表变更，返回取消订阅函数。
   *
   * 为什么必须有这个通道：插件状态是**渲染进程模块级单例**，组件只在自己触发
   * 的安装路径上手动 bump 刷新键；一旦安装发生在组件之外（SkillHub 子面板、
   * 技能创作、对话里模型调用 /install_skill），列表不会重算 —— 表现为
   * 「装好了但「我的技能」里看不见」。这里把「谁改了注册表」变成可订阅事实，
   * 消费方无需知道变更从哪来。
   *
   * 注意：紧凑窗是独立 webview、各持一份模块单例，本订阅**不跨窗口**；
   * 但插件列表只在主窗渲染（紧凑窗无工具、不展示插件），故不做跨窗口广播。
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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
  }

  /**
   * 持久化快照，并广播一次「注册表已变更」。
   *
   * 所有写路径（install / uninstall / setEnabled / setConnectorConfig /
   * updateManifest / flush）都汇聚到这里，因此**通知点只需要一个** ——
   * 新增写接口时不会漏发通知。
   */
  private save(): void {
    const snapshot: Record<string, InstalledPlugin> = {};
    for (const [id, entry] of this.installed.entries()) {
      snapshot[id] = entry;
    }
    saveSqliteBackedValue(INSTALLED_PLUGINS_STORAGE_KEY, JSON.stringify(snapshot));
    this.version += 1;
    for (const listener of Array.from(this.listeners)) {
      // 单个订阅者抛错不应打断其它订阅者，也不应影响安装主流程
      try {
        listener();
      } catch {
        /* 忽略订阅者自身的异常 */
      }
    }
  }

  /** 公开持久化（供模块级的一次性数据迁移等场景调用）。 */
  flush(): void {
    this.save();
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

  /**
   * 用户显式安装（SkillHub / 插件市场 / 本地导入 / 技能创作）且已启用的技能。
   *
   * 这些技能**不走项目 allowedSkillIds 白名单**：安装动作本身就是授权，
   * 「我的技能」页的全局开关是唯一入口。若把它们也要求逐项目勾选，会出现
   * 「装完永远无法用斜杠调用、且没有任何 UI 可以给已有项目补勾」的死局
   * （项目白名单目前只能在新建项目时挑选，装完后无入口）。
   * 内置技能仍受项目白名单约束（那是助手能力策展的一部分）。
   */
  listEnabledUserSkills(): PluginManifest[] {
    return this.list({ kind: "skill", enabled: true }).filter(
      (manifest) => !this.builtins.has(manifest.id) && this.installed.has(manifest.id)
    );
  }

  /** 列出所有已安装插件的原始 entry（包含 source、config 等元数据）。
   *  用于数据迁移 / 升级场景 —— list() 只丢出 manifest，不够。 */
  listInstalled(): Array<{ id: string; entry: InstalledPlugin }> {
    return Array.from(this.installed.entries()).map(([id, entry]) => ({
      id,
      entry,
    }));
  }

  listEnabledTools(): PluginManifest[] {
    return this.list({ kind: "tool", enabled: true });
  }

  listEnabledConnectors(): PluginManifest[] {
    return this.list({ kind: "connector", enabled: true });
  }

  /**
   * 列出**已启用**的专家（内置 + 已安装）。
   *
   * 必须带 `enabled: true`：`list()` 在 `enabled` 缺省时不过滤开关状态，
   * 曾在「我的插件」里关掉的专家仍会进 agent 工具名册、仍能被委派，
   * 也会出现在 `@专家` 选择器里 —— 与「开启才可用」的口径矛盾。
   */
  listExperts(): PluginManifest[] {
    return this.list({ kind: "expert", enabled: true });
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
    return entry;
  }

  /** 更新已安装插件的 manifest（保留 enabled/installedAt/source，仅替换定义）。用于专家编辑。 */
  updateManifest(manifest: PluginManifest): boolean {
    const entry = this.installed.get(manifest.id);
    if (!entry) return false;
    entry.manifest = manifest;
    this.save();
    return true;
  }

  uninstall(id: string): boolean {
    if (this.builtins.has(id)) return false;
    const removed = this.installed.delete(id);
    if (removed) {
      this.save();
    }
    return removed;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const entry = this.installed.get(id);
    if (!entry) return false;
    entry.enabled = enabled;
    this.save();
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
  // 一次性迁移（2026-09-08）：旧的「远程接入」连接器（来自 connectorhub 市场、
  // kind=connector）改注册为 kind=skill，使其出现在「我的技能」而非「我的连接器」
  // （不再伪装成 MCP 服务器）。新安装已直接注册为 skill，此处仅修正历史数据。
  let migrated = false;
  for (const { entry } of pluginRegistry.listInstalled()) {
    const repo =
      entry.source?.type === "marketplace" ? entry.source.repository : "";
    if (
      entry.manifest.kind === "connector" &&
      typeof repo === "string" &&
      repo.startsWith("connectorhub/")
    ) {
      entry.manifest.kind = "skill";
      migrated = true;
    }
  }
  if (migrated) pluginRegistry.flush();
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

