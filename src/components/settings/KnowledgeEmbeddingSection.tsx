import { useMemo, useState } from "react";
import {
  getKnowledgeEmbeddingProviderOptions,
  normalizeKnowledgeEmbeddingConfig,
  type KnowledgeEmbeddingConfig,
  type KnowledgeEmbeddingModelConfig,
  type KnowledgeEmbeddingProviderId,
} from "../../chat/knowledgeEmbedding";
import OmniSelect from "../ui/OmniSelect";
import OmniSwitch from "../ui/OmniSwitch";

type Props = {
  config: KnowledgeEmbeddingConfig;
  onChangeConfig: (config: KnowledgeEmbeddingConfig) => void;
  providerEndpoints?: ProviderEndpoint[];
};

type ProviderOption = {
  id: KnowledgeEmbeddingProviderId;
  label: string;
  baseUrl?: string;
};

type ProviderEndpoint = {
  id: string;
  name: string;
  baseUrl: string;
};

const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  moonshot: "https://api.moonshot.cn/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
  dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
};

type EditingModelState = KnowledgeEmbeddingModelConfig;

function createBlankModel(index: number): EditingModelState {
  return {
    id: `openai:custom-${index + 1}`,
    name: `模型 ${index + 1}`,
    provider: "openai",
    baseUrl: PROVIDER_BASE_URLS.openai,
    model: "",
    apiKey: "",
  };
}

