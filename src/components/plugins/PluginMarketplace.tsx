import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  X,
  Search,
  Download,
  Check,
  Star,
  Puzzle,
  Bot,
  Cable,
  Wand2,
  LayoutTemplate,
  Settings,
  Loader2,
  Package,
  PlugZap,
  Unplug,
  Plus,
  Pencil,
  AlertTriangle,
  Trash2,
  Hash,
  LayoutGrid,
  LayoutList,
  Eye,
  Power,
  PowerOff,
  ShieldCheck,
  ShieldAlert,
  Terminal,
  Globe,
} from "lucide-react";
import { pluginRegistry } from "../../plugins/registry";
import {
  ensureMcpConnector,
  disconnectMcpConnector,
  listConnectedMcpServers,
  listMcpTools,
  isConnectorTrusted,
  setConnectorTrusted,
  getMcpTrustInfo,
  parseMcpJson,
} from "../../plugins/mcp";
import type { McpToolInfo } from "../../plugins/mcp";
import { PLUGIN_CATEGORIES } from "../../plugins/builtins";
import {
  listSkillhubSkills,
  mapSkillhubCategory,
} from "../../plugins/skillhub";
import type {
  PluginFilter,
  PluginKind,
  PluginManifest,
} from "../../plugins/types";
import SkillhubBrowser from "./SkillhubBrowser";
import SkillsetsBrowser from "./SkillsetsBrowser";
import InstalledSkillsetCard, {
  collectSkillsetChildIds,
  collectSkillsetSlugs,
} from "./InstalledSkillsetCard";
import ConnectorhubBrowser from "./ConnectorhubBrowser";
import { getMcpCommandTemplate } from "../../plugins/connectorhub";
import { uninstallSkillhubSkill } from "../../plugins/skillhub";
import { repairSkillsetChildLinks } from "../../plugins/skillhubSkillsets";
import OmniSwitch from "../ui/OmniSwitch";

type PluginMarketplaceProps = {
  initialFilter?: Omit<PluginFilter, "kind"> & { kind?: PluginKind };
  onPick?: (manifest: PluginManifest) => void;
  onClose: () => void;
  embedded?: boolean;
  mainView?: boolean;
  /** 「创建专家」入口：点击后由宿主打开创建对话框。 */
  onCreateExpert?: () => void;
  /** 「编辑专家」入口：点击后由宿主打开编辑对话框（传入待编辑 manifest）。 */
  onEditExpert?: (manifest: PluginManifest) => void;
  /** 「新增 MCP」入口：连接器 tab 页面内会渲染新增按钮，点击回调。 */
  onAddMcp?: () => void;
  /** Marketplace 数据源（local/skillhub/...）。传入即受控；省略则用内部默认行为（=未推荐）。
   *  受控时父组件需同步保存 state，组件内部按 `kind` 自动同步 source 的逻辑也会
   *  改为通过 `onSourceChange` 回写，避免双 state 不同步。 */
  source?: MarketplaceSource;
  onSourceChange?: (next: MarketplaceSource) => void;
  /** 主视图（mainView）默认会折叠自身的 source-tabs 到顶部 toolbar——重复渲染两份
   *  即上方蓝框 vs 顶部 chrome 都出现同一组控件。本 prop = true 时 Marketplace
   *  不渲染自己的 source-tabs 块，由调用方（如 MainChatView）负责顶部渲染。
   *  第三方用（CreateProjectDialog 等）保持默认 false，自身渲染。 */
  omitTopTabs?: boolean;
};

/** Marketplace 二级数据源（在「一级 kind」之下的二级切换）。
 *  - skill     → local = "我的技能"，skillhub = "SkillHub 实时"，suites = "专家团"，connectors = "远程技能"
 *  - connector → local = "我的连接器"（仅 MCP；原远程接入市场已并入「我的技能」的「远程技能」tab）
 *  - expert    → my = "我的专家"，local = "本地内置"
 *  - tool/template → 只能 local */
export type MarketplaceSource =
  | "local"
  | "skillhub"
  | "suites"
  | "connectors"
  | "my";

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

/** 内置工具在 Marketplace 中的功能分组展示顺序。 */
const TOOL_GROUP_ORDER = [
  "文件",
  "会话",
  "档案",
  "Git",
  "导出",
  "联网",
  "插件安装",
];

/** 渲染一个 PluginManifest 的图标：
 * - `manifest.icon` 是 URL（http/https/data/blob/file 或 web 根路径）→ `<img>`
 * - 单个非 ASCII 字符（emoji） → 原样文本
 * - 其余（Lucide 名称或缺失）→ 按 `kind` 兜底
 */
function renderPluginIcon(manifest: PluginManifest) {
  const iconValue = manifest.icon?.trim();
  if (iconValue) {
    if (
      /^(https?:|data:|blob:|file:)/i.test(iconValue) ||
      iconValue.startsWith("/")
    ) {
      return (
        <img
          src={iconValue}
          alt=""
          className="plugin-card__icon-img"
          loading="lazy"
        />
      );
    }
    // 单字符 emoji（不全是 ASCII 字母/数字/下划线/点）
    if (iconValue.length <= 2 && /[^\x00-\x7F]/.test(iconValue)) {
      return (
        <span className="plugin-card__icon-emoji" aria-hidden>
          {iconValue}
        </span>
      );
    }
  }
  const Icon = ICON_MAP[manifest.kind] ?? Puzzle;
  return <Icon size={22} strokeWidth={1.7} />;
}

/** 通用插件详情抽屉。复用 .skillhub-detail* 样式（从右滑入、半透明遮罩、Esc 关闭），
 *  显示基础元数据 + body + 标签，底部按安装状态切换按钮。
 * skill / tool / connector / expert / template 都可用。 */
