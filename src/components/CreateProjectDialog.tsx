import { useCallback, useEffect, useMemo, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { X, Plus, Puzzle, Bot, Cable, Wand2, ChevronDown, FolderOpen } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { ProjectDraft } from "../chat/types";
import { RECOMMENDED_PROJECT_PRESETS } from "../config/manifests/projects";
import { pluginRegistry } from "../plugins/registry";
import type { PluginManifest } from "../plugins/types";
import PluginMarketplace from "./plugins/PluginMarketplace";

export type CreateProjectDialogProps = {
  open: boolean;
  onClose: () => void;
  onCreate: (draft: ProjectDraft) => void;
};

type PickedPlugins = {
  connectors: PluginManifest[];
  experts: PluginManifest[];
  skills: PluginManifest[];
};

export default function CreateProjectDialog({ open, onClose, onCreate }: CreateProjectDialogProps) {
  const [title, setTitle] = useState("");
  const [instruction, setInstruction] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [picked, setPicked] = useState<PickedPlugins>({ connectors: [], experts: [], skills: [] });
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);
  const [marketplaceKind, setMarketplaceKind] = useState<"connector" | "expert" | "skill" | null>(null);

  useEffect(() => {
    if (open) {
      setTitle("");
      setInstruction("");
      setWorkspacePath("");
      setSelectedTemplateId("");
      setPicked({ connectors: [], experts: [], skills: [] });
    }
  }, [open]);

  const templateOptions = useMemo(() => {
    return [{ id: "", title: "无模板" }, ...RECOMMENDED_PROJECT_PRESETS];
  }, []);

  const applyTemplate = useCallback((templateId: string) => {
    setSelectedTemplateId(templateId);
    if (!templateId) {
      setInstruction("");
      return;
    }
    const template = pluginRegistry.listTemplates().find((m) => m.id === templateId);
    if (template?.templatePrompt) {
      setInstruction(template.templatePrompt);
    } else {
      const preset = RECOMMENDED_PROJECT_PRESETS.find((p) => p.id === templateId);
      setInstruction(preset?.description ?? "");
    }
  }, []);

  const addPicked = useCallback((kind: keyof PickedPlugins, manifest: PluginManifest) => {
    setPicked((current) => {
      if (current[kind].some((item) => item.id === manifest.id)) return current;
      return { ...current, [kind]: [...current[kind], manifest] };
    });
  }, []);

  const removePicked = useCallback((kind: keyof PickedPlugins, id: string) => {
    setPicked((current) => ({
      ...current,
      [kind]: current[kind].filter((item) => item.id !== id),
    }));
  }, []);

  const handleAddClick = (kind: "connector" | "expert" | "skill") => {
    setMarketplaceKind(kind);
    setMarketplaceOpen(true);
  };

  const handleMarketplacePick = (manifest: PluginManifest) => {
    if (marketplaceKind) {
      const kindMap: Record<NonNullable<typeof marketplaceKind>, keyof PickedPlugins> = {
        connector: "connectors",
        expert: "experts",
        skill: "skills",
      };
      addPicked(kindMap[marketplaceKind], manifest);
    }
    setMarketplaceOpen(false);
    setMarketplaceKind(null);
  };

  const handleConfirm = () => {
    const draft: ProjectDraft = {
      title: title.trim() || "新项目",
      systemPrompt: instruction.trim(),
      workspacePath: workspacePath.trim() || undefined,
      allowedToolIds: [
        ...new Set([
          ...picked.connectors.flatMap((m) => m.defaultToolIds ?? []),
          ...picked.experts.flatMap((m) => m.defaultToolIds ?? []),
          ...picked.skills.flatMap((m) => m.defaultToolIds ?? []),
        ]),
      ],
      allowedSkillIds: [
        ...new Set([
          ...picked.experts.flatMap((m) => m.defaultSkillIds ?? []),
          ...picked.skills.map((m) => m.id),
        ]),
      ],
    };
    onCreate(draft);
    onClose();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  };

  if (!open) return null;

  return (
    <>
      <div className="omni-dialog-backdrop" onClick={onClose} />
      <div className="omni-dialog omni-dialog--create-project" role="dialog" aria-modal="true" aria-labelledby="create-project-title">
        <div className="omni-dialog__header">
          <h2 id="create-project-title">新建项目</h2>
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
            <div className="omni-dialog__label-row">
              <span className="omni-dialog__label">指令</span>
              <div className="omni-dialog__template-dropdown">
                <button type="button" className="omni-dialog__template-trigger">
                  <span>选择模板</span>
                  <ChevronDown size={14} strokeWidth={1.8} />
                </button>
                <div className="omni-dialog__template-menu">
                  {templateOptions.map((option) => (
                    <button
                      key={option.id || "none"}
                      type="button"
                      className={selectedTemplateId === option.id ? "omni-dialog__template-item--active" : ""}
                      onClick={() => applyTemplate(option.id)}
                    >
                      {option.title}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <textarea
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="提供当前项目的背景信息和规范，让 Omni 的回复更精准、更符合要求。比如：项目目标、团队习惯、风格偏好、输出约束等"
              rows={5}
            />
          </label>

          <div className="omni-dialog__field omni-dialog__field--workspace">
            <span className="omni-dialog__label">工作目录（可选）</span>
            <div className="omni-dialog__workspace-row">
              <input
                value={workspacePath}
                readOnly
                placeholder="未选择工作目录"
              />
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

          <PickedPluginRow
            icon={<Cable size={16} strokeWidth={1.8} />}
            label="连接器"
            hint="可选"
            items={picked.connectors}
            onAdd={() => handleAddClick("connector")}
            onRemove={(id) => removePicked("connectors", id)}
          />

          <PickedPluginRow
            icon={<Bot size={16} strokeWidth={1.8} />}
            label="专家"
            hint="可选"
            items={picked.experts}
            onAdd={() => handleAddClick("expert")}
            onRemove={(id) => removePicked("experts", id)}
          />

          <PickedPluginRow
            icon={<Wand2 size={16} strokeWidth={1.8} />}
            label="技能"
            hint="可选"
            items={picked.skills}
            onAdd={() => handleAddClick("skill")}
            onRemove={(id) => removePicked("skills", id)}
          />

          <p className="omni-dialog__hint">切换模版会覆盖当前编辑内容</p>
        </div>

        <div className="omni-dialog__footer">
          <button type="button" className="omni-dialog__button omni-dialog__button--secondary" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="omni-dialog__button omni-dialog__button--primary"
            onClick={handleConfirm}
            disabled={!title.trim()}
          >
            确定
          </button>
        </div>
      </div>

      {marketplaceOpen && marketplaceKind && (
        <PluginMarketplace
          initialFilter={{ kind: marketplaceKind }}
          onPick={handleMarketplacePick}
          onClose={() => {
            setMarketplaceOpen(false);
            setMarketplaceKind(null);
          }}
        />
      )}
    </>
  );
}

type PickedPluginRowProps = {
  icon: React.ReactNode;
  label: string;
  hint: string;
  items: PluginManifest[];
  onAdd: () => void;
  onRemove: (id: string) => void;
};

function PickedPluginRow({ icon, label, hint, items, onAdd, onRemove }: PickedPluginRowProps) {
  return (
    <div className="omni-dialog__plugin-row">
      <div className="omni-dialog__plugin-row-header">
        <div className="omni-dialog__plugin-row-title">
          {icon}
          <span>{label}</span>
          <span className="omni-dialog__plugin-row-hint">（{hint}）</span>
        </div>
        <button type="button" className="omni-dialog__plugin-add" onClick={onAdd}>
          <Plus size={14} strokeWidth={1.9} />
          <span>添加</span>
        </button>
      </div>
      {items.length > 0 && (
        <div className="omni-dialog__plugin-chips">
          {items.map((item) => (
            <span key={item.id} className="omni-dialog__plugin-chip">
              <Puzzle size={12} strokeWidth={1.8} />
              <span>{item.name}</span>
              <button type="button" onClick={() => onRemove(item.id)} aria-label={`移除 ${item.name}`}>
                <X size={12} strokeWidth={1.8} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
