import { useMemo } from "react";
import { Database, RefreshCw } from "lucide-react";
import type { Message } from "../adapters/types";
import { deriveChatSessionStats } from "../chat/sessionStats";
import {
  formatCacheHitPercent,
  formatCompactTokenCount,
  formatExactTokenCount,
  formatTokensPerSecond,
} from "../chat/turnUsage";
import type { ChatUsageStats } from "../chat/types";
import ContextUsageTrigger, { type ContextUsageSnapshot } from "./ContextUsagePanel";
import StatsDetailPopover, { StatsDetailTitle } from "./StatsDetailPopover";

type ChatStatsLineProps = {
  messages: Message[];
  sessionUsage?: ChatUsageStats;
  contextUsage?: ContextUsageSnapshot;
  isLoading?: boolean;
};

function formatSessionDuration(ms: number): string {
  if (ms <= 0) return "—";
  const seconds = ms / 1_000;
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}秒`;
  const roundedSeconds = Math.round(seconds);
  return `${Math.floor(roundedSeconds / 60)}分${roundedSeconds % 60}秒`;
}

export default function ChatStatsLine({
  messages,
  sessionUsage,
  contextUsage,
  isLoading = false,
}: ChatStatsLineProps) {
  const stats = useMemo(
    () => deriveChatSessionStats(messages, sessionUsage, isLoading),
    [messages, sessionUsage, isLoading],
  );
  const tokensPerSecond = stats.generationDurationMs > 0
    ? stats.generationTokens / (stats.generationDurationMs / 1_000)
    : 0;
  const cacheHit = stats.hasCacheReading
    ? formatCacheHitPercent(stats.cachedPromptTokens, stats.cacheObservedInputTokens)
    : null;
  const uncachedInputTokens = Math.max(0, stats.inputTokens - stats.cachedPromptTokens);
  const averageTtftMs = stats.ttftSamples > 0
    ? stats.ttftDurationMs / stats.ttftSamples
    : 0;
  const countText = stats.steps > 0
    ? `${stats.turns} 轮 ${stats.steps} 步${tokensPerSecond > 0 ? ` · ${formatTokensPerSecond(tokensPerSecond)} tok/s` : ""}`
    : "";
  const tokenText = stats.totalTokens > 0
    ? `${formatCompactTokenCount(stats.totalTokens)} tok${cacheHit === null ? "" : ` · 缓存命中 ${cacheHit}%`}`
    : "";
  const fullText = [countText, tokenText].filter(Boolean).join(" | ");

  if (!countText && !tokenText && !contextUsage) return null;

  return (
    <div className="chat-stats-line" title={fullText}>
      {countText && (
        <StatsDetailPopover
          triggerClassName="chat-stats-line__trigger chat-stats-line__trigger--session"
          triggerLabel={`会话统计：${countText}`}
          triggerContent={(
            <>
              <RefreshCw
                className={`chat-stats-line__icon${isLoading ? " chat-stats-line__icon--spinning" : ""}`}
                size={14}
                strokeWidth={1.7}
                aria-hidden="true"
              />
              <span>{countText}</span>
            </>
          )}
          panelLabel="会话统计"
          panelWidth={272}
        >
          <StatsDetailTitle
            icon={<RefreshCw size={15} strokeWidth={1.8} aria-hidden="true" />}
            title="会话统计"
          />
          <div className="stats-detail-popover__rule" aria-hidden="true" />
          <dl className="stats-detail-popover__rows">
            <div>
              <dt>模型用时</dt>
              <dd>{formatSessionDuration(stats.modelDurationMs)}</dd>
            </div>
            <div>
              <dt>首 token 平均（TTFT）</dt>
              <dd>{formatSessionDuration(averageTtftMs)}</dd>
            </div>
            <div>
              <dt>输出速度（TPS）</dt>
              <dd>{tokensPerSecond > 0 ? `${formatTokensPerSecond(tokensPerSecond)} tok/s` : "—"}</dd>
            </div>
          </dl>
        </StatsDetailPopover>
      )}
      {countText && tokenText && <span className="chat-stats-line__separator" aria-hidden="true">|</span>}
      {tokenText && (
        <StatsDetailPopover
          triggerClassName="chat-stats-line__trigger chat-stats-line__trigger--tokens"
          triggerLabel={`Token 用量：${tokenText}`}
          triggerContent={(
            <>
              <Database size={14} strokeWidth={1.7} aria-hidden="true" />
              <span>{tokenText}</span>
            </>
          )}
          panelLabel="Token 用量"
          panelWidth={292}
        >
          <StatsDetailTitle
            icon={<Database size={15} strokeWidth={1.8} aria-hidden="true" />}
            title="Token 用量"
            value={`${formatExactTokenCount(stats.totalTokens)} tok`}
          />
          <div className="stats-detail-popover__rule" aria-hidden="true" />
          <dl className="stats-detail-popover__rows">
            {cacheHit !== null && (
              <div>
                <dt>缓存命中</dt>
                <dd>{cacheHit}%</dd>
              </div>
            )}
            <div>
              <dt>{cacheHit === null ? "输入" : "未缓存输入"}</dt>
              <dd>{formatExactTokenCount(uncachedInputTokens)} tok</dd>
            </div>
            {cacheHit !== null && (
              <div>
                <dt>缓存读取</dt>
                <dd>{formatExactTokenCount(stats.cachedPromptTokens)} tok</dd>
              </div>
            )}
            <div>
              <dt>输出</dt>
              <dd>{formatExactTokenCount(stats.outputTokens)} tok</dd>
            </div>
          </dl>
        </StatsDetailPopover>
      )}
      {contextUsage && (
        <>
          {(countText || tokenText) && (
            <span className="chat-stats-line__separator" aria-hidden="true">|</span>
          )}
          <ContextUsageTrigger snapshot={contextUsage} />
        </>
      )}
    </div>
  );
}
