// 右侧「产物」聚合抽屉：按项目汇总 AI 产出的交付内容，可打开/预览/定位来源会话/删除
import { useCallback, useEffect, useState } from "react";
import { ChevronRight, FolderOpen, FolderSearch, Inbox, MessageSquare, Trash2, X } from "lucide-react";
import type { Artifact } from "../chat/artifacts";
import {
  ARTIFACTS_CHANGED_EVENT,
  ARTIFACT_TYPE_LABEL,
  artifactsForProject,
  clearProjectArtifacts,
  notifyArtifactsChanged,
  removeArtifact,
} from "../chat/artifacts";
import { ArtifactTypeIcon } from "./artifacts/ArtifactIcon";
import { checkArtifactPath, openArtifactPath, revealArtifactPath } from "./ArtifactCards";

interface ArtifactsPanelProps {
  projectId: string | null;
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

export default function ArtifactsPanel({ projectId, onClose, onJumpToSession }: ArtifactsPanelProps) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setArtifacts(projectId ? artifactsForProject(projectId) : []);
  }, [projectId]);

  useEffect(() => {
    refresh();
    window.addEventListener(ARTIFACTS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(ARTIFACTS_CHANGED_EVENT, refresh);
  }, [refresh]);

  /** 删除单条产物（元数据记录，删除后不可恢复） */
  const handleDelete = (artifact: Artifact) => {
    removeArtifact(artifact.id);
    notifyArtifactsChanged();
    setArtifacts((prev) => prev.filter((a) => a.id !== artifact.id));
    if (expandedId === artifact.id) setExpandedId(null);
  };

  /** 清空当前项目的全部产物 */
  const handleClearAll = () => {
    if (!projectId || artifacts.length === 0) return;
    if (!window.confirm(`确定清空当前项目的全部 ${artifacts.length} 项产物吗？删除后不可恢复。`)) return;
    clearProjectArtifacts(projectId);
    notifyArtifactsChanged();
    setArtifacts([]);
    setExpandedId(null);
  };

  /** 打开产物文件：先校验路径存在，失败给出明确提示（不静默） */
  const handleOpenArtifact = useCallback(
    async (artifact: Artifact) => {
      const path = artifact.path;
      if (!path) return;
      const exists = await checkArtifactPath(path);
      if (!exists) {
        window.alert("文件不存在：产物路径可能是虚拟路径，或文件已被移动/删除。");
        return;
      }
      const ok = await openArtifactPath(path);
      if (!ok) window.alert("打开失败：系统无法用默认应用打开该文件。");
    },
    []
  );

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

  return (
    <aside className="artifacts-panel">
      <div className="artifacts-panel__header">
        <div className="artifacts-panel__title">
          <strong>产物</strong>
          <span>{artifacts.length} 项</span>
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

      <div className="artifacts-panel__body">
        {artifacts.length === 0 ? (
          <div className="artifacts-panel__empty">
            <Inbox size={26} strokeWidth={1.4} />
            <p>暂无产物</p>
            <span>让 AI 导出文档、抓取网页或安装技能后，成果会出现在这里</span>
          </div>
        ) : (
          <ul className="artifacts-panel__list">
            {artifacts.map((artifact) => {
              const expanded = expandedId === artifact.id;
              const canOpen = Boolean(artifact.path);
              const canExpand = Boolean(artifact.content);
              return (
                <li key={artifact.id} className="artifacts-panel__item">
                  <div className="artifacts-panel__item-row">
                    <span className="artifacts-panel__item-icon">
                      <ArtifactTypeIcon type={artifact.type} size={16} />
                    </span>
                    <button
                      type="button"
                      className="artifacts-panel__item-main"
                      title={artifact.title}
                      onClick={() => {
                        if (canExpand) {
                          setExpandedId(expanded ? null : artifact.id);
                        } else if (canOpen) {
                          void handleOpenArtifact(artifact);
                        }
                      }}
                    >
                      <strong>{artifact.title}</strong>
                      <span>
                        {ARTIFACT_TYPE_LABEL[artifact.type]}
                        {artifact.size ? ` · ${(artifact.size / 1024).toFixed(1)} KB` : ""} · {formatRelativeTime(artifact.createdAt)}
                      </span>
                    </button>
                    {canOpen ? (
                      <button
                        type="button"
                        className="artifacts-panel__item-action"
                        title="打开文件"
                        aria-label="打开文件"
                        onClick={() => void handleOpenArtifact(artifact)}
                      >
                        <FolderOpen size={14} strokeWidth={1.9} />
                      </button>
                    ) : null}
                    {canOpen ? (
                      <button
                        type="button"
                        className="artifacts-panel__item-action"
                        title="在文件夹中显示"
                        aria-label="在文件夹中显示"
                        onClick={() => void handleRevealArtifact(artifact)}
                      >
                        <FolderSearch size={14} strokeWidth={1.9} />
                      </button>
                    ) : null}
                    {artifact.sessionId ? (
                      <button
                        type="button"
                        className="artifacts-panel__item-action"
                        title="定位到来源会话"
                        aria-label="定位到来源会话"
                        onClick={() => onJumpToSession(artifact.sessionId as string)}
                      >
                        <MessageSquare size={14} strokeWidth={1.9} />
                      </button>
                    ) : null}
                    {canExpand ? (
                      <ChevronRight size={14} strokeWidth={2} className={`artifacts-panel__item-chevron ${expanded ? "artifacts-panel__item-chevron--open" : ""}`} />
                    ) : null}
                    <button
                      type="button"
                      className="artifacts-panel__item-action artifacts-panel__item-action--danger"
                      title="删除该产物"
                      aria-label="删除该产物"
                      onClick={() => handleDelete(artifact)}
                    >
                      <Trash2 size={14} strokeWidth={1.9} />
                    </button>
                  </div>
                  {expanded && canExpand ? (
                    <pre className="artifacts-panel__item-preview">{artifact.content}</pre>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
