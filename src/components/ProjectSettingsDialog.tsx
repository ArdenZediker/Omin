import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { X, Bot, FolderOpen, Wand2, BookmarkPlus } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Project } from "../chat/types";
import { pluginRegistry } from "../plugins/registry";
import { saveAgentPreset } from "../plugins/agentPresets";
import { usePromptDialog } from "./PromptDialog";
import OmniSelect, { type OmniSelectOption } from "./ui/OmniSelect";
import PluginToggleRow from "./ui/PluginToggleRow";
import McpConnectorRow from "./ui/McpConnectorRow";

export type ProjectSettingsDialogProps = {
  open: boolean;
  project: Project | null;
  onClose: () => void;
  /** 提交设置补丁（useChatSessions.updateProjectProfile 透传）。 */
  onUpdate: (projectId: string, patch: Partial<Project>) => Project | null;
};

/**
 * 项目设置对话框：编辑项目名称 / 指令 / 工作目录 / 绑定专家（boundExpertIds）/ 技能白名单。
 *
 * 与 `CreateProjectDialog` 是同一件事的两个入口（建 vs 改），**字段口径必须对齐**：
 * - 能改的字段两边都有：名称、指令（含预设的「选」与「存」）、工作目录、连接器、绑定专家、技能。
 * - 刻意不一致的只有两处，都是站得住的：①工作目录新建时必填（新项目没目录就没落脚点）、
 *   编辑可留空；②主按钮文案（确定 / 保存）。
 * - 连接器 / 绑定专家 / 技能三行**同形态**：都用 `PluginToggleRow`，把全部候选项平铺成
 *   开关 chips，渲染的是**白名单全量的选中态**（不是「本次新挑的那几个」）—— 否则打开
 *   设置保存一次就会把之前选好的整批抹掉。
 *   2026-09-13 前这三行不统一：连接器已是平铺多选，专家/技能却是「已选项 + 「添加」→
 *   扩展中心挑选」。那个弹层只列本地已有项（装不了东西），等于把「打开扩展中心 → 切 tab
 *   → 挑一个」三步缩成一步，纯重复；技能行的候选集还把**用户自装技能**列了进去，而
 *   `allowedSkillIds` 根本管不到它们（见 `registry.ts:listEnabledUserSkills`）。
 * - 「连接器」行过去是个空操作：候选集没筛掉模型连接器，写进去的还是 `allowedToolIds`
 *   —— 而 MCP 工具名是运行时算的 `mcp__{连接器id}__{工具}`，不在工具 manifest 表里，
 *   `buildChatTools` 只会跳过它。现在写 `allowedConnectorIds`，真正参与
 *   `plugins/mcp.ts` 的白名单过滤；**空 = 不限制**（专家/技能则是空 = 都不给）。
 */
