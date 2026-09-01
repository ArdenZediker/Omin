/**
 * 「我的技能」里已安装专家团的套件卡片。
 *
 * 与普通技能卡片的区别（用户要求的「一套展示」）：
 *   - 带「套件」徽标，默认收起，点击可展开；
 *   - 展开后懒加载 SkillHub 详情 + batch 子技能元数据，列出引用的子技能：
 *     已装的打勾，未装的给单装按钮，底部提供一键补装与卸载整套；
 *   - 启用开关沿用普通技能的 OmniSwitch 行为。
 *
 * 识别依据：installSkillhubSkillset 注册时 source.repository = `skillset/<slug>`。
 */
import { memo, useCallback, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  Package,
  ShieldCheck,
  AlertTriangle,
} from "lucide-react";
import { pluginRegistry } from "../../plugins/registry";
import { installSkillhubSkill } from "../../plugins/skillhub";
import {
  uninstallSkillhubSkillset,
  getSkillhubSkillset,
  fetchSkillsetChildren,
  type SkillsetChildDetail,
} from "../../plugins/skillhubSkillsets";
import type { PluginManifest } from "../../plugins/types";
import OmniSwitch from "../ui/OmniSwitch";

/**
 * 收集已安装专家团：id → skillset slug。
 * installSkillhubSkillset 注册时 source = { type: "marketplace", repository: "skillset/<slug>" }。
 */
export function collectSkillsetSlugs(): Map<string, string> {
  const map = new Map<string, string>();
  for (const { id, entry } of pluginRegistry.listInstalled()) {
    if (
      entry.source.type === "marketplace" &&
      entry.source.repository.startsWith("skillset/")
    ) {
      const slug = entry.source.repository.slice("skillset/".length);
      if (slug) map.set(id, slug);
    }
  }
  return map;
}

/** 子技能唯一键：与 installSkillhubSkill 注册的 `namespace/slug` 对齐。 */
function childKey(c: SkillsetChildDetail): string {
  return c.namespace ? `${c.namespace}/${c.slug}` : c.slug;
}

type InstalledSkillsetCardProps = {
  manifest: PluginManifest;
  slug: string;
  enabled: boolean;
  isBuiltin: boolean;
  onToggleEnabled: (next: boolean) => void;
  /** 子技能安装/整套卸载后通知父级刷新（refreshKey）。 */
  onChanged: () => void;
};

