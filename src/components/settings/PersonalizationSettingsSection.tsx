import { useCallback, useEffect, useMemo, useState } from "react";
import OmniSelect from "../ui/OmniSelect";
import type { PersonaConfig, PersonaStyle } from "../../chat/types";
import {
  DEFAULT_PERSONA_CONFIG,
  loadPersonaConfig,
  savePersonaField,
  type PersonaFieldKey,
} from "../../chat/storage";

const STYLE_OPTIONS: Array<{ value: PersonaStyle; label: string; description: string }> = [
  { value: "default", label: "默认", description: "不设定特定风格" },
  { value: "professional", label: "专业严谨", description: "清晰准确，值得信赖" },
  { value: "friendly", label: "亲和友善", description: "温暖平易近人，鼓励支持" },
  { value: "direct", label: "直言不讳", description: "简明扼要，直击要点" },
  { value: "creative", label: "天马行空", description: "富有想象力，善用比喻" },
  { value: "efficient", label: "高效务实", description: "最少文字，最大信息量" },
  { value: "snarky", label: "毒舌吐槽", description: "犀利吐槽，但绝不伤人" },
  { value: "socratic", label: "启发引导", description: "用提问引导思考，授人以渔" },
];

const CUSTOM_INSTRUCTION_LIMIT = 1500;
const MEMORY_FIELD_LIMIT = 2000;
const AGENTS_MD_LIMIT = 4000;

const MEMORY_CARDS: Array<{
  key: PersonaFieldKey;
  title: string;
  placeholder: string;
  emptyText: string;
}> = [
  {
    key: "userName",
    title: "Omni 对你的称呼",
    placeholder: "例如：小明、老板、主人",
    emptyText: "暂无内容，点击编辑添加",
  },
  {
    key: "assistantName",
    title: "Omni 的名字",
    placeholder: "给 Omni 起一个专属名字，例如：小欧",
    emptyText: "暂无内容，点击编辑添加",
  },
  {
    key: "personaDescription",
    title: "Omni 的人设 / 人格描述",
    placeholder: "例如：你是一位冷静高效的编程搭档，说话直接、注重可执行性。",
    emptyText: "暂无内容，点击编辑添加",
  },
  {
    key: "longTermMemory",
    title: "Omni 的长期记忆记录",
    placeholder: "例如：用户是前端开发者，偏好 React + TypeScript；讨厌冗长解释。",
    emptyText: "暂无内容，点击编辑添加",
  },
];

function usePersonaConfig() {
  const [config, setConfig] = useState<PersonaConfig>(DEFAULT_PERSONA_CONFIG);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    loadPersonaConfig().then((loaded) => {
      setConfig(loaded);
      setIsLoaded(true);
    });
  }, []);

  const persistField = useCallback(async (key: PersonaFieldKey, value: string) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
    try {
      await savePersonaField(key, value);
    } catch {
      // 写入失败时保留界面状态，下次编辑会重试。
    }
  }, []);

  return { config, persistField, isLoaded };
}

function truncatePreview(text: string, maxLength = 72) {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) return normalized || null;
  return `${normalized.slice(0, maxLength)}…`;
}

