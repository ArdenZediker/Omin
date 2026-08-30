import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  Search,
  Download,
  Star,
  Check,
  ExternalLink,
  Loader2,
  AlertTriangle,
  Bot,
  ChevronDown,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-shell";
import { pluginRegistry } from "../../plugins/registry";
import {
  listSkillhubSkills,
  listSkillhubSkillCategories,
  installSkillhubSkill,
  uninstallSkillhubSkill,
  mapSkillToManifest,
  mapSkillhubCategory,
  skillUniqueKey,
  type SkillhubSkillSummary,
} from "../../plugins/skillhub";

type CategoryItem = { key: string; displayName: string };

// 排序 tab 参考 SkillHub 官网顶部筛选栏（全部 / 近期飙升 / 下载量 / 最近上新）。
// 底层接口仍使用实测生效的 sortBy：downloads / score / updated_at / stars；
// 官网无 trending 参数，故「近期飙升」使用 score 作为热门度代理。
const SORT_TABS = [
  { key: "", label: "全部" },
  { key: "score", label: "近期飙升" },
  { key: "downloads", label: "下载量" },
  { key: "updated_at", label: "最近上新" },
];

const API_KEY_OPTIONS = [
  { key: "all", label: "不限 API Key" },
  { key: "not_required", label: "无需 API Key" },
  { key: "required", label: "需要 API Key" },
];

const SOURCE_OPTIONS = [
  { key: "", label: "所有来源" },
  { key: "clawhub", label: "clawhub" },
  { key: "community", label: "community" },
];

/** SkillHub 的 homepage 字段是接口域名（api.skillhub.cn，不渲染网页），
 * 且路径缺少 /skills/ 前缀。打开来源页时需要：
 * 1) 换成前端域名 skillhub.cn；
 * 2) 技能路径前补 /skills/。 */
function toWebUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/+/, "");
    return `https://skillhub.cn/skills/${path}`;
  } catch {
    return url;
  }
}

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
        <div className="plugin-card__meta-left">
          <span>
            <Star size={12} /> {skill.stars ?? 0}
          </span>
          <span>
            <Download size={12} /> {skill.downloads ?? 0}
          </span>
        </div>
        <div className="plugin-card__meta-right">
          {skill.namespace?.canonicalName && <span className="plugin-card__author">{skill.namespace.canonicalName}</span>}
          {skill.labels?.requires_api_key === "true" && <span className="skillhub-browser__api">需 API Key</span>}
        </div>
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
          <button
            className="plugin-card__button plugin-card__button--secondary"
            onClick={() => void open(toWebUrl(skill.homepage!))}
          >
            <ExternalLink size={14} /> 来源
          </button>
        )}
      </div>
    </div>
  );
});

/**
 * SkillHub 实时浏览/安装面板。
 * 来自 SkillHub 的 DSH 风格 SKILL.md 技能，可一键安装进 Omni（一切皆插件）。
 * 参考 @cocofhu/skillhub（DeepSeek Harness 的 SkillHub 插件）的 API 与安装机制。
 */
