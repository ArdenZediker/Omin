// 右侧「产物」聚合抽屉：按项目/会话汇总 AI 产出的交付内容，
// 以「概览 + 可关闭文件标签」呈现。概览展示产物统计与最近列表；
// 点击产物打开为文件标签，支持关闭；全部关闭后边栏 reopen 默认回概览。
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { Check, Copy, ExternalLink, FolderOpen, FolderSearch, Inbox, LayoutGrid, MessageSquare, Trash2, X } from "lucide-react";
import { formatFileSize } from "./attachmentFormat";
import type { Artifact, ArtifactPanelState, ArtifactType } from "../chat/artifacts";
import {
  ARTIFACTS_CHANGED_EVENT,
  ARTIFACT_TYPE_LABEL,
  artifactsForSession,
  clearSessionArtifacts,
  consumePendingOpenArtifactId,
  consumePendingOpenArtifactLine,
  loadArtifactPanelState,
  notifyArtifactsChanged,
  OPEN_ARTIFACT_EVENT,
  removeArtifact,
  saveArtifactPanelState,
} from "../chat/artifacts";
import { ArtifactTypeIcon } from "./artifacts/ArtifactIcon";
import { checkArtifactPath, openArtifactPath, openArtifactUrl, revealArtifactPath } from "./ArtifactCards";
import { canPreviewWithViewer } from "./FilePreview";

/** file-viewer 预览组件懒加载：Office 家族文件预览时才拉起对应 chunk */
const FilePreview = lazy(() => import("./FilePreview"));

/** 可在面板内以文本（<pre>）预览的扩展名 */
const TEXT_PREVIEW_EXTS = new Set([
  "md", "markdown", "txt", "text", "log", "json", "jsonc", "csv", "tsv",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java", "c", "h",
  "cpp", "hpp", "cc", "cs", "rb", "php", "swift", "kt", "kts", "scala", "sh",
  "bash", "zsh", "yml", "yaml", "toml", "xml", "html", "htm", "css", "scss",
  "less", "sql", "ini", "cfg", "conf", "properties", "env", "lock", "gitignore",
  "dockerfile", "makefile", "vue", "svelte", "r", "pl", "lua", "dart", "ex",
  "exs", "erl", "clj", "hs", "nim", "zig", "wasm", "proto", "graphql", "diff",
]);

/** 可在面板内以图片（<img>）预览的扩展名 */
const IMAGE_PREVIEW_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif",
]);

function extOf(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx >= 0 ? path.slice(idx + 1).toLowerCase() : "";
}

interface ArtifactsPanelProps {
  projectId: string | null;
  /** 当前会话 id：产物严格按 projectId + sessionId 双重维度隔离 */
  sessionId: string | null;
  /** 关闭按钮回调：传入则渲染关闭按钮（如用作独立抽屉），不传则隐藏（嵌入其他面板时） */
  onClose?: () => void;
  onJumpToSession: (sessionId: string) => void;
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

const OVERVIEW_ID = "overview";

export default function ArtifactsPanel({ projectId, sessionId, onClose, onJumpToSession }: ArtifactsPanelProps) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [panelState, setPanelState] = useState<ArtifactPanelState>(loadArtifactPanelState);
  /** 打开产物请求携带的行号定位（/search_files 命中行跳转）：传给预览组件滚动定位 */
  const [revealLine, setRevealLine] = useState<{ artifactId: string; line: number } | null>(null);
  const [viewMode, setViewMode] = useState<"preview" | "source">("preview");
  const [copied, setCopied] = useState(false);
  const [pathCopied, setPathCopied] = useState(false);

  // 仅含 path 的本地文件产物：按需读取内容 / 转换图片预览源
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [imageSrc, setImageSrc] = useState<string | null>(null);

  const { activeTabId, openArtifactIds } = panelState;

  const refresh = useCallback(() => {
    // 产物按「项目 + 会话」严格隔离：当前会话只显示本会话的产物
    setArtifacts(artifactsForSession(projectId, sessionId));
  }, [projectId, sessionId]);

