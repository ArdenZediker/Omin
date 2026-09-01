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
  X,
  Hash,
  Package,
  Tag,
  Calendar,
  LayoutGrid,
  LayoutList,
  BadgeCheck,
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
  { key: "clawhub", label: "ClawHub" },
  { key: "community", label: "SkillHub" },
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

/** 把 0/空值渲染成 "—" 的安全格式化器。 */
function fmt(value: number | string | undefined | null, suffix = ""): string {
  if (value === undefined || value === null || value === "") return "—";
  return `${value}${suffix}`;
}

/** 把毫秒时间戳格式化成易读日期。本地时区、含时分避免「1970 凌晨」的歧义。 */
function formatDate(ms?: number | null): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Source 标签 → 中文显示。SkillHub 返回的 source 多为 'clawhub' / 'community' / 'skillhub'。 */
function formatSource(source?: string): string {
  switch (source) {
    case "clawhub":
      return "ClawHub";
    case "community":
      return "SkillHub 社区";
    case "skillhub":
      return "SkillHub";
    default:
      return source ?? "未知";
  }
}

type SkillDetailDrawerProps = {
  skill: SkillhubSkillSummary | null;
  onClose: () => void;
  isInstalled: boolean;
  isInstalling: boolean;
  onInstall: (skill: SkillhubSkillSummary) => void;
  onUninstall: (skill: SkillhubSkillSummary) => void;
};

/**
 * 技能详情抽屉。从右侧滑入，展示完整描述、作者、统计、所有标签、版本时间。
 * 复用与卡片同源的安装/来源按钮，状态自动同步卡片显示。
 * Esc 与点击遮罩均可关闭；浏览器侧焦点管理交回原触发元素。
 */
