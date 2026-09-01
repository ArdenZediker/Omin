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
  Hash,
  Tag,
  LayoutGrid,
  LayoutList,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-shell";
import { pluginRegistry } from "../../plugins/registry";
import {
  listCbteamsSuites,
  installCbteamsSuite,
  uninstallCbteamsSuite,
  type CbteamsSuite,
} from "../../plugins/cbteams";

const SUITE_HOMEPAGE =
  "https://github.com/zhizhunbao/workbuddy/tree/main/plugins/marketplaces/cb_teams_marketplace";

type SuiteCardProps = {
  suite: CbteamsSuite;
  isInstalled: boolean;
  isInstalling: boolean;
  isUninstalling: boolean;
  onInstall: (suite: CbteamsSuite) => void;
  onUninstall: (suite: CbteamsSuite) => void;
  onOpenDetail: (suite: CbteamsSuite) => void;
};

const SuiteCard = memo(function SuiteCard({
  suite,
  isInstalled,
  isInstalling,
  isUninstalling,
  onInstall,
  onUninstall,
  onOpenDetail,
}: SuiteCardProps) {
  const description = suite.description || suite.descriptionEn;
  return (
    <div
      className="plugin-card plugin-card--clickable"
      role="button"
      tabIndex={0}
      onClick={() => onOpenDetail(suite)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenDetail(suite);
        }
      }}
      aria-label={`查看 ${suite.name} 的详情`}
    >
      <div className="plugin-card__header">
        <div className="plugin-card__icon">
          <Package size={18} />
        </div>
        <div className="plugin-card__main">
          <div className="plugin-card__title-row">
            <h3>{suite.name}</h3>
            <span className="plugin-card__badge">{suite.categoryZh}</span>
          </div>
          <p className="plugin-card__description">{description}</p>
        </div>
      </div>
      <div className="plugin-card__meta">
        <div className="plugin-card__meta-left">
          <span>技能 × {suite.skillSlugs.length || suite.skills.length}</span>
          {suite.version && <span>v{suite.version}</span>}
        </div>
        <div className="plugin-card__meta-right">
          {suite.author && <span className="plugin-card__author">{suite.author}</span>}
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
              onClick={() => onUninstall(suite)}
              disabled={isUninstalling}
            >
              {isUninstalling ? <Loader2 size={14} className="spin" /> : null}
              卸载
            </button>
          </>
        ) : (
          <button
            className="plugin-card__button plugin-card__button--primary"
            onClick={() => onInstall(suite)}
            disabled={isInstalling}
          >
            {isInstalling ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
            {isInstalling ? "安装中…" : `安装（${suite.skillSlugs.length || suite.skills.length} 个技能）`}
          </button>
        )}
      </div>
    </div>
  );
});

type SuiteDetailDrawerProps = {
  suite: CbteamsSuite | null;
  onClose: () => void;
  isInstalled: boolean;
  isInstalling: boolean;
  isUninstalling: boolean;
  onInstall: (suite: CbteamsSuite) => void;
  onUninstall: (suite: CbteamsSuite) => void;
};

/**
 * 套件详情抽屉。从右侧滑入，展示完整描述（中英文）、作者、版本、所有技能列表、来源链接。
 * 底部按钮与卡片同源联动：安装/卸载状态实时同步。Esc 与点击遮罩均可关闭。
 */
