import { readSqliteBackedValue, saveSqliteBackedValue } from "../app/sqliteStorage";

export type KnowledgeRetrievalMode = "keyword" | "hybrid" | "vector";

export type KnowledgeEmbeddingProviderId =
  | "openai"
  | "openrouter"
  | "moonshot"
  | "siliconflow"
  | "dashscope"
  | "zhipu";

export type KnowledgeEmbeddingModelConfig = {
  id: string;
  name: string;
  provider: KnowledgeEmbeddingProviderId;
  baseUrl: string;
  model: string;
  apiKey: string;
};

export type KnowledgeEmbeddingConfig = {
  enabled: boolean;
  activeModelId: string;
  models: KnowledgeEmbeddingModelConfig[];
};

export type KnowledgeEmbeddingResolution = {
  provider: KnowledgeEmbeddingProviderId;
  baseUrl: string;
  modelKey: string;
  model: string;
  embedding: number[];
};

export const KNOWLEDGE_EMBEDDING_CONFIG_STORAGE_KEY = "omni_knowledge_embedding_profile";

const DEFAULT_BASE_URLS: Record<KnowledgeEmbeddingProviderId, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  moonshot: "https://api.moonshot.cn/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
  dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
};

const DEFAULT_PROVIDER: KnowledgeEmbeddingProviderId = "openai";
const DEFAULT_MODEL = "text-embedding-3-small";

const PROVIDER_OPTIONS: Array<{ id: KnowledgeEmbeddingProviderId; label: string }> = [
  { id: "openai", label: "OpenAI" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "moonshot", label: "Moonshot" },
  { id: "siliconflow", label: "SiliconFlow" },
  { id: "dashscope", label: "DashScope" },
  { id: "zhipu", label: "Zhipu" },
];

type LegacyKnowledgeEmbeddingProfile = {
  enabled?: boolean;
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
};

function isKnowledgeEmbeddingProviderId(value: string): value is KnowledgeEmbeddingProviderId {
  return PROVIDER_OPTIONS.some((item) => item.id === value);
}

function normalizeProvider(value: string | undefined | null): KnowledgeEmbeddingProviderId {
  if (value && isKnowledgeEmbeddingProviderId(value)) {
    return value;
  }
  return DEFAULT_PROVIDER;
}

function normalizeText(value: string | undefined | null) {
  return (value ?? "").trim();
}

function makeModelId(provider: KnowledgeEmbeddingProviderId, model: string, index = 0) {
  return `${provider}:${model || DEFAULT_MODEL}:${index}`;
}