export default function KnowledgeEmbeddingSection({ config, onChangeConfig, providerEndpoints = [] }: Props) {
  const providerOptions = getKnowledgeEmbeddingProviderOptions() as ProviderOption[];
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
      options.push({ ...option, baseUrl: option.baseUrl || PROVIDER_BASE_URLS[option.id] });
    }

    return options;
  }, [providerEndpoints, providerOptions]);
  const normalizedConfig = useMemo(() => normalizeKnowledgeEmbeddingConfig(config), [config]);
  const [isModelFormOpen, setIsModelFormOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<EditingModelState | null>(null);

  const getProviderBaseUrl = (provider: string) =>
    providerSelectOptions.find((item) => item.id === provider)?.baseUrl || PROVIDER_BASE_URLS[provider] || PROVIDER_BASE_URLS.openai;

  const getProviderLabel = (provider: string) =>
    providerSelectOptions.find((item) => item.id === provider)?.label || provider;

  const commit = (next: KnowledgeEmbeddingConfig) => {
    onChangeConfig(normalizeKnowledgeEmbeddingConfig(next));
  };

  const updateConfig = (patch: Partial<KnowledgeEmbeddingConfig>) => {
    commit({ ...normalizedConfig, ...patch });
  };

  const openNewModel = () => {
    setEditingModel(createBlankModel(normalizedConfig.models.length));
    setIsModelFormOpen(true);
  };

  const openEditModel = (model: KnowledgeEmbeddingModelConfig) => {
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

    const existingModel = normalizedConfig.models.find((model) => model.id === editingModel.id);
    const normalizedModel: KnowledgeEmbeddingModelConfig = {
      ...editingModel,
      id:
        existingModel?.id ??
        `${editingModel.provider}:${editingModel.model.trim() || "text-embedding-3-small"}:${normalizedConfig.models.filter((model) => model.provider === editingModel.provider).length + 1}`,
      name: editingModel.name.trim() || editingModel.model.trim() || "模型",
      provider: editingModel.provider,
      baseUrl: editingModel.baseUrl.trim() || getProviderBaseUrl(editingModel.provider),
      model: editingModel.model.trim() || "text-embedding-3-small",
      apiKey: editingModel.apiKey,
    };

    const nextModel = normalizedModel;
    const nextModels = existingModel
      ? normalizedConfig.models.map((model) => (model.id === editingModel.id ? nextModel : model))
      : [...normalizedConfig.models, nextModel];

    updateConfig({
      models: nextModels,
      activeModelId: nextModels.some((model) => model.id === normalizedConfig.activeModelId)
        ? normalizedConfig.activeModelId
        : nextModel.id,
    });
    closeModelForm();
  };

  const removeModel = (modelId: string) => {
    const nextModels = normalizedConfig.models.filter((model) => model.id !== modelId);
    updateConfig({
      models: nextModels.length > 0 ? nextModels : [createBlankModel(0)],
      activeModelId: nextModels[0]?.id ?? "",
    });
  };

  return (
    <section className="omni-knowledge-embedding-section flex min-h-0 flex-1 flex-col gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-900">向量模型</h3>
        </div>
        <span className={`omni-knowledge-status-badge inline-flex items-center rounded-full px-2 py-1 text-[11px] ${normalizedConfig.enabled ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>
          {normalizedConfig.enabled ? "已启用" : "已关闭"}
        </span>
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <OmniSwitch checked={normalizedConfig.enabled} onChange={(checked) => updateConfig({ enabled: checked })} ariaLabel="启用知识库向量化" />
        <span>启用知识库向量化</span>
      </label>

      <div className="flex min-h-0 flex-1 flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-medium uppercase tracking-[0.16em] text-slate-400">模型列表</div>
            <div className="text-xs text-slate-500">只展示列表，新增和编辑都通过弹窗完成。</div>
          </div>
          <button
            type="button"
            onClick={openNewModel}
            className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
          >
            添加模型
          </button>
        </div>

        <div className="max-h-[360px] space-y-2 overflow-y-auto overscroll-contain border-t border-slate-100 pt-3 pr-1 [scrollbar-gutter:stable]">
          {normalizedConfig.models.length > 0 ? (
            normalizedConfig.models.map((model) => {
              const isActive = model.id === normalizedConfig.activeModelId;
              return (
                <div
                  key={model.id}
                  className={`omni-knowledge-model-card rounded-lg border px-3 py-3 transition-colors ${
                    isActive
                      ? "border-violet-300 bg-violet-50 shadow-[inset_3px_0_0_rgba(124,58,237,0.68)]"
                      : "border-slate-200 bg-white hover:border-violet-200 hover:bg-violet-50"
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <button type="button" onClick={() => openEditModel(model)} className="min-w-0 flex-1 text-left">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className={`truncate text-sm font-medium ${isActive ? "text-violet-950" : "text-slate-900"}`}>
                          {model.name}
                        </span>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${isActive ? "bg-violet-100 text-violet-700" : "bg-slate-100 text-slate-500"}`}>
                          {getProviderLabel(model.provider)}
                        </span>
                      </div>
                      <div className={`mt-2 truncate text-xs ${isActive ? "text-violet-500" : "text-slate-400"}`}>
                        <span className={`font-medium ${isActive ? "text-violet-600" : "text-slate-500"}`}>模型 ID：</span>
                        {model.model}
                      </div>
                    </button>
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                      {isActive ? <span className="rounded-full bg-violet-100 px-2 py-1 text-xs font-medium text-violet-700">当前使用</span> : null}
                      {!model.apiKey.trim() ? <span className="rounded-full bg-amber-100 px-2 py-1 text-xs text-amber-700">缺少 Key</span> : null}
                      {!isActive ? (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            updateConfig({ activeModelId: model.id });
                          }}
                          className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
                        >
                          设为当前
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="omni-knowledge-empty-state rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-xs text-slate-400">
              还没有模型，点击“添加模型”先建一个。
            </div>
          )}
        </div>
      </div>

      {isModelFormOpen && editingModel ? (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-950/25 px-6">
          <div className="w-full max-w-xl rounded-xl border border-slate-200 bg-white p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">{normalizedConfig.models.some((model) => model.id === editingModel.id) ? "编辑模型" : "新增模型"}</h3>
              </div>
              <button onClick={closeModelForm} className="text-slate-400 hover:text-slate-700" type="button">
                ×
              </button>
            </div>

            <div className="space-y-4">
              <label className="grid grid-cols-[120px_1fr] gap-4">
                <span className="pt-2 text-right text-sm text-slate-700">供应商</span>
                <OmniSelect
                  value={editingModel.provider}
                  onChange={(value) => {
                    const provider = value as KnowledgeEmbeddingProviderId;
                    setEditingModel((current) => (current ? { ...current, provider, baseUrl: getProviderBaseUrl(provider) } : current));
                  }}
                  ariaLabel="向量模型供应商"
                  options={providerSelectOptions.map((item) => ({ value: item.id, label: item.label }))}
                />
              </label>

              <label className="grid grid-cols-[120px_1fr] gap-4">
                <span className="pt-2 text-right text-sm text-slate-700">Base URL</span>
                <input
                  value={editingModel.baseUrl}
                  onChange={(event) => setEditingModel((current) => (current ? { ...current, baseUrl: event.target.value } : current))}
                  placeholder="https://api.siliconflow.cn/v1"
                  className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"
                />
              </label>

              <label className="grid grid-cols-[120px_1fr] gap-4">
                <span className="pt-2 text-right text-sm text-slate-700">显示名称</span>
                <input
                  value={editingModel.name}
                  onChange={(event) => setEditingModel((current) => (current ? { ...current, name: event.target.value } : current))}
                  placeholder="默认向量模型"
                  className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"
                />
              </label>

              <label className="grid grid-cols-[120px_1fr] gap-4">
                <span className="pt-2 text-right text-sm text-slate-700">真实模型 ID</span>
                <input
                  value={editingModel.model}
                  onChange={(event) => setEditingModel((current) => (current ? { ...current, model: event.target.value } : current))}
                  placeholder="text-embedding-3-small"
                  className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"
                />
              </label>

              <label className="grid grid-cols-[120px_1fr] gap-4">
                <span className="pt-2 text-right text-sm text-slate-700">API Key</span>
                <input
                  type="password"
                  value={editingModel.apiKey}
                  onChange={(event) => setEditingModel((current) => (current ? { ...current, apiKey: event.target.value } : current))}
                  placeholder="该模型单独使用的 API Key"
                  className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"
                />
              </label>

              <div className="grid grid-cols-[120px_1fr] gap-4">
                <span />
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={saveEditingModel}
                    className="rounded-md bg-slate-900 px-4 py-2 text-xs font-medium text-white"
                  >
                    保存
                  </button>
                  <button type="button" onClick={closeModelForm} className="rounded-md border border-slate-200 px-4 py-2 text-xs text-slate-600">
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      removeModel(editingModel.id);
                      closeModelForm();
                    }}
                    className="rounded-md border border-rose-200 px-4 py-2 text-xs text-rose-600"
                  >
                    删除
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
