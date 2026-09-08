import { useMemo, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { X, Bot, Wand2, Cable, Check } from "lucide-react";
import { TOOL_MANIFESTS } from "../config/manifests/tools";
import { pluginRegistry } from "../plugins/registry";
import type { PluginManifest } from "../plugins/types";

export type CreateExpertDialogProps = {
  open: boolean;
  onClose: () => void;
  /** 创建成功后回调（宿主用于刷新扩展中心列表）。 */
  onCreated?: (manifest: PluginManifest) => void;
};

const EXPERT_CATEGORIES = [
  "开发编程",
  "内容创作",
  "数据分析",
  "知识管理",
  "商业运营",
  "设计多媒体",
  "AI Agent",
  "教育学习",
  "行业专业",
];

/**
 * 创建专家对话框：表单化生成 PluginManifest(kind: "expert") 并注册为本地插件。
 * 专家 = 子 Agent 档案：templatePrompt 为角色提示词，defaultToolIds/defaultSkillIds
 * 决定该专家被 agent 委派或 @ 指定时的能力边界。
 */
export default function CreateExpertDialog({ open, onClose, onCreated }: CreateExpertDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState(EXPERT_CATEGORIES[0]);
  const [templatePrompt, setTemplatePrompt] = useState("");
  const [selectedToolIds, setSelectedToolIds] = useState<string[]>([]);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);

  // 可声明工具：全部内置工具清单（排除 agent 自身，避免专家声明递归派发）。
  const toolOptions = useMemo(
    () => TOOL_MANIFESTS.filter((tool) => tool.id !== "agent").map((tool) => ({ id: tool.id, title: tool.title })),
    []
  );
  // 可绑定技能：注册表中的全部技能（含未启用——声明后由项目/会话启用逻辑决定是否生效）。
  const skillOptions = useMemo(
    () => pluginRegistry.list({ kind: "skill" }).map((skill) => ({ id: skill.id, title: skill.name })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open]
  );

  if (!open) return null;

  const toggle = (list: string[], id: string): string[] =>
    list.includes(id) ? list.filter((item) => item !== id) : [...list, id];

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  };

  const canSubmit = Boolean(name.trim() && templatePrompt.trim());

  const handleConfirm = () => {
    if (!canSubmit) return;
    const slug =
      name
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
        .replace(/^-+|-+$/g, "") || "expert";
    const manifest: PluginManifest = {
      id: `expert-${slug}-${Date.now().toString(36)}`,
      name: name.trim(),
      description: description.trim() || `${name.trim()}：自定义专家`,
      version: "1.0.0",
      author: "用户",
      kind: "expert",
      category: category,
      icon: "Bot",
      templatePrompt: templatePrompt.trim(),
      defaultToolIds: [...selectedToolIds],
      defaultSkillIds: [...selectedSkillIds],
    };
    pluginRegistry.install(manifest, { type: "local", path: "user" });
    onCreated?.(manifest);
    // 重置表单，便于连续创建
    setName("");
    setDescription("");
    setCategory(EXPERT_CATEGORIES[0]);
    setTemplatePrompt("");
    setSelectedToolIds([]);
    setSelectedSkillIds([]);
    onClose();
  };

  return (
    <>
      <div className="omni-dialog-backdrop" onClick={onClose} />
      <div className="omni-dialog omni-dialog--create-project" role="dialog" aria-modal="true" aria-labelledby="create-expert-title">
        <div className="omni-dialog__header">
          <h2 id="create-expert-title">创建专家</h2>
          <button type="button" className="omni-dialog__close" onClick={onClose} aria-label="关闭">
            <X size={18} strokeWidth={1.8} />
          </button>
        </div>

        <div className="omni-dialog__body">
          <label className="omni-dialog__field">
            <span className="omni-dialog__label">专家名称</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="如：周报专家、代码评审专家"
              maxLength={20}
            />
            <span className="omni-dialog__counter">{name.length}/20</span>
          </label>

          <label className="omni-dialog__field">
            <span className="omni-dialog__label">一句话描述</span>
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="擅长什么、什么场景下会用到（用于委派匹配）"
              maxLength={80}
            />
            <span className="omni-dialog__counter">{description.length}/80</span>
          </label>

          <label className="omni-dialog__field">
            <span className="omni-dialog__label">行业分类</span>
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              {EXPERT_CATEGORIES.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>

          <label className="omni-dialog__field">
            <span className="omni-dialog__label">角色提示词</span>
            <textarea
              value={templatePrompt}
              onChange={(event) => setTemplatePrompt(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="专家的系统提示词：角色定位 + 工作方式 + 输出偏好。被 agent 委派或 @ 指定时以此驱动。"
              rows={5}
            />
          </label>

          <div className="omni-dialog__plugin-row">
            <div className="omni-dialog__plugin-row-header">
              <div className="omni-dialog__plugin-row-title">
                <Cable size={16} strokeWidth={1.8} />
                <span>推荐工具</span>
                <span className="omni-dialog__plugin-row-hint">（可多选；委派时按声明给出，写类操作仍需用户确认）</span>
              </div>
            </div>
            <div className="omni-dialog__plugin-chips">
              {toolOptions.map((tool) => {
                const active = selectedToolIds.includes(tool.id);
                return (
                  <button
                    key={tool.id}
                    type="button"
                    className={`omni-dialog__plugin-chip${active ? " omni-dialog__plugin-chip--active" : ""}`}
                    onClick={() => setSelectedToolIds((current) => toggle(current, tool.id))}
                  >
                    {active ? <Check size={12} strokeWidth={2} /> : <Cable size={12} strokeWidth={1.8} />}
                    <span>{tool.title}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="omni-dialog__plugin-row">
            <div className="omni-dialog__plugin-row-header">
              <div className="omni-dialog__plugin-row-title">
                <Wand2 size={16} strokeWidth={1.8} />
                <span>绑定技能</span>
                <span className="omni-dialog__plugin-row-hint">（可多选；留空则专家不使用技能）</span>
              </div>
            </div>
            {skillOptions.length > 0 ? (
              <div className="omni-dialog__plugin-chips">
                {skillOptions.map((skill) => {
                  const active = selectedSkillIds.includes(skill.id);
                  return (
                    <button
                      key={skill.id}
                      type="button"
                      className={`omni-dialog__plugin-chip${active ? " omni-dialog__plugin-chip--active" : ""}`}
                      onClick={() => setSelectedSkillIds((current) => toggle(current, skill.id))}
                    >
                      {active ? <Check size={12} strokeWidth={2} /> : <Wand2 size={12} strokeWidth={1.8} />}
                      <span>{skill.title}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="omni-dialog__hint">暂无已安装技能</p>
            )}
          </div>

          <p className="omni-dialog__hint">
            <Bot size={12} strokeWidth={1.8} /> 创建后可在「我的专家」管理，项目绑定或 @ 提及即可使用。
          </p>
        </div>

        <div className="omni-dialog__footer">
          <button type="button" className="omni-dialog__button omni-dialog__button--secondary" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="omni-dialog__button omni-dialog__button--primary"
            onClick={handleConfirm}
            disabled={!canSubmit}
          >
            创建
          </button>
        </div>
      </div>
    </>
  );
}
