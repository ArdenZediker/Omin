import { memo, useCallback, useEffect, useRef, useState } from "react";
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

type SkillCardProps = {
  skill: SkillhubSkillSummary;
  isInstalled: boolean;
  isInstalling: boolean;
  onInstall: (skill: SkillhubSkillSummary) => void;
  onUninstall: (skill: SkillhubSkillSummary) => void;
};

/**
 * 技能卡片。用 memo 包裹，加载下一页时已存在的卡片不会重渲染 —— 这是滚动流畅的关键。
 */
const SkillCard = memo(function SkillCard({ skill, isInstalled, isInstalling, onInstall, onUninstall }: SkillCardProps) {
  const meta = mapSkillToManifest(skill);
  return (
    <div className="plugin-card">
      <div className="plugin-card__header">
        <div className="plugin-card__icon">
          {skill.iconUrl ? (
            <img src={skill.iconUrl} alt="" style={{ width: 22, height: 22, borderRadius: 6 }} loading="lazy" />
          ) : (
            <Bot size={18} />
          )}
        </div>
        <div className="plugin-card__main">
          <div className="plugin-card__title-row">
            <h3>{skill.name}</h3>
            <span className="plugin-card__badge">{meta.category}</span>
          </div>
        </div>
      </div>
      <p className="plugin-card__description">{skill.description_zh || skill.description}</p>
      <div className="plugin-card__meta">
        <span>
          <Star size={12} /> {skill.stars ?? 0}
        </span>
        <span>
          <Download size={12} /> {skill.downloads ?? 0}
        </span>
        {skill.namespace?.canonicalName && <span>{skill.namespace.canonicalName}</span>}
        {skill.labels?.requires_api_key === "true" && <span className="skillhub-browser__api">需 API Key</span>}
      </div>
      <div className="plugin-card__actions">
        {isInstalled ? (
          <button className="plugin-card__button plugin-card__button--installed" disabled>
            <Check size={14} /> 已安装
          </button>
        ) : (
          <button
            className="plugin-card__button plugin-card__button--primary"
            onClick={() => onInstall(skill)}
            disabled={isInstalling}
          >
            {isInstalling ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
            {isInstalling ? "安装中…" : "安装"}
          </button>
        )}
        {isInstalled && (
          <button className="plugin-card__button plugin-card__button--secondary" onClick={() => onUninstall(skill)}>
            卸载
          </button>
        )}
        {skill.homepage && (
          <a
            className="plugin-card__button plugin-card__button--secondary"
            href={skill.homepage}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={14} /> 来源
          </a>
        )}
      </div>
    </div>
  );
});

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
  // 异步回调里需要读到最新的 skills 做去重，用 ref 避免闭包过期
  const skillsRef = useRef<SkillhubSkillSummary[]>([]);
  skillsRef.current = skills;

  const refreshInstalled = useCallback(() => {
    setInstalled((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const s of skills) {
        const key = skillUniqueKey(s);
        const isInst = pluginRegistry.isInstalled(key);
        if (isInst && !next.has(key)) {
          next.add(key);
          changed = true;
        } else if (!isInst && next.has(key)) {
          next.delete(key);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [skills]);

  const resetSkills = useCallback(() => {
    setPage(1);
    setHasMore(true);
    setSkills([]);
  }, []);

  const loadSkills = useCallback(
    async (targetPage: number, append: boolean): Promise<{ added: number; hasMore: boolean }> => {
      if (targetPage === 1) setLoading(true);
      else setLoadingMore(true);
      setError(null);
      try {
        const pageSkills = await listSkillhubSkills({ query, category, page: targetPage, limit: 60 });
        // 按唯一键去重（不同 namespace 下 slug 可能重复），只保留本次真正新增的条目
        const prevKeys = append ? new Set(skillsRef.current.map(skillUniqueKey)) : new Set<string>();
        const seen = new Set<string>();
        const fresh = pageSkills.filter((s) => {
          const key = skillUniqueKey(s);
          if (seen.has(key) || prevKeys.has(key)) return false;
          seen.add(key);
          return true;
        });
        setSkills((prev) => (append ? [...prev, ...fresh] : fresh));
        const stillMore = pageSkills.length >= 20; // 服务端每页约 20 条，等于 20 认为还有下一页
        setHasMore(stillMore);
        setPage(targetPage);
        return { added: fresh.length, hasMore: stillMore };
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return { added: 0, hasMore: false };
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

  // 用 useCallback 稳定引用，配合 SkillCard 的 memo 才能真正避免整列表重渲染
  const handleInstall = useCallback(async (s: SkillhubSkillSummary) => {
    const key = skillUniqueKey(s);
    setInstalling(key);
    try {
      await installSkillhubSkill(s.slug);
      setInstalled((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(null);
    }
  }, []);

  const handleUninstall = useCallback(async (s: SkillhubSkillSummary) => {
    const key = skillUniqueKey(s);
    try {
      await uninstallSkillhubSkill(s.slug);
      setInstalled((prev) => {
        if (!prev.has(key)) return prev;
        const n = new Set(prev);
        n.delete(key);
        return n;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // 滚动加载：rAF 节流 + ref 锁。
  // 关键点：loading/loadingMore 是 state，更新是异步的，如果直接依赖它们做 guard，
  // 一次快速滚动会在 state 落地前并发发起多个请求，导致界面卡顿。这里用同步的 ref 锁拦截。
  const isLoadingRef = useRef(false);
  const loadMoreRef = useRef<() => void>(() => {});
  loadMoreRef.current = () => {
    if (isLoadingRef.current || !hasMore) return;
    isLoadingRef.current = true;
    void (async () => {
      try {
        let nextPage = page + 1;
        // 分类过滤在前端做，某一页可能整页都被过滤掉。此时继续往后翻，
        // 避免用户滚到底却看不到新内容；最多连翻 3 页，防止请求风暴。
        for (let i = 0; i < 3; i += 1) {
          const result = await loadSkills(nextPage, true);
          nextPage += 1;
          if (result.added > 0 || !result.hasMore) break;
        }
      } finally {
        isLoadingRef.current = false;
      }
    })();
  };

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const scrollContainer = grid.closest(".plugin-marketplace__body") as HTMLElement | null;
    if (!scrollContainer) return;

    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const threshold = 240;
        const nearBottom =
          scrollContainer.scrollTop + scrollContainer.clientHeight >= scrollContainer.scrollHeight - threshold;
        if (nearBottom) {
          loadMoreRef.current();
        }
      });
    };

    scrollContainer.addEventListener("scroll", onScroll, { passive: true });
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
            return (
              <SkillCard
                key={key}
                skill={s}
                isInstalled={installed.has(key)}
                isInstalling={installing === key}
                onInstall={handleInstall}
                onUninstall={handleUninstall}
              />
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