function InstalledSkillsetCardImpl({
  manifest,
  slug,
  enabled,
  isBuiltin,
  onToggleEnabled,
  onChanged,
}: InstalledSkillsetCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [children, setChildren] = useState<SkillsetChildDetail[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [installingChild, setInstallingChild] = useState<string | null>(null);
  const [installingAll, setInstallingAll] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      if (next && !loaded && !loading) {
        setLoading(true);
        setError(null);
        getSkillhubSkillset(slug)
          .then((full) => {
            const pairs = full.skills ?? [];
            if (pairs.length === 0) {
              setChildren([]);
              setLoaded(true);
              return undefined;
            }
            return fetchSkillsetChildren(pairs).then((res) => {
              setChildren(res.items);
              if (res.missing.length > 0) {
                setError(`${res.missing.length} 个引用技能已下架，无法获取`);
              }
              setLoaded(true);
            });
          })
          .catch((e) => {
            setError(e instanceof Error ? e.message : String(e));
            setLoaded(true);
          })
          .finally(() => setLoading(false));
      }
      return next;
    });
  }, [slug, loaded, loading]);

  /** 单装一个子技能；失败静默收集，不阻断其余项。 */
  const installChild = useCallback(
    async (child: SkillsetChildDetail) => {
      setInstallingChild(childKey(child));
      setError(null);
      try {
        await installSkillhubSkill(child.slug, child.namespace, {
          slug: child.slug,
          name: child.displayName ?? child.slug,
          description: child.summary ?? "",
          iconUrl: child.iconUrl,
          ownerName: child.ownerName,
          category: child.category,
          namespace: child.canonicalName
            ? { canonicalName: child.canonicalName, displayName: child.namespace }
            : undefined,
        });
        onChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setInstallingChild(null);
      }
    },
    [onChanged],
  );

  const installPendingChildren = useCallback(async () => {
    setInstallingAll(true);
    setError(null);
    let failed = 0;
    for (const child of children) {
      const key = childKey(child);
      if (pluginRegistry.isInstalled(key) || pluginRegistry.isInstalled(child.slug)) {
        continue;
      }
      try {
        await installSkillhubSkill(child.slug, child.namespace, {
          slug: child.slug,
          name: child.displayName ?? child.slug,
          description: child.summary ?? "",
          iconUrl: child.iconUrl,
          ownerName: child.ownerName,
          category: child.category,
          namespace: child.canonicalName
            ? { canonicalName: child.canonicalName, displayName: child.namespace }
            : undefined,
        });
      } catch {
        failed += 1;
      }
    }
    if (failed > 0) setError(`${failed} 个引用技能安装失败，其余已完成`);
    setInstallingAll(false);
    onChanged();
  }, [children, onChanged]);

  const handleUninstall = useCallback(async () => {
    setUninstalling(true);
    setError(null);
    try {
      await uninstallSkillhubSkillset(slug);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setUninstalling(false);
    }
  }, [slug, onChanged]);

  const pendingCount = children.filter(
    (c) =>
      !pluginRegistry.isInstalled(childKey(c)) &&
      !pluginRegistry.isInstalled(c.slug),
  ).length;

  return (
    <div
      className={`plugin-card plugin-card--skillset ${enabled || isBuiltin ? "" : "plugin-card--disabled"}`.trim()}
    >
      <div
        className="plugin-card__header"
        role="button"
        tabIndex={0}
        onClick={toggleExpanded}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleExpanded();
          }
        }}
        aria-expanded={expanded}
        aria-label={`${expanded ? "收起" : "展开"} ${manifest.name} 的子技能`}
      >
        <div className="plugin-card__icon">
          <Package size={18} />
        </div>
        <div className="plugin-card__main">
          <div className="plugin-card__title-row">
            <h3 title={manifest.name}>{manifest.name}</h3>
            <span className="plugin-card__badge plugin-card__badge--skillset">套件</span>
            {manifest.category && (
              <span className="plugin-card__badge">{manifest.category}</span>
            )}
          </div>
          <p className="plugin-card__description" title={manifest.description}>
            {manifest.description || "（暂无描述）"}
          </p>
          <div className="plugin-card__meta">
            <div className="plugin-card__meta-left">
              <span>SkillHub 专家团</span>
              {loaded && children.length > 0 && <span>· {children.length} 个子技能</span>}
            </div>
          </div>
        </div>
        <span className="skillset-owned__chevron" aria-hidden="true">
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </div>

      {expanded && (
        <div className="skillset-owned__body" onClick={(e) => e.stopPropagation()}>
          {loading && (
            <div className="skillhub-browser__status">
              <Loader2 size={14} className="spin" /> 加载子技能…
            </div>
          )}
          {error && (
            <div className="skillhub-browser__status skillhub-browser__status--error">
              <AlertTriangle size={14} /> {error}
            </div>
          )}
          {loaded && children.length === 0 && !error && (
            <div className="skillhub-browser__status">该套件没有引用子技能</div>
          )}
          {children.map((child) => {
            const installed =
              pluginRegistry.isInstalled(childKey(child)) ||
              pluginRegistry.isInstalled(child.slug);
            return (
              <div className="skillset-child" key={childKey(child)}>
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
                    {child.version && (
                      <span className="skillset-child__version">v{child.version}</span>
                    )}
                    {child.securityStatus === "benign" && (
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
                  {installed ? (
                    <span className="skillset-child__installed">
                      <Check size={12} /> 已装
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="plugin-card__button plugin-card__button--secondary"
                      disabled={installingChild === childKey(child)}
                      onClick={() => void installChild(child)}
                    >
                      {installingChild === childKey(child) ? (
                        <Loader2 size={12} className="spin" />
                      ) : (
                        <Download size={12} />
                      )}
                      安装
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          <div className="skillset-owned__footer">
            {pendingCount > 0 && (
              <button
                type="button"
                className="plugin-card__button plugin-card__button--secondary"
                disabled={installingAll}
                onClick={() => void installPendingChildren()}
              >
                {installingAll ? (
                  <Loader2 size={12} className="spin" />
                ) : (
                  <Download size={12} />
                )}
                {installingAll ? "安装中…" : `补装未装技能（${pendingCount}）`}
              </button>
            )}
            <button
              type="button"
              className="plugin-card__button plugin-card__button--secondary"
              disabled={uninstalling}
              onClick={() => void handleUninstall()}
            >
              {uninstalling ? <Loader2 size={12} className="spin" /> : null}
              卸载整套
            </button>
          </div>
        </div>
      )}

      <div className="plugin-card__actions" onClick={(e) => e.stopPropagation()}>
        <div
          className="plugin-card__enable"
          title={isBuiltin ? "内置项始终启用，不可关闭" : enabled ? "点击关闭" : "点击开启"}
        >
          <OmniSwitch checked={enabled} disabled={isBuiltin} onChange={onToggleEnabled} />
        </div>
      </div>
    </div>
  );
}

const InstalledSkillsetCard = memo(InstalledSkillsetCardImpl);
export default InstalledSkillsetCard;
