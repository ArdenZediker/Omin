import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  Search,
  Download,
  Check,
  Cable,
  Loader2,
  AlertTriangle,
  ExternalLink,
  Info,
  LayoutGrid,
  LayoutList,
  X,
  Package,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-shell";
import { pluginRegistry } from "../../plugins/registry";
import {
  listConnectorhubSkills,
  installConnectorhubSkill,
  uninstallConnectorhubSkill,
  type ConnectorhubSkill,
} from "../../plugins/connectorhub";

const CONNECTOR_HOMEPAGE =
  "https://github.com/zhizhunbao/workbuddy/tree/main/skills-marketplace/skills";

type ConnectorCardProps = {
  skill: ConnectorhubSkill;
  isInstalled: boolean;
  isInstalling: boolean;
  isUninstalling: boolean;
  onInstall: (skill: ConnectorhubSkill) => void;
  onUninstall: (skill: ConnectorhubSkill) => void;
  onOpenDetail: (skill: ConnectorhubSkill) => void;
};

const ConnectorCard = memo(function ConnectorCard({
  skill,
  isInstalled,
  isInstalling,
  isUninstalling,
  onInstall,
  onUninstall,
  onOpenDetail,
}: ConnectorCardProps) {
  const description = skill.descriptionZh || skill.description;
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
      aria-label={`查看 ${skill.displayName} 的详情`}
    >
      <div className="plugin-card__header">
        <div className="plugin-card__icon">
          <Cable size={18} />
        </div>
        <div className="plugin-card__main">
          <div className="plugin-card__title-row">
            <h3>{skill.displayName}</h3>
            <span className="plugin-card__badge">连接器</span>
          </div>
        </div>
      </div>
      <p className="plugin-card__description">{description}</p>
      {isInstalled && (
        <p className="connectorhub-browser__hint">
          <Info size={12} strokeWidth={1.8} />
          已安装 — 请到「本地连接器」中配置启动命令并连接
        </p>
      )}
      <div className="plugin-card__meta">
        <div className="plugin-card__meta-left">
          <span>{skill.category}</span>
          <span>· {skill.source}</span>
          {skill.version && <span>· v{skill.version}</span>}
        </div>
        <div className="plugin-card__meta-right" />
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
              disabled={isUninstalling}
            >
              {isUninstalling ? <Loader2 size={14} className="spin" /> : null}
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
        {/* 来源按钮保留：列表模式下与「安装」按钮等宽对齐（min-width） */}
        <button
          className="plugin-card__button plugin-card__button--secondary"
          onClick={() => void open(`${CONNECTOR_HOMEPAGE}/${skill.source}`)}
          title="在 GitHub 上查看"
        >
          <ExternalLink size={14} /> 来源
        </button>
      </div>
    </div>
  );
});

type ConnectorDetailDrawerProps = {
  skill: ConnectorhubSkill | null;
  onClose: () => void;
  isInstalled: boolean;
  isInstalling: boolean;
  isUninstalling: boolean;
  onInstall: (skill: ConnectorhubSkill) => void;
  onUninstall: (skill: ConnectorhubSkill) => void;
};

/**
 * 连接器详情抽屉。从右侧滑入，展示完整描述、版本、来源（GitHub）链接。
 * 底部按钮与卡片同源联动：安装/卸载状态实时同步。Esc 与点击遮罩均可关闭。
 * 卡片上的「来源」按钮与本抽屉的「GitHub 源仓库」按钮并存，前者快速直达，后者带完整描述上下文。
 */