  useEffect(() => {
    refresh();
    window.addEventListener(ARTIFACTS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(ARTIFACTS_CHANGED_EVENT, refresh);
  }, [refresh]);

  // 产物列表变化时：清理已不存在的打开标签；激活项失效时回退概览。
  useEffect(() => {
    setPanelState((prev) => {
      const ids = new Set(artifacts.map((a) => a.id));
      const nextOpen = prev.openArtifactIds.filter((id) => ids.has(id));
      let nextActive = prev.activeTabId;

      if (nextActive !== OVERVIEW_ID && !ids.has(nextActive)) {
        nextActive = nextOpen.length > 0 ? nextOpen[nextOpen.length - 1] : OVERVIEW_ID;
      }
      if (nextOpen.length === 0) {
        nextActive = OVERVIEW_ID;
      }

      const changed =
        nextOpen.length !== prev.openArtifactIds.length ||
        nextOpen.some((id, index) => id !== prev.openArtifactIds[index]) ||
        nextActive !== prev.activeTabId;

      return changed ? { activeTabId: nextActive, openArtifactIds: nextOpen } : prev;
    });
  }, [artifacts]);

  const openArtifactTab = useCallback((artifact: Artifact) => {
    setPanelState((prev) => {
      if (prev.openArtifactIds.includes(artifact.id)) {
        return { ...prev, activeTabId: artifact.id };
      }
      return {
        activeTabId: artifact.id,
        openArtifactIds: [...prev.openArtifactIds, artifact.id],
      };
    });
  }, []);

  const openArtifactById = useCallback(
    (artifactId: string) => {
      const target = artifactsForSession(projectId, sessionId).find((a) => a.id === artifactId);
      if (target) openArtifactTab(target);
    },
    [projectId, sessionId, openArtifactTab],
  );

  // 挂载时消费通过 requestOpenArtifactInPanel 积累的待打开产物 id（及配对行号）；
  // 同时监听运行时请求，让消息中的产物卡片点击也能在面板内打开。
  useEffect(() => {
    const pendingId = consumePendingOpenArtifactId();
    const pendingLine = consumePendingOpenArtifactLine();
    if (pendingId) {
      if (pendingLine) setRevealLine({ artifactId: pendingId, line: pendingLine });
      openArtifactById(pendingId);
    }

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ artifactId: string; line?: number | null }>).detail;
      if (detail?.artifactId) {
        if (typeof detail.line === "number" && detail.line >= 1) {
          setRevealLine({ artifactId: detail.artifactId, line: detail.line });
        }
        openArtifactById(detail.artifactId);
      }
    };
    window.addEventListener(OPEN_ARTIFACT_EVENT, handler);
    return () => window.removeEventListener(OPEN_ARTIFACT_EVENT, handler);
  }, [openArtifactById]);

  // 持久化面板状态
  useEffect(() => {
    saveArtifactPanelState(panelState);
  }, [panelState]);

  const openArtifacts = useMemo(
    () => openArtifactIds.map((id) => artifacts.find((a) => a.id === id)).filter((a): a is Artifact => Boolean(a)),
    [artifacts, openArtifactIds]
  );

  const activeArtifact = activeTabId === OVERVIEW_ID ? null : artifacts.find((a) => a.id === activeTabId) ?? null;

  // 切换产物时复位复制状态
  useEffect(() => {
    setCopied(false);
    setPathCopied(false);
  }, [activeTabId]);

  // 选中「仅含 path」的本地文件产物时：图片转 asset URL，文本读内容做内联预览。
  // 有 content 的文本类产物走上方 markdown 渲染，不经过这里。
  useEffect(() => {
    let cancelled = false;
    setFileContent(null);
    setFileError(null);
    setImageSrc(null);
    setFileLoading(false);
    const path = activeArtifact?.path;
    if (!path) return;
    const ext = extOf(path);
    if (IMAGE_PREVIEW_EXTS.has(ext)) {
      try {
        setImageSrc(convertFileSrc(path));
      } catch {
        setFileError("无法生成本地图片预览链接");
      }
      return;
    }
    if (TEXT_PREVIEW_EXTS.has(ext)) {
      setFileLoading(true);
      invoke<string>("read_workspace_file", {
        projectPath: null,
        path,
        maxChars: 200_000,
      })
        .then((text) => {
          if (!cancelled) setFileContent(text);
        })
        .catch((e) => {
          if (!cancelled) setFileError(typeof e === "string" ? e : String(e ?? "读取失败"));
        })
        .finally(() => {
          if (!cancelled) setFileLoading(false);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [activeArtifact?.id, activeArtifact?.path]);

  const closeArtifactTab = useCallback((event: React.MouseEvent, artifactId: string) => {
    event.stopPropagation();
    setPanelState((prev) => {
      const nextOpen = prev.openArtifactIds.filter((id) => id !== artifactId);
      let nextActive = prev.activeTabId;
      if (prev.activeTabId === artifactId) {
        nextActive = nextOpen.length > 0 ? nextOpen[nextOpen.length - 1] : OVERVIEW_ID;
      }
      return { activeTabId: nextActive, openArtifactIds: nextOpen };
    });
  }, []);

  const switchToOverview = useCallback(() => {
    setPanelState((prev) => ({ ...prev, activeTabId: OVERVIEW_ID }));
  }, []);

  /** 删除单条产物（元数据记录，删除后不可恢复） */
  const handleDelete = (artifact: Artifact) => {
    removeArtifact(artifact.id);
    notifyArtifactsChanged();
    setArtifacts((prev) => prev.filter((a) => a.id !== artifact.id));
  };

  /** 清空当前会话的全部产物 */
  const handleClearAll = () => {
    if (!artifacts.length || !sessionId) return;
    if (!window.confirm(`确定清空当前会话的全部 ${artifacts.length} 项产物吗？删除后不可恢复。`)) return;
    clearSessionArtifacts(projectId, sessionId);
    notifyArtifactsChanged();
    setArtifacts([]);
  };

  /** 打开产物文件：先校验路径存在，失败给出明确提示（不静默） */
  const handleOpenArtifact = useCallback(async (artifact: Artifact) => {
    const path = artifact.path;
    if (!path) return;
    const exists = await checkArtifactPath(path);
    if (!exists) {
      window.alert("文件不存在：产物路径可能是虚拟路径，或文件已被移动/删除。");
      return;
    }
    const ok = await openArtifactPath(path);
    if (!ok) window.alert("打开失败：系统无法用默认应用打开该文件。");
  }, []);

  /** 在系统文件管理器中显示产物所在位置 */
  const handleRevealArtifact = useCallback(async (artifact: Artifact) => {
    const path = artifact.path;
    if (!path) return;
    const exists = await checkArtifactPath(path);
    if (!exists) {
      window.alert("文件不存在：产物路径可能是虚拟路径，或文件已被移动/删除。");
      return;
    }
    const ok = await revealArtifactPath(path);
    if (!ok) window.alert("定位失败：文件可能已被移动或删除。");
  }, []);

  /** 用系统默认浏览器打开网页/搜索类产物的 URL */
  const handleOpenUrl = useCallback(async (artifact: Artifact) => {
    const url = artifact.url;
    if (!url) return;
    const ok = await openArtifactUrl(url);
    if (!ok) window.alert("打开失败：系统无法启动默认浏览器打开该链接。");
  }, []);

  const handleCopy = (artifact: Artifact) => {
    if (!artifact.content) return;
    void navigator.clipboard.writeText(artifact.content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  const handleCopyPath = (artifact: Artifact) => {
    if (!artifact.path) return;
    void navigator.clipboard.writeText(artifact.path).then(() => {
      setPathCopied(true);
      window.setTimeout(() => setPathCopied(false), 1200);
    });
  };

  const typeBreakdown = useMemo(() => {
    const map = new Map<ArtifactType, number>();
    artifacts.forEach((a) => {
      map.set(a.type, (map.get(a.type) ?? 0) + 1);
    });
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [artifacts]);

  const overviewList = artifacts.length === 0 ? (
    <div className="artifacts-panel__empty">
      <Inbox size={26} strokeWidth={1.4} />
      <p>暂无产物</p>
      <span>让 AI 导出文档、抓取网页或安装技能后，成果会出现在这里</span>
    </div>
  ) : (
    <ul className="artifacts-panel__list">
      {artifacts.map((artifact) => (
        <li key={artifact.id} className="artifacts-panel__item">
          <div className="artifacts-panel__item-row">
            <span className="artifacts-panel__item-icon">
              <ArtifactTypeIcon type={artifact.type} size={15} />
            </span>
            <button type="button" className="artifacts-panel__item-main" title={artifact.title} onClick={() => openArtifactTab(artifact)}>
              <strong>{artifact.title}</strong>
              <span>
                {ARTIFACT_TYPE_LABEL[artifact.type]}
                {artifact.size ? ` · ${formatFileSize(artifact.size)}` : ""}
                {" · "}{formatRelativeTime(artifact.createdAt)}
              </span>
            </button>
            <button
              type="button"
              className="artifacts-panel__item-action artifacts-panel__item-action--danger"
              title="删除该产物"
              aria-label="删除该产物"
              onClick={() => handleDelete(artifact)}
            >
              <Trash2 size={13} strokeWidth={2} />
            </button>
          </div>
        </li>
      ))}
    </ul>
  );

  return (
    <aside className="artifacts-panel">
      <div className="artifacts-panel__header">
        <div className="artifacts-panel__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTabId === OVERVIEW_ID}
            className={`artifacts-panel__tab ${activeTabId === OVERVIEW_ID ? "artifacts-panel__tab--active" : ""}`}
            title="产物概览"
            onClick={switchToOverview}
          >
            <LayoutGrid size={12} strokeWidth={2} />
            <span className="artifacts-panel__tab-label">概览</span>
          </button>
          {openArtifacts.map((artifact) => (
            <button
              key={artifact.id}
              type="button"
              role="tab"
              aria-selected={artifact.id === activeTabId}
              className={`artifacts-panel__tab ${artifact.id === activeTabId ? "artifacts-panel__tab--active" : ""}`}
              title={artifact.title}
              onClick={() => openArtifactTab(artifact)}
            >
              <ArtifactTypeIcon type={artifact.type} size={11} />
              <span className="artifacts-panel__tab-label">{artifact.title}</span>
              <span
                className="artifacts-panel__tab-close"
                role="button"
                aria-label={`关闭 ${artifact.title}`}
                title={`关闭 ${artifact.title}`}
                onClick={(event) => closeArtifactTab(event, artifact.id)}
              >
                <X size={11} strokeWidth={2} />
              </span>
            </button>
          ))}
        </div>
        <div className="artifacts-panel__header-actions">
          {artifacts.length > 0 ? (
            <button type="button" className="artifacts-panel__clear" title="清空当前项目全部产物" onClick={handleClearAll}>
              <Trash2 size={13} strokeWidth={2} />
              <span>清空</span>
            </button>
          ) : null}
          {onClose ? (
            <button type="button" className="artifacts-panel__close" title="关闭产物面板" aria-label="关闭产物面板" onClick={onClose}>
              <X size={15} strokeWidth={2} />
            </button>
          ) : null}
        </div>
      </div>

      {activeTabId === OVERVIEW_ID ? (
        <div className="artifacts-panel__overview">
          {artifacts.length > 0 && (
            <div className="artifacts-panel__overview-summary">
              <div className="artifacts-panel__overview-stat">
                <strong>{artifacts.length}</strong>
                <span>全部产物</span>
              </div>
              {typeBreakdown.slice(0, 4).map(([type, count]) => (
                <div key={type} className="artifacts-panel__overview-stat">
                  <strong>{count}</strong>
                  <span>{ARTIFACT_TYPE_LABEL[type]}</span>
                </div>
              ))}
            </div>
          )}
          <div className="artifacts-panel__overview-body">
            {overviewList}
          </div>
        </div>
      ) : activeArtifact ? (
        <div className="artifacts-panel__preview">
          <div className="artifacts-panel__preview-head">
            <div className="artifacts-panel__preview-title" title={activeArtifact.title}>
              {activeArtifact.title}
            </div>
            {activeArtifact.content ? (
              <div className="artifacts-panel__view-toggle" role="group" aria-label="预览模式">
                <button
                  type="button"
                  className={viewMode === "preview" ? "active" : ""}
                  onClick={() => setViewMode("preview")}
                >
                  预览
                </button>
                <button
                  type="button"
                  className={viewMode === "source" ? "active" : ""}
                  onClick={() => setViewMode("source")}
                >
                  源代码
                </button>
              </div>
            ) : null}
          </div>

          <div className="artifacts-panel__preview-toolbar">
            <div className="artifacts-panel__preview-meta">
              <ArtifactTypeIcon type={activeArtifact.type} size={12} />
              <span>{ARTIFACT_TYPE_LABEL[activeArtifact.type]}</span>
              {activeArtifact.size ? <span>· {formatFileSize(activeArtifact.size)}</span> : null}
              <span>· {formatRelativeTime(activeArtifact.createdAt)}</span>
            </div>
            <div className="artifacts-panel__preview-actions">
              {activeArtifact.path ? (
                <>
                  <button type="button" title="打开文件" aria-label="打开文件" onClick={() => void handleOpenArtifact(activeArtifact)}>
                    <FolderOpen size={14} strokeWidth={1.9} />
                  </button>
                  <button type="button" title="在文件夹中显示" aria-label="在文件夹中显示" onClick={() => void handleRevealArtifact(activeArtifact)}>
                    <FolderSearch size={14} strokeWidth={1.9} />
                  </button>
                  <button
                    type="button"
                    title={pathCopied ? "路径已复制" : "复制路径"}
                    aria-label={pathCopied ? "路径已复制" : "复制路径"}
                    onClick={() => handleCopyPath(activeArtifact)}
                  >
                    {pathCopied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.9} />}
                  </button>
                </>
              ) : null}
              {activeArtifact.url ? (
                <button type="button" title="在浏览器打开" aria-label="在浏览器打开" onClick={() => void handleOpenUrl(activeArtifact)}>
                  <ExternalLink size={14} strokeWidth={1.9} />
                </button>
              ) : null}
              {activeArtifact.content ? (
                <button type="button" title={copied ? "已复制" : "复制内容"} aria-label={copied ? "已复制" : "复制内容"} onClick={() => handleCopy(activeArtifact)}>
                  {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.9} />}
                </button>
              ) : null}
              {activeArtifact.sessionId ? (
                <button type="button" title="定位到来源会话" aria-label="定位到来源会话" onClick={() => onJumpToSession(activeArtifact.sessionId as string)}>
                  <MessageSquare size={14} strokeWidth={1.9} />
                </button>
              ) : null}
              <button
                type="button"
                className="artifacts-panel__preview-action--danger"
                title="删除该产物"
                aria-label="删除该产物"
                onClick={() => handleDelete(activeArtifact)}
              >
                <Trash2 size={14} strokeWidth={1.9} />
              </button>
            </div>
          </div>

          <div className="artifacts-panel__preview-body">
            {activeArtifact.content ? (
              viewMode === "source" ? (
                <pre className="artifacts-panel__source">{activeArtifact.content}</pre>
              ) : (
                <div className="artifacts-panel__markdown">
                  <Markdown remarkPlugins={[remarkGfm]}>{activeArtifact.content}</Markdown>
                </div>
              )
            ) : activeArtifact.path ? (
              imageSrc ? (
                <div className="artifacts-panel__image-wrap">
                  <img src={imageSrc} alt={activeArtifact.title} className="artifacts-panel__image" />
                </div>
              ) : fileLoading ? (
                <p className="artifacts-panel__empty-hint">正在读取文件…</p>
              ) : fileError ? (
                <div className="artifacts-panel__fileinfo">
                  <p>无法预览该文件：{fileError}</p>
                  <code>{activeArtifact.path}</code>
                </div>
              ) : fileContent !== null ? (
                <pre className="artifacts-panel__source">{fileContent}</pre>
              ) : activeArtifact.path && canPreviewWithViewer(activeArtifact.title) ? (
                <Suspense fallback={<p className="artifacts-panel__empty-hint">正在加载预览组件…</p>}>
                  <FilePreview
                    key={
                      revealLine?.artifactId === activeArtifact.id
                        ? `${activeArtifact.id}:L${revealLine.line}`
                        : activeArtifact.id
                    }
                    path={activeArtifact.path}
                    title={activeArtifact.title}
                    size={activeArtifact.size}
                    initialLine={revealLine?.artifactId === activeArtifact.id ? revealLine.line : undefined}
                  />
                </Suspense>
              ) : (
                <div className="artifacts-panel__fileinfo">
                  <p>这是二进制文件，面板内无法预览，点击下方按钮用系统应用打开，或在文件管理器中定位。</p>
                  <code>{activeArtifact.path}</code>
                </div>
              )
            ) : activeArtifact.url ? (
              <div className="artifacts-panel__fileinfo">
                <p>外部链接产物：</p>
                <a href={activeArtifact.url} target="_blank" rel="noreferrer">
                  {activeArtifact.url}
                </a>
              </div>
            ) : (
              <p className="artifacts-panel__empty-hint">该产物无可预览内容。</p>
            )}
          </div>
        </div>
      ) : (
        <div className="artifacts-panel__overview">
          <div className="artifacts-panel__empty">
            <Inbox size={26} strokeWidth={1.4} />
            <p>标签已关闭</p>
            <span>在概览中点击产物即可重新打开</span>
          </div>
        </div>
      )}
    </aside>
  );
}
