import { useCallback, useMemo, useState } from "react";
import { X, Search, Download, Copy, Check, Star, Puzzle, Bot, Cable, Wand2, LayoutTemplate, Settings } from "lucide-react";
import { pluginRegistry } from "../../plugins/registry";
import { listMarketplacePlugins } from "../../plugins/marketplace";
import { PLUGIN_CATEGORIES } from "../../plugins/builtins";
import type { PluginFilter, PluginKind, PluginManifest } from "../../plugins/types";
import { buildPluginInstallPrompt } from "../../plugins/registry";
import SkillhubBrowser from "./SkillhubBrowser";

type PluginMarketplaceProps = {
  initialFilter?: Omit<PluginFilter, "kind"> & { kind?: PluginKind | "all" };
  onPick?: (manifest: PluginManifest) => void;
  onClose: () => void;
  embedded?: boolean;
  mainView?: boolean;
};

const KIND_TABS: { kind: PluginKind | "all"; label: string; icon: typeof Puzzle }[] = [
  { kind: "all", label: "全部", icon: Puzzle },
  { kind: "skill", label: "技能", icon: Wand2 },
  { kind: "tool", label: "工具", icon: Puzzle },
  { kind: "connector", label: "连接器", icon: Cable },
  { kind: "expert", label: "专家", icon: Bot },
  { kind: "template", label: "模板", icon: LayoutTemplate },
];

const ICON_MAP: Record<string, typeof Puzzle> = {
  skill: Wand2,
  tool: Puzzle,
  connector: Cable,
  expert: Bot,
  template: LayoutTemplate,
};

