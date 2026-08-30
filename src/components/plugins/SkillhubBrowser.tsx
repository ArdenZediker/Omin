import { useCallback, useEffect, useRef, useState } from "react";
import {
  Search,
  Download,
  Star,
  Check,
  ExternalLink,
  Loader2,
  AlertTriangle,
  Puzzle,
  Bot,
} from "lucide-react";
import { pluginRegistry } from "../../plugins/registry";
import {
  listSkillhubSkills,
  listSkillhubPlugins,
  installSkillhubSkill,
  uninstallSkillhubSkill,
  mapSkillToManifest,
  skillUniqueKey,
  type SkillhubSkillSummary,
  type SkillhubPluginSummary,
} from "../../plugins/skillhub";

const SKILL_CATEGORIES = [
  "全部",
  "Pay Skill",
  "办公效率",
  "内容创作",
  "开发编程",
  "数据分析",
  "设计多媒体",
  "AI Agent",
  "知识管理",
  "商业运营",
  "教育学习",
  "行业专业",
  "IT 运维与安全",
  "生活服务",
];

type Tab = "skills" | "plugins";

/**
 * SkillHub 实时浏览/安装面板。
 * - 「技能」标签：来自 SkillHub 的 DSH 风格 SKILL.md 技能，可一键安装进 Omni（一切皆插件）。
 * - 「DSH 插件」标签：SkillHub 上的 DSH/Cordis 插件，仅作参考（需在 DeepSeek Harness 中安装）。
 * 参考 @cocofhu/skillhub（DeepSeek Harness 的 SkillHub 插件）的 API 与安装机制。
 */
