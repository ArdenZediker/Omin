import { useState, type ReactNode } from "react";
import type { CustomModelConfig } from "../../adapters/types";
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
  prefs: ChatUsagePreferences;
  prefsSaveStatus: "idle" | "dirty" | "saved" | "error";
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
  onSetPrefs: (prefs: ChatUsagePreferences) => void;
  onTestConnection: () => void | Promise<void>;
  onSavePrefs: () => void;
  onResetPrefs: () => void;
  onSaveModel: () => void | Promise<void>;
  onRemoveModel: (endpointId: string, id: string) => void;
  getRawApiKey: (id: string) => string;
  onModelChange: (modelId: string) => void | Promise<void>;
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-4">
      <label className="omni-model-section-field__label pt-2 text-right text-sm text-slate-700">{label}</label>
      {children}
    </div>
  );
}

function Actions({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-4">
      <span className="omni-model-section-field__label pt-1 text-right text-sm text-slate-700">{label}</span>
      <div className="flex items-center gap-3">{children}</div>
    </div>
  );
}

export default function ModelSettingsSection({
  endpoints,
  endpointModels,
  availableModels,
  currentModel,
  prefs,
  prefsSaveStatus,
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
  onSetPrefs,
  onTestConnection,
  onSavePrefs,
  onResetPrefs,
  onSaveModel,
  onRemoveModel,
  getRawApiKey,
  onModelChange,
}: Props) {
  const selectedMainModel = availableModels.find((model) => model.id === currentModel) ?? null;
  const [isPrefsPanelOpen, setIsPrefsPanelOpen] = useState(false);

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
            <div className="mt-0.5 text-xs text-slate-500">当前已创建的聊天模型会显示在这里。</div>
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
                </button>
              );
            })
          )}
        </div>
      </section>

      <section className="omni-model-section-card min-w-0 space-y-4">
        <div className="omni-model-prefs-heading border-b border-slate-100 pb-2">
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-slate-900">使用偏好</h3>
            <p className="mt-0.5 text-xs text-slate-500">控制默认请求参数，最终会与模型能力共同决定实际行为。</p>
          </div>
          <button type="button" onClick={() => setIsPrefsPanelOpen(true)} className="omni-model-prefs-summary__button">
            配置请求参数
          </button>
        </div>
      </section>

      {isPrefsPanelOpen && (
        <div className="omni-model-section-modal absolute inset-0 z-20 flex items-center justify-center bg-slate-950/25 px-6">
          <div className="w-full max-w-2xl rounded-xl border border-slate-200 bg-white p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">请求参数配置</h3>
                <p className="mt-0.5 text-xs text-slate-500">这些参数会作为默认偏好参与聊天请求，最终仍受模型能力限制。</p>
              </div>
              <button onClick={() => setIsPrefsPanelOpen(false)} className="text-slate-400 hover:text-slate-700" type="button">
                ×
              </button>
            </div>
            <div className="omni-model-prefs-grid">
              <label className="omni-model-prefs-toggle">
                <div>
                  <div className="omni-model-prefs-label">默认流式</div>
                  <div className="omni-model-prefs-hint">优先以流式方式返回模型回复。</div>
                </div>
                <OmniSwitch checked={prefs.enableStreaming} onChange={(checked) => onSetPrefs({ ...prefs, enableStreaming: checked })} ariaLabel="默认流式" />
              </label>
              <label className="omni-model-prefs-toggle">
                <div>
                  <div className="omni-model-prefs-label">允许图片</div>
                  <div className="omni-model-prefs-hint">允许支持视觉的模型接收图片输入。</div>
                </div>
                <OmniSwitch checked={prefs.enableVisionInput} onChange={(checked) => onSetPrefs({ ...prefs, enableVisionInput: checked })} ariaLabel="允许图片" />
              </label>
              <label className="omni-model-prefs-field">
                <span className="omni-model-prefs-label">采样温度</span>
                <input
                  type="number"
                  step="0.1"
                  value={prefs.temperature}
                  onChange={(e) => onSetPrefs({ ...prefs, temperature: Number(e.target.value) })}
                  className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"
                />
              </label>
              <label className="omni-model-prefs-field">
                <span className="omni-model-prefs-label">最大输出 Token</span>
                <input
                  type="number"
                  value={prefs.maxOutputTokens}
                  onChange={(e) => onSetPrefs({ ...prefs, maxOutputTokens: Number(e.target.value) })}
                  className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"
                />
                <p className="omni-settings-muted text-[11px] text-slate-500">限制单次回复最多生成的 token 数，不等于模型上下文长度。</p>
              </label>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
              <button
                onClick={onSavePrefs}
                disabled={prefsSaveStatus !== "dirty" && prefsSaveStatus !== "error"}
                className={`rounded-md px-4 py-2 text-xs font-medium text-white transition-colors ${
                  prefsSaveStatus === "saved"
                    ? "bg-emerald-600"
                    : prefsSaveStatus === "error"
                      ? "bg-red-600"
                      : prefsSaveStatus === "dirty"
                        ? "bg-violet-600 hover:bg-violet-500"
                        : "bg-slate-300"
                }`}
                type="button"
              >
                {prefsSaveStatus === "saved" ? "已保存" : prefsSaveStatus === "error" ? "保存失败" : prefsSaveStatus === "dirty" ? "保存修改" : "已是最新"}
              </button>
              <button onClick={onResetPrefs} className="rounded-md border border-slate-200 px-4 py-2 text-xs text-slate-600" type="button">
                重置默认
              </button>
              <button onClick={() => setIsPrefsPanelOpen(false)} className="rounded-md border border-slate-200 px-4 py-2 text-xs text-slate-600" type="button">
                关闭
              </button>
              {prefsSaveStatus === "dirty" && <span className="text-xs text-amber-600">有未保存修改</span>}
              {prefsSaveStatus === "saved" && <span className="text-xs text-emerald-600">已同步到聊天请求</span>}
              {prefsSaveStatus === "error" && <span className="text-xs text-red-500">请重试</span>}
            </div>
          </div>
        </div>
      )}

      {isModelFormOpen && (
        <div className="omni-model-section-modal absolute inset-0 z-20 flex items-center justify-center bg-slate-950/25 px-6">
          <div className="w-full max-w-xl rounded-xl border border-slate-200 bg-white p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">{editingModel ? "编辑模型" : "新增模型"}</h3>
                <p className="mt-0.5 text-xs text-slate-500">配置完成后保存并返回模型列表。</p>
              </div>
              <button onClick={onCloseModelForm} className="text-slate-400 hover:text-slate-700" type="button">
                ×
              </button>
            </div>
            <div className="space-y-4">
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
                <input value={baseUrl} onChange={(e) => onSetBaseUrl(e.target.value)} className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm" />
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
              <Field label="模型 ID">
                <input value={modelId} onChange={(e) => onSetModelId(e.target.value)} className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm" />
              </Field>
              <Field label="显示名称">
                <input value={modelName} onChange={(e) => onSetModelName(e.target.value)} className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm" />
              </Field>
              <Actions>
                <label className="inline-flex items-center gap-2 text-sm">
                  <OmniSwitch checked={modelVision} onChange={onSetModelVision} ariaLabel="模型支持视觉输入" />
                  <span>视觉输入</span>
                </label>
                <label className="inline-flex items-center gap-2 text-sm">
                  <OmniSwitch checked={modelStreaming} onChange={onSetModelStreaming} ariaLabel="模型支持流式输出" />
                  <span>流式输出</span>
                </label>
              </Actions>
              <Actions>
                <button
                  onClick={onTestConnection}
                  disabled={testingConnection || !modelEndpointId.trim() || !endpointName.trim() || !baseUrl.trim() || (!apiKey.trim() && !getRawApiKey(modelEndpointId.trim()))}
                  className="rounded-md border border-slate-200 px-4 py-2 text-xs text-slate-600 disabled:opacity-40"
                  type="button"
                >
                  {testingConnection ? "测试中..." : "测试连接"}
                </button>
                <button
                  onClick={onSaveModel}
                  disabled={testingConnection || !modelEndpointId.trim() || !endpointName.trim() || !baseUrl.trim() || !modelId.trim() || (!apiKey.trim() && !getRawApiKey(modelEndpointId.trim()))}
                  className="rounded-md bg-violet-600 px-4 py-2 text-xs font-medium text-white disabled:opacity-40"
                  type="button"
                >
                  {testingConnection ? "检测中..." : "保存模型"}
                </button>
                <button onClick={onCloseModelForm} className="rounded-md border border-slate-200 px-4 py-2 text-xs text-slate-600" type="button">
                  取消
                </button>
                {editingModel && (
                  <button
                    onClick={() => onRemoveModel(editingModel.endpointId, editingModel.id)}
                    className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-600"
                    type="button"
                  >
                    删除模型
                  </button>
                )}
                {testResult === true && <span className="text-xs text-emerald-600">连接成功</span>}
                {testResult === false && <span className="text-xs text-red-600">连接失败</span>}
              </Actions>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
