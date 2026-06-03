import { readSqliteBackedValue, saveSqliteBackedValue } from "../app/sqliteStorage";
import {
  KNOWLEDGE_EMBEDDING_PROVIDER_OPTIONS,
  type KnowledgeEmbeddingProviderId,
} from "./knowledgeEmbedding";

export type KnowledgeMultimodalCapability = "image" | "audio";
export type KnowledgeMultimodalProviderId = KnowledgeEmbeddingProviderId;

export type KnowledgeMultimodalModelConfig = {
  id: string;
  name: string;
  provider: KnowledgeMultimodalProviderId;
  baseUrl: string;
  model: string;
  apiKey: string;
  capability: KnowledgeMultimodalCapability;
};

export type KnowledgeMultimodalConfig = {
  enabled: boolean;
  activeImageModelId: string;
  activeAudioModelId: string;
  models: KnowledgeMultimodalModelConfig[];
};

export type KnowledgeCollectionMultimodalConfig = {
  enabled: boolean;
  image: {
    enabled: boolean;
    modelId: string;
    extractText: boolean;
    generateSummary: boolean;
  };
  audio: {
    enabled: boolean;
    modelId: string;
    keepTranscript: boolean;
    generateSummary: boolean;
  };
  mergeMode: "append";
};

type LegacyKnowledgeMultimodalProfile = {
  enabled?: boolean;
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  capability?: string;
  capabilities?: string[];
};

export const KNOWLEDGE_MULTIMODAL_CONFIG_STORAGE_KEY = "omni_knowledge_multimodal_profile";

export const KNOWLEDGE_MULTIMODAL_PROVIDER_BASE_URLS: Record<KnowledgeMultimodalProviderId, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  moonshot: "https://api.moonshot.cn/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
  dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
};

export const KNOWLEDGE_MULTIMODAL_PROVIDER_OPTIONS = KNOWLEDGE_EMBEDDING_PROVIDER_OPTIONS;
export const KNOWLEDGE_MULTIMODAL_CAPABILITY_OPTIONS: Array<{ id: KnowledgeMultimodalCapability; label: string }> = [
  { id: "image", label: "图片分析" },
  { id: "audio", label: "音频分析" },
];

const DEFAULT_PROVIDER: KnowledgeMultimodalProviderId = "openai";

function normalizeText(value: string | undefined | null) {
  return (value ?? "").trim();
}

function isKnowledgeMultimodalProviderId(value: string): value is KnowledgeMultimodalProviderId {
  return KNOWLEDGE_MULTIMODAL_PROVIDER_OPTIONS.some((item) => item.id === value);
}

function normalizeProvider(value: string | undefined | null): KnowledgeMultimodalProviderId {
  return value && isKnowledgeMultimodalProviderId(value) ? value : DEFAULT_PROVIDER;
}

function normalizeCapability(
  value: string | undefined | null,
  fallback?: string[] | null
): KnowledgeMultimodalCapability {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === "audio") {
    return "audio";
  }
  if (normalized === "image") {
    return "image";
  }
  const fallbackValue = (fallback ?? []).find((item) => item === "image" || item === "audio");
  return fallbackValue === "audio" ? "audio" : "image";
}

function getDefaultModelName(capability: KnowledgeMultimodalCapability) {
  return capability === "audio" ? "gpt-4o-mini-transcribe" : "gpt-4.1-mini";
}

function makeModelId(provider: KnowledgeMultimodalProviderId, capability: KnowledgeMultimodalCapability, model: string, index = 0) {
  return `${provider}:${capability}:${model || getDefaultModelName(capability)}:${index}`;
}

function normalizeModel(model: Partial<KnowledgeMultimodalModelConfig> & { capabilities?: string[] } | null | undefined, index: number) {
  const capability = normalizeCapability(model?.capability, model?.capabilities);
  const provider = normalizeProvider(model?.provider);
  const baseUrl = normalizeText(model?.baseUrl) || KNOWLEDGE_MULTIMODAL_PROVIDER_BASE_URLS[provider];
  const rawModel = normalizeText(model?.model) || getDefaultModelName(capability);
  return {
    id: normalizeText(model?.id) || makeModelId(provider, capability, rawModel, index),
    name: normalizeText(model?.name) || rawModel,
    provider,
    baseUrl,
    model: rawModel,
    apiKey: normalizeText(model?.apiKey),
    capability,
  } satisfies KnowledgeMultimodalModelConfig;
}

