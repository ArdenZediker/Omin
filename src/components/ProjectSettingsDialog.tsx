import { useEffect, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { X, Plus, Bot, FolderOpen, UserCog } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Project } from "../chat/types";
import { pluginRegistry } from "../plugins/registry";
import type { PluginManifest } from "../plugins/types";
import PluginMarketplace from "./plugins/PluginMarketplace";

export type ProjectSettingsDialogProps = {
  open: boolean;
  project: Project | null;
  onClose: () => void;
  /** 提交设置补丁（useChatSessions.updateProjectProfile 透传）。 */
  onUpdate: (projectId: string, patch: Partial<Project>) => Project | null;
};

/**
 * 项目设置对话框：编辑项目名称 / 指令 / 工作目录 / 绑定专家（boundExpertIds）。
 * 与 CreateProjectDialog 的专家选择交互保持一致（chips + 扩展中心点选），
 * 但提交走 onUpdateProject 增量补丁，不重建项目。
 */
export default function ProjectSettingsDialog({ open, project, onClose, onUpdate }: ProjectSettingsDialogProps) {
  const [title, setTitle] = useState("");
  const [instruction, setInstruction] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [boundExpertIds, setBoundExpertIds] = useState<string[]>([]);
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);

  useEffect(() => {
    if (open && project) {
      setTitle(project.title);
      setInstruction(project.systemPrompt ?? "");
      setWorkspacePath(project.workspacePath ?? "");
      setBoundExpertIds([...(project.boundExpertIds ?? [])]);
    }
  }, [open, project]);

  if (!open || !project) return null;

  const boundExperts = boundExpertIds
    .map((id) => pluginRegistry.list().find((m) => m.id === id))
    .filter((m): m is PluginManifest => Boolean(m));

  const handleMarketplacePick = (manifest: PluginManifest) => {
    setBoundExpertIds((current) => (current.includes(manifest.id) ? current : [...current, manifest.id]));
    setMarketplaceOpen(false);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  };

  const handleConfirm = () => {
    onUpdate(project.id, {
      title: title.trim() || project.title,
      systemPrompt: instruction,
      workspacePath: workspacePath.trim(),
      boundExpertIds: boundExpertIds.length > 0 ? boundExpertIds : undefined,
    });
    onClose();
  };

  return (
    <>
      <div className="omni-dialog-backdrop" onClick={onClose} />
      <div className="omni-dialog omni-dialog--create-project" role="dialog" aria-modal="true" aria-labelledby="project-settings-title">
        <div className="omni-dialog__header">
          <h2 id="project-settings-title">项目设置</h2>
          <button type="button" className="omni-dialog__close" onClick={onClose} aria-label="关闭">
            <X size={18} strokeWidth={1.8} />
          </button>
        </div>

        <div className="omni-dialog__body">
          <label className="omni-dialog__field">
            <span className="omni-dialog__label">项目名称</span>
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="请输入项目名称"
              maxLength={15}
            />
            <span className="omni-dialog__counter">{title.length}/15</span>
          </label>

          <label className="omni-dialog__field">
            <span className="omni-dialog__label">指令</span>
            <textarea
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="项目背景信息与规范：项目目标、团队习惯、风格偏好、输出约束等"
              rows={5}
            />
          </label>

          <div className="omni-dialog__field omni-dialog__field--workspace">
            <span className="omni-dialog__label">工作目录</span>
            <div className="omni-dialog__workspace-row">
              <input value={workspacePath} readOnly placeholder="未设置（使用全局默认工作空间）" />
              <button
                type="button"
                onClick={async () => {
                  try {
                    const selected = await openDialog({ directory: true, title: "选择项目工作目录" });
                    if (typeof selected === "string" && selected.trim()) {
                      setWorkspacePath(selected.trim());
                    }
                  } catch {
                    // ignore
                  }
                }}
              >
                <FolderOpen size={14} strokeWidth={1.8} />
                <span>选择目录</span>
              </button>
            </div>
          </div>

          <div className="omni-dialog__plugin-row">
            <div className="omni-dialog__plugin-row-header">
              <div className="omni-dialog__plugin-row-title">
                <Bot size={16} strokeWidth={1.8} />
                <span>绑定专家</span>
                <span className="omni-dialog__plugin-row-hint">（绑定后 agent 委派只派给这些专家；留空则不限制）</span>
              </div>
              <button type="button" className="omni-dialog__plugin-add" onClick={() => setMarketplaceOpen(true)}>
                <Plus size={14} strokeWidth={1.9} />
                <span>添加</span>
              </button>
            </div>
            {boundExperts.length > 0 && (
              <div className="omni-dialog__plugin-chips">
                {boundExperts.map((expert) => (
                  <span key={expert.id} className="omni-dialog__plugin-chip">
                    <UserCog size={12} strokeWidth={1.8} />
                    <span>{expert.name}</span>
                    <button
                      type="button"
                      onClick={() => setBoundExpertIds((current) => current.filter((id) => id !== expert.id))}
                      aria-label={`移除 ${expert.name}`}
                    >
                      <X size={12} strokeWidth={1.8} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="omni-dialog__footer">
          <button type="button" className="omni-dialog__button omni-dialog__button--secondary" onClick={onClose}>
            取消
          </button>
          <button type="button" className="omni-dialog__button omni-dialog__button--primary" onClick={handleConfirm}>
            保存
          </button>
        </div>
      </div>

      {marketplaceOpen && (
        <PluginMarketplace
          initialFilter={{ kind: "expert" }}
          onPick={handleMarketplacePick}
          onClose={() => setMarketplaceOpen(false)}
        />
      )}
    </>
  );
}
