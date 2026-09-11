import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { CustomModelConfig, UnsupportedParam } from "../../adapters/types";
import {
  ALL_UNSUPPORTED_PARAMS,
  describeSkippedParams,
  forgetUnsupportedParam,
  getLearnedUnsupportedParams,
  unsupportedParamParts,
} from "../../adapters/paramCompat";
import type { ChatUsagePreferences } from "../../chat/types";
import OmniSelect from "../ui/OmniSelect";
import OmniSwitch from "../ui/OmniSwitch";

type Endpoint = { id: string; name: string; baseUrl: string };

type Props = {
  endpoints: Endpoint[];
  endpointModels: Array<CustomModelConfig & { endpointId: string; endpointName: string }>;
  availableModels: Array<{
    id: string;
    name: string;
    provider: string;
    requestModelId?: string;
    supportsVision: boolean;
    supportsStreaming: boolean;
  }>;
  currentModel: string;
  /** 当前正在编辑的模型的请求参数偏好（「新增模型」时为默认值） */
  modelPrefs: ChatUsagePreferences;
  testingConnection: boolean;
  testResult: boolean | null;
  isModelFormOpen: boolean;
  editingModel: { endpointId: string; id: string } | null;
  modelEndpointId: string;
  endpointName: string;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  modelName: string;
  modelVision: boolean;
  modelStreaming: boolean;
  /** 该模型声明「不接受」的参数槽位（下发请求时跳过，避免 400） */
  modelUnsupportedParams: UnsupportedParam[];
  onOpenNewModelForm: () => void;
  onOpenEditModelForm: (model: CustomModelConfig & { endpointId: string }) => void;
  onCloseModelForm: () => void;
  onChooseEndpoint: (id: string) => void;
  onSetModelEndpointId: (value: string) => void;
  onSetEndpointName: (value: string) => void;
  onSetBaseUrl: (value: string) => void;
  onSetApiKey: (value: string) => void;
  onSetModelId: (value: string) => void;
  onSetModelName: (value: string) => void;
  onSetModelVision: (value: boolean) => void;
  onSetModelStreaming: (value: boolean) => void;
  onToggleModelUnsupportedParam: (param: UnsupportedParam) => void;
  /** 修改当前编辑模型的请求参数（随「保存模型」一并落盘，按模型 id 隔离） */
  onSetModelPrefs: (prefs: ChatUsagePreferences) => void;
  onResetModelPrefs: () => void;
  onTestConnection: () => void | Promise<void>;
  onSaveModel: () => void | Promise<void>;
  onRemoveModel: (endpointId: string, id: string) => void;
  getRawApiKey: (id: string) => string;
  onModelChange: (modelId: string) => void | Promise<void>;
};

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="grid grid-cols-[84px_minmax(0,1fr)] items-start gap-x-4">
      <label className="pt-2 text-right text-[13px] leading-5 text-slate-600">{label}</label>
      <div className="min-w-0">
        {children}
        {hint ? <p className="mt-1.5 text-[11px] leading-4 text-slate-400">{hint}</p> : null}
      </div>
    </div>
  );
}

/** 区块小标题：左侧分组名，右侧一句用途提示。 */
function SectionLabel({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-slate-100 pt-4">
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">{children}</span>
      {hint ? <span className="text-right text-[11px] leading-4 text-slate-400">{hint}</span> : null}
    </div>
  );
}

