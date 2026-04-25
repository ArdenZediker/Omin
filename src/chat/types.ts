import type { Message } from "../adapters/types";

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

export type ChatSession = {
  id: string;
  title: string;
  messages: Message[];
  pinned?: boolean;
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
};

export type SlashSkill = {
  id: string;
  command: string;
  title: string;
  description: string;
  systemPrompt?: string;
  promptPrefix?: string;
};