export default function SkillhubBrowser() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部");
  const [sortBy, setSortBy] = useState("");
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [apiKeyFilter, setApiKeyFilter] = useState<"all" | "required" | "not_required">("all");
  const [apiKeyOpen, setApiKeyOpen] = useState(false);
  const [sourceFilter, setSourceFilter] = useState("");
  const [sourceOpen, setSourceOpen] = useState(false);
  const [skills, setSkills] = useState<SkillhubSkillSummary[]>([]);
  const [skillCategories, setSkillCategories] = useState<CategoryItem[]>([{ key: "", displayName: "全部" }]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [installing, setInstalling] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const categoryRef = useRef<HTMLDivElement | null>(null);
  const apiKeyRef = useRef<HTMLDivElement | null>(null);
  const sourceRef = useRef<HTMLDivElement | null>(null);
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
      // API Key 筛选改为服务端 labels 参数（requires_api_key:true / :false），
      // 避免前端过滤造成分页数量错位。
      const labels =
        apiKeyFilter === "all" ? undefined : `requires_api_key:${apiKeyFilter === "required" ? "true" : "false"}`;
      try {
        const pageSkills = await listSkillhubSkills({
          query,
          category,
          page: targetPage,
          limit: 60,
          sortBy,
          labels,
          source: sourceFilter,
        });
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
    [query, category, sortBy, apiKeyFilter, sourceFilter],
  );

  // 搜索 / 分类 / 排序 / API Key / 来源筛选变化时重置并加载第一页
  useEffect(() => {
    resetSkills();
    void loadSkills(1, false);
  }, [query, category, sortBy, apiKeyFilter, sourceFilter, loadSkills, resetSkills]);

  // 动态加载 SkillHub 官方分类，避免写死分类导致空 tab
  useEffect(() => {
    listSkillhubSkillCategories()
      .then((cats) => {
        // 后端 /api/v1/categories 已按 sortOrder 排序，displayName 已是中文。
        // 直接用后端返回的 displayName，避免前端映射表滞后导致显示异常。
        const mapped: CategoryItem[] = cats.map((c) => ({
          key: c.key,
          displayName: c.displayName || mapSkillhubCategory(c.key),
        }));
        const unique: CategoryItem[] = [{ key: "", displayName: "全部" }];
        for (const item of mapped) {
          if (!unique.some((u) => u.displayName === item.displayName)) {
            unique.push(item);
          }
        }
        setSkillCategories(unique);
      })
      .catch(() => {});
  }, []);

  // 点击外部关闭分类 / API Key / 来源下拉菜单
  useEffect(() => {
    if (!categoryOpen && !apiKeyOpen && !sourceOpen) return;
    function handleClick(e: MouseEvent) {
      if (categoryRef.current && !categoryRef.current.contains(e.target as Node)) {
        setCategoryOpen(false);
      }
      if (apiKeyRef.current && !apiKeyRef.current.contains(e.target as Node)) {
        setApiKeyOpen(false);
      }
      if (sourceRef.current && !sourceRef.current.contains(e.target as Node)) {
        setSourceOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [categoryOpen, apiKeyOpen, sourceOpen]);

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
      <div className="skillhub-browser__filter-bar">
        <div className="plugin-marketplace__sort-tabs">
          {SORT_TABS.map((o) => (
            <button
              key={o.key || "default"}
              className={
                sortBy === o.key
                  ? "plugin-marketplace__sort-tab plugin-marketplace__sort-tab--active"
                  : "plugin-marketplace__sort-tab"
              }
              onClick={() => setSortBy(o.key)}
            >
              {o.label}
            </button>
          ))}
        </div>

        <div className="skillhub-browser__filters">
          <div className="plugin-marketplace__filter" ref={categoryRef}>
            <button
              className="plugin-marketplace__filter-trigger"
              onClick={() => setCategoryOpen((v) => !v)}
              title="场景分类"
            >
              {skillCategories.find((c) => c.displayName === category)?.displayName ?? "所有场景分类"}
              <ChevronDown size={14} />
            </button>
            {categoryOpen && (
              <div className="plugin-marketplace__filter-menu">
                {skillCategories.map((c) => (
                  <button
                    key={c.key || c.displayName}
                    className={
                      category === c.displayName
                        ? "plugin-marketplace__filter-item plugin-marketplace__filter-item--active"
                        : "plugin-marketplace__filter-item"
                    }
                    onClick={() => {
                      setCategory(c.displayName);
                      setCategoryOpen(false);
                    }}
                  >
                    {c.displayName}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="plugin-marketplace__filter" ref={apiKeyRef}>
            <button
              className="plugin-marketplace__filter-trigger"
              onClick={() => setApiKeyOpen((v) => !v)}
              title="API Key 筛选"
            >
              {API_KEY_OPTIONS.find((o) => o.key === apiKeyFilter)?.label ?? "不限 API Key"}
              <ChevronDown size={14} />
            </button>
            {apiKeyOpen && (
              <div className="plugin-marketplace__filter-menu">
                {API_KEY_OPTIONS.map((o) => (
                  <button
                    key={o.key}
                    className={
                      apiKeyFilter === o.key
                        ? "plugin-marketplace__filter-item plugin-marketplace__filter-item--active"
                        : "plugin-marketplace__filter-item"
                    }
                    onClick={() => {
                      setApiKeyFilter(o.key as typeof apiKeyFilter);
                      setApiKeyOpen(false);
                    }}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="plugin-marketplace__filter" ref={sourceRef}>
            <button
              className="plugin-marketplace__filter-trigger"
              onClick={() => setSourceOpen((v) => !v)}
              title="来源"
            >
              {SOURCE_OPTIONS.find((o) => o.key === sourceFilter)?.label ?? "所有来源"}
              <ChevronDown size={14} />
            </button>
            {sourceOpen && (
              <div className="plugin-marketplace__filter-menu">
                {SOURCE_OPTIONS.map((o) => (
                  <button
                    key={o.key || "all"}
                    className={
                      sourceFilter === o.key
                        ? "plugin-marketplace__filter-item plugin-marketplace__filter-item--active"
                        : "plugin-marketplace__filter-item"
                    }
                    onClick={() => {
                      setSourceFilter(o.key);
                      setSourceOpen(false);
                    }}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            className="plugin-marketplace__icon-btn"
            onClick={() => searchInputRef.current?.focus()}
            title="搜索"
          >
            <Search size={16} />
          </button>
        </div>
      </div>

      <div className="plugin-marketplace__search skillhub-browser__search">
        <Search size={15} />
        <input
          ref={searchInputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索技能名称、描述或关键词…"
        />
      </div>

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
      {!loading && !error && skills.length === 0 && (
        <div className="skillhub-browser__empty">未找到技能</div>
      )}

      <div ref={gridRef} className="plugin-marketplace__grid" style={{ marginTop: 14 }}>
        {skills.map((s) => {
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

        {!loading && skills.length > 0 && (
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