/** 可收起分组：标题行整行可点，左侧箭头指示展开状态；收起时只剩标题与状态徽标。 */
function CollapsibleSection({
  title,
  hint,
  badge,
  open,
  onToggle,
  children,
}: {
  title: string;
  hint?: ReactNode;
  badge?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="border-t border-slate-100 pt-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="omni-collapsible-header -mx-1 flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-slate-50"
      >
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${open ? "" : "-rotate-90"}`} />
        <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">{title}</span>
        {badge}
        {hint ? <span className="ml-auto text-right text-[11px] leading-4 text-slate-400">{hint}</span> : null}
      </button>
      {open ? <div className="mt-2 space-y-2">{children}</div> : null}
    </div>
  );
}

/** 开关行：左侧标题（可带原始参数名徽标）+ 说明，右侧开关。 */
function ToggleRow({
  title,
  description,
  param,
  checked,
  disabled = false,
  onChange,
  ariaLabel,
}: {
  title: string;
  description?: string;
  param?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-slate-700">{title}</span>
          {param ? (
            <code className="rounded-md border border-slate-200 px-1.5 py-px font-mono text-[10px] leading-4 text-slate-500">{param}</code>
          ) : null}
        </div>
        {description ? <p className="mt-0.5 text-[11px] leading-4 text-slate-400">{description}</p> : null}
      </div>
      <OmniSwitch checked={checked} onChange={onChange} disabled={disabled} ariaLabel={ariaLabel} />
    </div>
  );
}

export default function ModelSettingsSection({
  endpoints,
  endpointModels,
  availableModels,
  currentModel,
  modelPrefs,
  testingConnection,
  testResult,
  isModelFormOpen,
  editingModel,
  modelEndpointId,
  endpointName,
  baseUrl,
  apiKey,
  modelId,
  modelName,
  modelVision,
  modelStreaming,
  modelUnsupportedParams,
  onOpenNewModelForm,
  onOpenEditModelForm,
  onCloseModelForm,
  onChooseEndpoint,
  onSetModelEndpointId,
  onSetEndpointName,
  onSetBaseUrl,
  onSetApiKey,
  onSetModelId,
  onSetModelName,
  onSetModelVision,
  onSetModelStreaming,
  onToggleModelUnsupportedParam,
  onSetModelPrefs,
  onResetModelPrefs,
  onTestConnection,
  onSaveModel,
  onRemoveModel,
  getRawApiKey,
  onModelChange,
}: Props) {
  const selectedMainModel = availableModels.find((model) => model.id === currentModel) ?? null;

  // 「参数兼容」默认收起：绝大多数模型无需手动声明，只有明确知道某参数不吃、
  // 或服务端已经报过 400 时才需要展开。每次打开弹窗都回到收起态，避免上一个模型
  // 的展开状态莫名其妙带到下一个模型上。
  const [paramCompatOpen, setParamCompatOpen] = useState(false);
  useEffect(() => {
    setParamCompatOpen(false);
  }, [isModelFormOpen, editingModel?.id]);

  // 收起态也要能看出「这个模型被调过参」，否则收起等于隐藏。
  const compatModelId = editingModel?.id ?? modelId;
  const skippedParams = describeSkippedParams(compatModelId, modelUnsupportedParams);
  // 仅由运行期学习（而非本弹窗手动声明）得到的跳过项：开关上看不出来，需要单独回显与撤销。
  const learnedOnlyParams = [...getLearnedUnsupportedParams(compatModelId)].filter(
    (param) => !modelUnsupportedParams.includes(param)
  );

  return (
    <>
      <section className="omni-model-section-card min-w-0 space-y-4">
        <div className="border-b border-slate-100 pb-2">
          <h3 className="text-sm font-medium text-slate-900">主模型</h3>
          <p className="mt-0.5 text-xs text-slate-500">主模型用于普通聊天和未单独指定模型的项目；项目设置里的默认模型会优先覆盖它。</p>
        </div>
        <Field label="当前主模型">
          <div className="space-y-2">
            <OmniSelect
              value={selectedMainModel?.id ?? ""}
              onChange={(value) => void onModelChange(value)}
              disabled={availableModels.length === 0}
              ariaLabel="当前主模型"
              placeholder="先新增并保存一个聊天模型"
              options={
                availableModels.length === 0
                  ? [{ value: "", label: "先新增并保存一个聊天模型", disabled: true }]
                  : availableModels.map((model) => ({ value: model.id, label: model.name }))
              }
            />
            <p className="omni-settings-muted text-[11px] text-slate-500">
              {selectedMainModel
                ? `${selectedMainModel.provider} / ${selectedMainModel.requestModelId || selectedMainModel.id}`
                : "暂无可用主模型，请先新增模型并测试通过。"}
            </p>
          </div>
        </Field>
      </section>

      <section className="omni-model-section-card min-w-0 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-medium uppercase tracking-[0.16em] text-slate-400">模型列表</div>
            <div className="mt-0.5 text-xs text-slate-500">点击模型可编辑接口、请求参数与参数兼容。</div>
          </div>
          <button onClick={onOpenNewModelForm} className="omni-model-add-button shrink-0 rounded-md bg-slate-900 px-4 py-2 text-xs text-white" type="button">
            新增模型
          </button>
        </div>
        <div className="max-h-[360px] space-y-2 overflow-y-auto overscroll-contain border-t border-slate-100 pt-3 pr-1 [scrollbar-gutter:stable]">
          {endpointModels.length === 0 ? (
            <div className="rounded-md border border-dashed border-slate-300 px-4 py-8 text-center text-xs text-slate-400">
              暂无自定义模型，点击右上角新增。
            </div>
          ) : (
            endpointModels.map((model) => {
              const isCurrentMainModel = model.id === currentModel;
              const skipped = describeSkippedParams(model.id, model.unsupportedParams);

              return (
                <button
                  key={model.id}
                  onClick={() => onOpenEditModelForm(model)}
                  aria-pressed={isCurrentMainModel}
                  className={`flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                    isCurrentMainModel
                      ? "border-violet-300 bg-violet-50 text-violet-950 shadow-[inset_3px_0_0_rgba(124,58,237,0.68)]"
                      : "border-slate-200 bg-slate-50 hover:border-violet-200 hover:bg-violet-50"
                  }`}
                  type="button"
                >
                  <span className={`font-medium ${isCurrentMainModel ? "text-violet-950" : "text-slate-800"}`}>{model.name}</span>
                  <span className={isCurrentMainModel ? "text-violet-500" : "text-slate-400"}>{model.requestModelId || model.id}</span>
                  {isCurrentMainModel && (
                    <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">当前主模型</span>
                  )}
                  <span className={`ml-auto ${isCurrentMainModel ? "text-violet-500" : "text-slate-400"}`}>{model.endpointName}</span>
                  {model.supportsVision && <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-700">视觉</span>}
                  {model.supportsStreaming && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700">流式</span>}
                  {skipped && (
                    <span
                      title={`下发时跳过：${skipped.names.join("、")}`}
                      className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700"
                    >
                      已调参 {skipped.count}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </section>

      {isModelFormOpen && (
        <div className="omni-model-section-modal absolute inset-0 z-20 flex items-center justify-center bg-slate-950/25 px-6">
          <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-center justify-between gap-4 border-b border-slate-100 px-5 py-3.5">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-slate-900">{editingModel ? "编辑模型" : "新增模型"}</h3>
                <p className="mt-0.5 truncate text-xs text-slate-500">{modelName.trim() || modelId.trim() || "配置接口与请求参数后保存"}</p>
              </div>
              <button
                onClick={onCloseModelForm}
                aria-label="关闭"
                className="shrink-0 rounded-md px-2 py-1 text-base leading-none text-slate-400 hover:text-slate-700"
                type="button"
              >
                ×
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-5 py-4 [scrollbar-gutter:stable]">
              <SectionLabel hint="接口地址与访问密钥">接口</SectionLabel>
              <Field label="所属接口">
                <OmniSelect
                  value={endpoints.some((endpoint) => endpoint.id === modelEndpointId) ? modelEndpointId : "__new__"}
                  onChange={onChooseEndpoint}
                  ariaLabel="模型所属接口"
                  options={[
                    { value: "__new__", label: "新建自定义接口" },
                    ...endpoints.map((endpoint) => ({ value: endpoint.id, label: endpoint.name })),
                  ]}
                />
              </Field>
              {!endpoints.some((endpoint) => endpoint.id === modelEndpointId) && (
                <Field label="接口 ID">
                  <input
                    value={modelEndpointId}
                    onChange={(e) => onSetModelEndpointId(e.target.value)}
                    placeholder="my-gateway"
                    className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"
                  />
                </Field>
              )}
              <Field label="接口名称">
                <input value={endpointName} onChange={(e) => onSetEndpointName(e.target.value)} className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm" />
              </Field>
              <Field label="接口地址">
                <input
                  value={baseUrl}
                  onChange={(e) => onSetBaseUrl(e.target.value)}
                  placeholder="留空使用官方默认端点"
                  className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"
                />
              </Field>
              <Field label="访问密钥">
                <input
                  type="password"
                  value={apiKey}
                  onFocus={() => apiKey === "********" && onSetApiKey("")}
                  onChange={(e) => onSetApiKey(e.target.value)}
                  className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"
                />
              </Field>
              <SectionLabel hint="模型标识与内置能力">模型</SectionLabel>
              <Field label="模型 ID">
                <input value={modelId} onChange={(e) => onSetModelId(e.target.value)} className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm" />
              </Field>
              <Field label="显示名称">
                <input value={modelName} onChange={(e) => onSetModelName(e.target.value)} className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm" />
              </Field>
              <SectionLabel hint="成对的两道开关需同时开启才生效">能力</SectionLabel>
              <div className="divide-y divide-slate-100 rounded-md border border-slate-200 px-3.5">
                <ToggleRow
                  title="视觉输入"
                  description="该模型具备读图能力"
                  checked={modelVision}
                  onChange={onSetModelVision}
                  ariaLabel="模型支持视觉输入"
                />
                <ToggleRow
                  title="图片输入"
                  description="允许在对话中发送图片"
                  checked={modelPrefs.enableVisionInput}
                  onChange={(checked) => onSetModelPrefs({ ...modelPrefs, enableVisionInput: checked })}
                  ariaLabel="允许图片"
                />
                <ToggleRow
                  title="流式输出"
                  description="该模型支持逐字返回"
                  checked={modelStreaming}
                  onChange={onSetModelStreaming}
                  ariaLabel="模型支持流式输出"
                />
                <ToggleRow
                  title="流式请求"
                  description="聊天时实际使用流式返回"
                  checked={modelPrefs.enableStreaming}
                  onChange={(checked) => onSetModelPrefs({ ...modelPrefs, enableStreaming: checked })}
                  ariaLabel="默认流式"
                />
              </div>
              <SectionLabel hint="仅作用于当前模型，与其他模型互不影响">请求参数</SectionLabel>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1 block text-[11px] text-slate-500">采样温度</span>
                  <input
                    type="number"
                    step="0.1"
                    value={modelPrefs.temperature}
                    onChange={(e) => onSetModelPrefs({ ...modelPrefs, temperature: Number(e.target.value) })}
                    className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"
                  />
                  <span className="mt-1 block text-[11px] leading-4 text-slate-400">越大越随机，常用 0～1</span>
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] text-slate-500">最大输出 Token</span>
                  <input
                    type="number"
                    value={modelPrefs.maxOutputTokens}
                    onChange={(e) => onSetModelPrefs({ ...modelPrefs, maxOutputTokens: Number(e.target.value) })}
                    className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"
                  />
                  <span className="mt-1 block text-[11px] leading-4 text-slate-400">单次回复生成上限，非上下文长度</span>
                </label>
              </div>
              <div className="divide-y divide-slate-100 rounded-md border border-slate-200 px-3.5">
                <ToggleRow
                  title="省算力压缩"
                  description="上下文溢出时跳过 LLM 摘要，直接丢弃最旧历史"
                  checked={modelPrefs.costSaverCompaction ?? false}
                  onChange={(checked) => onSetModelPrefs({ ...modelPrefs, costSaverCompaction: checked })}
                  ariaLabel="省算力压缩"
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] leading-4 text-slate-400">未单独设置过的模型沿用默认值。</span>
                <button onClick={onResetModelPrefs} className="shrink-0 rounded-md border border-slate-200 px-3 py-1.5 text-xs text-slate-600" type="button">
                  重置为默认
                </button>
              </div>
              <CollapsibleSection
                title="参数兼容"
                hint={paramCompatOpen ? "开启后下发请求时自动跳过" : "按需展开"}
                open={paramCompatOpen}
                onToggle={() => setParamCompatOpen((open) => !open)}
                badge={
                  skippedParams ? (
                    <span
                      title={`下发时跳过：${skippedParams.names.join("、")}`}
                      className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700"
                    >
                      已调参 {skippedParams.count}
                    </span>
                  ) : null
                }
              >
                {learnedOnlyParams.length > 0 ? (
                  <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
                    <p className="text-[11px] leading-4 text-amber-800">
                      Omni 已根据服务端反馈自动跳过下列参数；下面的开关是「手动声明」入口，因此它们不会显示为开启。
                    </p>
                    <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1.5">
                      {learnedOnlyParams.map((param) => (
                        <li key={param} className="flex items-center gap-1.5">
                          <span className="text-[11px] text-amber-800">{unsupportedParamParts(param).title}</span>
                          <button
                            type="button"
                            onClick={() => forgetUnsupportedParam(compatModelId, param)}
                            className="rounded border border-amber-300 px-1.5 py-px text-[10px] text-amber-800 hover:bg-amber-100"
                          >
                            恢复下发
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <div className="divide-y divide-slate-100 rounded-md border border-slate-200 px-3.5">
                  {ALL_UNSUPPORTED_PARAMS.map((param) => {
                    const { wire, title } = unsupportedParamParts(param);
                    return (
                      <ToggleRow
                        key={param}
                        title={title}
                        param={wire}
                        checked={modelUnsupportedParams.includes(param)}
                        onChange={() => onToggleModelUnsupportedParam(param)}
                        ariaLabel={`模型不支持 ${param}`}
                      />
                    );
                  })}
                </div>
                <p className="text-[11px] leading-4 text-slate-400">
                  标注该模型不接受的参数，避免 400 报错。服务端报「参数不被支持」时 Omni 也会自动跳过并记住，无需手动开启。
                </p>
              </CollapsibleSection>
            </div>
            <div className="omni-model-modal-footer flex flex-wrap items-center gap-2 border-t border-slate-100 px-5 py-3.5">
              <button
                onClick={onTestConnection}
                disabled={testingConnection || !modelEndpointId.trim() || !endpointName.trim() || (!apiKey.trim() && !getRawApiKey(modelEndpointId.trim()))}
                className="rounded-md border border-slate-200 px-4 py-2 text-xs text-slate-600 disabled:opacity-40"
                type="button"
              >
                {testingConnection ? "测试中..." : "测试连接"}
              </button>
              <button
                onClick={onSaveModel}
                disabled={testingConnection || !modelEndpointId.trim() || !endpointName.trim() || !modelId.trim() || (!apiKey.trim() && !getRawApiKey(modelEndpointId.trim()))}
                className="rounded-md bg-violet-600 px-4 py-2 text-xs font-medium text-white disabled:opacity-40"
                type="button"
              >
                {testingConnection ? "检测中..." : "保存模型"}
              </button>
              <button onClick={onCloseModelForm} className="rounded-md border border-slate-200 px-4 py-2 text-xs text-slate-600" type="button">
                取消
              </button>
              <div className="ml-auto flex items-center gap-3">
                {testResult === true && <span className="text-xs text-emerald-600">连接成功</span>}
                {testResult === false && <span className="text-xs text-red-600">连接失败</span>}
                {editingModel && (
                  <button
                    onClick={() => onRemoveModel(editingModel.endpointId, editingModel.id)}
                    className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-600"
                    type="button"
                  >
                    删除模型
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