function SkillDetailDrawer({
  skill,
  onClose,
  isInstalled,
  isInstalling,
  onInstall,
  onUninstall,
}: SkillDetailDrawerProps) {
  // Esc 关闭
  useEffect(() => {
    if (!skill) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [skill, onClose]);

  if (!skill) return null;

  const requiresApiKey = skill.labels?.requires_api_key === "true";
  const labels = skill.labels
    ? Object.entries(skill.labels).filter(([k, v]) => k !== "requires_api_key" || v !== "true")
    : [];
  const sourceUrl = skill.homepage ? toWebUrl(skill.homepage) : "";
  const upstreamUrl = skill.upstream_url ?? "";

  return (
    <div
      className="skillhub-detail__overlay"
      onClick={onClose}
      role="presentation"
    >
      <aside
        className="skillhub-detail"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`${skill.name} 详情`}
      >
        <header className="skillhub-detail__header">
          <div className="skillhub-detail__identity">
            <div className="skillhub-detail__icon">
              {skill.iconUrl ? (
                <img src={skill.iconUrl} alt="" loading="lazy" />
              ) : (
                <Bot size={28} />
              )}
            </div>
            <div className="skillhub-detail__title-wrap">
              <h2>{skill.name}</h2>
              <div className="skillhub-detail__title-row">
                <span className="plugin-card__badge">
                  {mapSkillToManifest(skill).category}
                </span>
                {skill.source && (
                  <span className="skillhub-detail__source">{formatSource(skill.source)}</span>
                )}
                {requiresApiKey && (
                  <span className="skillhub-browser__api">需 API Key</span>
                )}
              </div>
            </div>
          </div>
          <button
            type="button"
            className="skillhub-detail__close"
            onClick={onClose}
            title="关闭 (Esc)"
            aria-label="关闭详情"
          >
            <X size={18} />
          </button>
        </header>

        <div className="skillhub-detail__body">
          <p className="skillhub-detail__description">
            {skill.description_zh || skill.description || "（暂无描述）"}
          </p>
          {skill.description_zh && skill.description && skill.description_zh !== skill.description && (
            <details className="skillhub-detail__description-en">
              <summary>查看英文原文</summary>
              <p>{skill.description}</p>
            </details>
          )}

          <div className="skillhub-detail__meta-grid">
            <div className="skillhub-detail__meta-item">
              <span className="skillhub-detail__meta-label">
                <Hash size={12} /> 作者
              </span>
              <span className="skillhub-detail__meta-value">{fmt(skill.namespace?.canonicalName)}</span>
            </div>
            <div className="skillhub-detail__meta-item">
              <span className="skillhub-detail__meta-label">
                <Package size={12} /> 版本
              </span>
              <span className="skillhub-detail__meta-value">{fmt(skill.version)}</span>
            </div>
            <div className="skillhub-detail__meta-item">
              <span className="skillhub-detail__meta-label">
                <Download size={12} /> 下载量
              </span>
              <span className="skillhub-detail__meta-value">{fmt(skill.downloads)}</span>
            </div>
            <div className="skillhub-detail__meta-item">
              <span className="skillhub-detail__meta-label">
                <Star size={12} /> 收藏
              </span>
              <span className="skillhub-detail__meta-value">{fmt(skill.stars)}</span>
            </div>
            <div className="skillhub-detail__meta-item">
              <span className="skillhub-detail__meta-label">安装量</span>
              <span className="skillhub-detail__meta-value">{fmt(skill.installs)}</span>
            </div>
            <div className="skillhub-detail__meta-item">
              <span className="skillhub-detail__meta-label">评分</span>
              <span className="skillhub-detail__meta-value">{fmt(skill.score)}</span>
            </div>
            <div className="skillhub-detail__meta-item">
              <span className="skillhub-detail__meta-label">
                <Calendar size={12} /> 最近更新
              </span>
              <span className="skillhub-detail__meta-value">{formatDate(skill.updated_at)}</span>
            </div>
            <div className="skillhub-detail__meta-item">
              <span className="skillhub-detail__meta-label">
                <Calendar size={12} /> 创建时间
              </span>
              <span className="skillhub-detail__meta-value">{formatDate(skill.created_at)}</span>
            </div>
          </div>

          {skill.subCategories && skill.subCategories.length > 0 && (
            <div className="skillhub-detail__tags">
              <div className="skillhub-detail__tags-label">
                <Tag size={12} /> 子分类
              </div>
              <div className="skillhub-detail__tag-list">
                {skill.subCategories.map((sub) => (
                  <span key={sub.key} className="skillhub-detail__tag">
                    {sub.name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {labels.length > 0 && (
            <div className="skillhub-detail__tags">
              <div className="skillhub-detail__tags-label">
                <Tag size={12} /> 标签
              </div>
              <div className="skillhub-detail__tag-list">
                {labels.map(([key, value]) => (
                  <span key={key} className="skillhub-detail__tag skillhub-detail__tag--label">
                    {key}: {value}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <footer className="skillhub-detail__footer">
          {isInstalled ? (
            <>
              <button
                type="button"
                className="plugin-card__button plugin-card__button--installed"
                disabled
              >
                <Check size={14} /> 已安装
              </button>
              <button
                type="button"
                className="plugin-card__button plugin-card__button--secondary"
                onClick={() => onUninstall(skill)}
              >
                卸载
              </button>
            </>
          ) : (
            <button
              type="button"
              className="plugin-card__button plugin-card__button--primary"
              onClick={() => onInstall(skill)}
              disabled={isInstalling}
            >
              {isInstalling ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <Download size={14} />
              )}
              {isInstalling ? "安装中…" : "安装"}
            </button>
          )}
          {sourceUrl && (
            <button
              type="button"
              className="plugin-card__button plugin-card__button--secondary"
              onClick={() => void open(sourceUrl)}
            >
              <ExternalLink size={14} /> SkillHub 详情页
            </button>
          )}
          {upstreamUrl && upstreamUrl !== sourceUrl && (
            <button
              type="button"
              className="plugin-card__button plugin-card__button--secondary"
              onClick={() => void open(upstreamUrl)}
            >
              <ExternalLink size={14} /> 源仓库
            </button>
          )}
        </footer>
      </aside>
    </div>
  );
}

type SkillCardProps = {
  skill: SkillhubSkillSummary;
  isInstalled: boolean;
  isInstalling: boolean;
  onInstall: (skill: SkillhubSkillSummary) => void;
  onUninstall: (skill: SkillhubSkillSummary) => void;
  onOpenDetail: (skill: SkillhubSkillSummary) => void;
};

/**
 * 技能卡片。用 memo 包裹，加载下一页时已存在的卡片不会重渲染 —— 这是滚动流畅的关键。
 * 整张卡片可点击打开详情；按钮通过 stopPropagation 阻止冒泡，保持原有行为。
 */
const SkillCard = memo(function SkillCard({
  skill,
  isInstalled,
  isInstalling,
  onInstall,
  onUninstall,
  onOpenDetail,
}: SkillCardProps) {
  const meta = mapSkillToManifest(skill);
  const requiresApiKey = skill.labels?.requires_api_key === "true";
  return (
    <div
      className="plugin-card plugin-card--clickable"
      role="button"
      tabIndex={0}
      onClick={() => onOpenDetail(skill)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenDetail(skill);
        }
      }}
      aria-label={`查看 ${skill.name} 的详情`}
    >
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
            {skill.verified && (
              <BadgeCheck
                size={14}
                className="plugin-card__verified"
                aria-label="官方认证"
                strokeWidth={2.4}
              />
            )}
            <span className="plugin-card__badge">{meta.category}</span>
            {requiresApiKey && (
              <span className="skillhub-browser__api" title="需要 API Key">
                <Hash size={11} /> 需 API Key
              </span>
            )}
            <span className="plugin-card__source-tag" title="来自 SkillHub">
              SkillHub
            </span>
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
              {skill.namespace?.canonicalName && (
                <span className="plugin-card__author">{skill.namespace.canonicalName}</span>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className="plugin-card__actions" onClick={(e) => e.stopPropagation()}>
        {isInstalled ? (
          <>
            <button className="plugin-card__button plugin-card__button--installed" disabled>
              <Check size={14} /> 已安装
            </button>
            <button
              className="plugin-card__button plugin-card__button--secondary"
              onClick={() => onUninstall(skill)}
            >
              卸载
            </button>
          </>
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
  // 视图布局切换：grid（多列卡片）/ list（单列紧凑）。默认 grid。
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  // 搜索框以「开关」形式展开/收起：filter-bar 右侧的图标按钮是开关，点击展开全宽单行搜索框
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [skills, setSkills] = useState<SkillhubSkillSummary[]>([]);
  const [skillCategories, setSkillCategories] = useState<CategoryItem[]>([{ key: "", displayName: "全部" }]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [installing, setInstalling] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<SkillhubSkillSummary | null>(null);
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

  // 展开搜索框时自动 focus 输入框
  useEffect(() => {
    if (searchExpanded) {
      searchInputRef.current?.focus();
    }
  }, [searchExpanded]);

  useEffect(() => {
    refreshInstalled();
  }, [skills, refreshInstalled]);

  // 用 useCallback 稳定引用，配合 SkillCard 的 memo 才能真正避免整列表重渲染
  const handleInstall = useCallback(
    async (s: SkillhubSkillSummary) => {
      const ns = s.namespace?.canonicalName;
      setInstalling(skillUniqueKey(s));
      try {
        await installSkillhubSkill(s.slug, ns);
        // 让 install/uninstall 后 UI 状态与 pluginRegistry 完全同步
        refreshInstalled();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setInstalling(null);
      }
    },
    [refreshInstalled],
  );

  const handleUninstall = useCallback(
    async (s: SkillhubSkillSummary) => {
      const ns = s.namespace?.canonicalName;
      try {
        await uninstallSkillhubSkill(s.slug, ns);
        refreshInstalled();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refreshInstalled],
  );

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
            className={
              searchExpanded
                ? "plugin-marketplace__icon-btn plugin-marketplace__icon-btn--active"
                : "plugin-marketplace__icon-btn"
            }
            onClick={() => setSearchExpanded((v) => !v)}
            title={searchExpanded ? "收起搜索" : "展开搜索"}
            aria-label={searchExpanded ? "收起搜索" : "展开搜索"}
          >
            <Search size={16} />
          </button>

          <div className="plugin-marketplace__view-toggle" role="group" aria-label="视图布局">
            <button
              type="button"
              className={
                viewMode === "grid"
                  ? "plugin-marketplace__icon-btn plugin-marketplace__icon-btn--active"
                  : "plugin-marketplace__icon-btn"
              }
              onClick={() => setViewMode("grid")}
              title="网格视图"
              aria-label="网格视图"
              aria-pressed={viewMode === "grid"}
            >
              <LayoutGrid size={16} />
            </button>
            <button
              type="button"
              className={
                viewMode === "list"
                  ? "plugin-marketplace__icon-btn plugin-marketplace__icon-btn--active"
                  : "plugin-marketplace__icon-btn"
              }
              onClick={() => setViewMode("list")}
              title="列表视图"
              aria-label="列表视图"
              aria-pressed={viewMode === "list"}
            >
              <LayoutList size={16} />
            </button>
          </div>
        </div>
      </div>

      <div
        className={
          searchExpanded
            ? "plugin-marketplace__search skillhub-browser__search skillhub-browser__search--expanded"
            : "plugin-marketplace__search skillhub-browser__search"
        }
      >
        <Search size={15} />
        <input
          ref={searchInputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索技能名称、描述或关键词…"
        />
        {query && (
          <button
            type="button"
            className="plugin-marketplace__search-clear"
            onClick={() => setQuery("")}
            aria-label="清除搜索"
          >
            <X size={14} strokeWidth={1.8} />
          </button>
        )}
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

      <div
        ref={gridRef}
        className={
          viewMode === "list"
            ? "plugin-marketplace__grid plugin-marketplace__grid--list"
            : "plugin-marketplace__grid"
        }
        style={{ marginTop: 14 }}
      >
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
              onOpenDetail={setSelectedSkill}
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
      <SkillDetailDrawer
        skill={selectedSkill}
        onClose={() => setSelectedSkill(null)}
        isInstalled={selectedSkill ? installed.has(skillUniqueKey(selectedSkill)) : false}
        isInstalling={selectedSkill ? installing === skillUniqueKey(selectedSkill) : false}
        onInstall={handleInstall}
        onUninstall={handleUninstall}
      />
    </div>
  );
}
