import { useMemo, type CSSProperties } from "react";
import type { Message, ChatImage } from "../adapters/types";
import {
  estimatePromptTokens,
  estimateSystemTokens,
  estimateTokens,
  estimateToolsTokens,
  findLatestContextSample,
  IMAGE_REQUEST_TOKENS,
  measureContextUsage,
} from "../chat/tokenEstimator";
import { formatCompactTokenCount } from "../chat/turnUsage";
import StatsDetailPopover from "./StatsDetailPopover";

export type ContextUsageItem = {
  name: string;
  description?: string;
  schema?: unknown;
};

export type ContextUsageSnapshot = {
  /** 当前实际执行模型；锚点必须与这个模型一致。 */
  modelId: string;
  /** 当前模型上下文窗口（token） */
  contextWindow: number;
  /** 系统提示词 */
  systemPrompt?: string;
  /** 当前生效的本地工具声明 */
  tools: ContextUsageItem[];
  /** 当前已连接的 MCP 工具声明 */
  mcpTools: ContextUsageItem[];
  /** 当前生效的技能注入提示词 */
  skillsPrompt?: string;
  /** 历史消息 */
  messages: Message[];
  /** 当前输入框文本 */
  inputText: string;
  /** 当前输入框图片 */
  inputImages: ChatImage[];
};

type ContextUsagePanelProps = {
  snapshot: ContextUsageSnapshot;
};

function useContextBreakdown(snapshot: ContextUsageSnapshot) {
  return useMemo(() => {
    const system = estimateSystemTokens(snapshot.systemPrompt);
    const localTools = estimateToolsTokens(snapshot.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: (tool.schema ?? {}) as Record<string, unknown>,
    })));
    const mcpTools = estimateToolsTokens(snapshot.mcpTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: (tool.schema ?? {}) as Record<string, unknown>,
    })));
    const skills = estimateTokens(snapshot.skillsPrompt ?? "");
    const tools = localTools + mcpTools + skills;
    const conversation =
      estimatePromptTokens(snapshot.messages) +
      estimateTokens(snapshot.inputText) +
      (snapshot.inputImages?.length ?? 0) * IMAGE_REQUEST_TOKENS;
    const heuristicTotal = system + tools + conversation;
    const measurement = measureContextUsage(
      conversation,
      heuristicTotal,
      findLatestContextSample(snapshot.messages, snapshot.modelId),
    );
    const total = measurement.tokens;
    const contextWindow = Math.max(1, snapshot.contextWindow);
    const exactPercent = Math.min(100, Math.max(0, (total / contextWindow) * 100));
    return {
      rows: [
        { key: "system", label: "系统提示词", tone: "system", tokens: system },
        { key: "tools", label: "工具定义", tone: "tools", tokens: tools },
        { key: "conversation", label: "对话消息", tone: "messages", tokens: conversation },
      ],
      total,
      contextWindow,
      percent: Math.round(exactPercent),
      exactPercent,
      basis: measurement.basis,
    };
  }, [snapshot]);
}

export function ContextUsageTrigger({ snapshot }: ContextUsagePanelProps) {
  const breakdown = useContextBreakdown(snapshot);
  const rowsTotal = breakdown.rows.reduce((sum, row) => sum + row.tokens, 0);
  const segments = rowsTotal > 0
    ? breakdown.rows.filter((row) => row.tokens > 0)
    : [{ key: "total", tone: "", tokens: 1 }];

  return (
    <StatsDetailPopover
      triggerClassName="context-usage__trigger"
      triggerLabel={`上下文已用 ${breakdown.percent}%`}
      triggerContent={(
        <>
          <span
            className="context-usage__ring"
            style={{ "--context-usage-percent": breakdown.exactPercent } as CSSProperties}
            aria-hidden="true"
          />
          <span className="context-usage__trigger-text">{breakdown.percent}%</span>
        </>
      )}
      panelLabel="上下文用量"
      panelWidth={272}
    >
      <div className="context-usage__header">
        <span className="context-usage__headline">
          上下文已用 <strong>{breakdown.percent}%</strong>
        </span>
        <span className="context-usage__figures">
          ~{formatCompactTokenCount(breakdown.total)} / {formatCompactTokenCount(breakdown.contextWindow)}
        </span>
      </div>
      <div className="context-usage__bar" aria-hidden="true">
        {segments.map((segment) => (
          <span
            key={segment.key}
            className={segment.tone
              ? `context-usage__segment context-usage__segment--${segment.tone}`
              : "context-usage__segment"}
            style={{
              width: `${breakdown.exactPercent * (segment.tokens / (rowsTotal || 1))}%`,
            }}
          />
        ))}
      </div>
      <dl className="context-usage__rows">
        {breakdown.rows.map((row) => (
          <div key={row.key}>
            <dt>
              <span
                className={`context-usage__swatch context-usage__swatch--${row.tone}`}
                aria-hidden="true"
              />
              {row.label}
            </dt>
            <dd>~{formatCompactTokenCount(row.tokens)}</dd>
          </div>
        ))}
      </dl>
    </StatsDetailPopover>
  );
}

export default ContextUsageTrigger;
