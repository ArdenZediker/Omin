import { readSqliteBackedJson, saveSqliteBackedValue } from "../app/sqliteStorage";

export type KnowledgeRetrievalMode = "keyword" | "hybrid" | "vector";

export type KnowledgeEmbeddingProviderId =
  | "openai"
  | "openrouter"
  | "moonshot"
  | "siliconflow"
  | "dashscope"
  | "zhipu";

export type KnowledgeEmbeddingProfile = {
  enabled: boolean;
  provider: KnowledgeEmbeddingProviderId;
  model: string;
};

export const KNOWLEDGE_EMBEDDING_PROFILE_STORAGE_KEY = "omni_knowledge_embedding_profile";

export const DEFAULT_KNOWLEDGE_EMBEDDING_PROFILE: KnowledgeEmbeddingProfile = {
  enabled: false,
  provider: "openai",
  model: "text-embedding-3-small",
};

export const KNOWLEDGE_RETRIEVAL_MODE_OPTIONS: Array<{
  id: KnowledgeRetrievalMode;
  label: string;
  description: string;
}> = [
  { id: "keyword", label: "关键词", description: "不使用向量，纯文本召回" },
  { id: "hybrid", label: "混合", description: "关键词 + 向量共同召回" },
  { id: "vector", label: "向量", description: "以向量召回为主" },
];

export const KNOWLEDGE_EMBEDDING_PROVIDER_OPTIONS: Array<{
  id: KnowledgeEmbeddingProviderId;
  label: string;
}> = [
  { id: "openai", label: "OpenAI" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "moonshot", label: "Moonshot" },
  { id: "siliconflow", label: "SiliconFlow" },
  { id: "dashscope", label: "DashScope" },
  { id: "zhipu", label: "Zhipu" },
];

export function loadKnowledgeEmbeddingProfile(): KnowledgeEmbeddingProfile {
  return readSqliteBackedJson(KNOWLEDGE_EMBEDDING_PROFILE_STORAGE_KEY, DEFAULT_KNOWLEDGE_EMBEDDING_PROFILE);
}

export function saveKnowledgeEmbeddingProfile(profile: KnowledgeEmbeddingProfile) {
  saveSqliteBackedValue(KNOWLEDGE_EMBEDDING_PROFILE_STORAGE_KEY, JSON.stringify(profile));
}

export function normalizeKnowledgeRetrievalMode(): KnowledgeRetrievalMode {
  return "hybrid";
}
