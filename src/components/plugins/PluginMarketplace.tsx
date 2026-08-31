import { useCallback, useEffect, useMemo, useState } from "react";
import {
  X,
  Search,
  Download,
  Copy,
  Check,
  Star,
  Puzzle,
  Bot,
  Cable,
  Wand2,
  LayoutTemplate,
  Settings,
  Package,
  PlugZap,
  Unplug,
  AlertTriangle,
} from "lucide-react";
import { pluginRegistry } from "../../plugins/registry";
import { listMarketplacePlugins } from "../../plugins/marketplace";
import {
  ensureMcpConnector,
  disconnectMcpConnector,
  listConnectedMcpServers,
} from "../../plugins/mcp";
import { PLUGIN_CATEGORIES } from "../../plugins/builtins";
import type {
  PluginFilter,
  PluginKind,
  PluginManifest,
} from "../../plugins/types";
import { buildPluginInstallPrompt } from "../../plugins/registry";
import SkillhubBrowser from "./SkillhubBrowser";
import CbteamsBrowser from "./CbteamsBrowser";
import ConnectorhubBrowser from "./ConnectorhubBrowser";
import { getMcpCommandTemplate } from "../../plugins/connectorhub";

type PluginMarketplaceProps = {
  initialFilter?: Omit<PluginFilter, "kind"> & { kind?: PluginKind };
  onPick?: (manifest: PluginManifest) => void;
  onClose: () => void;
  embedded?: boolean;
  mainView?: boolean;
};

