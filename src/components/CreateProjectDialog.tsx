import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { X, Plus, Puzzle, Bot, Cable, Wand2, ChevronDown, FolderOpen } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { ProjectDraft } from "../chat/types";
import { pluginRegistry } from "../plugins/registry";
import type { PluginManifest } from "../plugins/types";
import PluginMarketplace from "./plugins/PluginMarketplace";

export type CreateProjectDialogProps = {
  open: boolean;
  onClose: () => void;
  onCreate: (draft: ProjectDraft) => void;
  /**
   * 打开时预选的**项目预设** id（来自扩展中心「用它新建项目」）。
   * 不传 / 传 null 即普通新建项目，用户自行从下拉里选。
   */
  initialTemplateId?: string | null;
};

type PickedPlugins = {
  connectors: PluginManifest[];
  experts: PluginManifest[];
  skills: PluginManifest[];
};

export default function CreateProjectDialog({
  open,
  onClose,
  onCreate,
  initialTemplateId,
}: CreateProjectDialogProps) {
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

  // 预设选项的**唯一事实来源**就是注册表（`kind:"template"`）。
  // 曾经这里读 `RECOMMENDED_PROJECT_PRESETS`（另一份同名、同描述的硬编码副本），
  // 而指令正文却去 `pluginRegistry.listTemplates()` 取 —— 两份定义必须手工同步，
  // 改一侧就静默失配（下拉还列着，指令悄悄变成一句描述）。现只留注册表这一份。
  // 订阅理由同 PluginMarketplace：注册表是渲染进程模块级单例，变更可能发生在
  // 本组件之外，靠自身 handler 刷新必漏。snapshot 是递增数字（原始值），不会
  // 像返回新数组那样把 React 推进无限重渲染。
  const templateVersion = useSyncExternalStore(
    (listener) => pluginRegistry.subscribe(listener),
    () => pluginRegistry.getVersion(),
  );

  const templateOptions = useMemo(() => {
    // 快照本身不参与计算，只用于把这份列表钉在注册表版本上（否则装了/卸了预设不刷新）。
    void templateVersion;
    return [
      { id: "", title: "无预设" },
      ...pluginRegistry.listTemplates().map((manifest) => ({
        id: manifest.id,
        title: manifest.name,
      })),
    ];
  }, [templateVersion]);

  const applyTemplate = useCallback((templateId: string) => {
    setSelectedTemplateId(templateId);
    const template = templateId
      ? pluginRegistry.listTemplates().find((m) => m.id === templateId)
      : undefined;
    // 写的是**持久项目指令** `instruction`，不是起手句 —— 后者（`starterPrompt`）
    // 是一次性的「这次想问什么」，由扩展中心卡片的「插入输入框」消费。
    setInstruction(template?.instruction ?? "");
  }, []);

  // 从扩展中心「用它新建项目」进来时预设已选定：打开即套用。
  // 必须声明在上面那条重置 effect **之后** —— 同一次提交里两个 effect 按声明顺序执行，
  // 先清空再套用；顺序反了套用的结果会被重置覆盖掉。
  useEffect(() => {
    if (open && initialTemplateId) applyTemplate(initialTemplateId);
  }, [open, initialTemplateId, applyTemplate]);

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
      // 选中的专家记为项目绑定专家：该项目会话里 agent 工具只委派给这些专家
      boundExpertIds: picked.experts.map((m) => m.id),
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
                  <span>选择预设</span>
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
            <span className="omni-dialog__label">工作目录</span>
            <div className="omni-dialog__workspace-row">
              <input
                value={workspacePath}
                readOnly
                placeholder="请选择项目工作目录"
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
            disabled={!title.trim() || !workspacePath.trim()}
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
