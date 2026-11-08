import type { Message } from "../adapters/types";
import type { ChatUsageStats } from "./types";

export type ChatSessionStats = {
  turns: number;
  steps: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedPromptTokens: number;
  cacheObservedInputTokens: number;
  generationDurationMs: number;
  generationTokens: number;
  modelDurationMs: number;
  ttftDurationMs: number;
  ttftSamples: number;
  hasCacheReading: boolean;
};

/**
 * Project the current session into the compact composer footer shown by DSH.
 * A streaming assistant placeholder is excluded until settled, matching DSH so
 * chunk deltas do not churn the stats row.
 */
export function deriveChatSessionStats(
  messages: Message[],
  usageStats: ChatUsageStats | undefined,
  isLoading: boolean,
): ChatSessionStats {
  const last = messages[messages.length - 1];
  const settledMessages = isLoading && last?.role === "project"
    ? messages.slice(0, -1)
    : messages;

  let userTurns = 0;
  let assistantSteps = 0;
  let toolSteps = 0;
  let messageInputTokens = 0;
  let messageOutputTokens = 0;
  let messageTotalTokens = 0;
  let cachedPromptTokens = 0;
  let cacheObservedInputTokens = 0;
  let generationDurationMs = 0;
  let generationTokens = 0;
  let modelDurationMs = 0;
  let ttftDurationMs = 0;
  let ttftSamples = 0;
  let hasCacheReading = false;

  for (const message of settledMessages) {
    if (message.role === "user") {
      userTurns += 1;
      continue;
    }
    if (message.role !== "project") continue;

    const hasSettledOutput = Boolean(
      message.content.trim()
      || message.turnUsage
      || message.toolCallResults?.length
      || message.steps?.length,
    );
    if (!hasSettledOutput) continue;
    assistantSteps += 1;
    toolSteps += message.toolCallResults?.length ?? 0;

    const usage = message.turnUsage;
    if (!usage) continue;
    messageInputTokens += usage.inputTokens;
    messageOutputTokens += usage.outputTokens;
    messageTotalTokens += usage.totalTokens;
    if (usage.cachedPromptTokens !== undefined) {
      hasCacheReading = true;
      cachedPromptTokens += usage.cachedPromptTokens;
      cacheObservedInputTokens += usage.inputTokens;
    }
    if ((usage.generationDurationMs ?? 0) > 0) {
      generationDurationMs += usage.generationDurationMs ?? 0;
      generationTokens += usage.outputTokens;
    }
    modelDurationMs += usage.modelDurationMs ?? usage.generationDurationMs ?? 0;
    if ((usage.ttftDurationMs ?? 0) >= 0 && (usage.ttftSamples ?? 0) > 0) {
      ttftDurationMs += usage.ttftDurationMs ?? 0;
      ttftSamples += usage.ttftSamples ?? 0;
    }
  }

  const totalsMatchMessages = usageStats
    && usageStats.promptTokens === messageInputTokens
    && usageStats.completionTokens === messageOutputTokens;
  const usageStatsHasTotals = Boolean(usageStats && usageStats.totalTokens > 0);
  const inputTokens = totalsMatchMessages || !usageStatsHasTotals
    ? messageInputTokens
    : usageStats?.promptTokens ?? messageInputTokens;
  const outputTokens = totalsMatchMessages || !usageStatsHasTotals
    ? messageOutputTokens
    : usageStats?.completionTokens ?? messageOutputTokens;
  const totalTokens = usageStats?.totalTokens || messageTotalTokens || inputTokens + outputTokens;

  return {
    turns: Math.min(userTurns, assistantSteps),
    steps: assistantSteps + toolSteps,
    totalTokens,
    inputTokens,
    outputTokens,
    cachedPromptTokens,
    cacheObservedInputTokens,
    generationDurationMs,
    generationTokens,
    modelDurationMs,
    ttftDurationMs,
    ttftSamples,
    hasCacheReading,
  };
}