export default function PersonalizationSettingsSection() {
  const { config, persistField, isLoaded } = usePersonaConfig();
  const [customInstruction, setCustomInstruction] = useState(config.customInstruction);
  const [agentsMd, setAgentsMd] = useState(config.agentsMd);
  const [editingKey, setEditingKey] = useState<PersonaFieldKey | null>(null);
  const [draftValue, setDraftValue] = useState("");

  useEffect(() => {
    setCustomInstruction(config.customInstruction);
  }, [config.customInstruction]);

  useEffect(() => {
    setAgentsMd(config.agentsMd);
  }, [config.agentsMd]);

  const handleStyleChange = useCallback(
    (value: string) => {
      const style = value as PersonaStyle;
      void persistField("style", style);
    },
    [persistField]
  );

  const handleCustomInstructionChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = event.target.value.slice(0, CUSTOM_INSTRUCTION_LIMIT);
      setCustomInstruction(next);
    },
    []
  );

  const handleCustomInstructionBlur = useCallback(() => {
    if (customInstruction !== config.customInstruction) {
      void persistField("customInstruction", customInstruction.trim());
    }
  }, [config, customInstruction, persistField]);

  const handleAgentsMdChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value.slice(0, AGENTS_MD_LIMIT);
    setAgentsMd(next);
  }, []);

  const handleAgentsMdBlur = useCallback(() => {
    if (agentsMd !== config.agentsMd) {
      void persistField("agentsMd", agentsMd.trim());
    }
  }, [config, agentsMd, persistField]);

  const startEditing = useCallback(
    (key: PersonaFieldKey) => {
      const value = String(config[key] ?? "");
      setDraftValue(value);
      setEditingKey(key);
    },
    [config]
  );

  const cancelEditing = useCallback(() => {
    setEditingKey(null);
    setDraftValue("");
  }, []);

  const confirmEditing = useCallback(() => {
    if (!editingKey) return;
    const trimmed = draftValue.trim();
    void persistField(editingKey, trimmed);
    setEditingKey(null);
    setDraftValue("");
  }, [draftValue, editingKey, persistField]);

  const editingCard = useMemo(
    () => MEMORY_CARDS.find((card) => card.key === editingKey) ?? null,
    [editingKey]
  );

  if (!isLoaded) {
    return (
      <section className="space-y-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm omni-settings-card">
        <div className="h-20 animate-pulse rounded-lg bg-slate-100" />
      </section>
    );
  }

  return (
    <section className="space-y-5">
      <div className="space-y-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm omni-settings-card">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium text-slate-900 omni-settings-title">基本风格和语调</h3>
            <p className="mt-1 text-xs text-slate-500 omni-settings-muted">设置 Omni 回复你的风格和语调。这不会影响 Omni 的功能。</p>
          </div>
          <OmniSelect
            value={config.style}
            options={STYLE_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label,
              description: option.description,
            }))}
            onChange={handleStyleChange}
            ariaLabel="选择回复风格"
            className="w-full max-w-[160px] shrink-0"
          />
        </div>
      </div>

      <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm omni-settings-card">
        <div>
          <h3 className="text-sm font-medium text-slate-900 omni-settings-title">本地长期记忆文件</h3>
          <p className="mt-1 text-xs text-slate-500 omni-settings-muted">
            以下内容保存在数据目录的 persona 文件夹（多个 .md 文件），你可直接编辑，Omni 也会在对话中自动更新。
          </p>
        </div>

        <div className="space-y-3">
          {MEMORY_CARDS.map((card) => {
            const value = String(config[card.key] ?? "");
            const preview = truncatePreview(value);
            return (
              <div
                key={card.key}
                className="group rounded-lg border border-slate-200 bg-slate-50/70 p-3.5 transition-colors hover:border-slate-300 hover:bg-slate-50"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h4 className="text-sm font-medium text-slate-900 omni-settings-title">{card.title}</h4>
                    <p className="mt-1 text-xs text-slate-500 omni-settings-muted">
                      {preview ?? card.emptyText}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => startEditing(card.key)}
                    className="shrink-0 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50 hover:text-slate-900"
                  >
                    编辑
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="space-y-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm omni-settings-card">
        <div className="border-b border-slate-100 pb-3">
          <h3 className="text-sm font-medium text-slate-900 omni-settings-title">自定义指令</h3>
          <p className="mt-1 text-xs text-slate-500 omni-settings-muted">告诉 Omni 你希望它始终遵循的规则和偏好，这会直接影响所有对话。</p>
        </div>

        <div className="space-y-2">
          <textarea
            value={customInstruction}
            onChange={handleCustomInstructionChange}
            onBlur={handleCustomInstructionBlur}
            placeholder='例如："每次回答我之前都说 ok，再接后续内容"'
            rows={6}
            className="w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
          />
          <div className="flex items-center justify-between text-xs text-slate-500 omni-settings-muted">
            <span>这些指令会应用于你的所有对话</span>
            <span>{customInstruction.length}/{CUSTOM_INSTRUCTION_LIMIT}</span>
          </div>
        </div>
      </div>

      <div className="space-y-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm omni-settings-card">
        <div className="border-b border-slate-100 pb-3">
          <h3 className="text-sm font-medium text-slate-900 omni-settings-title">AGENTS.md 指令文件</h3>
          <p className="mt-1 text-xs text-slate-500 omni-settings-muted">
            仿 codex / deepseek-harness 的指令文件约定：一段自由格式的行为约定，人和 AI 都可直接编辑，会注入系统提示词。存在 AGENTS.override.md 时以它优先。
          </p>
        </div>

        <div className="space-y-2">
          <textarea
            value={agentsMd}
            onChange={handleAgentsMdChange}
            onBlur={handleAgentsMdBlur}
            placeholder='例如："你是一名注重可维护性的前端工程师；回答时优先给出可运行的最小改动，并说明取舍。"'
            rows={8}
            className="w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
          />
          <div className="flex items-center justify-between text-xs text-slate-500 omni-settings-muted">
            <span>自由格式，会写入 persona/AGENTS.md 并注入系统提示词</span>
            <span>{agentsMd.length}/{AGENTS_MD_LIMIT}</span>
          </div>
        </div>
      </div>

      {editingCard && (
        <div className="fixed inset-0 z-[12000] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-5 shadow-xl omni-settings-card">
            <h3 className="text-sm font-medium text-slate-900 omni-settings-title">{editingCard.title}</h3>
            <p className="mt-1 text-xs text-slate-500 omni-settings-muted">编辑后点击确认保存，内容会写入对应的 persona md 文件并注入系统提示词。</p>
            <textarea
              autoFocus
              value={draftValue}
              onChange={(event) => setDraftValue(event.target.value.slice(0, MEMORY_FIELD_LIMIT))}
              placeholder={editingCard.placeholder}
              rows={8}
              className="mt-4 w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
            />
            <div className="mt-2 flex items-center justify-between">
              <span className="text-xs text-slate-500 omni-settings-muted">{draftValue.length}/{MEMORY_FIELD_LIMIT}</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={cancelEditing}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={confirmEditing}
                  className="rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700"
                >
                  确认
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
