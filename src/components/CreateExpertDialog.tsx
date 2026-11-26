import { useEffect, useMemo, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { X, Bot, Wand2, Cable, Plug, Check } from "lucide-react";
import { TOOL_MANIFESTS } from "../config/manifests/tools";
import { pluginRegistry } from "../plugins/registry";
import { canonicalizeExpertManifest, legacyExpertProfile, compileExpertTemplatePrompt } from "../plugins/expertProfiles";
import type { ExpertProfile, PluginManifest } from "../plugins/types";

export type CreateExpertDialogProps = {
  open: boolean;
  editing?: PluginManifest | null;
  copying?: PluginManifest | null;
  onClose: () => void;
  onCreated?: (manifest: PluginManifest) => void;
};

const EXPERT_CATEGORIES = [
  "开发编程", "内容创作", "数据分析", "知识管理", "商业运营", "产品管理",
  "质量管理", "项目管理", "设计多媒体", "AI Agent", "教育学习", "行业专业",
];

type DraftExample = { title: string; prompt: string };

const EMPTY_EXAMPLES: DraftExample[] = [
  { title: "示例一", prompt: "" },
  { title: "示例二", prompt: "" },
];

function profileFromManifest(source: PluginManifest | null): ExpertProfile {
  return source?.expertProfile ?? (source ? legacyExpertProfile(source) : {
    role: "",
    methodology: "",
    boundaries: "",
    deliverables: "",
    examples: [],
  });
}

function splitTags(value: string): string[] {
  return [...new Set(value.split(/[、,，\n]/).map((tag) => tag.trim()).filter(Boolean))].slice(0, 8);
}

function profileIsComplete(profile: ExpertProfile): boolean {
  return Boolean(
    profile.role.trim() && profile.methodology.trim() && profile.boundaries.trim() &&
    profile.deliverables.trim() && profile.examples.length >= 2 &&
    profile.examples.every((example) => example.prompt.trim()),
  );
}

/** 创建、复制、编辑统一使用 DSH ExpertProfile，再编译为运行时提示词。 */
export default function CreateExpertDialog({
  open,
  editing = null,
  copying = null,
  onClose,
  onCreated,
}: CreateExpertDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState(EXPERT_CATEGORIES[0]);
  const [role, setRole] = useState("");
  const [methodology, setMethodology] = useState("");
  const [boundaries, setBoundaries] = useState("");
  const [deliverables, setDeliverables] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [examples, setExamples] = useState<DraftExample[]>(EMPTY_EXAMPLES);
  const [selectedToolIds, setSelectedToolIds] = useState<string[]>([]);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [selectedMcpConnectorIds, setSelectedMcpConnectorIds] = useState<string[]>([]);

  const isEditing = Boolean(editing);

  useEffect(() => {
    if (!open) return;
    const source = editing ?? copying;
    const profile = profileFromManifest(source);
    setName(source ? (editing ? source.name : `${source.name}（自定义）`) : "");
    setDescription(source?.description ?? "");
    setCategory(source?.category && EXPERT_CATEGORIES.includes(source.category) ? source.category : EXPERT_CATEGORIES[0]);
    setRole(profile.role);
    setMethodology(profile.methodology);
    setBoundaries(profile.boundaries);
    setDeliverables(profile.deliverables);
    setTagsText(source?.tags?.join("、") ?? "");
    setExamples(profile.examples.length > 0
      ? profile.examples.slice(0, 2).map((example) => ({ title: example.title, prompt: example.prompt }))
      : EMPTY_EXAMPLES);
    setSelectedToolIds([...(source?.defaultToolIds ?? [])]);
    setSelectedSkillIds([...(source?.defaultSkillIds ?? [])]);
    setSelectedMcpConnectorIds([...(source?.defaultMcpConnectorIds ?? [])]);
  }, [open, editing, copying]);

  const toolOptions = useMemo(
    () => TOOL_MANIFESTS.filter((tool) => tool.id !== "agent").map((tool) => ({ id: tool.id, title: tool.title })),
    [],
  );
  const skillOptions = useMemo(
    () => pluginRegistry.list({ kind: "skill" }).map((skill) => ({ id: skill.id, title: skill.name })),
    [open],
  );
  const mcpOptions = useMemo(
    () => pluginRegistry.list({ kind: "connector" }).filter((connector) => !connector.provider)
      .map((connector) => ({ id: connector.id, title: connector.name })),
    [open],
  );

  if (!open) return null;

  const profile: ExpertProfile = {
    role,
    methodology,
    boundaries,
    deliverables,
    examples: examples.map((example, index) => ({
      id: `example-${index + 1}`,
      title: example.title.trim() || `示例${index + 1}`,
      prompt: example.prompt,
    })),
  };
  const tags = splitTags(tagsText);
  const canSubmit = Boolean(name.trim() && description.trim() && tags.length > 0 && profileIsComplete(profile));

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  };

  const handleConfirm = () => {
    if (!canSubmit) return;
    const fields = {
      name: name.trim(),
      description: description.trim(),
      category,
      tags,
      expertProfile: {
        ...profile,
        role: profile.role.trim(),
        methodology: profile.methodology.trim(),
        boundaries: profile.boundaries.trim(),
        deliverables: profile.deliverables.trim(),
        examples: profile.examples.map((example) => ({ ...example, prompt: example.prompt.trim() })),
      },
      templatePrompt: compileExpertTemplatePrompt(name.trim(), profile),
      defaultToolIds: [...selectedToolIds],
      defaultSkillIds: [...selectedSkillIds],
      defaultMcpConnectorIds: [...selectedMcpConnectorIds],
    };
    let manifest: PluginManifest;
    if (editing) {
      manifest = { ...editing, ...fields };
      pluginRegistry.updateManifest(manifest);
    } else {
      const slug = name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-+|-+$/g, "") || "expert";
      const base = `expert-${slug}-${Date.now().toString(36)}`;
      let id = base;
      for (let n = 2; pluginRegistry.getManifest(id); n += 1) id = `${base}-${n}`;
      manifest = { id, version: "1.0.0", author: "用户", kind: "expert", icon: "Bot", ...fields };
      manifest = canonicalizeExpertManifest(manifest);
      pluginRegistry.install(manifest, { type: "user" });
    }
    onCreated?.(manifest);
    onClose();
  };

  const field = (
    label: string,
    value: string,
    setValue: (value: string) => void,
    placeholder: string,
    rows = 3,
  ) => (
    <label className="omni-dialog__field">
      <span className="omni-dialog__label">{label}</span>
      <textarea value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={handleKeyDown} placeholder={placeholder} rows={rows} />
    </label>
  );

  return (
    <>
      <div className="omni-dialog-backdrop" onClick={onClose} />
      <div className="omni-dialog omni-dialog--create-project omni-dialog--create-expert" role="dialog" aria-modal="true" aria-labelledby="create-expert-title">
        <div className="omni-dialog__header">
          <div>
            <h2 id="create-expert-title">{isEditing ? "编辑专家" : copying ? "复制专家" : "创建专家"}</h2>
            <p className="omni-dialog__subtitle">按 DSH 专家定义创建，可直接用于 @ 对话和 Agent 委派。</p>
          </div>
          <button type="button" className="omni-dialog__close" onClick={onClose} aria-label="关闭"><X size={18} strokeWidth={1.8} /></button>
        </div>

        <div className="omni-dialog__body">
          <div className="omni-dialog__section-heading"><strong>基本信息</strong><span>用于目录展示和专家匹配</span></div>
          <label className="omni-dialog__field"><span className="omni-dialog__label">专家名称</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={handleKeyDown} placeholder="如：周报分析顾问" maxLength={40} /></label>
          <label className="omni-dialog__field"><span className="omni-dialog__label">专家描述</span><input value={description} onChange={(event) => setDescription(event.target.value)} onKeyDown={handleKeyDown} placeholder="说明专家解决什么问题、适用于什么场景" maxLength={160} /></label>
          <label className="omni-dialog__field"><span className="omni-dialog__label">分类</span><select value={category} onChange={(event) => setCategory(event.target.value)}>{EXPERT_CATEGORIES.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          <label className="omni-dialog__field"><span className="omni-dialog__label">标签</span><input value={tagsText} onChange={(event) => setTagsText(event.target.value)} onKeyDown={handleKeyDown} placeholder="用顿号或逗号分隔，例如：复盘、改进、团队协作" /></label>

          <div className="omni-dialog__section-heading"><strong>专家定义</strong><span>这四项会原样进入 DSH 专家档案</span></div>
          {field("角色定位", role, setRole, "这个专家是谁，擅长解决什么类型的问题？", 4)}
          {field("工作方法", methodology, setMethodology, "描述专家如何分析、判断和推进任务。", 5)}
          {field("行为边界", boundaries, setBoundaries, "说明不能臆造什么、遇到信息不足如何处理。", 4)}
          {field("交付物", deliverables, setDeliverables, "说明最终应该输出什么结果。", 3)}

          <div className="omni-dialog__section-heading"><strong>使用示例</strong><span>至少提供两个真实提问，帮助用户直接召唤专家</span></div>
          {examples.map((example, index) => (
            <div className="omni-dialog__example-fields" key={index}>
              <input value={example.title} onChange={(event) => setExamples((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, title: event.target.value } : item))} onKeyDown={handleKeyDown} placeholder={`示例${index + 1}标题`} />
              <textarea value={example.prompt} onChange={(event) => setExamples((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, prompt: event.target.value } : item))} onKeyDown={handleKeyDown} placeholder="用户会怎样向这个专家提问？" rows={3} />
            </div>
          ))}

          <div className="omni-dialog__section-heading"><strong>能力依赖</strong><span>只绑定当前 Omni 中真实存在的工具、技能和 MCP</span></div>
          <PluginChips icon={<Cable size={16} strokeWidth={1.8} />} title="推荐工具" hint="可多选；写类操作仍需用户确认" options={toolOptions} selected={selectedToolIds} setSelected={setSelectedToolIds} />
          <PluginChips icon={<Wand2 size={16} strokeWidth={1.8} />} title="绑定技能" hint="可多选" options={skillOptions} selected={selectedSkillIds} setSelected={setSelectedSkillIds} />
          <PluginChips icon={<Plug size={16} strokeWidth={1.8} />} title="绑定 MCP" hint="可多选；绑定后使用连接器暴露的工具" options={mcpOptions} selected={selectedMcpConnectorIds} setSelected={setSelectedMcpConnectorIds} empty="暂无已安装的 MCP 连接器" />

          <p className="omni-dialog__hint"><Bot size={12} strokeWidth={1.8} /> 保存后会生成统一的 DSH ExpertProfile，并由系统编译运行时角色提示词。</p>
        </div>
        <div className="omni-dialog__footer">
          <button type="button" className="omni-dialog__button omni-dialog__button--secondary" onClick={onClose}>取消</button>
          <button type="button" className="omni-dialog__button omni-dialog__button--primary" onClick={handleConfirm} disabled={!canSubmit}>{isEditing ? "保存" : copying ? "创建副本" : "创建专家"}</button>
        </div>
      </div>
    </>
  );
}

function PluginChips({
  icon,
  title,
  hint,
  options,
  selected,
  setSelected,
  empty,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  options: Array<{ id: string; title: string }>;
  selected: string[];
  setSelected: (update: (current: string[]) => string[]) => void;
  empty?: string;
}) {
  return (
    <div className="omni-dialog__plugin-row">
      <div className="omni-dialog__plugin-row-header"><div className="omni-dialog__plugin-row-title">{icon}<span>{title}</span><span className="omni-dialog__plugin-row-hint">（{hint}）</span></div></div>
      {options.length > 0 ? <div className="omni-dialog__plugin-chips">{options.map((option) => {
        const active = selected.includes(option.id);
        return <button key={option.id} type="button" className={`omni-dialog__plugin-chip${active ? " omni-dialog__plugin-chip--active" : ""}`} onClick={() => setSelected((current) => current.includes(option.id) ? current.filter((id) => id !== option.id) : [...current, option.id])}>{active ? <Check size={12} strokeWidth={2} /> : icon}<span>{option.title}</span></button>;
      })}</div> : <p className="omni-dialog__hint">{empty ?? "暂无可用项"}</p>}
    </div>
  );
}