function fingerprintKey(value: string) {
  let hash = 0xcbf29ce484222325n;
  for (const char of value) {
    hash ^= BigInt(char.codePointAt(0) ?? 0);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function createDefaultModels(): KnowledgeEmbeddingModelConfig[] {
  return [
    {
      id: makeModelId(DEFAULT_PROVIDER, DEFAULT_MODEL, 0),
      name: "默认向量模型",
      provider: DEFAULT_PROVIDER,
      baseUrl: DEFAULT_BASE_URLS[DEFAULT_PROVIDER],
      model: DEFAULT_MODEL,
      apiKey: "",
    },
  ];
}

function normalizeModel(model: Partial<KnowledgeEmbeddingModelConfig> | null | undefined, index: number): KnowledgeEmbeddingModelConfig {
  const provider = normalizeProvider(model?.provider);
  const baseUrl = normalizeText(model?.baseUrl) || DEFAULT_BASE_URLS[provider];
  const rawModel = normalizeText(model?.model) || DEFAULT_MODEL;
  return {
    id: normalizeText(model?.id) || makeModelId(provider, rawModel, index),
    name: normalizeText(model?.name) || rawModel,
    provider,
    baseUrl,
    model: rawModel,
    apiKey: normalizeText(model?.apiKey),
  };
}

function normalizeModels(models: KnowledgeEmbeddingModelConfig[] | undefined | null): KnowledgeEmbeddingModelConfig[] {
  const next: KnowledgeEmbeddingModelConfig[] = [];
  const seenIds = new Set<string>();

  for (const [index, model] of (models ?? []).entries()) {
    const normalized = normalizeModel(model, index);
    const uniqueId = seenIds.has(normalized.id) ? `${normalized.id}-${index}` : normalized.id;
    seenIds.add(uniqueId);
    next.push({
      ...normalized,
      id: uniqueId,
    });
  }

  if (next.length === 0) {
    return createDefaultModels();
  }

  return next;
}

function normalizeActiveModelId(models: KnowledgeEmbeddingModelConfig[], activeModelId: string | undefined | null) {
  const normalized = normalizeText(activeModelId);
  if (normalized && models.some((model) => model.id === normalized)) {
    return normalized;
  }
  return models[0]?.id ?? "";
}

export function getDefaultKnowledgeEmbeddingConfig(): KnowledgeEmbeddingConfig {
  const models = createDefaultModels();
  return {
    enabled: false,
    activeModelId: models[0].id,
    models,
  };
}

export function normalizeKnowledgeEmbeddingConfig(input: Partial<KnowledgeEmbeddingConfig> | null | undefined): KnowledgeEmbeddingConfig {
  const models = normalizeModels(input?.models as KnowledgeEmbeddingModelConfig[] | undefined | null);
  const activeModelId = normalizeActiveModelId(models, input?.activeModelId);

  return {
    enabled: Boolean(input?.enabled),
    activeModelId,
    models,
  };
}

function parseLegacyEmbeddingConfig(raw: LegacyKnowledgeEmbeddingProfile): KnowledgeEmbeddingConfig {
  const provider = normalizeProvider(raw.provider);
  const baseUrl = normalizeText(raw.baseUrl) || DEFAULT_BASE_URLS[provider];
  const model = normalizeText(raw.model) || DEFAULT_MODEL;
  const models = [
    {
      id: makeModelId(provider, model, 0),
      name: model,
      provider,
      baseUrl,
      model,
      apiKey: normalizeText(raw.apiKey),
    },
  ];

  return {
    enabled: Boolean(raw.enabled),
    activeModelId: models[0].id,
    models,
  };
}

export function loadKnowledgeEmbeddingConfig(): KnowledgeEmbeddingConfig {
  const raw = readSqliteBackedValue(KNOWLEDGE_EMBEDDING_CONFIG_STORAGE_KEY);
  if (!raw) {
    return getDefaultKnowledgeEmbeddingConfig();
  }

  try {
    const parsed = JSON.parse(raw) as Partial<KnowledgeEmbeddingConfig> & LegacyKnowledgeEmbeddingProfile;
    if (Array.isArray(parsed.models) || typeof parsed.activeModelId === "string" || typeof parsed.apiKey === "string") {
      return normalizeKnowledgeEmbeddingConfig(parsed);
    }
    return parseLegacyEmbeddingConfig(parsed);
  } catch {
    return getDefaultKnowledgeEmbeddingConfig();
  }
}

export function saveKnowledgeEmbeddingConfig(config: KnowledgeEmbeddingConfig) {
  saveSqliteBackedValue(KNOWLEDGE_EMBEDDING_CONFIG_STORAGE_KEY, JSON.stringify(normalizeKnowledgeEmbeddingConfig(config)));
}

export function getKnowledgeEmbeddingProviderOptions() {
  return PROVIDER_OPTIONS;
}

export function getKnowledgeEmbeddingModelById(config: KnowledgeEmbeddingConfig, modelId: string) {
  return config.models.find((model) => model.id === modelId) ?? null;
}

export function getActiveKnowledgeEmbeddingModel(config: KnowledgeEmbeddingConfig) {
  return getKnowledgeEmbeddingModelById(config, config.activeModelId) ?? config.models[0] ?? null;
}

export function getKnowledgeEmbeddingModelKey(config: KnowledgeEmbeddingConfig, modelId?: string | null) {
  const resolvedModel = modelId ? getKnowledgeEmbeddingModelById(config, modelId) : getActiveKnowledgeEmbeddingModel(config);
  if (!resolvedModel) {
    return "";
  }
  return `${resolvedModel.provider}:${resolvedModel.model}:${fingerprintKey(resolvedModel.apiKey.trim())}`;
}

export async function embedKnowledgeText(text: string, configOverride?: KnowledgeEmbeddingConfig): Promise<KnowledgeEmbeddingResolution | null> {
  const config = normalizeKnowledgeEmbeddingConfig(configOverride ?? loadKnowledgeEmbeddingConfig());
  if (!config.enabled) {
    return null;
  }

  const activeModel = getActiveKnowledgeEmbeddingModel(config);
  if (!activeModel) {
    return null;
  }

  const apiKey = activeModel.apiKey.trim();
  if (!apiKey) {
    return null;
  }

  const baseUrl = activeModel.baseUrl.trim().replace(/\/+$/, "");
  if (!baseUrl) {
    return null;
  }

  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: activeModel.model,
      input: [text],
    }),
  });

  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(message || `Embedding request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    data?: Array<{ embedding?: number[] }>;
    model?: string;
  };
  const embedding = payload.data?.[0]?.embedding ?? [];
  if (embedding.length === 0) {
    return null;
  }

  return {
    provider: activeModel.provider,
    baseUrl,
    modelKey: getKnowledgeEmbeddingModelKey(config, activeModel.id),
    model: activeModel.model,
    embedding,
  };
}

export const DEFAULT_KNOWLEDGE_EMBEDDING_CONFIG = getDefaultKnowledgeEmbeddingConfig();
export const KNOWLEDGE_EMBEDDING_PROVIDER_OPTIONS = PROVIDER_OPTIONS;

export function normalizeKnowledgeRetrievalMode(): KnowledgeRetrievalMode {
  return "hybrid";
}