export default function PluginMarketplace({ initialFilter = {}, onPick, onClose, embedded = false, mainView = false }: PluginMarketplaceProps) {
  const [query, setQuery] = useState(initialFilter.query ?? "");
  const [kind, setKind] = useState<PluginKind | "all">(initialFilter.kind ?? "all");
  const [category, setCategory] = useState(initialFilter.category ?? "全部");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [configuringId, setConfiguringId] = useState<string | null>(null);
  const [configDraft, setConfigDraft] = useState<Record<string, string>>({});
  const [source, setSource] = useState<"local" | "skillhub">("local");
  const [searchExpanded, setSearchExpanded] = useState(!mainView);

  const allPlugins = useMemo(() => {
    const builtins = pluginRegistry.list({ kind: kind === "all" ? undefined : kind, query });
    const marketplace = listMarketplacePlugins({ kind: kind === "all" ? undefined : kind, query });
    // 去重：marketplace 同名已安装的不重复展示
    const installedIds = new Set(builtins.map((m) => m.id));
    return [...builtins, ...marketplace.filter((m) => !installedIds.has(m.id))];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, query, refreshKey]);

  const filteredPlugins = useMemo(() => {
    if (category === "全部") return allPlugins;
    return allPlugins.filter((m) => m.category === category);
  }, [allPlugins, category]);

  const stats = useMemo(() => pluginRegistry.stats(), [refreshKey]);

  const handleCopyInstallPrompt = useCallback((manifest: PluginManifest) => {
    const prompt = buildPluginInstallPrompt(manifest);
    navigator.clipboard.writeText(prompt).catch(() => {});
    setCopiedId(manifest.id);
    window.setTimeout(() => setCopiedId((current) => (current === manifest.id ? null : current)), 1500);
  }, []);

  const handleInstall = useCallback((manifest: PluginManifest) => {
    pluginRegistry.install(manifest, { type: "marketplace", repository: `skillhub/${manifest.id}` });
    setRefreshKey((current) => current + 1);
  }, []);

  const isInstalled = (id: string) => pluginRegistry.isInstalled(id) || pluginRegistry.isBuiltin(id);

  const openConfig = useCallback((manifest: PluginManifest) => {
    const existing = (pluginRegistry.getConnectorConfig(manifest.id) ?? {}) as Record<string, unknown>;
    const draft: Record<string, string> = {};
    for (const field of manifest.configFields ?? []) {
      const value = existing[field.id];
      draft[field.id] = value == null ? "" : String(value);
    }
    setConfigDraft(draft);
    setConfiguringId(manifest.id);
  }, []);

  const updateDraft = useCallback((id: string, value: string) => {
    setConfigDraft((current) => ({ ...current, [id]: value }));
  }, []);

  const saveConfig = useCallback(
    (manifest: PluginManifest) => {
      const values: Record<string, unknown> = {};
      for (const field of manifest.configFields ?? []) {
        const raw = configDraft[field.id];
        if (raw === undefined || raw === "") continue;
        values[field.id] = field.type === "number" ? Number(raw) : raw;
      }
      pluginRegistry.setConnectorConfig(manifest.id, values);
      setConfiguringId(null);
      setRefreshKey((current) => current + 1);
    },
    [configDraft]
  );

  const renderMarketplace = () => (
    <div
      className={`plugin-marketplace ${embedded ? "plugin-marketplace--embedded" : ""} ${mainView ? "plugin-marketplace--main-view" : ""}`}
      role={embedded || mainView ? undefined : "dialog"}
      aria-modal={embedded || mainView ? undefined : "true"}
      aria-labelledby={embedded || mainView ? undefined : "plugin-marketplace-title"}
    >
      <div className="plugin-marketplace__header">
        {!mainView && (
          <>
            <div className="plugin-marketplace__title-row">
              <h2 id="plugin-marketplace-title">插件广场</h2>
              {!embedded && (
                <button type="button" className="plugin-marketplace__close" onClick={onClose} aria-label="关闭">
                  <X size={18} strokeWidth={1.8} />
                </button>
              )}
            </div>
            <p className="plugin-marketplace__subtitle">参考 SkillHub / DeepSeek Harness，发现可安装的插件与技能</p>
          </>
        )}

        {!onPick && (
            <div className="plugin-marketplace__source-tabs" role="tablist" aria-label="插件来源">
              <button
                type="button"
                role="tab"
                aria-selected={source === "local"}
                className={`plugin-marketplace__source-tab ${source === "local" ? "plugin-marketplace__source-tab--active" : ""}`}
                onClick={() => setSource("local")}
              >
                <LayoutTemplate size={14} strokeWidth={1.8} />
                <span>本地内置</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={source === "skillhub"}
                className={`plugin-marketplace__source-tab ${source === "skillhub" ? "plugin-marketplace__source-tab--active" : ""}`}
                onClick={() => setSource("skillhub")}
              >
                <Bot size={14} strokeWidth={1.8} />
                <span>SkillHub 实时</span>
              </button>
            </div>
          )}

          {!onPick && source === "skillhub" ? null : (
            <>
              {mainView ? (
                <div className="plugin-marketplace__top-bar">
                  <div className="plugin-marketplace__category-tabs">
                    {PLUGIN_CATEGORIES.filter((c) => c === "全部" || filteredPlugins.some((m) => m.category === c)).map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={`plugin-marketplace__category-tab ${category === c ? "plugin-marketplace__category-tab--active" : ""}`}
                        onClick={() => setCategory(c)}
                      >
                        {c}
                      </button>
                    ))}
                  </div>

                  <div className={`plugin-marketplace__search ${searchExpanded ? "plugin-marketplace__search--expanded" : ""}`}>
                    {searchExpanded ? (
                      <>
                        <Search size={16} strokeWidth={1.8} />
                        <input
                          value={query}
                          onChange={(event) => setQuery(event.target.value)}
                          placeholder="搜索..."
                          autoFocus
                        />
                        <button
                          type="button"
                          className="plugin-marketplace__search-close"
                          onClick={() => {
                            setQuery("");
                            setSearchExpanded(false);
                          }}
                          aria-label="清除搜索"
                        >
                          <X size={14} strokeWidth={1.8} />
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="plugin-marketplace__search-toggle"
                        onClick={() => setSearchExpanded(true)}
                        aria-label="展开搜索"
                      >
                        <Search size={18} strokeWidth={1.8} />
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  <div className="plugin-marketplace__search">
                    <Search size={16} strokeWidth={1.8} />
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="搜索插件、技能、专家..."
                    />
                  </div>

                  <div className="plugin-marketplace__kind-tabs">
                    {KIND_TABS.map((tab) => (
                      <button
                        key={tab.kind}
                        type="button"
                        className={`plugin-marketplace__kind-tab ${kind === tab.kind ? "plugin-marketplace__kind-tab--active" : ""}`}
                        onClick={() => setKind(tab.kind)}
                      >
                        <tab.icon size={14} strokeWidth={1.8} />
                        <span>{tab.label}</span>
                      </button>
                    ))}
                  </div>

                  <div className="plugin-marketplace__category-tabs">
                    {PLUGIN_CATEGORIES.filter((c) => c === "全部" || filteredPlugins.some((m) => m.category === c)).map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={`plugin-marketplace__category-tab ${category === c ? "plugin-marketplace__category-tab--active" : ""}`}
                        onClick={() => setCategory(c)}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>

        <div className="plugin-marketplace__body">
          {!onPick && source === "skillhub" ? (
            <SkillhubBrowser />
          ) : filteredPlugins.length === 0 ? (
            <div className="plugin-marketplace__empty">
              <Puzzle size={40} strokeWidth={1.2} />
              <p>没有找到匹配的插件</p>
              <span>试试其他关键词，或从本地/远程导入 SKILL.md</span>
            </div>
          ) : (
            <div className="plugin-marketplace__grid">
              {filteredPlugins.map((manifest) => {
                const Icon = ICON_MAP[manifest.kind] ?? Puzzle;
                const installed = isInstalled(manifest.id);
                return (
                  <div key={manifest.id} className="plugin-card">
                    <div className="plugin-card__icon">
                      <Icon size={22} strokeWidth={1.7} />
                    </div>
                    <div className="plugin-card__main">
                      <div className="plugin-card__title-row">
                        <h3>{manifest.name}</h3>
                        <span className="plugin-card__badge">{manifest.kind}</span>
                      </div>
                      <p className="plugin-card__description">{manifest.description}</p>
                      <div className="plugin-card__meta">
                        <span>{manifest.author ?? "Omni"}</span>
                        {manifest.category && <span>· {manifest.category}</span>}
                        <span>· v{manifest.version}</span>
                      </div>
                      {manifest.tags && manifest.tags.length > 0 && (
                        <div className="plugin-card__tags">
                          {manifest.tags.map((tag) => (
                            <span key={tag} className="plugin-card__tag">
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="plugin-card__actions">
                      {onPick ? (
                        <button
                          type="button"
                          className="plugin-card__button plugin-card__button--primary"
                          onClick={() => onPick(manifest)}
                        >
                          <Check size={14} strokeWidth={2} />
                          <span>选择</span>
                        </button>
                      ) : manifest.kind === "connector" ? (
                        <>
                          <button
                            type="button"
                            className="plugin-card__button plugin-card__button--secondary"
                            onClick={() => openConfig(manifest)}
                          >
                            <Settings size={14} strokeWidth={1.8} />
                            <span>配置</span>
                          </button>
                          {!installed && (
                            <button
                              type="button"
                              className="plugin-card__button plugin-card__button--primary"
                              onClick={() => handleInstall(manifest)}
                            >
                              <Download size={14} strokeWidth={1.8} />
                              <span>安装</span>
                            </button>
                          )}
                        </>
                      ) : installed ? (
                        <button type="button" className="plugin-card__button plugin-card__button--installed" disabled>
                          <Star size={14} strokeWidth={1.8} />
                          <span>已安装</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="plugin-card__button plugin-card__button--primary"
                          onClick={() => handleInstall(manifest)}
                        >
                          <Download size={14} strokeWidth={1.8} />
                          <span>安装</span>
                        </button>
                      )}
                      <button
                        type="button"
                        className="plugin-card__button plugin-card__button--secondary"
                        onClick={() => handleCopyInstallPrompt(manifest)}
                        title="复制给 AI 安装"
                      >
                        {copiedId === manifest.id ? (
                          <>
                            <Check size={14} strokeWidth={2} />
                            <span>已复制</span>
                          </>
                        ) : (
                          <>
                            <Copy size={14} strokeWidth={1.8} />
                            <span>复制安装</span>
                          </>
                        )}
                      </button>
                    </div>
                    {configuringId === manifest.id && manifest.configFields && manifest.configFields.length > 0 && (
                      <div className="plugin-card__config">
                        {manifest.configFields.map((field) => (
                          <label key={field.id} className="plugin-card__config-field">
                            <span>
                              {field.label}
                              {field.required ? " *" : ""}
                            </span>
                            {field.type === "boolean" ? (
                              <input
                                type="checkbox"
                                checked={configDraft[field.id] === "true"}
                                onChange={(event) => updateDraft(field.id, event.target.checked ? "true" : "false")}
                              />
                            ) : field.type === "select" ? (
                              <select value={configDraft[field.id] ?? ""} onChange={(event) => updateDraft(field.id, event.target.value)}>
                                <option value="">{field.placeholder ?? "请选择"}</option>
                                {field.options?.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <input
                                type={field.type === "password" ? "password" : field.type === "number" ? "number" : "text"}
                                value={configDraft[field.id] ?? ""}
                                placeholder={field.placeholder}
                                onChange={(event) => updateDraft(field.id, event.target.value)}
                              />
                            )}
                          </label>
                        ))}
                        <div className="plugin-card__config-actions">
                          <button
                            type="button"
                            className="plugin-card__button plugin-card__button--secondary"
                            onClick={() => setConfiguringId(null)}
                          >
                            取消
                          </button>
                          <button
                            type="button"
                            className="plugin-card__button plugin-card__button--primary"
                            onClick={() => saveConfig(manifest)}
                          >
                            保存
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="plugin-marketplace__footer">
          <div className="plugin-marketplace__stats">
            <span>已启用：{stats.skill} 技能</span>
            <span>{stats.tool} 工具</span>
            <span>{stats.connector} 连接器</span>
            <span>{stats.expert} 专家</span>
            <span>{stats.template} 模板</span>
          </div>
        </div>
      </div>
  );

  if (embedded || mainView) {
    return renderMarketplace();
  }

  return (
    <>
      <div className="plugin-marketplace-backdrop" onClick={onClose} />
      {renderMarketplace()}
    </>
  );
}