const KIND_TABS: {
  kind: PluginKind;
  label: string;
  icon: typeof Puzzle;
}[] = [
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

export default function PluginMarketplace({
  initialFilter = {},
  onPick,
  onClose,
  embedded = false,
  mainView = false,
}: PluginMarketplaceProps) {
  const [query, setQuery] = useState(initialFilter.query ?? "");
  // 不设「全部」混合列表：一级分类必须具体，默认落在技能（SkillHub）。
  const [kind, setKind] = useState<PluginKind>(initialFilter.kind ?? "skill");
  const [category, setCategory] = useState(initialFilter.category ?? "全部");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [configuringId, setConfiguringId] = useState<string | null>(null);
  const [configDraft, setConfigDraft] = useState<Record<string, string>>({});
  // MCP 型连接器（无 provider 的 connector）启动配置草稿
  const [mcpDraft, setMcpDraft] = useState({ command: "", args: "", env: "" });
  // 当前已连接的 MCP 服务器（内存态，来自 mcp.ts）
  const [connectedList, setConnectedList] = useState(() =>
    listConnectedMcpServers(),
  );
  // 连接失败的错误提示（卡片上展示）
  const [mcpError, setMcpError] = useState<{
    connectorId: string;
    message: string;
  } | null>(null);
  // 「本地 / SkillHub / 套件 / 远程连接器」不再是顶部一级切换：左侧（或类型 tab）的一级分类才是主导航。
  // 点「技能」直接展示 SkillHub 浏览界面；点「连接器」直接展示外部服务接入型技能浏览；
  // 其他分类仍是本地列表。页内保留子开关切换回本地。
  const [source, setSource] = useState<"local" | "skillhub" | "suites" | "connectors">(
    initialFilter.kind === "skill"
      ? "skillhub"
      : initialFilter.kind === "connector"
        ? "connectors"
        : "local",
  );
  const [searchExpanded, setSearchExpanded] = useState(!mainView);

  // 一级分类切换时联动来源：技能 → SkillHub，连接器 → 远程连接器，其他 → 本地。
  useEffect(() => {
    setSource(
      kind === "skill" ? "skillhub" : kind === "connector" ? "connectors" : "local",
    );
  }, [kind]);

  const allPlugins = useMemo(() => {
    const builtins = pluginRegistry.list({ kind, query });
    const marketplace = listMarketplacePlugins({ kind, query });
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

  // SkillHub / 套件浏览界面只在「技能」一级分类下出现；远程连接器只在「连接器」下出现。
  const showSkillhub = !onPick && source === "skillhub" && kind === "skill";
  const showSuites = !onPick && source === "suites" && kind === "skill";
  const showConnectorhub = !onPick && source === "connectors" && kind === "connector";

  const handleCopyInstallPrompt = useCallback((manifest: PluginManifest) => {
    const prompt = buildPluginInstallPrompt(manifest);
    navigator.clipboard.writeText(prompt).catch(() => {});
    setCopiedId(manifest.id);
    window.setTimeout(
      () =>
        setCopiedId((current) => (current === manifest.id ? null : current)),
      1500,
    );
  }, []);

  const handleInstall = useCallback((manifest: PluginManifest) => {
    pluginRegistry.install(manifest, {
      type: "marketplace",
      repository: `skillhub/${manifest.id}`,
    });
    setRefreshKey((current) => current + 1);
  }, []);

  const isInstalled = (id: string) =>
    pluginRegistry.isInstalled(id) || pluginRegistry.isBuiltin(id);

  // MCP 型连接器：kind=connector 且无 provider（provider 是模型连接器的标志，
  // 模型连接器走 API Key 配置；MCP 型走 command/args/env 启动配置）。
  const isMcpConnector = (manifest: PluginManifest) =>
    manifest.kind === "connector" && !manifest.provider;

  /** 解析命令行参数（支持双引号/单引号包裹的空格参数）。 */
  const parseArgsLine = (input: string): string[] => {
    const tokens: string[] = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input)) !== null) {
      tokens.push(m[1] ?? m[2] ?? m[3]);
    }
    return tokens;
  };

  /** 解析环境变量文本（每行 KEY=VALUE，忽略空行与 # 注释）。 */
  const parseEnvLines = (input: string): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const line of input.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return env;
  };

  const refreshConnected = useCallback(() => {
    setConnectedList(listConnectedMcpServers());
  }, []);

  useEffect(() => {
    refreshConnected();
  }, [refreshKey, refreshConnected]);

  const openConfig = useCallback((manifest: PluginManifest) => {
    const existing = (pluginRegistry.getConnectorConfig(manifest.id) ??
      {}) as Record<string, unknown>;
    const draft: Record<string, string> = {};
    for (const field of manifest.configFields ?? []) {
      const value = existing[field.id];
      draft[field.id] = value == null ? "" : String(value);
    }
    setConfigDraft(draft);
    if (isMcpConnector(manifest)) {
      const args = Array.isArray(existing.args)
        ? (existing.args as unknown[]).map(String)
        : [];
      const env =
        existing.env && typeof existing.env === "object"
          ? (existing.env as Record<string, unknown>)
          : {};
      // 未配置过 command 时用高频服务模板预填
      const template = String(existing.command ?? "").trim()
        ? null
        : getMcpCommandTemplate(manifest.id);
      setMcpDraft({
        command: String(existing.command ?? template?.command ?? ""),
        args:
          args.length > 0
            ? args.join(" ")
            : (template?.args ?? ""),
        env:
          Object.keys(env).length > 0
            ? Object.entries(env)
                .map(([key, value]) => `${key}=${String(value)}`)
                .join("\n")
            : (template?.env ?? ""),
      });
    }
    setConfiguringId(manifest.id);
  }, []);

  const updateDraft = useCallback((id: string, value: string) => {
    setConfigDraft((current) => ({ ...current, [id]: value }));
  }, []);

  const updateMcpDraft = useCallback(
    (key: "command" | "args" | "env", value: string) => {
      setMcpDraft((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  const saveConfig = useCallback(
    async (manifest: PluginManifest) => {
      const values: Record<string, unknown> = {};
      for (const field of manifest.configFields ?? []) {
        const raw = configDraft[field.id];
        if (raw === undefined || raw === "") continue;
        values[field.id] = field.type === "number" ? Number(raw) : raw;
      }
      if (isMcpConnector(manifest)) {
        values.command = mcpDraft.command.trim();
        values.args = parseArgsLine(mcpDraft.args);
        values.env = parseEnvLines(mcpDraft.env);
      }
      pluginRegistry.setConnectorConfig(manifest.id, values);
      setConfiguringId(null);
      setRefreshKey((current) => current + 1);
      // MCP 型连接器保存后若已配 command，立即拉起服务器
      if (isMcpConnector(manifest) && String(values.command ?? "").trim()) {
        try {
          await ensureMcpConnector(manifest);
        } catch (error) {
          setMcpError({
            connectorId: manifest.id,
            message:
              error instanceof Error ? error.message : String(error),
          });
        }
      }
      refreshConnected();
    },
    [configDraft, mcpDraft, refreshConnected],
  );

  const handleConnect = useCallback(
    async (manifest: PluginManifest) => {
      const config = pluginRegistry.getConnectorConfig(manifest.id) ?? {};
      if (!String(config.command ?? "").trim()) {
        openConfig(manifest);
        return;
      }
      setMcpError(null);
      try {
        await ensureMcpConnector(manifest);
      } catch (error) {
        setMcpError({
          connectorId: manifest.id,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        refreshConnected();
      }
    },
    [openConfig, refreshConnected],
  );

  const handleDisconnect = useCallback(
    async (manifest: PluginManifest) => {
      await disconnectMcpConnector(manifest.id);
      refreshConnected();
    },
    [refreshConnected],
  );

  const renderMarketplace = () => (
    <div
      className={`plugin-marketplace ${embedded ? "plugin-marketplace--embedded" : ""} ${mainView ? "plugin-marketplace--main-view" : ""}`}
      role={embedded || mainView ? undefined : "dialog"}
      aria-modal={embedded || mainView ? undefined : "true"}
      aria-labelledby={
        embedded || mainView ? undefined : "plugin-marketplace-title"
      }
    >
      <div className="plugin-marketplace__header">
        {!mainView && (
          <>
            <div className="plugin-marketplace__title-row">
              <h2 id="plugin-marketplace-title">扩展中心</h2>
              {!embedded && (
                <button
                  type="button"
                  className="plugin-marketplace__close"
                  onClick={onClose}
                  aria-label="关闭"
                >
                  <X size={18} strokeWidth={1.8} />
                </button>
              )}
            </div>
            <p className="plugin-marketplace__subtitle">
              参考 SkillHub / DeepSeek Harness，发现可安装的插件与技能
            </p>
          </>
        )}

        {!onPick && kind === "skill" && (
          <div
            className="plugin-marketplace__source-tabs"
            role="tablist"
            aria-label="技能来源"
          >
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
            <button
              type="button"
              role="tab"
              aria-selected={source === "suites"}
              className={`plugin-marketplace__source-tab ${source === "suites" ? "plugin-marketplace__source-tab--active" : ""}`}
              onClick={() => setSource("suites")}
            >
              <Package size={14} strokeWidth={1.8} />
              <span>套件</span>
            </button>
          </div>
        )}

        {!onPick && kind === "connector" && (
          <div
            className="plugin-marketplace__source-tabs"
            role="tablist"
            aria-label="连接器来源"
          >
            <button
              type="button"
              role="tab"
              aria-selected={source === "local"}
              className={`plugin-marketplace__source-tab ${source === "local" ? "plugin-marketplace__source-tab--active" : ""}`}
              onClick={() => setSource("local")}
            >
              <Settings size={14} strokeWidth={1.8} />
              <span>本地连接器</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={source === "connectors"}
              className={`plugin-marketplace__source-tab ${source === "connectors" ? "plugin-marketplace__source-tab--active" : ""}`}
              onClick={() => setSource("connectors")}
            >
              <Cable size={14} strokeWidth={1.8} />
              <span>远程接入</span>
            </button>
          </div>
        )}

        {showSkillhub || showSuites || showConnectorhub ? null : (
          <>
            {mainView ? (
              <div className="plugin-marketplace__top-bar">
                <div className="plugin-marketplace__category-tabs">
                  {PLUGIN_CATEGORIES.filter(
                    (c) =>
                      c === "全部" ||
                      allPlugins.some((m) => m.category === c),
                  ).map((c) => (
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

                <div
                  className={`plugin-marketplace__search ${searchExpanded ? "plugin-marketplace__search--expanded" : ""}`}
                >
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
                  {PLUGIN_CATEGORIES.filter(
                    (c) =>
                      c === "全部" ||
                      allPlugins.some((m) => m.category === c),
                  ).map((c) => (
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
        {showSkillhub ? (
          <SkillhubBrowser />
        ) : showSuites ? (
          <CbteamsBrowser />
        ) : showConnectorhub ? (
          <ConnectorhubBrowser />
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
              const mcpConnected = connectedList.find(
                (s) => s.connectorId === manifest.id,
              );
              return (
                <div key={manifest.id} className="plugin-card">
                  <div className="plugin-card__icon">
                    <Icon size={22} strokeWidth={1.7} />
                  </div>
                  <div className="plugin-card__main">
                    <div className="plugin-card__title-row">
                      <h3>{manifest.name}</h3>
                      <span className="plugin-card__badge">
                        {manifest.kind}
                      </span>
                    </div>
                    <p className="plugin-card__description">
                      {manifest.description}
                    </p>
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
                        {!installed ? (
                          <button
                            type="button"
                            className="plugin-card__button plugin-card__button--primary"
                            onClick={() => handleInstall(manifest)}
                          >
                            <Download size={14} strokeWidth={1.8} />
                            <span>安装</span>
                          </button>
                        ) : isMcpConnector(manifest) ? (
                          mcpConnected ? (
                            <>
                              <span
                                className="plugin-card__connected"
                                title={`已连接 · 暴露 ${mcpConnected.toolCount} 个工具`}
                              >
                                <span className="plugin-card__connected-dot" />
                                <span>{mcpConnected.toolCount} 工具</span>
                              </span>
                              <button
                                type="button"
                                className="plugin-card__button plugin-card__button--secondary"
                                onClick={() => void handleDisconnect(manifest)}
                              >
                                <Unplug size={14} strokeWidth={1.8} />
                                <span>断开</span>
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="plugin-card__button plugin-card__button--primary"
                              onClick={() => void handleConnect(manifest)}
                            >
                              <PlugZap size={14} strokeWidth={1.8} />
                              <span>连接</span>
                            </button>
                          )
                        ) : null}
                      </>
                    ) : installed ? (
                      <button
                        type="button"
                        className="plugin-card__button plugin-card__button--installed"
                        disabled
                      >
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
                  {mcpError?.connectorId === manifest.id && (
                    <div className="plugin-card__mcp-error">
                      <AlertTriangle size={13} strokeWidth={1.8} />
                      <span>{mcpError.message}</span>
                    </div>
                  )}
                  {configuringId === manifest.id &&
                    ((manifest.configFields?.length ?? 0) > 0 ||
                      isMcpConnector(manifest)) && (
                      <div className="plugin-card__config">
                        {manifest.configFields?.map((field) => (
                          <label
                            key={field.id}
                            className="plugin-card__config-field"
                          >
                            <span>
                              {field.label}
                              {field.required ? " *" : ""}
                            </span>
                            {field.type === "boolean" ? (
                              <input
                                type="checkbox"
                                checked={configDraft[field.id] === "true"}
                                onChange={(event) =>
                                  updateDraft(
                                    field.id,
                                    event.target.checked ? "true" : "false",
                                  )
                                }
                              />
                            ) : field.type === "select" ? (
                              <select
                                value={configDraft[field.id] ?? ""}
                                onChange={(event) =>
                                  updateDraft(field.id, event.target.value)
                                }
                              >
                                <option value="">
                                  {field.placeholder ?? "请选择"}
                                </option>
                                {field.options?.map((option) => (
                                  <option
                                    key={option.value}
                                    value={option.value}
                                  >
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <input
                                type={
                                  field.type === "password"
                                    ? "password"
                                    : field.type === "number"
                                      ? "number"
                                      : "text"
                                }
                                value={configDraft[field.id] ?? ""}
                                placeholder={field.placeholder}
                                onChange={(event) =>
                                  updateDraft(field.id, event.target.value)
                                }
                              />
                            )}
                          </label>
                        ))}
                        {isMcpConnector(manifest) && (
                          <>
                            <div className="plugin-card__config-section">
                              MCP 启动配置
                            </div>
                            <label className="plugin-card__config-field">
                              <span>启动命令 *</span>
                              <input
                                value={mcpDraft.command}
                                onChange={(event) =>
                                  updateMcpDraft("command", event.target.value)
                                }
                                placeholder="如 npx / node / python"
                              />
                            </label>
                            <label className="plugin-card__config-field">
                              <span>参数（支持引号包裹的空格）</span>
                              <input
                                value={mcpDraft.args}
                                onChange={(event) =>
                                  updateMcpDraft("args", event.target.value)
                                }
                                placeholder='如 -y @modelcontextprotocol/server-github'
                              />
                            </label>
                            <label className="plugin-card__config-field">
                              <span>环境变量（每行 KEY=VALUE）</span>
                              <textarea
                                value={mcpDraft.env}
                                onChange={(event) =>
                                  updateMcpDraft("env", event.target.value)
                                }
                                rows={3}
                                placeholder="GITHUB_TOKEN=ghp_xxxxxxxx&#10;GITHUB_REPO_OWNER=..."
                              />
                            </label>
                          </>
                        )}
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