function normalizeModels(models: Array<KnowledgeMultimodalModelConfig | (Partial<KnowledgeMultimodalModelConfig> & { capabilities?: string[] })> | undefined | null) {
  const seenIds = new Set<string>();
  const next: KnowledgeMultimodalModelConfig[] = [];

  for (const [index, model] of (models ?? []).entries()) {
    const normalized = normalizeModel(model, index);
    const uniqueId = seenIds.has(normalized.id) ? `${normalized.id}-${index}` : normalized.id;
    seenIds.add(uniqueId);
    next.push({ ...normalized, id: uniqueId });
  }

  return next;
}

function normalizeActiveModelId(
  models: KnowledgeMultimodalModelConfig[],
  activeModelId: string | undefined | null,
  capability: KnowledgeMultimodalCapability
) {
  const normalized = normalizeText(activeModelId);
  if (normalized && models.some((model) => model.id === normalized && model.capability === capability)) {
    return normalized;
  }
  return models.find((model) => model.capability === capability)?.id ?? "";
}

export function getDefaultKnowledgeMultimodalConfig(): KnowledgeMultimodalConfig {
  return {
    enabled: false,
    activeImageModelId: "",
    activeAudioModelId: "",
    models: [],
  };
}

export function getDefaultCollectionMultimodalConfig(): KnowledgeCollectionMultimodalConfig {
  return {
    enabled: false,
    image: {
      enabled: false,
      modelId: "",
      extractText: true,
      generateSummary: true,
    },
    audio: {
      enabled: false,
      modelId: "",
      keepTranscript: true,
      generateSummary: true,
    },
    mergeMode: "append",
  };
}

export function normalizeKnowledgeMultimodalConfig(input: Partial<KnowledgeMultimodalConfig> | null | undefined): KnowledgeMultimodalConfig {
  const models = normalizeModels(input?.models);
  return {
    enabled: Boolean(input?.enabled ?? models.length > 0),
    activeImageModelId: normalizeActiveModelId(models, input?.activeImageModelId, "image"),
    activeAudioModelId: normalizeActiveModelId(models, input?.activeAudioModelId, "audio"),
    models,
  };
}

function parseLegacyMultimodalConfig(raw: LegacyKnowledgeMultimodalProfile): KnowledgeMultimodalConfig {
  const capability = normalizeCapability(raw.capability, raw.capabilities);
  const provider = normalizeProvider(raw.provider);
  const model = normalizeText(raw.model) || getDefaultModelName(capability);
  return normalizeKnowledgeMultimodalConfig({
    enabled: Boolean(raw.enabled ?? true),
    models: [
      {
        id: makeModelId(provider, capability, model, 0),
        name: model,
        provider,
        baseUrl: normalizeText(raw.baseUrl) || KNOWLEDGE_MULTIMODAL_PROVIDER_BASE_URLS[provider],
        model,
        apiKey: normalizeText(raw.apiKey),
        capability,
      },
    ],
  });
}

export function loadKnowledgeMultimodalConfig(): KnowledgeMultimodalConfig {
  const raw = readSqliteBackedValue(KNOWLEDGE_MULTIMODAL_CONFIG_STORAGE_KEY);
  if (!raw) {
    return getDefaultKnowledgeMultimodalConfig();
  }

  try {
    const parsed = JSON.parse(raw) as Partial<KnowledgeMultimodalConfig> & LegacyKnowledgeMultimodalProfile;
    if (
      Array.isArray(parsed.models) ||
      typeof parsed.activeImageModelId === "string" ||
      typeof parsed.activeAudioModelId === "string" ||
      typeof parsed.enabled === "boolean"
    ) {
      return normalizeKnowledgeMultimodalConfig(parsed);
    }
    return parseLegacyMultimodalConfig(parsed);
  } catch {
    return getDefaultKnowledgeMultimodalConfig();
  }
}

export function saveKnowledgeMultimodalConfig(config: KnowledgeMultimodalConfig) {
  saveSqliteBackedValue(
    KNOWLEDGE_MULTIMODAL_CONFIG_STORAGE_KEY,
    JSON.stringify(normalizeKnowledgeMultimodalConfig(config))
  );
}

export function getKnowledgeMultimodalProviderOptions() {
  return KNOWLEDGE_MULTIMODAL_PROVIDER_OPTIONS;
}

export function getKnowledgeMultimodalModelById(config: KnowledgeMultimodalConfig, modelId: string) {
  return config.models.find((model) => model.id === modelId) ?? null;
}

export function getKnowledgeMultimodalModelsByCapability(
  config: KnowledgeMultimodalConfig,
  capability: KnowledgeMultimodalCapability
) {
  return config.models.filter((model) => model.capability === capability);
}

export const DEFAULT_KNOWLEDGE_MULTIMODAL_CONFIG = getDefaultKnowledgeMultimodalConfig();
