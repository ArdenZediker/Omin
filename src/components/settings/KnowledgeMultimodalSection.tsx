import { useMemo, useState } from "react";
import {
  getKnowledgeMultimodalModelsByCapability,
  getKnowledgeMultimodalProviderOptions,
  KNOWLEDGE_MULTIMODAL_CAPABILITY_OPTIONS,
  KNOWLEDGE_MULTIMODAL_PROVIDER_BASE_URLS,
  normalizeKnowledgeMultimodalConfig,
  type KnowledgeMultimodalCapability,
  type KnowledgeMultimodalConfig,
  type KnowledgeMultimodalModelConfig,
  type KnowledgeMultimodalProviderId,
} from "../../chat/knowledgeMultimodal";

type Props = {
  config: KnowledgeMultimodalConfig;
  onChangeConfig: (config: KnowledgeMultimodalConfig) => void;
};

type ProviderOption = {
  id: KnowledgeMultimodalProviderId;
  label: string;
};

type EditingModelState = KnowledgeMultimodalModelConfig;

function createBlankModel(index: number): EditingModelState {
  return {
    id: `openai:image:custom-${index + 1}`,
    name: `多模态模型 ${index + 1}`,
    provider: "openai",
    baseUrl: KNOWLEDGE_MULTIMODAL_PROVIDER_BASE_URLS.openai,
    model: "",
    apiKey: "",
    capability: "image",
  };
}