function ConnectorDetailDrawer({
  skill,
  onClose,
  isInstalled,
  isInstalling,
  isUninstalling,
  onInstall,
  onUninstall,
}: ConnectorDetailDrawerProps) {
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

  const sourceUrl = `${CONNECTOR_HOMEPAGE}/${skill.source}`;

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
        aria-label={`${skill.displayName} 详情`}
      >
        <header className="skillhub-detail__header">
          <div className="skillhub-detail__identity">
            <div className="skillhub-detail__icon">
              <Cable size={28} />
            </div>
            <div className="skillhub-detail__title-wrap">
              <h2>{skill.displayName}</h2>
              <div className="skillhub-detail__title-row">
                <span className="plugin-card__badge">{skill.category}</span>
                <span className="skillhub-detail__source">外部连接器</span>
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
            {skill.descriptionZh || skill.description || "（暂无描述）"}
          </p>
          {skill.descriptionZh && skill.description && skill.descriptionZh !== skill.description && (
            <details className="skillhub-detail__description-en">
              <summary>查看英文原文</summary>
              <p>{skill.description}</p>
            </details>
          )}

          <div className="skillhub-detail__meta-grid">
            <div className="skillhub-detail__meta-item">
              <span className="skillhub-detail__meta-label">
                <Package size={12} /> 标识
              </span>
              <span className="skillhub-detail__meta-value">{skill.name}</span>
            </div>
            <div className="skillhub-detail__meta-item">
              <span className="skillhub-detail__meta-label">
                <Package size={12} /> 版本
              </span>
              <span className="skillhub-detail__meta-value">{skill.version || "—"}</span>
            </div>
            <div className="skillhub-detail__meta-item">
              <span className="skillhub-detail__meta-label">
                <Package size={12} /> 分类
              </span>
              <span className="skillhub-detail__meta-value">{skill.category}</span>
            </div>
            <div className="skillhub-detail__meta-item">
              <span className="skillhub-detail__meta-label">
                <Package size={12} /> 来源
              </span>
              <span className="skillhub-detail__meta-value">{skill.source}</span>
            </div>
          </div>
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
                disabled={isUninstalling}
              >
                {isUninstalling ? <Loader2 size={14} className="spin" /> : null}
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
              {isInstalling ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
              {isInstalling ? "安装中…" : "安装"}
            </button>
          )}
          <button
            type="button"
            className="plugin-card__button plugin-card__button--secondary"
            onClick={() => void open(sourceUrl)}
          >
            <ExternalLink size={14} /> GitHub 源仓库
          </button>
        </footer>
      </aside>
    </div>
  );
}

/**
 * 外部服务接入型技能浏览面板（WorkBuddy 技能库）。
 * 数据来自 GitHub 仓库内的 skills-marketplace marketplace.json，
 * 前端按白名单过滤出「接入型」技能作为连接器展示；安装 = 整包下载
 * 仓库 zip 并落地该技能子树到本地技能目录。
 */
export default function ConnectorhubBrowser() {
  const [skills, setSkills] = useState<ConnectorhubSkill[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  // 视图布局切换：grid（多列卡片）/ list（单列紧凑）。默认 grid。
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  // 安装态在本组件内维护：source → 是否已安装（安装/卸载后刷新）
  const [installedSources, setInstalledSources] = useState<Set<string>>(new Set());
  const [selectedSkill, setSelectedSkill] = useState<ConnectorhubSkill | null>(null);

  const refreshInstalled = useCallback((list: ConnectorhubSkill[]) => {
    const next = new Set<string>();
    for (const s of list) {
      if (pluginRegistry.isInstalled(s.source)) next.add(s.source);
    }
    setInstalledSources(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listConnectorhubSkills()
      .then((list) => {
        if (cancelled) return;
        setSkills(list);
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
    for (const s of skills) seen.add(s.category);
    return ["全部", ...Array.from(seen)];
  }, [skills]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills.filter((s) => {
      if (category !== "全部" && s.category !== category) return false;
      if (!q) return true;
      return `${s.displayName} ${s.name} ${s.source} ${s.description} ${s.descriptionZh}`
        .toLowerCase()
        .includes(q);
    });
  }, [skills, query, category]);

  const handleInstall = useCallback(async (s: ConnectorhubSkill) => {
    setInstalling(s.source);
    setError(null);
    try {
      await installConnectorhubSkill(s.source);
      setInstalledSources((prev) => new Set(prev).add(s.source));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(null);
    }
  }, []);

  const handleUninstall = useCallback(async (s: ConnectorhubSkill) => {
    setUninstalling(s.source);
    setError(null);
    try {
      await uninstallConnectorhubSkill(s.source);
      setInstalledSources((prev) => {
        const next = new Set(prev);
        next.delete(s.source);
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUninstalling(null);
    }
  }, []);

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
          placeholder="搜索连接器名称、来源或描述…"
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
        <div className="skillhub-browser__empty">
          未找到外部服务接入型连接器
        </div>
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
          <ConnectorCard
            key={s.source}
            skill={s}
            isInstalled={installedSources.has(s.source)}
            isInstalling={installing === s.source}
            isUninstalling={uninstalling === s.source}
            onInstall={(skill) => void handleInstall(skill)}
            onUninstall={(skill) => void handleUninstall(skill)}
            onOpenDetail={setSelectedSkill}
          />
        ))}
      </div>
      <ConnectorDetailDrawer
        skill={selectedSkill}
        onClose={() => setSelectedSkill(null)}
        isInstalled={selectedSkill ? installedSources.has(selectedSkill.source) : false}
        isInstalling={selectedSkill ? installing === selectedSkill.source : false}
        isUninstalling={selectedSkill ? uninstalling === selectedSkill.source : false}
        onInstall={handleInstall}
        onUninstall={handleUninstall}
      />
    </div>
  );
}
