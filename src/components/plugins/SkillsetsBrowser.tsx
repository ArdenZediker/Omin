/**
 * SkillHub 专家团浏览/安装面板（原 CB Teams 套件面板的替代实现）。
 *
 * 数据来自 SkillHub 官方 skillsets 接口：列表一次拿全（59 条，已含 meta-skill
 * 原文 content），详情接口额外给出子技能的精确 {slug, namespace} 映射，
 * 再由 batch 接口补齐子技能的图标/简介/下载量/安全扫描状态。
 *
 * 安装语义：卡片上的主按钮是**一键安装**（本体 meta-skill + 它引用的全部子技能，
 * 已装的不重复装）；详情抽屉里额外保留「仅装本体」与「补装引用技能」，供只想装
 * 编排包、或事后按需补子技能的人用。
 */
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  Search,
  Download,
  Check,
  Package,
  Loader2,
  AlertTriangle,
  ExternalLink,
  X,
  Tag,
  ShieldCheck,
  LayoutGrid,
  LayoutList,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-shell";
import { pluginRegistry } from "../../plugins/registry";
import {
  listSkillhubSkillsets,
  getSkillhubSkillset,
  fetchSkillsetChildren,
  installSkillhubSkillset,
  installSkillsetChildren,
  loadSkillsetChildren,
  uninstallSkillhubSkillset,
  mapSkillsetScene,
  skillsetChildId,
  type SkillhubSkillset,
  type SkillsetChildDetail,
} from "../../plugins/skillhubSkillsets";

/** 详情抽屉已懒加载好的内容：专家团详情 + 子技能元数据 + 查不到的项。 */
interface SkillsetDetailState {
  set: SkillhubSkillset;
  children: SkillsetChildDetail[];
  missing: Array<{ slug: string; namespace: string }>;
}

type SkillsetCardProps = {
  set: SkillhubSkillset;
  isInstalled: boolean;
  isInstalling: boolean;
  isUninstalling: boolean;
  /** 一键安装：套件本体 + 全部引用子技能。 */
  onInstallAll: (set: SkillhubSkillset) => void;
  onUninstall: (set: SkillhubSkillset) => void;
  onOpenDetail: (set: SkillhubSkillset) => void;
};

const SkillsetCard = memo(function SkillsetCard({
  set,
  isInstalled,
  isInstalling,
  isUninstalling,
  onInstallAll,
  onUninstall,
  onOpenDetail,
}: SkillsetCardProps) {
  return (
    <div
      className="plugin-card plugin-card--clickable"
      role="button"
      tabIndex={0}
      onClick={() => onOpenDetail(set)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenDetail(set);
        }
      }}
      aria-label={`查看 ${set.displayName} 的详情`}
    >
      <div className="plugin-card__header">
        <div className="plugin-card__icon">
          {set.iconUrl ? (
            <img src={set.iconUrl} alt="" width={20} height={20} />
          ) : (
            <Package size={18} />
          )}
        </div>
        <div className="plugin-card__main">
          <div className="plugin-card__title-row">
            <h3 title={set.displayName}>{set.displayName}</h3>
            <span className="plugin-card__badge">{mapSkillsetScene(set.scene)}</span>
          </div>
          <p className="plugin-card__description" title={set.summary}>
            {set.summary || "（暂无描述）"}
          </p>
          <div className="plugin-card__meta">
            <div className="plugin-card__meta-left">
              <span>SkillHub 专家团</span>
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
              onClick={() => onUninstall(set)}
              disabled={isUninstalling}
            >
              {isUninstalling ? <Loader2 size={14} className="spin" /> : null}
              卸载
            </button>
          </>
        ) : (
          <button
            className="plugin-card__button plugin-card__button--primary"
            title="安装专家团本体与它引用的全部子技能（已装的不重复装）"
            onClick={() => onInstallAll(set)}
            disabled={isInstalling}
          >
            {isInstalling ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
            {isInstalling ? "安装中…" : "一键安装"}
          </button>
        )}
      </div>
    </div>
  );
});