export default function KnowledgeMultimodalSection({ config, onChangeConfig }: Props) {
  const providerOptions = getKnowledgeMultimodalProviderOptions() as ProviderOption[];
  const normalizedConfig = useMemo(() => normalizeKnowledgeMultimodalConfig(config), [config]);
  const imageModels = useMemo(
    () => getKnowledgeMultimodalModelsByCapability(normalizedConfig, "image"),
    [normalizedConfig]
  );
  const audioModels = useMemo(
    () => getKnowledgeMultimodalModelsByCapability(normalizedConfig, "audio"),
    [normalizedConfig]
  );
  const [isModelFormOpen, setIsModelFormOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<EditingModelState | null>(null);

  const commit = (next: KnowledgeMultimodalConfig) => {
    onChangeConfig(normalizeKnowledgeMultimodalConfig(next));
  };

  const updateConfig = (patch: Partial<KnowledgeMultimodalConfig>) => {
    const next = normalizeKnowledgeMultimodalConfig({ ...normalizedConfig, ...patch });
    commit({
      ...next,
      enabled: next.models.length > 0,
    });
  };

  const openNewModel = () => {
    setEditingModel(createBlankModel(normalizedConfig.models.length));
    setIsModelFormOpen(true);
  };

  const openEditModel = (model: KnowledgeMultimodalModelConfig) => {
    setEditingModel(model);
    setIsModelFormOpen(true);
  };

  const closeModelForm = () => {
    setIsModelFormOpen(false);
    setEditingModel(null);
  };

  const saveEditingModel = () => {
    if (!editingModel) {
      return;
    }

    const capability = editingModel.capability;
    const modelValue = editingModel.model.trim() || (capability === "audio" ? "gpt-4o-mini-transcribe" : "gpt-4.1-mini");
    const existingModel = normalizedConfig.models.find((model) => model.id === editingModel.id);
    const normalizedModel: KnowledgeMultimodalModelConfig = {
      ...editingModel,
      id:
        existingModel?.id ??
        `${editingModel.provider}:${capability}:${modelValue}:${
          normalizedConfig.models.filter((model) => model.provider === editingModel.provider && model.capability === capability).length + 1
        }`,
      name: editingModel.name.trim() || modelValue,
      provider: editingModel.provider,
      baseUrl: editingModel.baseUrl.trim() || KNOWLEDGE_MULTIMODAL_PROVIDER_BASE_URLS[editingModel.provider],
      model: modelValue,
      apiKey: editingModel.apiKey,
      capability,
    };

    const nextModels = existingModel
      ? normalizedConfig.models.map((model) => (model.id === existingModel.id ? normalizedModel : model))
      : [...normalizedConfig.models, normalizedModel];

    updateConfig({
      models: nextModels,
      activeImageModelId:
        capability === "image" && !normalizedConfig.activeImageModelId
          ? normalizedModel.id
          : normalizedConfig.activeImageModelId,
      activeAudioModelId:
        capability === "audio" && !normalizedConfig.activeAudioModelId
          ? normalizedModel.id
          : normalizedConfig.activeAudioModelId,
    });
    closeModelForm();
  };

  const removeModel = (modelId: string) => {
    const nextModels = normalizedConfig.models.filter((model) => model.id !== modelId);
    updateConfig({
      models: nextModels,
      activeImageModelId:
        normalizedConfig.activeImageModelId === modelId
          ? nextModels.find((model) => model.capability === "image")?.id ?? ""
          : normalizedConfig.activeImageModelId,
      activeAudioModelId:
        normalizedConfig.activeAudioModelId === modelId
          ? nextModels.find((model) => model.capability === "audio")?.id ?? ""
          : normalizedConfig.activeAudioModelId,
    });
  };

  const statusText =
    normalizedConfig.models.length === 0
      ? "未配置模型"
      : `${imageModels.length} 个图片模型 / ${audioModels.length} 个音频模型`;

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-900">多模态模型</h3>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            管理知识库可复用的图片与音频分析模型。知识库级多模态设置会从这里选择具体模型。
          </p>
        </div>
        <span
          className={`inline-flex items-center rounded-full px-2 py-1 text-[11px] ${
            normalizedConfig.models.length > 0 ? "bg-sky-100 text-sky-700" : "bg-slate-200 text-slate-600"
          }`}
        >
          {statusText}
        </span>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <label className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium uppercase tracking-[0.16em] text-slate-400">图片默认模型</div>
          <div className="mt-1 text-xs text-slate-500">知识库启用图片分析时，优先使用这里选中的模型。</div>
          <select
            value={normalizedConfig.activeImageModelId}
            onChange={(event) => updateConfig({ activeImageModelId: event.target.value })}
            className="mt-3 h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
          >
            <option value="">未设置</option>
            {imageModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name} ({model.provider})
              </option>
            ))}
          </select>
        </label>

        <label className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium uppercase tracking-[0.16em] text-slate-400">音频默认模型</div>
          <div className="mt-1 text-xs text-slate-500">知识库启用音频分析时，优先使用这里选中的模型。</div>
          <select
            value={normalizedConfig.activeAudioModelId}
            onChange={(event) => updateConfig({ activeAudioModelId: event.target.value })}
            className="mt-3 h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
          >
            <option value="">未设置</option>
            {audioModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name} ({model.provider})
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-medium uppercase tracking-[0.16em] text-slate-400">模型列表</div>
            <div className="text-xs text-slate-500">每条模型记录只对应一种能力，便于知识库侧直接选择与校验。</div>
          </div>
          <button
            type="button"
            onClick={openNewModel}
            className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
          >
            添加模型
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {normalizedConfig.models.length > 0 ? (
            normalizedConfig.models.map((model) => {
              const isImageDefault = model.id === normalizedConfig.activeImageModelId;
              const isAudioDefault = model.id === normalizedConfig.activeAudioModelId;
              return (
                <div key={model.id} className="rounded-lg border border-slate-200 bg-white px-3 py-3 transition-colors hover:border-slate-300">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <button type="button" onClick={() => openEditModel(model)} className="min-w-0 flex-1 text-left">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        <span className="rounded-full bg-slate-100 px-2 py-1">供应商：{model.provider}</span>
                        <span className="rounded-full bg-slate-100 px-2 py-1">{model.name}</span>
                        <span className="rounded-full bg-sky-100 px-2 py-1 text-sky-700">
                          {model.capability === "image" ? "图片" : "音频"}
                        </span>
                        {isImageDefault ? <span className="rounded-full bg-emerald-100 px-2 py-1 text-emerald-700">图片默认</span> : null}
                        {isAudioDefault ? <span className="rounded-full bg-emerald-100 px-2 py-1 text-emerald-700">音频默认</span> : null}
                        {!model.apiKey.trim() ? <span className="rounded-full bg-amber-100 px-2 py-1 text-amber-700">缺少 Key</span> : null}
                      </div>
                      <div className="mt-2 text-xs text-slate-400">
                        <span className="font-medium text-slate-500">模型 ID：</span>
                        {model.model}
                      </div>
                    </button>

                    <div className="flex shrink-0 items-center gap-2">
                      {model.capability === "image" && !isImageDefault ? (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            updateConfig({ activeImageModelId: model.id });
                          }}
                          className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
                        >
                          设为图片默认
                        </button>
                      ) : null}
                      {model.capability === "audio" && !isAudioDefault ? (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            updateConfig({ activeAudioModelId: model.id });
                          }}
                          className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
                        >
                          设为音频默认
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          removeModel(model.id);
                        }}
                        className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs text-rose-600 hover:bg-rose-100"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-xs text-slate-400">
              还没有多模态模型，点击“添加模型”先建一条记录。
            </div>
          )}
        </div>
      </div>

      {isModelFormOpen && editingModel ? (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-950/25 px-6">
          <div className="w-full max-w-xl rounded-xl border border-slate-200 bg-white p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  {normalizedConfig.models.some((model) => model.id === editingModel.id) ? "编辑多模态模型" : "新增多模态模型"}
                </h3>
                <p className="mt-1 text-xs text-slate-500">每条模型记录只绑定一种能力，便于知识库按图片或音频分别选择。</p>
              </div>
              <button onClick={closeModelForm} className="text-slate-400 hover:text-slate-700" type="button">
                ×
              </button>
            </div>

            <div className="space-y-4">
              <label className="grid grid-cols-[120px_1fr] gap-4">
                <span className="pt-2 text-right text-sm text-slate-700">能力</span>
                <select
                  value={editingModel.capability}
                  onChange={(event) =>
                    setEditingModel((current) =>
                      current ? { ...current, capability: event.target.value as KnowledgeMultimodalCapability } : current
                    )
                  }
                  className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"
                >
                  {KNOWLEDGE_MULTIMODAL_CAPABILITY_OPTIONS.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="grid grid-cols-[120px_1fr] gap-4">
                <span className="pt-2 text-right text-sm text-slate-700">供应商</span>
                <select
                  value={editingModel.provider}
                  onChange={(event) => {
                    const provider = event.target.value as KnowledgeMultimodalProviderId;
                    setEditingModel((current) =>
                      current ? { ...current, provider, baseUrl: KNOWLEDGE_MULTIMODAL_PROVIDER_BASE_URLS[provider] } : current
                    );
                  }}
                  className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"
                >
                  {providerOptions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="grid grid-cols-[120px_1fr] gap-4">
                <span className="pt-2 text-right text-sm text-slate-700">Base URL</span>
                <input
                  value={editingModel.baseUrl}
                  onChange={(event) => setEditingModel((current) => (current ? { ...current, baseUrl: event.target.value } : current))}
                  placeholder="https://api.openai.com/v1"
                  className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"
                />
              </label>

              <label className="grid grid-cols-[120px_1fr] gap-4">
                <span className="pt-2 text-right text-sm text-slate-700">显示名称</span>
                <input
                  value={editingModel.name}
                  onChange={(event) => setEditingModel((current) => (current ? { ...current, name: event.target.value } : current))}
                  placeholder="知识库图片分析模型"
                  className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"
                />
              </label>

              <label className="grid grid-cols-[120px_1fr] gap-4">
                <span className="pt-2 text-right text-sm text-slate-700">模型 ID</span>
                <input
                  value={editingModel.model}
                  onChange={(event) => setEditingModel((current) => (current ? { ...current, model: event.target.value } : current))}
                  placeholder={editingModel.capability === "audio" ? "gpt-4o-mini-transcribe" : "gpt-4.1-mini"}
                  className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"
                />
              </label>

              <label className="grid grid-cols-[120px_1fr] gap-4">
                <span className="pt-2 text-right text-sm text-slate-700">API Key</span>
                <input
                  type="password"
                  value={editingModel.apiKey}
                  onChange={(event) => setEditingModel((current) => (current ? { ...current, apiKey: event.target.value } : current))}
                  placeholder="该模型专用 API Key"
                  className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"
                />
              </label>

              <div className="grid grid-cols-[120px_1fr] gap-4">
                <span />
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={closeModelForm}
                    className="rounded-md border border-slate-200 bg-white px-4 py-2 text-xs text-slate-600 hover:bg-slate-50"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={saveEditingModel}
                    className="rounded-md bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800"
                  >
                    保存
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
