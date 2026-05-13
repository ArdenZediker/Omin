import type { Message } from "../adapters/types";
import type { KnowledgeContextResult } from "./knowledgeTypes";

export type ChatUsagePreferences = {
  enableStreaming: boolean;
  enableVisionInput: boolean;
  temperature: number;
  maxOutputTokens: number;
};

export type ChatUsageStats = {
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  lastModel: string | null;
  lastUsedAt: number | null;
  hasEstimatedUsage: boolean;
};

export type AssistantKind = "basic" | "custom";

export type AssistantMemoryScope = "off" | "session" | "assistant";

export type AssistantProfileDraft = {
  sourcePresetId?: string | null;
  title?: string;
  description?: string;
  groupName?: string | null;
  avatarType?: "emoji" | "image";
  avatarValue?: string;
  systemPrompt?: string;
  defaultModelId?: string | null;
  allowedToolIds?: string[];
  allowedSkillIds?: string[];
  memoryScope?: AssistantMemoryScope;
  autoSaveMemories?: boolean;
  autoSaveSummaries?: boolean;
};

export type AssistantProfile = {
  id: string;
  kind: AssistantKind;
  sourcePresetId?: string | null;
  title: string;
  description: string;
  groupName?: string | null;
  avatarType?: "emoji" | "image";
  avatarValue?: string;
  systemPrompt?: string;
  defaultModelId?: string | null;
  allowedToolIds: string[];
  allowedSkillIds: string[];
  memoryScope: AssistantMemoryScope;
  autoSaveMemories: boolean;
  autoSaveSummaries: boolean;
  createdAt: number;
  updatedAt: number;
};

export type AssistantPresetRecord = {
  id: string;
  title: string;
  description: string;
  avatarCode?: string | null;
  systemPrompt?: string;
  defaultModelId?: string | null;
  allowedToolIds: string[];
  allowedSkillIds: string[];
};

export type ManifestStorageSnapshot = {
  assistantPresets: AssistantPresetRecord[];
  toolManifests: Array<Record<string, unknown>>;
  skillManifests: Array<Record<string, unknown>>;
};

export type SessionSummaryRecord = {
  sessionId: string;
  assistantId: string;
  title: string;
  summary: string;
  updatedAt: number;
};

export type AssistantMemoryRecord = {
  id: string;
  assistantId: string;
  content: string;
  sourceSessionId?: string | null;
  createdAt: number;
  updatedAt: number;
};

export type UserPreferenceRecord = {
  key: string;
  value: string;
  updatedAt: number;
};

export type ScheduledTaskRecord = {
  id: string;
  title: string;
  prompt: string;
  cron: string;
  target: "desktop" | "notification" | "session";
  sessionId?: string | null;
  enabled: boolean;
  lastRunAt?: number | null;
  createdAt: number;
  updatedAt: number;
};

export type ChatSession = {
  id: string;
  assistantId: string;
  title: string;
  messages: Message[];
  pinned?: boolean;
  favorite?: boolean;
  createdAt: number;
  updatedAt: number;
  usage: ChatUsageStats;
};

export type ChatExecutionResult = {
  content: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  estimated: boolean;
  costUsd: number;
  knowledgeContext?: KnowledgeContextResult | null;
};

export type SlashSkill = {
  id: string;
  command: string;
  title: string;
  description: string;
  systemPrompt?: string;
  promptPrefix?: string;
};