/** 详情抽屉里的一行子技能：图标 + 名称 + 简介 + 下载量 + 安全状态。 */
function ChildRow({ child }: { child: SkillsetChildDetail }) {
  const benign = child.securityStatus === "benign";
  return (
    <div className="skillset-child">
      <div className="skillset-child__icon">
        {child.iconUrl ? (
          <img src={child.iconUrl} alt="" width={22} height={22} />
        ) : (
          <Package size={14} />
        )}
      </div>
      <div className="skillset-child__main">
        <div className="skillset-child__title-row">
          <span className="skillset-child__name" title={child.displayName}>
            {child.displayName}
          </span>
          {child.version && <span className="skillset-child__version">v{child.version}</span>}
          {benign && (
            <span className="skillset-child__safe" title="安全扫描通过">
              <ShieldCheck size={12} />
            </span>
          )}
        </div>
        <p className="skillset-child__summary" title={child.summary}>
          {child.summary || "（暂无简介）"}
        </p>
      </div>
      <div className="skillset-child__meta">
        {typeof child.downloads === "number" && <span>{child.downloads} 次下载</span>}
        {child.requiresApiKey && <span className="skillset-child__warn">需 API Key</span>}
      </div>
    </div>
  );
}

/** 子技能唯一键（`namespace/slug`）—— 共用 skillhubSkillsets 的实现，勿在此另写一份。 */
const childKey = skillsetChildId;

type SkillsetDetailDrawerProps = {
  detail: SkillsetDetailState | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  isInstalled: boolean;
  isInstalling: boolean;
  isUninstalling: boolean;
  installingChildren: boolean;
  installedChildKeys: Set<string>;
  /** 一键安装：套件本体 + 全部引用子技能。 */
  onInstallAll: (set: SkillhubSkillset) => void;
  /** 仅装本体：只落地 meta-skill，子技能留给以后按需补。 */
  onInstallBodyOnly: (set: SkillhubSkillset) => void;
  onUninstall: (set: SkillhubSkillset) => void;
  onInstallChildren: (children: SkillsetChildDetail[]) => void;
};