export default function SkillhubBrowser() {
  const [tab, setTab] = useState<Tab>("skills");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部");
  const [skills, setSkills] = useState<SkillhubSkillSummary[]>([]);
  const [plugins, setPlugins] = useState<SkillhubPluginSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [installing, setInstalling] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);

  const refreshInstalled = useCallback(() => {
    const next = new Set<string>();
    for (const s of skills) if (pluginRegistry.isInstalled(skillUniqueKey(s))) next.add(skillUniqueKey(s));
    setInstalled(next);
  }, [skills]);

  const resetSkills = useCallback(() => {
    setPage(1);
    setHasMore(true);
    setSkills([]);
  }, []);

  const loadSkills = useCallback(
    async (targetPage: number, append: boolean) => {
      if (targetPage === 1) setLoading(true);
      else setLoadingMore(true);
      setError(null);
      try {
        const pageSkills = await listSkillhubSkills({ query, category, page: targetPage, limit: 60 });
        setSkills((prev) => {
          const combined = append ? [...prev, ...pageSkills] : pageSkills;
          // 按唯一键去重（不同 namespace 下 slug 可能重复）
          const seen = new Set<string>();
          return combined.filter((s) => {
            const key = skillUniqueKey(s);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        });
        setHasMore(pageSkills.length >= 20); // 服务端每页约 20 条，等于 20 认为还有下一页
        setPage(targetPage);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [query, category],
  );

  const loadPlugins = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPlugins(await listSkillhubPlugins({ query }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [query]);

  // 切换 tab / 搜索 / 分类时重置并加载第一页
  useEffect(() => {
    resetSkills();
    if (tab === "skills") void loadSkills(1, false);
    else void loadPlugins();
  }, [tab, query, category, loadSkills, loadPlugins, resetSkills]);

  useEffect(() => {
    refreshInstalled();
  }, [skills, refreshInstalled]);

  const handleInstall = async (s: SkillhubSkillSummary) => {
    const key = skillUniqueKey(s);
    setInstalling(key);
    try {
      await installSkillhubSkill(s.slug);
      setInstalled((prev) => new Set(prev).add(key));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(null);
    }
  };

  const handleUninstall = async (s: SkillhubSkillSummary) => {
    const key = skillUniqueKey(s);
    try {
      await uninstallSkillhubSkill(s.slug);
      setInstalled((prev) => {
        const n = new Set(prev);
        n.delete(key);
        return n;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleLoadMore = () => {
    if (!loading && !loadingMore && hasMore) {
      void loadSkills(page + 1, true);
    }
  };

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const scrollContainer = grid.closest(".plugin-marketplace__body") as HTMLElement | null;
    if (!scrollContainer) return;

    const onScroll = () => {
      const threshold = 120;
      const nearBottom = scrollContainer.scrollTop + scrollContainer.clientHeight >= scrollContainer.scrollHeight - threshold;
      if (nearBottom) {
        handleLoadMore();
      }
    };

    scrollContainer.addEventListener("scroll", onScroll);
    return () => scrollContainer.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="skillhub-browser">
      <div className="plugin-marketplace__search">
        <Search size={15} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索 SkillHub 技能 / 插件…"
        />
      </div>

      <div className="plugin-marketplace__kind-tabs">
        <button
          className={
            tab === "skills"
              ? "plugin-marketplace__kind-tab plugin-marketplace__kind-tab--active"
              : "plugin-marketplace__kind-tab"
          }
          onClick={() => setTab("skills")}
        >
          <Bot size={13} /> 技能（可安装）
        </button>
        <button
          className={
            tab === "plugins"
              ? "plugin-marketplace__kind-tab plugin-marketplace__kind-tab--active"
              : "plugin-marketplace__kind-tab"
          }
          onClick={() => setTab("plugins")}
        >
          <Puzzle size={13} /> DSH 插件（参考）
        </button>
      </div>

      {tab === "skills" && (
        <div className="plugin-marketplace__category-tabs">
          {SKILL_CATEGORIES.map((c) => (
            <button
              key={c}
              className={
                category === c
                  ? "plugin-marketplace__category-tab plugin-marketplace__category-tab--active"
                  : "plugin-marketplace__category-tab"
              }
              onClick={() => setCategory(c)}
            >
              {c}
            </button>
          ))}
        </div>
      )}

      {loading && (
        <div className="skillhub-browser__status">
          <Loader2 size={16} className="spin" /> 加载中…
        </div>
      )}
      {error && (
        <div className="skillhub-browser__status skillhub-browser__status--error">
          <AlertTriangle size={15} /> {error}
        </div>
      )}
      {!loading && !error && tab === "skills" && skills.length === 0 && (
        <div className="skillhub-browser__empty">未找到技能</div>
      )}
      {!loading && !error && tab === "plugins" && plugins.length === 0 && (
        <div className="skillhub-browser__empty">未找到 DSH 插件</div>
      )}

      <div ref={gridRef} className="plugin-marketplace__grid" style={{ marginTop: 14 }}>
        {tab === "skills" &&
          skills.map((s) => {
            const key = skillUniqueKey(s);
            const isInst = installed.has(key);
            const meta = mapSkillToManifest(s);
            return (
              <div className="plugin-card" key={key}>
                <div className="plugin-card__header">
                  <div className="plugin-card__icon">
                    {s.iconUrl ? (
                      <img
                        src={s.iconUrl}
                        alt=""
                        style={{ width: 22, height: 22, borderRadius: 6 }}
                      />
                    ) : (
                      <Bot size={18} />
                    )}
                  </div>
                  <div className="plugin-card__main">
                    <div className="plugin-card__title-row">
                      <h3>{s.name}</h3>
                      <span className="plugin-card__badge">{meta.category}</span>
                    </div>
                  </div>
                </div>
                <p className="plugin-card__description">{s.description_zh || s.description}</p>
                <div className="plugin-card__meta">
                  <span>
                    <Star size={12} /> {s.stars ?? 0}
                  </span>
                  <span>
                    <Download size={12} /> {s.downloads ?? 0}
                  </span>
                  {s.namespace?.canonicalName && <span>{s.namespace.canonicalName}</span>}
                  {s.labels?.requires_api_key === "true" && (
                    <span className="skillhub-browser__api">需 API Key</span>
                  )}
                </div>
                <div className="plugin-card__actions">
                  {isInst ? (
                    <button className="plugin-card__button plugin-card__button--installed" disabled>
                      <Check size={14} /> 已安装
                    </button>
                  ) : (
                    <button
                      className="plugin-card__button plugin-card__button--primary"
                      onClick={() => handleInstall(s)}
                      disabled={installing === key}
                    >
                      {installing === key ? (
                        <Loader2 size={14} className="spin" />
                      ) : (
                        <Download size={14} />
                      )}
                      {installing === key ? "安装中…" : "安装"}
                    </button>
                  )}
                  {isInst && (
                    <button
                      className="plugin-card__button plugin-card__button--secondary"
                      onClick={() => handleUninstall(s)}
                    >
                      卸载
                    </button>
                  )}
                  {s.homepage && (
                    <a
                      className="plugin-card__button plugin-card__button--secondary"
                      href={s.homepage}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink size={14} /> 来源
                    </a>
                  )}
                </div>
              </div>
            );
          })}

        {tab === "plugins" &&
          plugins.map((p) => (
            <div className="plugin-card" key={p.fullName}>
              <div className="plugin-card__header">
                <div className="plugin-card__icon">
                  {p.avatarUrl ? (
                    <img
                      src={p.avatarUrl}
                      alt=""
                      style={{ width: 22, height: 22, borderRadius: 6 }}
                    />
                  ) : (
                    <Puzzle size={18} />
                  )}
                </div>
                <div className="plugin-card__main">
                  <div className="plugin-card__title-row">
                    <h3>{p.name}</h3>
                    <span className="plugin-card__badge">{p.categoryKey}</span>
                  </div>
                </div>
              </div>
              <p className="plugin-card__description">{p.description}</p>
              <div className="plugin-card__meta">
                <span>
                  <Star size={12} /> {p.stars ?? 0}
                </span>
                {p.license && <span>{p.license}</span>}
                {p.installability && <span>{p.installability}</span>}
              </div>
              <div className="plugin-card__actions">
                {p.repositoryUrl && (
                  <a
                    className="plugin-card__button plugin-card__button--secondary"
                    href={p.repositoryUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <ExternalLink size={14} /> GitHub
                  </a>
                )}
                <span
                  className="plugin-card__badge"
                  style={{ flex: 1, textAlign: "center" }}
                  title="DSH 插件为 Cordis 插件，需在 DeepSeek Harness 中安装"
                >
                  DSH 专用
                </span>
              </div>
            </div>
          ))}

        {tab === "skills" && !loading && skills.length > 0 && (
          <div className="skillhub-browser__load-more">
            {loadingMore ? (
              <span className="skillhub-browser__loading">
                <Loader2 size={14} className="spin" /> 加载中…
              </span>
            ) : hasMore ? null : (
              <span className="skillhub-browser__end">已加载全部</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
