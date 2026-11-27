import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { X, Bot, Wand2, FolderOpen } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { ProjectDraft } from "../chat/types";
import { pluginRegistry } from "../plugins/registry";
import OmniSelect, { type OmniSelectOption } from "./ui/OmniSelect";
import PluginToggleRow from "./ui/PluginToggleRow";
import McpConnectorRow from "./ui/McpConnectorRow";

export type CreateProjectDialogProps = {
  open: boolean;
  onClose: () => void;
  onCreate: (draft: ProjectDraft) => void;
  /**
   * 打开时预选的**专家预设** id（来自扩展中心「用它新建项目」）。
   * 不传 / 传 null 即普通新建项目，用户自行从下拉里选。
   */
  initialAgentPresetId?: string | null;
};

export default function CreateProjectDialog({
  open,
  onClose,
  onCreate,
  initialAgentPresetId,
}: CreateProjectDialogProps) {
  const [title, setTitle] = useState("");
  const [instruction, setInstruction] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [selectedAgentPresetId, setSelectedAgentPresetId] = useState("");
  const selectedAgentPresetIdRef = useRef("");
  // 绑定专家（agent 委派白名单）与内置技能白名单。都是 id 数组 —— 行为与
  // ProjectSettingsDialog 完全一致，两处必须同步改（见该文件头部注释）。
  const [boundExpertIds, setBoundExpertIds] = useState<string[]>([]);
  const [allowedSkillIds, setAllowedSkillIds] = useState<string[]>([]);
  // 项目级连接器白名单。**空 = 不限制**（放行全部已信任连接器），勾了才收窄 —— 见 McpConnectorRow。
  const [connectorIds, setConnectorIds] = useState<string[]>([]);

  useEffect(() => {
    if (open) {
      setTitle("");
      setInstruction("");
      setWorkspacePath("");
      setSelectedAgentPresetId("");
      selectedAgentPresetIdRef.current = "";
      setBoundExpertIds([]);
      setAllowedSkillIds([]);
      setConnectorIds([]);
    }
  }, [open]);

  // 预设选项的唯一事实来源是专家注册表；角色和项目指令都从同一条 manifest 读取。
  // 曾经这里读 `RECOMMENDED_PROJECT_PRESETS`（另一份同名、同描述的硬编码副本），
  // 指令正文也从同一份注册表读取，避免选项与实际套用内容出现两份来源。
  // 订阅理由同 PluginMarketplace：注册表是渲染进程模块级单例，变更可能发生在
  // 本组件之外，靠自身 handler 刷新必漏。snapshot 是递增数字（原始值），不会
  // 像返回新数组那样把 React 推进无限重渲染。
  const agentPresetVersion = useSyncExternalStore(
    (listener) => pluginRegistry.subscribe(listener),
    () => pluginRegistry.getVersion(),
  );

  const agentPresetOptions = useMemo<OmniSelectOption[]>(() => {
    // 快照本身不参与计算，只用于把这份列表钉在注册表版本上（否则装了/卸了预设不刷新）。
    void agentPresetVersion;
    return [
      { value: "", label: "无预设" },
      ...pluginRegistry.listAgentPresets().map((manifest) => ({
        value: manifest.id,
        label: manifest.name,
      })),
    ];
  }, [agentPresetVersion]);

  const applyAgentPreset = useCallback((presetId: string) => {
    const previousPresetId = selectedAgentPresetIdRef.current;
    selectedAgentPresetIdRef.current = presetId;
    setSelectedAgentPresetId(presetId);
    const preset = presetId
      ? pluginRegistry.listAgentPresets().find((m) => m.id === presetId)
      : undefined;
    // 写的是**持久项目指令** `instruction`，不是起手句 —— 后者（`starterPrompt`）
    // 是一次性的「这次想问什么」，由扩展中心卡片的「插入输入框」消费。
    setInstruction(preset?.instruction ?? "");
    setBoundExpertIds((current) => {
      const next = current.filter((id) => id !== previousPresetId);
      return preset && !next.includes(preset.id)
        ? [...next, preset.id]
        : next;
    });
  }, []);

  // 从扩展中心「用它新建项目」进来时预设已选定：打开即套用。
  // 必须声明在上面那条重置 effect **之后** —— 同一次提交里两个 effect 按声明顺序执行，
  // 先清空再套用；顺序反了套用的结果会被重置覆盖掉。
  useEffect(() => {
    if (open && initialAgentPresetId) applyAgentPreset(initialAgentPresetId);
  }, [open, initialAgentPresetId, applyAgentPreset]);

  /**
   * 三行的候选集。与 `ProjectSettingsDialog` 逐字同源，改一处必须改两处。
   *
   * - 专家 = 已启用专家（内置与用户自建共用同一套配置）；
   * - 技能 = **仅内置技能** —— `allowedSkillIds` 管不到用户自装技能（那些走
   *   `listEnabledUserSkills()` 绕过白名单，见 `registry.ts:158-171`）；
   * - 连接器由 `McpConnectorRow` 自己订阅注册表算（要滤掉模型连接器）。
   *
   * 专家/技能依赖 `agentPresetVersion`，把它钉在注册表版本上：插件可能在别处装、卸、改。
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

  const toggleConnector = useCallback((id: string) => {
    setConnectorIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }, []);

  const handleConfirm = () => {
    const draft: ProjectDraft = {
      title: title.trim() || "新项目",
      systemPrompt: instruction.trim(),
      workspacePath: workspacePath.trim() || undefined,
      // 能力集只写**真正生效**的两项：内置技能白名单（`allowedSkillIds` 决定内置技能能否
      // 被斜杠调用 / 被定时任务执行，见 `chat/skills.ts`、`chat/taskExecutor.ts`）与
      // MCP 连接器白名单（`allowedConnectorIds`，见 `plugins/mcp.ts::listActiveMcpTools`）。
      //
      // 曾经这里还把每个已选插件的 `defaultToolIds`、专家的 `defaultSkillIds` 一并并进来，
      // 但创建流程并不读取它们：
      // - 模型默认工具由 `DEFAULT_MODEL_TOOL_IDS` 控制；`allowedToolIds` 当前只作为
      //   项目额外工具扩展集，字段缺省时由 `chat/storage.ts` 补默认值。这里没有工具选择 UI，
      //   所以不写它，避免把它误当成第二套默认清单。
      //   ⚠️ 但**连接器不能走这条路**：MCP 工具名是运行时算出来的 `mcp__{连接器id}__{工具}`，
      //   不在工具 manifest 表里，`buildChatTools` 会直接跳过（`chatRuntimeHelpers.ts:113`），
      //   所以连接器 manifest 也从不声明 `defaultToolIds`（全仓 0 处）—— 它必须单列一项。
      // - 专家的 `defaultSkillIds` 有自己的运行时消费方（`chat/subAgent.ts` 委派子 Agent、
      //   `useChatRuntime.ts` @ 专家时启用），不必再借项目白名单重述一遍；
      //   而专家（自建）声明的 `defaultSkillIds` 多为 `[]`，并进来也只是空转。
      // 顺带：专家真正的工具边界由 `chat/expertTools.ts::selectExpertTools` 在委派时按
      // 专家自己的声明挑，与项目白名单无关。
      allowedSkillIds: [...allowedSkillIds],
      // 项目可用的 MCP 连接器白名单：**空 = 不限制**。写 undefined 而非 []，让「未设置」
      // 只有一种表示（`normalizeProject` 读回时也会把 [] 归一成 undefined）。
      allowedConnectorIds: connectorIds.length > 0 ? [...connectorIds] : undefined,
      // 选中的专家记为项目绑定专家：该项目会话里 agent 工具只委派给这些专家
      boundExpertIds: [...boundExpertIds],
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

          <div className="omni-dialog__field">
            <div className="omni-dialog__label-row">
              <label className="omni-dialog__label" htmlFor="create-project-instruction">
                指令
              </label>
              {/* 预设下拉改走 OmniSelect，不再用自绘的 :hover 弹出层。
                  旧实现的触发器与菜单之间隔着 6px（`top: calc(100% + 6px)`），
                  鼠标从触发器移向菜单时穿过这段死区，两边都不处于 :hover，
                  菜单当场 display:none —— 表现出来就是「鼠标一脱焦，下拉框就消失」，
                  压根选不中。OmniSelect 是点击开合 + 外部 pointerdown 关闭，
                  菜单还 portal 到 body（`.omni-dialog` 是 overflow:hidden，
                  `__body` 还是 overflow-y:auto，留在对话框内部的浮层会被裁或被卷走）。 */}
              <OmniSelect
                className="omni-select--preset"
                ariaLabel="选择专家预设"
                placeholder="无预设"
                value={selectedAgentPresetId}
                options={agentPresetOptions}
                onChange={applyAgentPreset}
              />
            </div>
            <textarea
              id="create-project-instruction"
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="提供当前项目的背景信息和规范，让 Omni 的回复更精准、更符合要求。比如：项目目标、团队习惯、风格偏好、输出约束等"
              rows={5}
            />
          </div>

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

          {/* 连接器行的候选集换成**已安装的 MCP 连接器**多选（`McpConnectorRow`）。
              旧的「添加 → 扩展中心挑一个」有两个问题：①扩展中心的连接器 tab 混着
              **模型连接器**（`provider` 非空，在「模型设置」里配），它们不暴露任何
              `mcp__*` 工具，勾进来只是写下一个永不生效的 id；②旧实现把它记进
              `allowedToolIds` —— 而 MCP 工具名是运行时算的 `mcp__{id}__{tool}`，
              不在工具 manifest 表里，那条路必然空转（见 handleConfirm 的注释）。
              现在按 id 记进 `allowedConnectorIds`，真正参与 mcp.ts 的白名单过滤。 */}
          <McpConnectorRow selectedIds={connectorIds} onToggle={toggleConnector} />

          {/* 专家/技能两行的文案与 ProjectSettingsDialog **必须逐字一致**。
              此前新建写「专家（可选）」、编辑写「绑定专家（绑定后 agent 委派只派给这些专家；
              留空则不限制）」——同一个 `boundExpertIds` 字段，一个不说、一个才说，
              而这个字段的真实含义（委派白名单）相当反直觉，新建时不说等于埋坑。 */}
          <PluginToggleRow
            icon={<Bot size={16} strokeWidth={1.8} />}
            label="绑定专家"
            hint="agent 委派白名单：只派给这些专家；留空 = 模型不自动委派任何专家（手动 @专家 不受限）"
            options={expertOptions}
            selectedIds={boundExpertIds}
            onToggle={toggleBoundExpert}
            emptyText="暂无专家（可在扩展中心「专家 → 我的专家」里创建）"
            idleIcon={<Bot size={12} strokeWidth={2} />}
          />

          <PluginToggleRow
            icon={<Wand2 size={16} strokeWidth={1.8} />}
            label="技能"
            hint="内置技能：勾选后可用斜杠调用"
            options={skillOptions}
            selectedIds={allowedSkillIds}
            onToggle={toggleAllowedSkill}
            emptyText="暂无内置技能"
            idleIcon={<Wand2 size={12} strokeWidth={2} />}
          />

          <p className="omni-dialog__hint">切换专家预设会覆盖「指令」中已编辑的内容</p>
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
    </>
  );
}