export default function ProjectSettingsDialog({ open, project, onClose, onUpdate }: ProjectSettingsDialogProps) {
  const [title, setTitle] = useState("");
  const [instruction, setInstruction] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [boundExpertIds, setBoundExpertIds] = useState<string[]>([]);
  const [allowedSkillIds, setAllowedSkillIds] = useState<string[]>([]);
  /** 项目可用的 MCP 连接器白名单；空 = 不限制（放行全部已信任连接器）。 */
  const [allowedConnectorIds, setAllowedConnectorIds] = useState<string[]>([]);
  /** 单行反馈区（套用预设 / 另存为预设共用一行，避免弹 toast）。 */
  const [notice, setNotice] = useState("");
  const { openPrompt } = usePromptDialog();

  useEffect(() => {
    if (open && project) {
      setTitle(project.title);
      setInstruction(project.systemPrompt ?? "");
      setWorkspacePath(project.workspacePath ?? "");
      setBoundExpertIds([...(project.boundExpertIds ?? [])]);
      setAllowedSkillIds([...(project.allowedSkillIds ?? [])]);
      setAllowedConnectorIds([...(project.allowedConnectorIds ?? [])]);
      setNotice("");
    }
  }, [open, project]);

  // 预设选项的唯一事实来源是专家注册表。订阅理由同 CreateProjectDialog：
  // 注册表是渲染进程模块级单例，预设可能是本组件之外存的（「另存为预设」就在本组件里，
  // 但扩展中心、对话工具都会写），靠自身 handler 刷新必漏。
  const agentPresetVersion = useSyncExternalStore(
    (listener) => pluginRegistry.subscribe(listener),
    () => pluginRegistry.getVersion(),
  );

  const agentPresetOptions = useMemo<OmniSelectOption[]>(() => {
    void agentPresetVersion;
    return pluginRegistry.listAgentPresets().map((manifest) => ({
      value: manifest.id,
      label: manifest.name,
    }));
  }, [agentPresetVersion]);

  /**
   * 候选集：专家 = 已启用专家（现在全部是用户自建的）；技能 = **仅内置技能**。
   *
   * 技能为什么只列内置：`allowedSkillIds` 的真实作用是「内置技能能否被斜杠调用 / 被定时
   * 任务执行」（`chat/skills.ts`、`chat/taskExecutor.ts`），而用户自装技能走
   * `pluginRegistry.listEnabledUserSkills()` **绕过这个白名单**（`registry.ts:158-171`）。
   * 之前那个「添加 → 扩展中心」弹层把自装技能也列了出来，勾了写进去却永远不生效 —— 语义错配。
   *
   * 依赖 `agentPresetVersion` 是把它钉在注册表版本上：专家/技能可能在别处装、卸、改。
   */
  const expertOptions = useMemo(() => {
    void agentPresetVersion;
    return pluginRegistry.listExperts().map((manifest) => ({
      id: manifest.id,
      name: manifest.name,
    }));
  }, [agentPresetVersion]);

  const skillOptions = useMemo(() => {
    void agentPresetVersion;
    return pluginRegistry
      .list({ kind: "skill" })
      .filter((manifest) => pluginRegistry.isBuiltin(manifest.id))
      .map((manifest) => ({ id: manifest.id, name: manifest.name }));
  }, [agentPresetVersion]);

  const toggleBoundExpert = useCallback((id: string) => {
    setBoundExpertIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }, []);

  const toggleAllowedSkill = useCallback((id: string) => {
    setAllowedSkillIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }, []);

  const toggleAllowedConnector = useCallback((id: string) => {
    setAllowedConnectorIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }, []);

  /** 套用预设：写进 textarea（**覆盖**现有指令），由用户决定要不要「保存」。 */
  const applyPreset = useCallback((agentPresetId: string) => {
    const agentPreset = pluginRegistry.listAgentPresets().find((manifest) => manifest.id === agentPresetId);
    if (!agentPreset?.instruction) return;
    setInstruction(agentPreset.instruction);
    setBoundExpertIds((current) => current.includes(agentPreset.id) ? current : [...current, agentPreset.id]);
    setNotice(`已套用专家预设「${agentPreset.name}」的指令并绑定该专家，可继续编辑后再保存。`);
  }, []);

  /**
   * 「保存为专家预设」：把当前 textarea 里的项目指令存入统一专家目录。
   *
   * 存的是**当前编辑中的内容**（不是已保存项目的 systemPrompt）—— 用户往往是先调顺了眼下的
   * 指令、再想把它沉淀成预设，此时强迫他先点「保存」再另存是多余的。
   * 名称/说明走 `usePromptDialog`（≤2 个字段），不新造一张表单弹窗。
   */
  const handleSaveAsPreset = async () => {
    const values = await openPrompt({
      title: "保存为专家预设",
      description:
        "保存后可在项目中套用，也能绑定工具和技能供会话委派使用。同名预设会更新。",
      confirmLabel: "保存专家预设",
      fields: [
        {
          label: "专家名称",
          defaultValue: title.trim(),
          placeholder: "如：周报专家",
          autoFocus: true,
        },
        {
          label: "一句话说明",
          required: false,
          placeholder: "会显示在预设列表里，便于以后辨认",
        },
      ],
    });
    if (!values) return;

    const [name, description] = values;
    const result = saveAgentPreset({ name, description, instruction });
    setNotice(
      result.ok
        ? result.created
          ? `已保存专家预设「${result.manifest.name}」，可在专家管理和项目选择器中使用。`
          : `已更新同名专家预设「${result.manifest.name}」。`
        : `保存失败：${result.error}`,
    );
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  };

  if (!open || !project) return null;

  const handleConfirm = () => {
    onUpdate(project.id, {
      title: title.trim() || project.title,
      systemPrompt: instruction,
      workspacePath: workspacePath.trim(),
      boundExpertIds: boundExpertIds.length > 0 ? boundExpertIds : undefined,
      allowedSkillIds,
      // 空 = 不限制。写 undefined（而不是 []）才能**清掉**已有的白名单：
      // `updateProjectProfile` 是 `{...project, ...patch}`，键存在但值为 undefined
      // 会覆盖旧值；若这里直接省略这个键，旧的限制反而会被保留下来。
      allowedConnectorIds: allowedConnectorIds.length > 0 ? allowedConnectorIds : undefined,
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

          <div className="omni-dialog__field">
            <div className="omni-dialog__label-row">
              <label className="omni-dialog__label" htmlFor="project-settings-instruction">
                指令
              </label>
              {/* 两个动作与新建项目对话框同位置、同形态：
                  「选择预设」是**选**（套用会覆盖当前指令，下方有常驻提示），
                  「另存为预设」是**存**（把这份指令沉淀成一条预设）。
                  外层不能是 `<label>`：label 只关联第一个可标签元素，
                  包住按钮/选择器后点「指令」就去触发它们而不聚焦 textarea 了。 */}
              <div className="omni-dialog__label-actions">
                <OmniSelect
                  className="omni-select--preset"
                  ariaLabel="选择专家预设"
                  placeholder="选择预设"
                  value=""
                  options={agentPresetOptions}
                  onChange={applyPreset}
                />
                <button
                  type="button"
                  className="omni-dialog__preset-save"
                  onClick={() => void handleSaveAsPreset()}
                  disabled={!instruction.trim()}
                  title={
                    instruction.trim()
                      ? "保存为可在项目和专家委派中复用的专家预设（同名时更新）"
                      : "指令为空，没有可保存的内容"
                  }
                >
                  <BookmarkPlus size={14} strokeWidth={1.8} />
                  <span>保存为专家预设</span>
                </button>
              </div>
            </div>
            <textarea
              id="project-settings-instruction"
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="项目背景信息与规范：项目目标、团队习惯、风格偏好、输出约束等"
              rows={5}
            />
            <p className="omni-dialog__hint">套用预设会覆盖「指令」中已编辑的内容</p>
            {notice && <p className="omni-dialog__hint">{notice}</p>}
          </div>

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

          {/* 行顺序与 CreateProjectDialog 对齐：连接器 → 绑定专家 → 技能。 */}
          <McpConnectorRow
            selectedIds={allowedConnectorIds}
            onToggle={toggleAllowedConnector}
          />

          {/* 文案与 CreateProjectDialog 逐字一致（hint 会渲染成「（…）」）。
              候选是「已启用专家」全量平铺，不再走「添加 → 扩展中心挑选」弹层 ——
              那个弹层只列本地已有项、装不了东西，纯重复（见 PluginToggleRow 注释）。 */}
          <PluginToggleRow
            icon={<Bot size={16} strokeWidth={1.8} />}
            label="绑定专家"
            hint="agent 委派白名单：只派给这些专家；留空 = 模型不自动委派任何专家（手动 @专家 不受限）"
            options={expertOptions}
            selectedIds={boundExpertIds}
            onToggle={toggleBoundExpert}
            emptyText="暂无专家（可在扩展中心「专家 → 我的专家」里创建）"
            idleIcon={<Bot size={12} strokeWidth={1.8} />}
          />

          {/* 候选只列**内置技能**（用户自装技能绕过这个白名单，列出来勾了也不生效）。
              渲染的是**当前白名单的全量**选中态，不是「本次新加的」—— 否则点一次保存
              就会把新建时勾的技能整批抹掉。直接增删 `allowedSkillIds` 也让 `storage.ts`
              里那句「用户可在项目设置中关闭」终于落到实处（此前那个入口根本不存在）。 */}
          <PluginToggleRow
            icon={<Wand2 size={16} strokeWidth={1.8} />}
            label="技能"
            hint="内置技能：勾选后可用斜杠调用"
            options={skillOptions}
            selectedIds={allowedSkillIds}
            onToggle={toggleAllowedSkill}
            emptyText="暂无内置技能"
            idleIcon={<Wand2 size={12} strokeWidth={1.8} />}
          />
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
    </>
  );
}