function PluginDetailDrawer({
  manifest,
  isInstalled,
  isBuiltin,
  onClose,
  onInstall,
  onUninstall,
}: {
  manifest: PluginManifest | null;
  isInstalled: boolean;
  isBuiltin: boolean;
  onClose: () => void;
  onInstall: (m: PluginManifest) => void;
  onUninstall: (m: PluginManifest) => void;
}) {
  useEffect(() => {
    if (!manifest) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [manifest, onClose]);

  if (!manifest) return null;

  const description =
    manifest.description ||
    (manifest.body ? manifest.body.split("\n")[0] : "（暂无描述）");
  const sourceUrl = manifest.sourceUrl ?? "";

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
        aria-label={`${manifest.name} 详情`}
      >
        <header className="skillhub-detail__header">
          <div className="skillhub-detail__identity">
            <div className="skillhub-detail__icon">
              {renderPluginIcon(manifest)}
            </div>
            <div className="skillhub-detail__title-wrap">
              <h2>{manifest.name}</h2>
              <div className="skillhub-detail__title-row">
                <span className="plugin-card__badge">{manifest.kind}</span>
                {manifest.category && (
                  <span className="skillhub-detail__source">
                    {manifest.category}
                  </span>
                )}
                {isBuiltin && (
                  <span className="skillhub-detail__source">内置</span>
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
          <p className="skillhub-detail__description">{description}</p>

          <div className="skillhub-detail__meta-grid">
            <div className="skillhub-detail__meta-item">
              <span className="skillhub-detail__meta-label">
                <Hash size={12} /> 作者
              </span>
              <span className="skillhub-detail__meta-value">
                {manifest.author ?? "Omni"}
              </span>
            </div>
            {!isBuiltin && (
              <div className="skillhub-detail__meta-item">
                <span className="skillhub-detail__meta-label">
                  <Package size={12} /> 版本
                </span>
                <span className="skillhub-detail__meta-value">
                  v{manifest.version}
                </span>
              </div>
            )}
            <div className="skillhub-detail__meta-item">
              <span className="skillhub-detail__meta-label">分类</span>
              <span className="skillhub-detail__meta-value">
                {manifest.category ?? "其他"}
              </span>
            </div>
            <div className="skillhub-detail__meta-item">
              <span className="skillhub-detail__meta-label">ID</span>
              <span className="skillhub-detail__meta-value">{manifest.id}</span>
            </div>
            <div className="skillhub-detail__meta-item">
              <span className="skillhub-detail__meta-label">命令</span>
              <span className="skillhub-detail__meta-value">
                <code>{manifest.command ?? "/"}</code>
              </span>
            </div>
            <div className="skillhub-detail__meta-item">
              <span className="skillhub-detail__meta-label">来源</span>
              <span className="skillhub-detail__meta-value">
                {sourceUrl ? (
                  <a
                    href={sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    打开
                  </a>
                ) : (
                  "Omni 本地"
                )}
              </span>
            </div>
          </div>

          {manifest.tags && manifest.tags.length > 0 && (
            <div className="skillhub-detail__tags">
              <div className="skillhub-detail__tags-label">标签</div>
              <div className="skillhub-detail__tag-list">
                {manifest.tags.map((tag) => (
                  <span key={tag} className="skillhub-detail__tag">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}

          {manifest.body && manifest.body !== description && (
            <details className="skillhub-detail__description-en">
              <summary>查看正文（systemPrompt）</summary>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  fontFamily: "inherit",
                  fontSize: "12px",
                  lineHeight: 1.55,
                }}
              >
                {manifest.body}
              </pre>
            </details>
          )}
        </div>

        <footer className="skillhub-detail__footer">
          {isInstalled && !isBuiltin ? (
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
                className="plugin-card__button plugin-card__button--danger"
                onClick={() => onUninstall(manifest)}
              >
                <Trash2 size={14} strokeWidth={1.8} />
                卸载
              </button>
            </>
          ) : isInstalled ? (
            <button
              type="button"
              className="plugin-card__button plugin-card__button--installed"
              disabled
            >
              <Check size={14} /> 已安装（内置）
            </button>
          ) : (
            <button
              type="button"
              className="plugin-card__button plugin-card__button--primary"
              onClick={() => onInstall(manifest)}
            >
              <Download size={14} strokeWidth={1.8} />
              安装
            </button>
          )}
          <button
            type="button"
            className="plugin-card__button plugin-card__button--secondary"
            onClick={onClose}
          >
            关闭
          </button>
        </footer>
      </aside>
    </div>
  );
}

export default function PluginMarketplace({
  initialFilter = {},
  onPick,
  onClose,
  embedded = false,
  mainView = false,
  onCreateExpert,
  onEditExpert,
  onAddMcp,
  source: controlledSource,
  onSourceChange,
  omitTopTabs = false,
}: PluginMarketplaceProps) {
  const [query, setQuery] = useState(initialFilter.query ?? "");
  // 搜索框以「开关」形式展开/收起：mainView 顶部为折叠图标，点击展开全宽单行搜索框。
  // 「我的技能」tab 下默认展开（placeholder「搜索已安装的技能」必须可见以引导批量管理）。
  const [searchExpanded, setSearchExpanded] = useState(!mainView);
  // 本地主视图（mainView）下卡片布局：默认 grid（多列平铺卡片，全应用统一）。
  // 用户可切到 list（一行一张，按钮在右侧）。三个浏览器自己管理 viewMode，默认值同为 grid。
  // 约定：任何带视图切换的列表页默认一律走 grid，保证跨页面视觉一致。
  const [localViewMode, setLocalViewMode] = useState<"grid" | "list">("grid");
  // 不设「全部」混合列表：一级分类必须具体，默认落在技能（SkillHub）。
  // 「工具」tab 已从扩展中心移除（内置工具始终暴露，无需在此管理）。
  const [kind, setKind] = useState<PluginKind>(
    initialFilter.kind === "tool" ? "skill" : (initialFilter.kind ?? "skill"),
  );
  const [category, setCategory] = useState(initialFilter.category ?? "全部");
  // source 受控 ↔ 非受控：当 parent 传入 `source` 时即走受控模式，所有写入通过
  // `onSourceChange` 回写父组件；不传则保留未受控默认行为，内部 `useEffect([kind])`
  // 会自动把 source 重置到该 kind 的默认视图。
  const isSourceControlled = controlledSource !== undefined;
  const [internalSource, setInternalSource] = useState<MarketplaceSource>(
    initialFilter.kind === "skill"
      ? "skillhub"
      : initialFilter.kind === "connector"
        ? "connectors"
        : initialFilter.kind === "expert"
          ? "my"
          : "local",
  );
  const source: MarketplaceSource = isSourceControlled
    ? (controlledSource as MarketplaceSource)
    : internalSource;
  const setSource = useCallback(
    (next: MarketplaceSource) => {
      if (isSourceControlled) {
        onSourceChange?.(next);
      } else {
        setInternalSource(next);
      }
    },
    [isSourceControlled, onSourceChange],
  );
  const [refreshKey, setRefreshKey] = useState(0);
  // 注册表一变更就重算：安装/卸载可能发生在**本组件之外**（SkillHub 子面板、
  // 远程技能子面板、技能创作、对话里模型调用 /install_skill），这些路径收不到
  // 本组件的任何回调 —— 只靠自身 handler bump 刷新键会漏，表现为「已安装
  // 但「我的技能」里看不见」（切 tab 也不会重算：source 不在各 useMemo 的依赖里）。
  // 订阅注册表是唯一不漏的口径。
  useEffect(
    () => pluginRegistry.subscribe(() => setRefreshKey((current) => current + 1)),
    [],
  );
  const [configuringId, setConfiguringId] = useState<string | null>(null);
  const [configDraft, setConfigDraft] = useState<Record<string, string>>({});
  // 详情抽屉选中（点击整卡打开）。onPick 模式下用 onPick 选择，不打开详情。
  const [detailManifest, setDetailManifest] = useState<PluginManifest | null>(
    null,
  );
  // MCP 型连接器（无 provider 的 connector）启动配置草稿（统一 JSON 输入）
  const [mcpDraft, setMcpDraft] = useState("");
  const [mcpDraftError, setMcpDraftError] = useState<string | null>(null);
  // 配置面板的连接模式分段（仅视觉：Remote = http / Stdio = 子进程）。
  // 点击切换会把草稿换成对应模式的空骨架，底层仍是 JSON，不改变解析链路。
  const [mcpMode, setMcpMode] = useState<"stdio" | "http">("stdio");
  // 当前已连接的 MCP 服务器（内存态，来自 mcp.ts）
  const [connectedList, setConnectedList] = useState(() =>
    listConnectedMcpServers(),
  );
  // 连接失败的错误提示（卡片上展示）
  const [mcpError, setMcpError] = useState<{
    connectorId: string;
    message: string;
  } | null>(null);
  // 正在拉起中的连接器 id。
  // 拉起要 spawn 子进程 / 走完整 HTTP 握手（initialize + tools/list），慢的时候数秒无反馈，
  // 用户会以为按钮没点上而反复点 —— 因此必须有「连接中」中间态把按钮锁住。
  // 用 id 而不是布尔值：列表里同时只可能有一个连接在飞，但卡片是复用的，
  // 布尔值会让所有卡片一起变灰。
  const [mcpConnectingId, setMcpConnectingId] = useState<string | null>(null);
  // 信任门：待用户确认信任的 MCP 连接器（WorkBuddy 式「配置完不自动激活」）
  const [trustPromptId, setTrustPromptId] = useState<string | null>(null);
  // 一级分类切换时联动来源：技能 → SkillHub，连接器 → 远程连接器，专家 → 我的专家，其他 → 本地。
  // 受控模式下 source 由父组件持有，本组件只读不写，kind 变化后的联动也由父组件
  // （MainChatView）监听 `kind` 调 onSourceChange 完成；这里保留非受控分支保
  // CreateProjectDialog 等调用方的向后兼容。
  useEffect(() => {
    if (isSourceControlled) return;
    setInternalSource(
      kind === "skill"
        ? "skillhub"
        : kind === "connector"
          ? "connectors"
          : kind === "expert"
            ? "my"
            : "local",
    );
  }, [kind, isSourceControlled]);

  const allPlugins = useMemo(() => {
    // 本地列表 = 已安装/内置；不再混入 MARKETPLACE_PLUGINS 静态示例（2026-09-01 移除）。
    const list = pluginRegistry.list({ kind, query });
    // 内置工具是 Omni 自带能力，无需在扩展中心作为插件展示/管理，故从「工具」tab 隐藏。
    if (kind === "tool")
      return list.filter((m) => !pluginRegistry.isBuiltin(m.id));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, query, refreshKey]);

  // SkillHub / 专家团浏览界面只在「技能」一级分类下出现；远程连接器只在「连接器」下出现。
  const showSkillhub = !onPick && source === "skillhub" && kind === "skill";
  const showSuites = !onPick && source === "suites" && kind === "skill";
  const showConnectorhub =
    !onPick && source === "connectors" && kind === "skill";
  // 「我的专家」：用户自己创建/安装的专家（非内置）。
  const showMyExperts = !onPick && source === "my" && kind === "expert";
  // 「我的技能」：用户已安装/内置的本地技能（不混入 SkillHub/专家团），按用户要求不分类、一栏通览。
  const showMySkills = !onPick && source === "local" && kind === "skill";

  // 「我的技能」tab 下的批量管理模式：toggle 切换，多选删除已安装技能（2026-09-01）
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // 通用确认对话框：danger 操作（尤其是批量卸载、无撤销的破坏性动作）
  // 必须二次确认，避免误触。confirm 中点击取消则不执行；点击确认才执行
  // onConfirm。state 同时承载文案与回调，让调用方写一段配置而非重复模板。
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    message: string;
    danger: boolean;
    onConfirm: () => void;
  } | null>(null);
  // MCP 工具列表弹窗：点击已连接连接器的「X 工具」徽标查看暴露的工具。
  const [toolsDialog, setToolsDialog] = useState<{
    connectorId: string;
    connectorName: string;
    tools: McpToolInfo[];
    loading: boolean;
    error?: string;
  } | null>(null);
  // 离开「我的技能」时清理批量状态，避免回到「我的技能」时残留选择
  useEffect(() => {
    if (!showMySkills && (batchMode || selectedIds.size > 0)) {
      setBatchMode(false);
      setSelectedIds(new Set());
    }
  }, [showMySkills, batchMode, selectedIds.size]);
  // 「我的技能」tab 自动展开搜索框（让 placeholder「搜索已安装的技能」立即可见）
  useEffect(() => {
    if (mainView && showMySkills && !searchExpanded) setSearchExpanded(true);
  }, [mainView, showMySkills, searchExpanded]);

  // 已安装的专家团（id → skillset slug）；列表里渲染成套件卡片，子技能收进卡片内。
  const skillsetSlugs = useMemo(() => collectSkillsetSlugs(), [refreshKey]);

  // 属于这些已安装专家团的子技能 id：在「我的技能」里不单独平铺。
  // 批量模式与技能选择器（onPick）不过滤 —— 那两个场景要逐项勾选/卸载，
  // 隐藏项会让用户以为技能不见了。
  const skillsetChildIds = useMemo(
    () => collectSkillsetChildIds(skillsetSlugs.values()),
    [skillsetSlugs],
  );
  const hideSkillsetChildren = showMySkills && !onPick && !batchMode;

  // 历史回填：本字段引入之前装的子技能没有归属记录，会一直散在平铺列表里。
  // 这里对已安装的套件各拉一次详情，把已装的子技能补上归属（best-effort，
  // 每个套件每会话只试一次，见 repairSkillsetChildLinks）。只有真的补上了才刷新，
  // 否则会把订阅者推进无限重渲染。
  useEffect(() => {
    let cancelled = false;
    void repairSkillsetChildLinks([...skillsetSlugs.values()]).then((changed) => {
      if (changed && !cancelled) setRefreshKey((current) => current + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [skillsetSlugs]);

  const filteredPlugins = useMemo(() => {
    // 「我的技能」按用户要求不分类、一栏通览，跳过 category 过滤。
    const list =
      showMySkills || category === "全部"
        ? allPlugins
        : allPlugins.filter((m) => m.category === category);
    // 子技能只在套件卡片内出现 —— 用户要的「按专家团一套展示，不散开」。
    return hideSkillsetChildren
      ? list.filter((m) => !skillsetChildIds.has(m.id))
      : list;
  }, [allPlugins, category, showMySkills, hideSkillsetChildren, skillsetChildIds]);

  /** 工具按功能分组（用于「工具」tab 下按会话/文件/Git/导出等分块展示）。 */
  const groupedTools = useMemo(() => {
    if (kind !== "tool") return [];
    const map = new Map<string, PluginManifest[]>();
    for (const m of filteredPlugins) {
      const group = m.group || "其他";
      if (!map.has(group)) map.set(group, []);
      map.get(group)!.push(m);
    }
    const entries = Array.from(map.entries());
    entries.sort((a, b) => {
      const idxA = TOOL_GROUP_ORDER.indexOf(a[0]);
      const idxB = TOOL_GROUP_ORDER.indexOf(b[0]);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return a[0].localeCompare(b[0], "zh-CN");
    });
    return entries;
  }, [filteredPlugins, kind]);

  const stats = useMemo(() => pluginRegistry.stats(), [refreshKey]);
  const myExperts = useMemo(
    () =>
      pluginRegistry
        .list({ kind: "expert" })
        .filter((manifest) => !pluginRegistry.isBuiltin(manifest.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refreshKey],
  );

  const emptyInfo = useMemo(() => {
    switch (kind) {
      case "skill":
        return {
          icon: Wand2,
          title: "没有找到匹配的技能",
          hint: "试试其他关键词，或切换到「SkillHub 实时」发现更多技能",
        };
      case "connector":
        return {
          icon: Cable,
          title: "没有找到匹配的连接器",
          hint: onAddMcp
            ? "试试其他关键词，或点击右上角「新增 MCP」添加自定义连接器"
            : "试试其他关键词，或从「远程技能」浏览更多技能",
        };
      case "expert":
        return {
          icon: Bot,
          title: "没有找到匹配的专家",
          hint: onCreateExpert
            ? "试试其他关键词，或点击「创建专家」新建一个"
            : "试试其他关键词",
        };
      case "template":
        return {
          icon: LayoutTemplate,
          title: "没有找到匹配的模板",
          hint: "试试其他关键词",
        };
      default:
        return {
          icon: Puzzle,
          title: "没有找到匹配的插件",
          hint: "试试其他关键词，或从本地/远程导入 SKILL.md",
        };
    }
  }, [kind, onAddMcp, onCreateExpert]);

  // 数据迁移（2026-09-01 启动 effect）：为「我的技能」tab 内已安装但缺 icon 的
  // SkillHub 来源技能按 slug 拉一次 SkillHub summary，补全 iconUrl/author/category。
  // 老版本 installSkillhubSkill 没合并 summary.iconUrl 字段，已存在的技能
  // manifest.icon 为 undefined；本次迁移只动 kind === "skill" 且 source 标记
  // 为 SkillHub 的项，其它来源（本地导入、内置、用户自建）一律跳过。
  const migratedIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!showMySkills) return;
    const candidates = pluginRegistry
      .listInstalled()
      .filter(({ id, entry }) => {
        if (migratedIdsRef.current.has(id)) return false;
        const m = entry.manifest;
        const source = entry.source;
        return (
          m.kind === "skill" &&
          !m.icon &&
          (m.sourceUrl ?? "").includes("skillhub.cn") &&
          source.type === "marketplace" &&
          source.repository.startsWith("skillhub/")
        );
      });
    if (candidates.length === 0) return;

    let cancelled = false;
    (async () => {
      for (const { id, entry } of candidates) {
        migratedIdsRef.current.add(id); // 先标记，避免 effect 多次触发重复拉
        const source = entry.source;
        if (source.type !== "marketplace") continue;
        const parts = id.split("/");
        const slug = parts[parts.length - 1] ?? id;
        try {
          const list = await listSkillhubSkills({ query: slug, limit: 20 });
          if (cancelled) return;
          const summary = list.find((s) => s.slug === slug) ?? list[0];
          if (!summary) continue;
          const patched: PluginManifest = {
            ...entry.manifest,
            icon: entry.manifest.icon || summary.iconUrl,
            author: entry.manifest.author || summary.ownerName,
            category:
              entry.manifest.category ||
              (summary.category
                ? mapSkillhubCategory(summary.category)
                : undefined),
          };
          pluginRegistry.install(patched, source);
          setRefreshKey((current) => current + 1);
        } catch (e) {
          // 拉取失败不抛，保留 Wand2 占位图，下一次启动再试
          if (!cancelled) {
            // eslint-disable-next-line no-console
            console.warn(`SkillHub icon migration failed for ${slug}:`, e);
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // 只在 showMySkills 首次切到 true 时跑一次（migratedIdsRef 防重）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMySkills]);

  // Esc 关闭 confirm dialog（仅 confirm 打开时挂监听）。
  useEffect(() => {
    if (!confirmDialog) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setConfirmDialog(null);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirmDialog]);

  // Esc 关闭 MCP 工具列表弹窗（仅打开时挂监听）。
  useEffect(() => {
    if (!toolsDialog) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setToolsDialog(null);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [toolsDialog]);

  const handleInstall = useCallback((manifest: PluginManifest) => {
    pluginRegistry.install(manifest, {
      type: "marketplace",
      repository: `skillhub/${manifest.id}`,
    });
    setRefreshKey((current) => current + 1);
  }, []);

  /** 卸载非内置插件：
   *  - skill 走 uninstallSkillhubSkill（删 ~/.dsh/skills/<slug> + 移注册表），
   *    Rust 失败兜底仅移注册表；
   *  - expert / tool / connector / template 没有磁盘目录，仅 pluginRegistry.uninstall
   *    即可（不调 Rust 命令，避免 Rust 端找不到目录抛错）。 */
  const handleUninstall = useCallback((manifest: PluginManifest) => {
    const parts = manifest.id.split("/");
    const slug = parts[parts.length - 1] ?? manifest.id;
    const namespace =
      parts.length > 1 ? parts.slice(0, -1).join("/") : undefined;
    if (manifest.kind === "skill") {
      uninstallSkillhubSkill(slug, namespace)
        .catch(() => {
          pluginRegistry.uninstall(manifest.id);
        })
        .finally(() => setRefreshKey((current) => current + 1));
    } else {
      pluginRegistry.uninstall(manifest.id);
      setRefreshKey((current) => current + 1);
    }
  }, []);

  /** 切换/设置单张卡的选中状态（在 batchMode 下被整卡 onClick 调用）。 */
  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const isInstalled = (id: string) =>
    pluginRegistry.isInstalled(id) || pluginRegistry.isBuiltin(id);

  /** 切换技能启用状态：内置项固定 enabled=true 不允许关闭（保护内置基础栈）。 */
  const handleToggleEnabled = useCallback(
    (manifest: PluginManifest, next: boolean) => {
      if (pluginRegistry.isBuiltin(manifest.id)) return;
      pluginRegistry.setEnabled(manifest.id, next);
      setRefreshKey((current) => current + 1);
    },
    [],
  );

  /** 顶部 batch toolbar 用的「全局」actions：对所有可见非内置项生效（不需要先选中）。
   *  selectedIds 仍清空，因为顶部操作后选中状态无意义了。 */
  const handleBatchAllSetEnabled = useCallback(
    (next: boolean) => {
      const targets = filteredPlugins.filter(
        (m) => !pluginRegistry.isBuiltin(m.id),
      );
      for (const m of targets) {
        pluginRegistry.setEnabled(m.id, next);
      }
      if (targets.length > 0) {
        setRefreshKey((current) => current + 1);
        setSelectedIds(new Set());
      }
    },
    [filteredPlugins],
  );
  const handleBatchAllUninstall = useCallback(() => {
    const targets = filteredPlugins.filter(
      (m) => !pluginRegistry.isBuiltin(m.id),
    );
    if (targets.length === 0) return;
    for (const m of targets) handleUninstall(m);
    setSelectedIds(new Set());
    setBatchMode(false);
  }, [filteredPlugins, handleUninstall]);
  // MCP 型连接器：kind=connector 且无 provider（无 provider 即本机 MCP 服务器，
  // 走 command/args/env 启动配置；模型统一在「模型设置」配置，不在此作为卡片管理）。
  const isMcpConnector = (manifest: PluginManifest) =>
    manifest.kind === "connector" && !manifest.provider;

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
      const url = String(existing.url ?? "").trim();
      const command = String(existing.command ?? "").trim();
      // 优先回显新增/上次保存时的原始 JSON，保证打开配置与填写时完全一致
      // （parseMcpJson 会归一化并丢弃 mcpServers 包装、字段顺序等，不能丢原始输入）。
      const rawJson =
        typeof existing.rawJson === "string"
          ? existing.rawJson.trim()
          : "";
      let jsonText: string;
      if (rawJson) {
        jsonText = rawJson;
      } else if (url) {
        const headers =
          existing.headers && typeof existing.headers === "object"
            ? (existing.headers as Record<string, unknown>)
            : {};
        const configJson: Record<string, unknown> = { url };
        if (Object.keys(headers).length > 0) configJson.headers = headers;
        jsonText = JSON.stringify(configJson, null, 2);
      } else if (command) {
        const args = Array.isArray(existing.args)
          ? (existing.args as unknown[]).map(String)
          : [];
        const env =
          existing.env && typeof existing.env === "object"
            ? (existing.env as Record<string, unknown>)
            : {};
        const configJson: Record<string, unknown> = { command };
        if (args.length > 0) configJson.args = args;
        if (Object.keys(env).length > 0) configJson.env = env;
        jsonText = JSON.stringify(configJson, null, 2);
      } else {
        // 未配置过 command/url 时用高频服务模板预填
        const template = getMcpCommandTemplate(manifest.id);
        const configJson: Record<string, unknown> = template
          ? { command: template.command }
          : { command: "" };
        if (template && template.args.trim())
          configJson.args = template.args.trim().split(/\s+/);
        if (template && template.env.trim()) {
          const env: Record<string, string> = {};
          for (const line of template.env.split("\n")) {
            const trimmed = line.trim();
            const eq = trimmed.indexOf("=");
            if (eq > 0) env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
          }
          if (Object.keys(env).length > 0) configJson.env = env;
        }
        jsonText = JSON.stringify(configJson, null, 2);
      }
      setMcpDraft(jsonText);
      // 已有 url → Remote(http) 模式；否则 Stdio 模式（默认骨架）。
      setMcpMode(url ? "http" : "stdio");
    }
    setMcpDraftError(null);
    setConfiguringId(manifest.id);
  }, []);

  // 切换连接模式分段：把草稿替换为对应模式的空骨架模板。
  // 内部仍是 JSON 文本，不改变 parseMcpJson 解析链路。
  const switchMcpMode = useCallback((mode: "stdio" | "http") => {
    if (mode === mcpMode) return;
    setMcpMode(mode);
    const skeleton =
      mode === "http"
        ? { url: "", headers: {} }
        : { command: "", args: [], env: {} };
    const text = JSON.stringify(skeleton, null, 2);
    setMcpDraft(text);
    setMcpDraftError(null);
  }, [mcpMode]);

  const updateDraft = useCallback((id: string, value: string) => {
    setConfigDraft((current) => ({ ...current, [id]: value }));
  }, []);

  const updateMcpDraft = useCallback((value: string) => {
    setMcpDraft(value);
    if (!value.trim()) {
      setMcpDraftError(null);
      return;
    }
    const result = parseMcpJson(value);
    setMcpDraftError("error" in result ? result.error : null);
  }, []);

  const saveConfig = useCallback(
    async (manifest: PluginManifest) => {
      const values: Record<string, unknown> = {};
      for (const field of manifest.configFields ?? []) {
        const raw = configDraft[field.id];
        if (raw === undefined || raw === "") continue;
        values[field.id] = field.type === "number" ? Number(raw) : raw;
      }
      if (isMcpConnector(manifest)) {
        const jsonText = mcpDraft.trim();
        if (!jsonText) {
          setMcpDraftError("配置不能为空");
          return;
        }
        const parsed = parseMcpJson(jsonText);
        if ("error" in parsed) {
          setMcpDraftError(parsed.error);
          return;
        }

        // 写入解析后的配置，并清理旧配置中可能冲突的字段
        if (parsed.type === "http") {
          values.url = parsed.url;
          values.headers = parsed.headers;
          delete values.command;
          delete values.args;
          delete values.env;
        } else {
          values.command = parsed.command;
          values.args = parsed.args;
          values.env = parsed.env;
          delete values.url;
          delete values.headers;
        }

        // 启动命令/远程地址变更 → 重置信任态。新的配置可能指向完全不同的
        // 服务器（比如从只读的文件服务器换成能执行 shell 的服务器），必须让
        // 用户重新确认一次，不能沿用旧信任。
        const prev = pluginRegistry.getConnectorConfig(manifest.id) ?? {};
        const prevUrl = String(prev.url ?? "").trim();
        const prevCommand = String(prev.command ?? "").trim();
        const configChanged =
          parsed.type === "http"
            ? prevUrl !== parsed.url ||
              JSON.stringify(prev.headers ?? {}) !==
                JSON.stringify(parsed.headers)
            : prevCommand !== parsed.command ||
              JSON.stringify(Array.isArray(prev.args) ? prev.args : []) !==
                JSON.stringify(parsed.args);
        if (configChanged) {
          values.trusted = false;
        }
      }
      // 同步保存原始 JSON 草稿，保证下次打开配置与本次编辑完全一致
      // （parseMcpJson 只存归一化字段，会丢失 mcpServers 包装 / 字段顺序）。
      values.rawJson = mcpDraft.trim();
      pluginRegistry.setConnectorConfig(manifest.id, values);
      setConfiguringId(null);
      setMcpDraftError(null);
      setRefreshKey((current) => current + 1);
      // MCP 型连接器：已信任 → 立即拉起；未信任 → 只弹信任确认，不自动激活。
      if (isMcpConnector(manifest)) {
        const hasLaunch =
          String(values.command ?? "").trim() ||
          String(values.url ?? "").trim();
        if (hasLaunch) {
          if (isConnectorTrusted(manifest)) {
            try {
              await ensureMcpConnector(manifest);
            } catch (error) {
              setMcpError({
                connectorId: manifest.id,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          } else {
            setTrustPromptId(manifest.id);
          }
        }
      }
      refreshConnected();
    },
    [configDraft, mcpDraft, refreshConnected],
  );

  const handleConnect = useCallback(
    async (manifest: PluginManifest) => {
      const config = pluginRegistry.getConnectorConfig(manifest.id) ?? {};
      const hasLaunch =
        String(config.command ?? "").trim() ||
        String(config.url ?? "").trim();
      if (!hasLaunch) {
        openConfig(manifest);
        return;
      }
      setMcpError(null);
      // 信任门：未受信任的连接器先弹确认，不直接拉起子进程。
      if (!isConnectorTrusted(manifest)) {
        setTrustPromptId(manifest.id);
        return;
      }
      setMcpConnectingId(manifest.id);
      try {
        await ensureMcpConnector(manifest);
      } catch (error) {
        setMcpError({
          connectorId: manifest.id,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setMcpConnectingId(null);
        refreshConnected();
      }
    },
    [openConfig, refreshConnected],
  );

  /** 信任弹窗里点「信任并连接」：写入信任态后再拉起服务器。 */
  const confirmTrust = useCallback(
    async (manifest: PluginManifest) => {
      setConnectorTrusted(manifest, true);
      setTrustPromptId(null);
      setMcpError(null);
      setRefreshKey((current) => current + 1);
      // 弹窗一关就没有任何反馈了，这里同样要进「连接中」态。
      setMcpConnectingId(manifest.id);
      try {
        await ensureMcpConnector(manifest);
      } catch (error) {
        setMcpError({
          connectorId: manifest.id,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setMcpConnectingId(null);
        refreshConnected();
      }
    },
    [refreshConnected],
  );

  const handleDisconnect = useCallback(
    async (manifest: PluginManifest) => {
      await disconnectMcpConnector(manifest.id);
      refreshConnected();
    },
    [refreshConnected],
  );

  const handleShowTools = useCallback(
    async (manifest: PluginManifest) => {
      setToolsDialog({
        connectorId: manifest.id,
        connectorName: manifest.name,
        tools: [],
        loading: true,
      });
      try {
        const tools = await listMcpTools(manifest.id);
        setToolsDialog({
          connectorId: manifest.id,
          connectorName: manifest.name,
          tools,
          loading: false,
        });
      } catch (error) {
        setToolsDialog({
          connectorId: manifest.id,
          connectorName: manifest.name,
          tools: [],
          loading: false,
          error:
            error instanceof Error
              ? error.message
              : String(error ?? "获取工具列表失败"),
        });
      }
    },
    [],
  );

  const renderMarketplace = () => {
    /** 单张插件卡片渲染，被平铺列表与工具分组列表共用。 */
    const renderPluginCard = (manifest: PluginManifest) => {
      const installed = isInstalled(manifest.id);
      const mcpConnected = connectedList.find(
        (s) => s.connectorId === manifest.id,
      );
      const isBuiltin = pluginRegistry.isBuiltin(manifest.id);
      const inBatch = batchMode && showMySkills && !isBuiltin;
      // 已安装的专家团在「我的技能」里渲染为可展开的套件卡片
      // （批量模式与技能选择器仍用普通卡片，避免干扰选择逻辑）。
      const skillsetSlug =
        showMySkills && !onPick && !inBatch
          ? (skillsetSlugs.get(manifest.id) ?? null)
          : null;
      if (skillsetSlug) {
        return (
          <InstalledSkillsetCard
            key={manifest.id}
            manifest={manifest}
            slug={skillsetSlug}
            enabled={pluginRegistry.isEnabled(manifest.id)}
            isBuiltin={isBuiltin}
            onToggleEnabled={(next) => handleToggleEnabled(manifest, next)}
            onChanged={() => setRefreshKey((current) => current + 1)}
          />
        );
      }
      const isSelected = inBatch && selectedIds.has(manifest.id);
      const enabled = pluginRegistry.isEnabled(manifest.id);
      // 连接器卡片走紧凑布局（见 plugins.css `.plugin-card--connector`）：
      // 描述区不参与「统一高度」的预留行，底部按钮按内容宽度右对齐。
      // 技能 / SkillHub 卡片仍保持 8b29f15 的同行等高策略，不受影响。
      const connectorClass =
        manifest.kind === "connector" ? " plugin-card--connector" : "";
      const cardClass =
        (inBatch
          ? `plugin-card plugin-card--batch ${isSelected ? "plugin-card--batch-selected" : ""} ${enabled || isBuiltin ? "" : "plugin-card--disabled"}`
          : onPick
            ? `plugin-card plugin-card--pickable ${enabled || isBuiltin ? "" : "plugin-card--disabled"}`
            : `plugin-card plugin-card--clickable ${enabled || isBuiltin ? "" : "plugin-card--disabled"}`
        ).trim() + connectorClass;
      const cardRole: "button" | "checkbox" = inBatch ? "checkbox" : "button";
      return (
        <div
          key={manifest.id}
          className={cardClass}
          role={cardRole}
          aria-checked={inBatch ? isSelected : undefined}
          tabIndex={0}
          onClick={
            inBatch
              ? () => toggleSelected(manifest.id)
              : onPick
                ? () => onPick(manifest)
                : () => setDetailManifest(manifest)
          }
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              if (inBatch) toggleSelected(manifest.id);
              else if (onPick) onPick(manifest);
              else setDetailManifest(manifest);
            }
          }}
          aria-label={
            inBatch
              ? `${isSelected ? "取消选中" : "选中"} ${manifest.name}`
              : onPick
                ? `选择 ${manifest.name}`
                : `${manifest.name} 详情`
          }
        >
          <div className="plugin-card__header">
            <div className="plugin-card__icon">
              {inBatch ? (
                <span
                  className={`plugin-card__batch-checkbox ${isSelected ? "plugin-card__batch-checkbox--checked" : ""}`}
                  aria-hidden="true"
                >
                  {isSelected ? <Check size={14} strokeWidth={2.2} /> : null}
                </span>
              ) : (
                renderPluginIcon(manifest)
              )}
            </div>
            <div className="plugin-card__main">
              <div className="plugin-card__title-row">
                <h3 title={manifest.name}>{manifest.name}</h3>
                {showMySkills && !onPick && (
                  <div
                    className="plugin-card__enable"
                    onClick={(e) => e.stopPropagation()}
                    title={
                      isBuiltin
                        ? "内置项始终启用，不可关闭"
                        : enabled
                          ? "点击关闭"
                          : "点击开启"
                    }
                  >
                    <OmniSwitch
                      checked={enabled}
                      disabled={isBuiltin}
                      onChange={(next) =>
                        void handleToggleEnabled(manifest, next)
                      }
                      ariaLabel={
                        isBuiltin
                          ? `${manifest.name}（内置项不可关闭）`
                          : `${enabled ? "关闭" : "开启"} ${manifest.name}`
                      }
                    />
                  </div>
                )}
              </div>
              <p
                className="plugin-card__description"
                title={manifest.description}
              >
                {manifest.description}
              </p>
              {manifest.tags && manifest.tags.length > 0 && (
                <div className="plugin-card__tags">
                  {manifest.tags.map((tag) => (
                    <span key={tag} className="plugin-card__tag">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              <div className="plugin-card__meta">
                <span>{manifest.author ?? "Omni"}</span>
                {manifest.category && <span>· {manifest.category}</span>}
                {!isBuiltin && <span>· v{manifest.version}</span>}
              </div>
            </div>
          </div>
          {/* 卡片底部 actions 区：只在「选择模式」（onPick，CreateProjectDialog
              弹窗中选插件）和「连接器」（套件管理：连接 / 断开 / 配置）两种
              场景保留。其余场景（我的技能 / 我的专家 / 批量管理 / 通用浏览）
              都不再在卡片底部展示按钮行——卡片可整体点击打开详情抽屉，所有
              安装 / 卸载 / 已安装 等单卡操作统一入口。避免在 4 列
              grid 下视觉拥挤 + 防止误触「删除」按钮。 */}
          {(onPick || manifest.kind === "connector") && (
            <div
              className="plugin-card__actions"
              onClick={(e) => e.stopPropagation()}
            >
              {inBatch ? (
                isBuiltin ? (
                  <span className="plugin-card__connected">
                    <span className="plugin-card__connected-dot" />
                    <span>内置</span>
                  </span>
                ) : (
                  <button
                    type="button"
                    className={
                      isSelected
                        ? "plugin-card__button plugin-card__button--danger"
                        : "plugin-card__button plugin-card__button--secondary"
                    }
                    onClick={() => toggleSelected(manifest.id)}
                    aria-label={
                      isSelected
                        ? `取消选中 ${manifest.name}`
                        : `选中 ${manifest.name}`
                    }
                  >
                    {isSelected ? <Check size={14} strokeWidth={2} /> : null}
                    <span>{isSelected ? "已选中" : "选择"}</span>
                  </button>
                )
              ) : onPick ? (
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
                    onClick={(e) => {
                      e.stopPropagation();
                      openConfig(manifest);
                    }}
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
                        <button
                          type="button"
                          className="plugin-card__connected plugin-card__connected--clickable"
                          title={`已连接 · 暴露 ${mcpConnected.toolCount} 个工具，点击查看详情`}
                          onClick={() => void handleShowTools(manifest)}
                        >
                          <span className="plugin-card__connected-dot" />
                          <span>{mcpConnected.toolCount} 工具</span>
                        </button>
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
                        className={
                          isConnectorTrusted(manifest)
                            ? "plugin-card__button plugin-card__button--primary"
                            : "plugin-card__button plugin-card__button--trust"
                        }
                        onClick={() => void handleConnect(manifest)}
                        disabled={mcpConnectingId === manifest.id}
                        aria-busy={mcpConnectingId === manifest.id}
                        title={
                          mcpConnectingId === manifest.id
                            ? "正在连接，请稍候…"
                            : isConnectorTrusted(manifest)
                              ? "启动该 MCP 服务器，并将其工具注入 AI 对话"
                              : "该连接器尚未获得信任，点击后需确认信任才会启动"
                        }
                      >
                        {mcpConnectingId === manifest.id ? (
                          <Loader2 size={14} strokeWidth={1.8} className="spin" />
                        ) : isConnectorTrusted(manifest) ? (
                          <PlugZap size={14} strokeWidth={1.8} />
                        ) : (
                          <ShieldAlert size={14} strokeWidth={1.8} />
                        )}
                        <span>
                          {mcpConnectingId === manifest.id
                            ? "连接中…"
                            : isConnectorTrusted(manifest)
                              ? "连接"
                              : "信任并连接"}
                        </span>
                      </button>
                    )
                  ) : null}
                </>
              ) : installed && !pluginRegistry.isBuiltin(manifest.id) ? (
                <button
                  type="button"
                  className="plugin-card__button plugin-card__button--danger"
                  onClick={() => handleUninstall(manifest)}
                  title="卸载并删除此插件"
                >
                  <Trash2 size={14} strokeWidth={1.8} />
                  <span>删除</span>
                </button>
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
            </div>
          )}
          {trustPromptId === manifest.id &&
            (() => {
              const info = getMcpTrustInfo(manifest);
              return (
                <div
                  className="plugin-card__trust-prompt"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="plugin-card__trust-head">
                    <ShieldAlert size={15} strokeWidth={1.9} />
                    <span>信任「{manifest.name}」？</span>
                  </div>
                  <p className="plugin-card__trust-warn">
                    该连接器会暴露 MCP 工具给 AI 直接调用，
                    <strong>
                      不受 Omni 内置工具权限（只读 / 写入白名单）约束
                    </strong>
                    。请确认你信任它的来源与连接配置。
                  </p>
                  {info.type === "stdio" ? (
                    <>
                      <div className="plugin-card__trust-cmd">
                        <Terminal size={12} strokeWidth={1.8} />
                        <code>
                          {info.command}
                          {info.args.length > 0
                            ? ` ${info.args.join(" ")}`
                            : ""}
                        </code>
                      </div>
                      {info.envKeys.length > 0 && (
                        <div className="plugin-card__trust-env">
                          <span>环境变量</span>
                          {info.envKeys.map((key) => (
                            <code key={key}>{key}=••••</code>
                          ))}
                        </div>
                      )}
                    </>
                  ) : info.type === "http" ? (
                    <>
                      <div className="plugin-card__trust-cmd">
                        <Globe size={12} strokeWidth={1.8} />
                        <code>{info.url}</code>
                      </div>
                      {info.headerKeys.length > 0 && (
                        <div className="plugin-card__trust-env">
                          <span>请求头</span>
                          {info.headerKeys.map((key) => (
                            <code key={key}>{key}: ••••</code>
                          ))}
                        </div>
                      )}
                    </>
                  ) : null}
                  <div className="plugin-card__trust-actions">
                    <button
                      type="button"
                      className="plugin-card__button plugin-card__button--secondary"
                      onClick={() => setTrustPromptId(null)}
                    >
                      <span>取消</span>
                    </button>
                    <button
                      type="button"
                      className="plugin-card__button plugin-card__button--primary"
                      onClick={() => void confirmTrust(manifest)}
                    >
                      <ShieldCheck size={14} strokeWidth={1.8} />
                      <span>信任并连接</span>
                    </button>
                  </div>
                </div>
              );
            })()}
          {mcpError?.connectorId === manifest.id && (
            <div
              className="plugin-card__mcp-error"
              onClick={(e) => e.stopPropagation()}
            >
              <AlertTriangle size={13} strokeWidth={1.8} />
              <span>{mcpError.message}</span>
            </div>
          )}
          {configuringId === manifest.id &&
            ((manifest.configFields?.length ?? 0) > 0 ||
              isMcpConnector(manifest)) && (
              <div
                className="plugin-card__config"
                onClick={(e) => e.stopPropagation()}
              >
                {manifest.configFields?.map((field) => (
                  <label key={field.id} className="plugin-card__config-field">
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
                          <option key={option.value} value={option.value}>
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
                      <div
                        className="omni-mcp-seg"
                        role="tablist"
                        aria-label="连接模式"
                      >
                        <button
                          type="button"
                          role="tab"
                          aria-selected={mcpMode === "http"}
                          className={`omni-mcp-seg__btn ${
                            mcpMode === "http"
                              ? "omni-mcp-seg__btn--active"
                              : ""
                          }`}
                          onClick={() => switchMcpMode("http")}
                        >
                          Remote
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={mcpMode === "stdio"}
                          className={`omni-mcp-seg__btn ${
                            mcpMode === "stdio"
                              ? "omni-mcp-seg__btn--active"
                              : ""
                          }`}
                          onClick={() => switchMcpMode("stdio")}
                        >
                          Stdio
                        </button>
                      </div>
                      <span className="plugin-card__config-section-label">
                        MCP 启动配置（JSON）
                      </span>
                    </div>
                    <label className="plugin-card__config-field">
                      <span>配置 JSON *</span>
                      <textarea
                        className="omni-mcp-create-json"
                        value={mcpDraft}
                        onChange={(event) => updateMcpDraft(event.target.value)}
                        rows={10}
                        spellCheck={false}
                        placeholder='{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_TOKEN": "ghp_xxxx" }
}

// 或远程 Streamable HTTP：
{
  "url": "https://api.example.com/mcp",
  "headers": { "Authorization": "Bearer xxx" }
}'
                      />
                    </label>
                    {mcpDraftError && (
                      <div className="omni-mcp-create-field__error">
                        {mcpDraftError}
                      </div>
                    )}
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
    };

    return (
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

          {!omitTopTabs && !onPick && kind === "skill" && (
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
                <span>我的技能</span>
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
                <span>专家团</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={source === "connectors"}
                className={`plugin-marketplace__source-tab ${source === "connectors" ? "plugin-marketplace__source-tab--active" : ""}`}
                onClick={() => setSource("connectors")}
              >
                <Cable size={14} strokeWidth={1.8} />
                <span>远程技能</span>
              </button>
            </div>
          )}

          {!omitTopTabs && !onPick && kind === "connector" && (
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
                <span>我的连接器</span>
              </button>
            </div>
          )}

          {!omitTopTabs && !onPick && kind === "expert" && (
            <div
              className="plugin-marketplace__source-tabs"
              role="tablist"
              aria-label="专家来源"
            >
              <button
                type="button"
                role="tab"
                aria-selected={source === "my"}
                className={`plugin-marketplace__source-tab ${source === "my" ? "plugin-marketplace__source-tab--active" : ""}`}
                onClick={() => setSource("my")}
              >
                <Bot size={14} strokeWidth={1.8} />
                <span>我的专家</span>
              </button>
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
            </div>
          )}

          {showSkillhub ||
          showSuites ||
          showConnectorhub ||
          showMyExperts ? null : (
            <>
              {mainView ? (
                <>
                  <div className="plugin-marketplace__top-bar">
                    {showMySkills && (
                      <button
                        type="button"
                        className={`plugin-marketplace__batch-btn ${batchMode ? "plugin-marketplace__batch-btn--active" : ""}`}
                        onClick={() => {
                          setBatchMode((v) => !v);
                          setSelectedIds(new Set());
                        }}
                        aria-pressed={batchMode}
                        aria-label="批量管理"
                        title={
                          batchMode
                            ? "退出批量管理模式"
                            : "进入批量管理模式：多选并删除已安装技能"
                        }
                      >
                        <Eye size={14} strokeWidth={1.8} />
                        <span>批量管理</span>
                      </button>
                    )}
                    {!showMySkills && (
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
                    )}

                    <div
                      className={`plugin-marketplace__search ${searchExpanded ? "plugin-marketplace__search--expanded" : ""}`}
                    >
                      {searchExpanded ? (
                        <>
                          <Search size={16} strokeWidth={1.8} />
                          <input
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder={
                              showMySkills
                                ? "搜索已安装的连接器"
                                : "搜索连接器..."
                            }
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
                          title="搜索"
                        >
                          <Search size={18} strokeWidth={1.8} />
                        </button>
                      )}
                    </div>

                    <div
                      className="plugin-marketplace__view-toggle"
                      role="group"
                      aria-label="视图布局"
                    >
                      <button
                        type="button"
                        className={
                          localViewMode === "grid"
                            ? "plugin-marketplace__icon-btn plugin-marketplace__icon-btn--active"
                            : "plugin-marketplace__icon-btn"
                        }
                        onClick={() => setLocalViewMode("grid")}
                        title="网格视图"
                        aria-label="网格视图"
                        aria-pressed={localViewMode === "grid"}
                      >
                        <LayoutGrid size={16} />
                      </button>
                      <button
                        type="button"
                        className={
                          localViewMode === "list"
                            ? "plugin-marketplace__icon-btn plugin-marketplace__icon-btn--active"
                            : "plugin-marketplace__icon-btn"
                        }
                        onClick={() => setLocalViewMode("list")}
                        title="列表视图"
                        aria-label="列表视图"
                        aria-pressed={localViewMode === "list"}
                      >
                        <LayoutList size={16} />
                      </button>
                    </div>

                    {kind === "connector" && onAddMcp && (
                      <button
                        type="button"
                        className="plugin-marketplace__add-mcp-btn"
                        onClick={onAddMcp}
                        title="新增自定义 MCP 连接器"
                      >
                        <Plus size={14} strokeWidth={2} />
                        <span>新增 MCP</span>
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="plugin-marketplace__search">
                    <Search size={16} strokeWidth={1.8} />
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder={
                        showMySkills
                          ? "搜索已安装的技能"
                          : "搜索插件、技能、专家..."
                      }
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

                  <div className="plugin-marketplace__kind-tabs">
                    {KIND_TABS.filter((tab) => tab.kind !== "tool").map(
                      (tab) => (
                        <button
                          key={tab.kind}
                          type="button"
                          className={`plugin-marketplace__kind-tab ${kind === tab.kind ? "plugin-marketplace__kind-tab--active" : ""}`}
                          onClick={() => setKind(tab.kind)}
                        >
                          <tab.icon size={14} strokeWidth={1.8} />
                          <span>{tab.label}</span>
                        </button>
                      ),
                    )}
                  </div>

                  {!showMySkills && (
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
                  )}
                </>
              )}
            </>
          )}
        </div>

        <div className="plugin-marketplace__body">
          {showMySkills && batchMode && (
            <div
              className="plugin-marketplace__batch-top-bar"
              role="toolbar"
              aria-label="批量操作"
            >
              <div className="plugin-marketplace__batch-top-left">
                <span className="plugin-marketplace__batch-top-count">
                  已选 <strong>{selectedIds.size}</strong> 项
                </span>
                <button
                  type="button"
                  className="plugin-marketplace__batch-top-mini"
                  onClick={() => {
                    const selectable = filteredPlugins.filter(
                      (m) => !pluginRegistry.isBuiltin(m.id),
                    );
                    const allSelected =
                      selectable.length > 0 &&
                      selectable.every((m) => selectedIds.has(m.id));
                    if (allSelected) setSelectedIds(new Set());
                    else setSelectedIds(new Set(selectable.map((m) => m.id)));
                  }}
                >
                  {filteredPlugins
                    .filter((m) => !pluginRegistry.isBuiltin(m.id))
                    .every((m) => selectedIds.has(m.id))
                    ? "取消全选"
                    : "全选"}
                </button>
                <button
                  type="button"
                  className="plugin-marketplace__batch-top-mini"
                  disabled={selectedIds.size === 0}
                  onClick={() => setSelectedIds(new Set())}
                >
                  清空
                </button>
              </div>
              <div className="plugin-marketplace__batch-top-right">
                <button
                  type="button"
                  className="plugin-marketplace__batch-top-btn plugin-marketplace__batch-top-btn--primary"
                  onClick={() => handleBatchAllSetEnabled(true)}
                  title="开启所有非内置技能"
                >
                  <Power size={14} strokeWidth={1.8} />
                  <span>开启</span>
                </button>
                <button
                  type="button"
                  className="plugin-marketplace__batch-top-btn"
                  onClick={() => handleBatchAllSetEnabled(false)}
                  title="关闭所有非内置技能"
                >
                  <PowerOff size={14} strokeWidth={1.8} />
                  <span>关闭</span>
                </button>
                <button
                  type="button"
                  className="plugin-marketplace__batch-top-btn plugin-marketplace__batch-top-btn--danger"
                  onClick={() => {
                    const targets = filteredPlugins.filter(
                      (m) => !pluginRegistry.isBuiltin(m.id),
                    );
                    if (targets.length === 0) return;
                    setConfirmDialog({
                      title: "确认批量卸载",
                      message: `将卸载当前列表中全部 ${targets.length} 个已安装技能（含 SkillHub / 专家团 / 工具 / 连接器 / 专家 / 模板）。内置基础栈不受影响。此操作无法撤销，是否继续？`,
                      danger: true,
                      onConfirm: () => handleBatchAllUninstall(),
                    });
                  }}
                  title="卸载所有非内置技能"
                >
                  <Trash2 size={14} strokeWidth={1.8} />
                  <span>卸载</span>
                </button>
                <button
                  type="button"
                  className="plugin-marketplace__batch-top-btn"
                  onClick={() => {
                    setBatchMode(false);
                    setSelectedIds(new Set());
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          )}
          {showSkillhub ? (
            <SkillhubBrowser />
          ) : showSuites ? (
            <SkillsetsBrowser />
          ) : showConnectorhub ? (
            <ConnectorhubBrowser />
          ) : showMyExperts ? (
            <div className="plugin-marketplace__my-experts">
              <div className="plugin-marketplace__my-experts-toolbar">
                <span>你创建或从市场安装的专家</span>
                <button
                  type="button"
                  className="plugin-marketplace__create-expert"
                  onClick={onCreateExpert}
                >
                  <Plus size={14} strokeWidth={2} />
                  <span>创建专家</span>
                </button>
              </div>
              {myExperts.length === 0 ? (
                <div className="plugin-marketplace__empty plugin-marketplace__empty--my-experts">
                  <Bot size={40} strokeWidth={1.2} />
                  <p>还没有自定义专家</p>
                  <span>
                    点击「创建专家」填写名称、角色提示词并绑定工具/技能，
                    创建后可通过项目绑定、@ 提及或 agent 委派使用
                  </span>
                  <button
                    type="button"
                    className="plugin-marketplace__create-expert"
                    onClick={onCreateExpert}
                  >
                    <Plus size={14} strokeWidth={2} />
                    <span>创建专家</span>
                  </button>
                </div>
              ) : (
                <div className="plugin-marketplace__grid">
                  {myExperts.map((manifest) => {
                    return (
                      <div key={manifest.id} className="plugin-card">
                        <div className="plugin-card__icon">
                          {renderPluginIcon(manifest)}
                        </div>
                        <div className="plugin-card__main">
                          <div className="plugin-card__title-row">
                            <h3>{manifest.name}</h3>
                            <span className="plugin-card__badge">expert</span>
                          </div>
                          <p className="plugin-card__description">
                            {manifest.description}
                          </p>
                          <div className="plugin-card__meta">
                            <span>{manifest.author ?? "Omni"}</span>
                            {manifest.category && (
                              <span>· {manifest.category}</span>
                            )}
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
                          <span className="plugin-card__connected">
                            <span className="plugin-card__connected-dot" />
                            <span>已启用</span>
                          </span>
                          {onEditExpert && (
                            <button
                              type="button"
                              className="plugin-card__button"
                              onClick={() => onEditExpert(manifest)}
                              title="编辑此专家的提示词/工具/技能"
                              aria-label={`编辑 ${manifest.name}`}
                            >
                              <Pencil size={14} strokeWidth={1.8} />
                              <span>编辑</span>
                            </button>
                          )}
                          <button
                            type="button"
                            className="plugin-card__button plugin-card__button--danger"
                            onClick={() => handleUninstall(manifest)}
                            title="卸载并删除此专家"
                            aria-label={`删除 ${manifest.name}`}
                          >
                            <Trash2 size={14} strokeWidth={1.8} />
                            <span>删除</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : filteredPlugins.length === 0 ? (
            (() => {
              const EmptyIcon = emptyInfo.icon;
              return (
                <div className="plugin-marketplace__empty">
                  <EmptyIcon size={40} strokeWidth={1.2} />
                  <p>{emptyInfo.title}</p>
                  <span>{emptyInfo.hint}</span>
                </div>
              );
            })()
          ) : kind === "tool" && groupedTools.length > 0 ? (
            <div className="plugin-marketplace__groups">
              {groupedTools.map(([group, items]) => (
                <section key={group} className="plugin-marketplace__group">
                  <h3 className="plugin-marketplace__group-title">
                    {group}
                    <span className="plugin-marketplace__group-count">
                      {items.length}
                    </span>
                  </h3>
                  <div
                    className={
                      mainView && localViewMode === "list"
                        ? "plugin-marketplace__grid plugin-marketplace__grid--list"
                        : "plugin-marketplace__grid"
                    }
                  >
                    {items.map((manifest) => renderPluginCard(manifest))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div
              className={
                mainView && localViewMode === "list"
                  ? "plugin-marketplace__grid plugin-marketplace__grid--list"
                  : "plugin-marketplace__grid"
              }
            >
              {filteredPlugins.map((manifest) => renderPluginCard(manifest))}
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

        <PluginDetailDrawer
          manifest={detailManifest}
          isInstalled={detailManifest ? isInstalled(detailManifest.id) : false}
          isBuiltin={
            detailManifest ? pluginRegistry.isBuiltin(detailManifest.id) : false
          }
          onClose={() => setDetailManifest(null)}
          onInstall={(m) => void handleInstall(m)}
          onUninstall={(m) => void handleUninstall(m)}
        />

        {/* 危险操作二次确认 dialog（参考 .omni-confirm-overlay / .omni-confirm-dialog
          共享样式）。打开时 Esc 关闭 + 自动聚焦「取消」按钮（不是「确认」——
          因为危险操作的「确认」红色按钮如果默认 focus，Enter 会直接破坏数据
          而无取消机会；让 focus 落在「取消」反而要求用户主动选择「确认」
          才能继续破坏操作，是 UX 安全设计）。 */}
        {confirmDialog && (
          <div
            className="omni-confirm-overlay"
            role="presentation"
            onClick={() => setConfirmDialog(null)}
          >
            <div
              className="omni-confirm-dialog"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="plugin-marketplace-confirm-title"
              aria-describedby="plugin-marketplace-confirm-message"
              onClick={(e) => e.stopPropagation()}
            >
              <div
                className="omni-confirm-dialog__title"
                id="plugin-marketplace-confirm-title"
              >
                {confirmDialog.title}
              </div>
              <div
                className="omni-confirm-dialog__message"
                id="plugin-marketplace-confirm-message"
              >
                {confirmDialog.message}
              </div>
              <div className="omni-confirm-dialog__actions">
                <button
                  type="button"
                  className="omni-confirm-dialog__button"
                  onClick={() => setConfirmDialog(null)}
                  autoFocus
                >
                  取消
                </button>
                <button
                  type="button"
                  className={
                    confirmDialog.danger
                      ? "omni-confirm-dialog__button omni-confirm-dialog__button--danger"
                      : "omni-confirm-dialog__button omni-confirm-dialog__button--primary"
                  }
                  onClick={() => {
                    const cb = confirmDialog.onConfirm;
                    setConfirmDialog(null);
                    cb();
                  }}
                >
                  {confirmDialog.danger ? "确认卸载" : "确认"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* MCP 工具列表弹窗：点击已连接连接器的「X 工具」徽标打开。 */}
        {toolsDialog && (
          <div
            className="omni-confirm-overlay"
            role="presentation"
            onClick={() => setToolsDialog(null)}
          >
            <div
              className="omni-confirm-dialog omni-tools-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="plugin-marketplace-tools-title"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="omni-tools-dialog__header">
                <div>
                  <div
                    className="omni-confirm-dialog__title omni-tools-dialog__title"
                    id="plugin-marketplace-tools-title"
                  >
                    {toolsDialog.connectorName} 的工具
                  </div>
                  <div className="omni-tools-dialog__subtitle">
                    {toolsDialog.loading
                      ? "正在加载…"
                      : `${toolsDialog.tools.length} 个工具已暴露给 AI 调用`}
                  </div>
                </div>
                <button
                  type="button"
                  className="omni-tools-dialog__close"
                  onClick={() => setToolsDialog(null)}
                  aria-label="关闭"
                >
                  <X size={18} strokeWidth={1.8} />
                </button>
              </div>
              <div className="omni-tools-dialog__body">
                {toolsDialog.error ? (
                  <div className="omni-tools-dialog__error">
                    <AlertTriangle size={16} strokeWidth={1.8} />
                    <span>{toolsDialog.error}</span>
                  </div>
                ) : toolsDialog.loading ? (
                  <div className="omni-tools-dialog__loading">
                    正在获取工具列表…
                  </div>
                ) : toolsDialog.tools.length === 0 ? (
                  <div className="omni-tools-dialog__empty">
                    该连接器未暴露任何工具。
                  </div>
                ) : (
                  <ul className="omni-tools-dialog__list">
                    {toolsDialog.tools.map((tool) => (
                      <li key={tool.name} className="omni-tools-dialog__item">
                        <div className="omni-tools-dialog__item-name">
                          {tool.name}
                        </div>
                        <div className="omni-tools-dialog__item-desc">
                          {tool.description || "无描述"}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="omni-confirm-dialog__actions omni-tools-dialog__actions">
                <button
                  type="button"
                  className="omni-confirm-dialog__button omni-confirm-dialog__button--primary"
                  onClick={() => setToolsDialog(null)}
                >
                  关闭
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

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