function SuiteDetailDrawer({
  suite,
  onClose,
  isInstalled,
  isInstalling,
  isUninstalling,
  onInstall,
  onUninstall,
}: SuiteDetailDrawerProps) {
  // Esc 关闭
  useEffect(() => {
    if (!suite) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [suite, onClose]);

  if (!suite) return null;

  const sourceUrl = suite.homepage || `${SUITE_HOMEPAGE}/plugins/${suite.name}`;
  const skillCount = suite.skillSlugs.length || suite.skills.length;

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
        aria-label={`${suite.name} 详情`}
      >
        <header className="skillhub-detail__header">
          <div className="skillhub-detail__identity">
            <div className="skillhub-detail__icon">
              <Package size={28} />
            </div>
            <div className="skillhub-detail__title-wrap">
              <h2>{suite.name}</h2>
              <div className="skillhub-detail__title-row">
                <span className="plugin-card__badge">{suite.categoryZh}</span>
                <span className="skillhub-detail__source">CB Teams 套件</span>
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
            {suite.description || suite.descriptionEn || "（暂无描述）"}
          </p>
          {suite.description && suite.descriptionEn && suite.description !== suite.descriptionEn && (
            <details className="skillhub-detail__description-en">
              <summary>查看英文原文</summary>
              <p>{suite.descriptionEn}</p>
            </details>
          )}

          <div className="skillhub-detail__meta-grid">
            <div className="skillhub-detail__meta-item">
              <span className="skillhub-detail__meta-label">
                <Hash size={12} /> 作者
              </span>
              <span className="skillhub-detail__meta-value">{suite.author || "—"}</span>
            </div>
            <div className="skillhub-detail__meta-item">
              <span className="skillhub-detail__meta-label">
                <Package size={12} /> 版本
              </span>
              <span className="skillhub-detail__meta-value">{suite.version || "—"}</span>
            </div>
            <div className="skillhub-detail__meta-item">
              <span className="skillhub-detail__meta-label">
                <Tag size={12} /> 分类
              </span>
              <span className="skillhub-detail__meta-value">{suite.categoryZh}</span>
            </div>
            <div className="skillhub-detail__meta-item">
              <span className="skillhub-detail__meta-label">技能数</span>
              <span className="skillhub-detail__meta-value">{skillCount}</span>
            </div>
          </div>

          {suite.skillSlugs.length > 0 && (
            <div className="skillhub-detail__tags">
              <div className="skillhub-detail__tags-label">
                <Tag size={12} /> 包含技能
              </div>
              <div className="skillhub-detail__tag-list">
                {suite.skillSlugs.map((slug) => (
                  <span key={slug} className="skillhub-detail__tag">
                    {slug}
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
                className="plugin-card__button plugin-card__button--installed"
                disabled
              >
                <Check size={14} /> 已安装
              </button>
              <button
                className="plugin-card__button plugin-card__button--secondary"
                onClick={() => onUninstall(suite)}
                disabled={isUninstalling}
              >
                {isUninstalling ? <Loader2 size={14} className="spin" /> : null}
                卸载
              </button>
            </>
          ) : (
            <button
              className="plugin-card__button plugin-card__button--primary"
              onClick={() => onInstall(suite)}
              disabled={isInstalling}
            >
              {isInstalling ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
              {isInstalling ? "安装中…" : `安装（${skillCount} 个技能）`}
            </button>
          )}
          <button
            className="plugin-card__button plugin-card__button--secondary"
            onClick={() => void open(sourceUrl)}
            title="在 GitHub 上查看"
          >
            <ExternalLink size={14} /> 源仓库
          </button>
        </footer>
      </aside>
    </div>
  );
}

/**
 * CB Teams 套件浏览/安装面板。
 * 数据来自 GitHub 仓库内的 marketplace.json（27 个套件），
 * 安装 = 整包下载仓库 zip 并落地套件内全部技能。
 */
export default function CbteamsBrowser() {
  const [suites, setSuites] = useState<CbteamsSuite[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  // 当前打开详情的套件；非空时右侧抽屉可见
  const [selectedSuite, setSelectedSuite] = useState<CbteamsSuite | null>(null);
  // 视图布局切换：grid（多列卡片）/ list（单列紧凑）。默认 grid。
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  // 安装态在本组件内维护：slug → 是否已安装（安装/卸载后刷新）
  const [installedSlugs, setInstalledSlugs] = useState<Set<string>>(new Set());

  const refreshInstalled = useCallback((list: CbteamsSuite[]) => {
    const next = new Set<string>();
    for (const s of list) {
      for (const slug of s.skillSlugs) {
        if (pluginRegistry.isInstalled(slug)) next.add(slug);
      }
    }
    setInstalledSlugs(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listCbteamsSuites()
      .then((list) => {
        if (cancelled) return;
        setSuites(list);
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
    for (const s of suites) seen.add(s.categoryZh);
    return ["全部", ...Array.from(seen)];
  }, [suites]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return suites.filter((s) => {
      if (category !== "全部" && s.categoryZh !== category) return false;
      if (!q) return true;
      return `${s.name} ${s.description} ${s.descriptionEn} ${s.categoryZh}`
        .toLowerCase()
        .includes(q);
    });
  }, [suites, query, category]);

  const isSuiteInstalled = useCallback(
    (s: CbteamsSuite) =>
      s.skillSlugs.length > 0 && s.skillSlugs.every((slug) => installedSlugs.has(slug)),
    [installedSlugs],
  );

  const handleInstall = useCallback(
    async (s: CbteamsSuite) => {
      setInstalling(s.name);
      setError(null);
      try {
        await installCbteamsSuite(s.name);
        setInstalledSlugs((prev) => {
          const next = new Set(prev);
          for (const slug of s.skillSlugs) next.add(slug);
          return next;
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setInstalling(null);
      }
    },
    [],
  );

  const handleUninstall = useCallback(
    async (s: CbteamsSuite) => {
      setUninstalling(s.name);
      setError(null);
      try {
        await uninstallCbteamsSuite(s.name, s.skillSlugs);
        setInstalledSlugs((prev) => {
          const next = new Set(prev);
          for (const slug of s.skillSlugs) next.delete(slug);
          return next;
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setUninstalling(null);
      }
    },
    [],
  );

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
          placeholder="搜索套件名称、描述或关键词…"
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
        <div className="skillhub-browser__empty">未找到套件</div>
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
          <SuiteCard
            key={s.name}
            suite={s}
            isInstalled={isSuiteInstalled(s)}
            isInstalling={installing === s.name}
            isUninstalling={uninstalling === s.name}
            onInstall={(suite) => void handleInstall(suite)}
            onUninstall={(suite) => void handleUninstall(suite)}
            onOpenDetail={setSelectedSuite}
          />
        ))}
      </div>

      <SuiteDetailDrawer
        suite={selectedSuite}
        onClose={() => setSelectedSuite(null)}
        isInstalled={selectedSuite ? isSuiteInstalled(selectedSuite) : false}
        isInstalling={selectedSuite ? installing === selectedSuite.name : false}
        isUninstalling={selectedSuite ? uninstalling === selectedSuite.name : false}
        onInstall={(suite) => void handleInstall(suite)}
        onUninstall={(suite) => void handleUninstall(suite)}
      />
    </div>
  );
}
