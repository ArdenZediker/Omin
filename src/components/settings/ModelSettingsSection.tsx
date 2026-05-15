import type { ReactNode } from "react";
import type { CustomModelConfig } from "../../adapters/types";
import type { ChatUsagePreferences } from "../../chat/types";

type Endpoint = { id: string; name: string; baseUrl: string };

type Props = {
  endpoints: Endpoint[];
  endpointModels: Array<CustomModelConfig & { endpointId: string; endpointName: string }>;
  prefs: ChatUsagePreferences;
  prefsSaveStatus: "idle" | "saved" | "error";
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
  onSaveModel: () => void | Promise<void>;
  onRemoveModel: (endpointId: string, id: string) => void;
  getRawApiKey: (id: string) => string;
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-4">
      <label className="pt-2 text-right text-sm text-slate-700">{label}</label>
      {children}
    </div>
  );
}

function Actions({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-4">
      <span className="pt-1 text-right text-sm text-slate-700">{label}</span>
      <div className="flex items-center gap-3">{children}</div>
    </div>
  );
}

export default function ModelSettingsSection({
  endpoints,
  endpointModels,
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
  onSaveModel,
  onRemoveModel,
  getRawApiKey,
}: Props) {
  return (
    <>
      <section className="min-w-0 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-medium uppercase tracking-[0.16em] text-slate-400">模型列表</div>
            <div className="mt-0.5 text-xs text-slate-500">当前已创建的聊天模型会显示在这里。</div>
          </div>
          <button onClick={onOpenNewModelForm} className="shrink-0 rounded-md bg-slate-900 px-4 py-2 text-xs text-white" type="button">
            新增模型
          </button>
        </div>
        <div className="space-y-2">
          {endpointModels.length === 0 ? (
            <div className="rounded-md border border-dashed border-slate-300 px-4 py-8 text-center text-xs text-slate-400">
              暂无自定义模型，点击右上角新增。
            </div>
          ) : (
            endpointModels.map((model) => (
              <button
                key={model.id}
                onClick={() => onOpenEditModelForm(model)}
                className="flex w-full items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-left text-xs hover:border-violet-200 hover:bg-violet-50"
                type="button"
              >
                <span className="font-medium text-slate-800">{model.name}</span>
                <span className="text-slate-400">{model.requestModelId || model.id}</span>
                <span className="ml-auto text-slate-400">{model.endpointName}</span>
                {model.supportsVision && <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-700">视觉</span>}
                {model.supportsStreaming && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700">流式</span>}
              </button>
            ))
          )}
        </div>
      </section>

      <section className="min-w-0 space-y-4">
        <div className="border-b border-slate-100 pb-2">
          <h3 className="text-sm font-medium text-slate-900">使用偏好</h3>
          <p className="mt-0.5 text-xs text-slate-500">控制默认请求参数，最终会与模型能力共同决定实际行为。</p>
        </div>
        <Actions label="默认流式">
          <input type="checkbox" checked={prefs.enableStreaming} onChange={(e) => onSetPrefs({ ...prefs, enableStreaming: e.target.checked })} />
        </Actions>
        <Actions label="允许图片">
          <input type="checkbox" checked={prefs.enableVisionInput} onChange={(e) => onSetPrefs({ ...prefs, enableVisionInput: e.target.checked })} />
        </Actions>
        <Field label="采样温度">
          <input
            type="number"
            step="0.1"
            value={prefs.temperature}
            onChange={(e) => onSetPrefs({ ...prefs, temperature: Number(e.target.value) })}
            className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"
          />
        </Field>
        <Field label="最大输出 Token">
          <div className="space-y-1">
            <input
              type="number"
              value={prefs.maxOutputTokens}
              onChange={(e) => onSetPrefs({ ...prefs, maxOutputTokens: Number(e.target.value) })}
              className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"
            />
            <p className="omni-settings-muted text-[11px] text-slate-500">限制单次回复最多生成的 token 数，不等于模型上下文长度。</p>
          </div>
        </Field>
        <Actions>
          <div className="flex items-center gap-3">
            <button
              onClick={onSavePrefs}
              className={`rounded-md px-4 py-2 text-xs font-medium text-white transition-colors ${
                prefsSaveStatus === "saved" ? "bg-emerald-600" : prefsSaveStatus === "error" ? "bg-red-600" : "bg-violet-600 hover:bg-violet-500"
              }`}
              type="button"
            >
              {prefsSaveStatus === "saved" ? "已保存" : prefsSaveStatus === "error" ? "保存失败" : "保存偏好"}
            </button>
            {prefsSaveStatus === "saved" && <span className="text-xs text-emerald-600">偏好已生效</span>}
            {prefsSaveStatus === "error" && <span className="text-xs text-red-500">请重试</span>}
          </div>
        </Actions>
      </section>

      {isModelFormOpen && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/25 px-6">
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
                <select
                  value={endpoints.some((endpoint) => endpoint.id === modelEndpointId) ? modelEndpointId : "__new__"}
                  onChange={(e) => onChooseEndpoint(e.target.value)}
                  className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"
                >
                  <option value="__new__">新建自定义接口</option>
                  {endpoints.map((endpoint) => (
                    <option key={endpoint.id} value={endpoint.id}>
                      {endpoint.name}
                    </option>
                  ))}
                </select>
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
                <label className="text-sm">
                  <input type="checkbox" checked={modelVision} onChange={(e) => onSetModelVision(e.target.checked)} /> 视觉输入
                </label>
                <label className="text-sm">
                  <input type="checkbox" checked={modelStreaming} onChange={(e) => onSetModelStreaming(e.target.checked)} /> 流式输出
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
