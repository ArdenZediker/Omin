import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  Search,
  Download,
  Check,
  Package,
  Loader2,
  AlertTriangle,
  ExternalLink,
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
};

const SuiteCard = memo(function SuiteCard({
  suite,
  isInstalled,
  isInstalling,
  isUninstalling,
  onInstall,
  onUninstall,
}: SuiteCardProps) {
  const description = suite.description || suite.descriptionEn;
  return (
    <div className="plugin-card">
      <div className="plugin-card__header">
        <div className="plugin-card__icon">
          <Package size={18} />
        </div>
        <div className="plugin-card__main">
          <div className="plugin-card__title-row">
            <h3>{suite.name}</h3>
            <span className="plugin-card__badge">{suite.categoryZh}</span>
          </div>
        </div>
      </div>
      <p className="plugin-card__description">{description}</p>
      <div className="plugin-card__meta">
        <div className="plugin-card__meta-left">
          <span>技能 × {suite.skillSlugs.length || suite.skills.length}</span>
          {suite.version && <span>v{suite.version}</span>}
        </div>
        <div className="plugin-card__meta-right">
          {suite.author && <span className="plugin-card__author">{suite.author}</span>}
        </div>
      </div>
      <div className="plugin-card__actions">
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
        <button
          className="plugin-card__button plugin-card__button--secondary"
          onClick={() => void open(suite.homepage || `${SUITE_HOMEPAGE}/plugins/${suite.name}`)}
          title="在 GitHub 上查看"
        >
          <ExternalLink size={14} /> 来源
        </button>
      </div>
    </div>
  );
});

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

      <div className="plugin-marketplace__grid" style={{ marginTop: 14 }}>
        {filtered.map((s) => (
          <SuiteCard
            key={s.name}
            suite={s}
            isInstalled={isSuiteInstalled(s)}
            isInstalling={installing === s.name}
            isUninstalling={uninstalling === s.name}
            onInstall={(suite) => void handleInstall(suite)}
            onUninstall={(suite) => void handleUninstall(suite)}
          />
        ))}
      </div>
    </div>
  );
}
