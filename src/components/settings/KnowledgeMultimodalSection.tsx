import { useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
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
import OmniSelect from "../ui/OmniSelect";
import { useDialogFocus } from "../../hooks/useDialogFocus";

type Props = {
  config: KnowledgeMultimodalConfig;
  onChangeConfig: (config: KnowledgeMultimodalConfig) => void;
  providerEndpoints?: ProviderEndpoint[];
};

type ProviderOption = {
  id: KnowledgeMultimodalProviderId;
  label: string;
  baseUrl?: string;
};

type ProviderEndpoint = {
  id: string;
  name: string;
  baseUrl: string;
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

export default function KnowledgeMultimodalSection({ config, onChangeConfig, providerEndpoints = [] }: Props) {
  const providerOptions = getKnowledgeMultimodalProviderOptions() as ProviderOption[];
  const providerSelectOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: ProviderOption[] = [];

    for (const endpoint of providerEndpoints) {
      const id = endpoint.id.trim();
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      options.push({ id, label: endpoint.name || id, baseUrl: endpoint.baseUrl });
    }

    for (const option of providerOptions) {
      if (seen.has(option.id)) {
        continue;
      }
      seen.add(option.id);
      options.push({ ...option, baseUrl: option.baseUrl || KNOWLEDGE_MULTIMODAL_PROVIDER_BASE_URLS[option.id] });
    }

    return options;
  }, [providerEndpoints, providerOptions]);
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
  const modelDialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(modelDialogRef, isModelFormOpen);

  const getProviderBaseUrl = (provider: string) =>
    providerSelectOptions.find((item) => item.id === provider)?.baseUrl || KNOWLEDGE_MULTIMODAL_PROVIDER_BASE_URLS[provider] || KNOWLEDGE_MULTIMODAL_PROVIDER_BASE_URLS.openai;

  const getProviderLabel = (provider: string) =>
    providerSelectOptions.find((item) => item.id === provider)?.label || provider;

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

  const toggleDefaultModel = (capability: KnowledgeMultimodalCapability, modelId: string) => {
    if (capability === "image") {
      updateConfig({
        activeImageModelId: normalizedConfig.activeImageModelId === modelId ? "" : modelId,
      });
      return;
    }

    updateConfig({
      activeAudioModelId: normalizedConfig.activeAudioModelId === modelId ? "" : modelId,
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
      baseUrl: editingModel.baseUrl.trim() || getProviderBaseUrl(editingModel.provider),
      model: modelValue,
      apiKey: editingModel.apiKey,
      capability,
    };

    const nextModels = existingModel
      ? normalizedConfig.models.map((model) => (model.id === existingModel.id ? normalizedModel : model))
      : [...normalizedConfig.models, normalizedModel];

    updateConfig({
      models: nextModels,
      activeImageModelId: normalizedConfig.activeImageModelId,
      activeAudioModelId: normalizedConfig.activeAudioModelId,
    });
    closeModelForm();
  };

  const removeModel = (modelId: string) => {
    const nextModels = normalizedConfig.models.filter((model) => model.id !== modelId);
    updateConfig({
      models: nextModels,
      activeImageModelId: normalizedConfig.activeImageModelId === modelId ? "" : normalizedConfig.activeImageModelId,
      activeAudioModelId: normalizedConfig.activeAudioModelId === modelId ? "" : normalizedConfig.activeAudioModelId,
    });
  };

  const statusText =
    normalizedConfig.models.length === 0
      ? "未配置模型"
      : `${imageModels.length} 个图片模型 / ${audioModels.length} 个音频模型`;
  const editingStoredModel = editingModel
    ? normalizedConfig.models.find((model) => model.id === editingModel.id) ?? null
    : null;
  const isEditingImageDefault = editingModel?.id === normalizedConfig.activeImageModelId;
  const isEditingAudioDefault = editingModel?.id === normalizedConfig.activeAudioModelId;

  return (
    <section className="omni-knowledge-multimodal-section flex min-h-0 flex-1 flex-col gap-4 rounded-xl border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="omni-knowledge-model-heading text-sm font-semibold">多模态模型</h3>
          <p className="omni-knowledge-model-description mt-1 text-xs leading-5">
            管理知识库可复用的图片与音频分析模型。知识库级多模态设置会从这里选择具体模型。
          </p>
        </div>
        <span className="omni-knowledge-status-badge" data-state={normalizedConfig.models.length > 0 ? "configured" : "empty"}>
          {statusText}
        </span>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <label className="omni-knowledge-model-default rounded-xl border p-4">
          <div className="omni-knowledge-model-list__title">图片默认模型</div>
          <div className="omni-knowledge-model-list__hint mt-1">知识库启用图片分析时，优先使用这里选中的模型；再次选择当前模型可取消默认。</div>
          <OmniSelect
            value={normalizedConfig.activeImageModelId}
            onChange={(value) => toggleDefaultModel("image", value)}
            placeholder="请选择图片模型"
            ariaLabel="图片默认模型"
            className="mt-3"
            options={imageModels.map((model) => ({ value: model.id, label: `${model.name} (${model.provider})` }))}
          />
        </label>

        <label className="omni-knowledge-model-default rounded-xl border p-4">
          <div className="omni-knowledge-model-list__title">音频默认模型</div>
          <div className="omni-knowledge-model-list__hint mt-1">知识库启用音频分析时，优先使用这里选中的模型；再次选择当前模型可取消默认。</div>
          <OmniSelect
            value={normalizedConfig.activeAudioModelId}
            onChange={(value) => toggleDefaultModel("audio", value)}
            placeholder="请选择音频模型"
            ariaLabel="音频默认模型"
            className="mt-3"
            options={audioModels.map((model) => ({ value: model.id, label: `${model.name} (${model.provider})` }))}
          />
        </label>
      </div>

      <div className="omni-knowledge-model-list flex min-h-0 flex-1 flex-col gap-3 rounded-xl border p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="omni-knowledge-model-list__title">模型列表</div>
            <div className="omni-knowledge-model-list__hint">每条模型记录只对应一种能力，便于知识库侧直接选择与校验。</div>
          </div>
          <button
            type="button"
            onClick={openNewModel}
            className="omni-knowledge-button omni-knowledge-button--secondary"
          >
            添加模型
          </button>
        </div>

        <div className="omni-knowledge-model-list__items max-h-[360px] space-y-2 overflow-y-auto overscroll-contain pt-3 pr-1 [scrollbar-gutter:stable]">
          {normalizedConfig.models.length > 0 ? (
            normalizedConfig.models.map((model) => {
              const isImageDefault = model.id === normalizedConfig.activeImageModelId;
              const isAudioDefault = model.id === normalizedConfig.activeAudioModelId;
              const isDefaultModel = isImageDefault || isAudioDefault;
              return (
                <div
                  key={model.id}
                  className="omni-knowledge-model-card rounded-lg border px-3 py-3 transition-colors"
                  data-active={isDefaultModel}
                >
                  <div className="flex items-start justify-between gap-4">
                    <button type="button" onClick={() => openEditModel(model)} className="omni-knowledge-model-card__edit min-w-0 flex-1 text-left">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="omni-knowledge-model-card__name truncate text-sm font-medium">{model.name}</span>
                        <span className="omni-knowledge-chip omni-knowledge-chip--provider shrink-0">
                          {getProviderLabel(model.provider)}
                        </span>
                      </div>
                      <div className="omni-knowledge-model-card__meta mt-2 truncate text-xs">
                        <span className="font-medium">模型 ID：</span>
                        {model.model}
                      </div>
                    </button>
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                      <span className="omni-knowledge-chip omni-knowledge-chip--capability">
                        {model.capability === "image" ? "图片" : "音频"}
                      </span>
                      {isImageDefault ? <span className="omni-knowledge-chip omni-knowledge-chip--selected">图片默认</span> : null}
                      {isAudioDefault ? <span className="omni-knowledge-chip omni-knowledge-chip--selected">音频默认</span> : null}
                      {!model.apiKey.trim() ? <span className="omni-knowledge-chip omni-knowledge-chip--warning">缺少 Key</span> : null}
                    </div>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="omni-knowledge-empty-state rounded-lg border border-dashed px-4 py-8 text-center text-xs">
              还没有多模态模型，点击“添加模型”先建一条记录。
            </div>
          )}
        </div>
      </div>

      {isModelFormOpen && editingModel ? (
        <div className="omni-knowledge-model-modal-backdrop">
          <div
            ref={modelDialogRef}
            className="omni-knowledge-model-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="knowledge-multimodal-model-dialog-title"
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                closeModelForm();
              }
            }}
          >
            <div className="omni-knowledge-model-dialog__header">
              <div>
                <h3 id="knowledge-multimodal-model-dialog-title" className="omni-knowledge-model-dialog__title">
                  {normalizedConfig.models.some((model) => model.id === editingModel.id) ? "编辑多模态模型" : "新增多模态模型"}
                </h3>
                <p className="omni-knowledge-model-dialog__hint mt-1 text-xs">每条模型记录只绑定一种能力，便于知识库按图片或音频分别选择。</p>
              </div>
              <button onClick={closeModelForm} aria-label="关闭" className="omni-knowledge-model-dialog__close" type="button">
                <X size={16} strokeWidth={1.8} />
              </button>
            </div>

            <div className="omni-knowledge-model-dialog__body">
              <label className="omni-knowledge-model-field">
                <span className="omni-knowledge-model-field__label">能力</span>
                <OmniSelect
                  value={editingModel.capability}
                  onChange={(value) =>
                    setEditingModel((current) =>
                      current ? { ...current, capability: value as KnowledgeMultimodalCapability } : current
                    )
                  }
                  ariaLabel="多模态模型能力"
                  options={KNOWLEDGE_MULTIMODAL_CAPABILITY_OPTIONS.map((item) => ({ value: item.id, label: item.label }))}
                />
              </label>

              <label className="omni-knowledge-model-field">
                <span className="omni-knowledge-model-field__label">供应商</span>
                <OmniSelect
                  value={editingModel.provider}
                  onChange={(value) => {
                    const provider = value as KnowledgeMultimodalProviderId;
                    setEditingModel((current) =>
                      current ? { ...current, provider, baseUrl: getProviderBaseUrl(provider) } : current
                    );
                  }}
                  ariaLabel="多模态模型供应商"
                  options={providerSelectOptions.map((item) => ({ value: item.id, label: item.label }))}
                />
              </label>

              <label className="omni-knowledge-model-field">
                <span className="omni-knowledge-model-field__label">Base URL</span>
                <input
                  value={editingModel.baseUrl}
                  onChange={(event) => setEditingModel((current) => (current ? { ...current, baseUrl: event.target.value } : current))}
                  placeholder="https://api.openai.com/v1"
                  className="omni-knowledge-model-input"
                />
              </label>

              <label className="omni-knowledge-model-field">
                <span className="omni-knowledge-model-field__label">显示名称</span>
                <input
                  value={editingModel.name}
                  onChange={(event) => setEditingModel((current) => (current ? { ...current, name: event.target.value } : current))}
                  placeholder="知识库图片分析模型"
                  className="omni-knowledge-model-input"
                />
              </label>

              <label className="omni-knowledge-model-field">
                <span className="omni-knowledge-model-field__label">模型 ID</span>
                <input
                  value={editingModel.model}
                  onChange={(event) => setEditingModel((current) => (current ? { ...current, model: event.target.value } : current))}
                  placeholder={editingModel.capability === "audio" ? "gpt-4o-mini-transcribe" : "gpt-4.1-mini"}
                  className="omni-knowledge-model-input"
                />
              </label>

              <label className="omni-knowledge-model-field">
                <span className="omni-knowledge-model-field__label">API Key</span>
                <input
                  type="password"
                  value={editingModel.apiKey}
                  onChange={(event) => setEditingModel((current) => (current ? { ...current, apiKey: event.target.value } : current))}
                  placeholder="该模型专用 API Key"
                  className="omni-knowledge-model-input"
                />
              </label>

              <div className="omni-knowledge-model-dialog__footer-row">
                <span />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    {editingStoredModel?.capability === "image" ? (
                      <button
                        type="button"
                        onClick={() => toggleDefaultModel("image", editingStoredModel.id)}
                        className={`omni-knowledge-button ${isEditingImageDefault ? "omni-knowledge-button--selected" : "omni-knowledge-button--secondary"}`}
                      >
                        {isEditingImageDefault ? "取消图片默认" : "设为图片默认"}
                      </button>
                    ) : null}
                    {editingStoredModel?.capability === "audio" ? (
                      <button
                        type="button"
                        onClick={() => toggleDefaultModel("audio", editingStoredModel.id)}
                        className={`omni-knowledge-button ${isEditingAudioDefault ? "omni-knowledge-button--selected" : "omni-knowledge-button--secondary"}`}
                      >
                        {isEditingAudioDefault ? "取消音频默认" : "设为音频默认"}
                      </button>
                    ) : null}
                    {editingStoredModel ? (
                      <button
                        type="button"
                        onClick={() => {
                          removeModel(editingStoredModel.id);
                          closeModelForm();
                        }}
                        className="omni-knowledge-button omni-knowledge-button--danger"
                      >
                        删除
                      </button>
                    ) : null}
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    <button
                      type="button"
                      onClick={closeModelForm}
                      className="omni-knowledge-button omni-knowledge-button--secondary"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      onClick={saveEditingModel}
                      className="omni-knowledge-button omni-knowledge-button--primary"
                    >
                      保存
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