/** 专家团详情抽屉：描述、场景、子技能列表、来源链接与安装操作。 */
function SkillsetDetailDrawer({
  detail,
  loading,
  error,
  onClose,
  isInstalled,
  isInstalling,
  isUninstalling,
  installingChildren,
  installedChildKeys,
  onInstallAll,
  onInstallBodyOnly,
  onUninstall,
  onInstallChildren,
}: SkillsetDetailDrawerProps) {
  useEffect(() => {
    if (!detail) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [detail, onClose]);

  if (!detail) return null;
  const { set, children, missing } = detail;
  const pendingChildren = children.filter((c) => !installedChildKeys.has(childKey(c)));

  return (
    <div className="skillhub-detail__overlay" onClick={onClose} role="presentation">
      <aside
        className="skillhub-detail"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`${set.displayName} 详情`}
      >
        <header className="skillhub-detail__header">
          <div className="skillhub-detail__identity">
            <div className="skillhub-detail__icon">
              {set.iconUrl ? (
                <img src={set.iconUrl} alt="" width={34} height={34} />
              ) : (
                <Package size={28} />
              )}
            </div>
            <div className="skillhub-detail__title-wrap">
              <h2>{set.displayName}</h2>
              <div className="skillhub-detail__title-row">
                <span className="plugin-card__badge">{mapSkillsetScene(set.scene)}</span>
                <span className="skillhub-detail__source">SkillHub 专家团</span>
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
          <p className="skillhub-detail__description">{set.summary || "（暂无描述）"}</p>
          {set.summaryEn && set.summaryEn !== set.summary && (
            <details className="skillhub-detail__description-en">
              <summary>查看英文原文</summary>
              <p>{set.summaryEn}</p>
            </details>
          )}

          <div className="skillhub-detail__meta-grid">
            <div className="skillhub-detail__meta-item">
              <span className="skillhub-detail__meta-label">
                <Tag size={12} /> 场景
              </span>
              <span className="skillhub-detail__meta-value">
                {mapSkillsetScene(set.scene)}
                {set.subScene ? ` / ${set.subScene}` : ""}
              </span>
            </div>
            <div className="skillhub-detail__meta-item">
              <span className="skillhub-detail__meta-label">
                <Package size={12} /> 引用技能
              </span>
              <span className="skillhub-detail__meta-value">
                {set.skillSlugs?.length ?? set.skills?.length ?? 0}
              </span>
            </div>
          </div>

          {loading && (
            <div className="skillhub-browser__status">
              <Loader2 size={16} className="spin" /> 加载子技能…
            </div>
          )}
          {error && (
            <div className="skillhub-browser__status skillhub-browser__status--error">
              <AlertTriangle size={15} /> {error}
            </div>
          )}

          {children.length > 0 && (
            <div className="skillhub-detail__tags">
              <div className="skillhub-detail__tags-label">
                <Tag size={12} /> 引用技能（可按需单独安装）
              </div>
              <div className="skillset-children">
                {children.map((c) => (
                  <ChildRow key={childKey(c)} child={c} />
                ))}
              </div>
            </div>
          )}

          {missing.length > 0 && (
            <div className="skillhub-detail__tags">
              <div className="skillhub-detail__tags-label">以下技能已下架</div>
              <div className="skillhub-detail__tag-list">
                {missing.map((m) => (
                  <span key={`${m.namespace}/${m.slug}`} className="skillhub-detail__tag">
                    {m.slug}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <footer className="skillhub-detail__footer">
          {isInstalled ? (
            <>
              <button className="plugin-card__button plugin-card__button--installed" disabled>
                <Check size={14} /> 已安装
              </button>
              <button
                className="plugin-card__button plugin-card__button--secondary"
                onClick={() => onUninstall(set)}
                disabled={isUninstalling}
              >
                {isUninstalling ? <Loader2 size={14} className="spin" /> : null}
                卸载
              </button>
            </>
          ) : (
            <>
              <button
                className="plugin-card__button plugin-card__button--primary"
                title="安装专家团本体与它引用的全部子技能（已装的不重复装）"
                onClick={() => onInstallAll(set)}
                disabled={isInstalling}
              >
                {isInstalling ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
                {isInstalling
                  ? "安装中…"
                  : children.length > 0
                    ? `一键安装（含 ${children.length} 个子技能）`
                    : "一键安装"}
              </button>
              <button
                className="plugin-card__button plugin-card__button--secondary"
                title="只装专家团本体（一条 meta-skill），子技能以后按需再补"
                onClick={() => onInstallBodyOnly(set)}
                disabled={isInstalling}
              >
                仅装本体
              </button>
            </>
          )}
          {pendingChildren.length > 0 && (
            <button
              className="plugin-card__button plugin-card__button--secondary"
              onClick={() => onInstallChildren(pendingChildren)}
              disabled={installingChildren}
              title="把上面引用的技能逐个安装到本地"
            >
              {installingChildren ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
              {installingChildren
                ? "安装中…"
                : `安装引用技能（${pendingChildren.length}）`}
            </button>
          )}
          <button
            className="plugin-card__button plugin-card__button--secondary"
            onClick={() => void open(`https://www.skillhub.cn/skillsets/${set.slug}`)}
            title="在 SkillHub 上查看"
          >
            <ExternalLink size={14} /> 来源
          </button>
        </footer>
      </aside>
    </div>
  );
}

/** 专家团浏览面板主体。 */
export default function SkillsetsBrowser() {
  const [sets, setSets] = useState<SkillhubSkillset[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  const [installingChildren, setInstallingChildren] = useState(false);
  const [detail, setDetail] = useState<SkillsetDetailState | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [installedSlugs, setInstalledSlugs] = useState<Set<string>>(new Set());

  const refreshInstalled = useCallback((list: SkillhubSkillset[]) => {
    const next = new Set<string>();
    for (const s of list) {
      if (pluginRegistry.isInstalled(s.slug)) next.add(s.slug);
    }
    setInstalledSlugs(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listSkillhubSkillsets()
      .then((list) => {
        if (cancelled) return;
        setSets(list);
        refreshInstalled(list);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshInstalled]);

  const categories = useMemo(() => {
    const seen = new Set<string>();
    for (const s of sets) seen.add(mapSkillsetScene(s.scene));
    return ["全部", ...Array.from(seen)];
  }, [sets]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sets.filter((s) => {
      if (category !== "全部" && mapSkillsetScene(s.scene) !== category) return false;
      if (!q) return true;
      return `${s.displayName} ${s.summary} ${s.scene ?? ""} ${s.subScene ?? ""}`
        .toLowerCase()
        .includes(q);
    });
  }, [sets, query, category]);

  /** 打开详情：列表接口不含子技能映射，需按 slug 拉详情再批量取子技能元数据。 */
  const handleOpenDetail = useCallback(async (set: SkillhubSkillset) => {
    setDetail({ set, children: [], missing: [] });
    setDetailLoading(true);
    setDetailError(null);
    try {
      const full = await getSkillhubSkillset(set.slug);
      const base: SkillsetDetailState = { set: full, children: [], missing: [] };
      setDetail(base);
      const pairs = full.skills ?? [];
      if (pairs.length > 0) {
        const res = await fetchSkillsetChildren(pairs);
        setDetail({ set: full, children: res.items, missing: res.missing });
      }
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  /** 仅装本体：只落地 meta-skill（一条 SKILL.md），子技能留给以后按需补。 */
  const handleInstallBodyOnly = useCallback(async (set: SkillhubSkillset) => {
    setInstalling(set.slug);
    setError(null);
    try {
      await installSkillhubSkillset(set);
      setInstalledSlugs((prev) => new Set(prev).add(set.slug));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(null);
    }
  }, []);

  /**
   * 一键安装：专家团本体 + 全部引用子技能。
   *
   * 必须先取一次详情再装子技能 —— 列表接口只给 skillSlugs，子技能的精确
   * `{slug, namespace}` 映射只在详情接口里，这一步请求省不掉。
   *
   * 子技能中已经装过的**只补归属关系、不重装**（见 installSkillsetChildren），
   * 所以重复点「一键安装」是安全的，也能把历史上散落在「我的技能」里的子技能
   * 就地收编回套件卡片。
   */
  const handleInstallAll = useCallback(async (set: SkillhubSkillset) => {
    setInstalling(set.slug);
    setError(null);
    try {
      await installSkillhubSkillset(set);
      setInstalledSlugs((prev) => new Set(prev).add(set.slug));
      const res = await loadSkillsetChildren(set.slug);
      const { failed } = await installSkillsetChildren(res.items, set.slug);
      if (failed > 0) {
        setError(`专家团已安装；${failed} 个子技能安装失败，其余已完成`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(null);
    }
  }, []);

  const handleUninstall = useCallback(async (set: SkillhubSkillset) => {
    setUninstalling(set.slug);
    setError(null);
    try {
      await uninstallSkillhubSkillset(set.slug);
      setInstalledSlugs((prev) => {
        const next = new Set(prev);
        next.delete(set.slug);
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUninstalling(null);
    }
  }, []);

  /** 补装引用的子技能（详情抽屉里的次要入口）；失败不阻断其余项。 */
  const handleInstallChildren = useCallback(
    async (children: SkillsetChildDetail[]) => {
      const slug = detail?.set.slug;
      if (!slug) return;
      setInstallingChildren(true);
      setError(null);
      const { failed } = await installSkillsetChildren(children, slug);
      if (failed > 0) {
        setError(`${failed} 个引用技能安装失败，其余已完成`);
      }
      setInstallingChildren(false);
    },
    [detail?.set.slug],
  );

  // 子技能安装态：installSkillhubSkill 注册为 `namespace/slug`，老数据可能只有
  // slug，两种都判一次。installingChildren 由 true→false 时触发重算。
  const installedChildKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const c of detail?.children ?? []) {
      const key = childKey(c);
      if (pluginRegistry.isInstalled(key) || pluginRegistry.isInstalled(c.slug)) {
        keys.add(key);
      }
    }
    return keys;
  }, [detail?.children, installingChildren]);

  return (
    <div className="skillhub-browser">
      <div className="skillhub-browser__filter-bar">
        <div className="plugin-marketplace__sort-tabs">
          {categories.map((c) => (
            <button
              key={c}
              className={
                category === c
                  ? "plugin-marketplace__sort-tab plugin-marketplace__sort-tab--active"
                  : "plugin-marketplace__sort-tab"
              }
              onClick={() => setCategory(c)}
            >
              {c}
            </button>
          ))}
        </div>

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

      <div className="plugin-marketplace__search skillhub-browser__search">
        <Search size={15} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索专家团名称、描述或场景…"
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
      {!loading && !error && filtered.length === 0 && (
        <div className="skillhub-browser__empty">未找到专家团</div>
      )}

      <div
        className={
          viewMode === "list"
            ? "plugin-marketplace__grid plugin-marketplace__grid--list"
            : "plugin-marketplace__grid"
        }
        style={{ marginTop: 14 }}
      >
        {filtered.map((s) => (
          <SkillsetCard
            key={s.slug}
            set={s}
            isInstalled={installedSlugs.has(s.slug)}
            isInstalling={installing === s.slug}
            isUninstalling={uninstalling === s.slug}
            onInstallAll={(set) => void handleInstallAll(set)}
            onUninstall={(set) => void handleUninstall(set)}
            onOpenDetail={(set) => void handleOpenDetail(set)}
          />
        ))}
      </div>

      <SkillsetDetailDrawer
        detail={detail}
        loading={detailLoading}
        error={detailError}
        onClose={() => setDetail(null)}
        isInstalled={detail ? installedSlugs.has(detail.set.slug) : false}
        isInstalling={detail ? installing === detail.set.slug : false}
        isUninstalling={detail ? uninstalling === detail.set.slug : false}
        installingChildren={installingChildren}
        installedChildKeys={installedChildKeys}
        onInstallAll={(set) => void handleInstallAll(set)}
        onInstallBodyOnly={(set) => void handleInstallBodyOnly(set)}
        onUninstall={(set) => void handleUninstall(set)}
        onInstallChildren={(children) => void handleInstallChildren(children)}
      />
    </div>
  );
}
