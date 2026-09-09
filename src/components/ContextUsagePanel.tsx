import { useMemo, useState } from "react";
import { BarChart3, X } from "lucide-react";
import type { Message, ChatImage } from "../adapters/types";
import { estimateTokens, estimatePromptTokens } from "../chat/tokenEstimator";

export type ContextUsageItem = {
  name: string;
  description?: string;
  schema?: unknown;
};

export type ContextUsageSnapshot = {
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
  placement?: "toolbar" | "footer";
};

function formatK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return `${n}`;
}

function toolItemsToJson(items: ContextUsageItem[]): string {
  return JSON.stringify(
    items.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      parameters: t.schema ?? {},
    })),
  );
}

function useContextBreakdown(snapshot: ContextUsageSnapshot) {
  return useMemo(() => {
    const system = estimateTokens(snapshot.systemPrompt ?? "");
    const tools = estimateTokens(toolItemsToJson(snapshot.tools));
    const conversation =
      estimatePromptTokens(snapshot.messages) +
      estimateTokens(snapshot.inputText) +
      (snapshot.inputImages?.length ?? 0) * 256;
    const mcp = estimateTokens(toolItemsToJson(snapshot.mcpTools));
    const skills = estimateTokens(snapshot.skillsPrompt ?? "");
    const total = system + tools + conversation + mcp + skills;
    const contextWindow = Math.max(1, snapshot.contextWindow);
    const percent = Math.min(100, Math.max(0, (total / contextWindow) * 100));
    return {
      rows: [
        { key: "system", label: "System Prompt", color: "#8b5cf6", tokens: system },
        { key: "tools", label: "Tools", color: "#22c55e", tokens: tools },
        { key: "conversation", label: "Conversation", color: "#f59e0b", tokens: conversation },
        { key: "mcp", label: "MCP", color: "#a855f7", tokens: mcp },
        { key: "skills", label: "Skills", color: "#ec4899", tokens: skills },
      ],
      total,
      contextWindow,
      percent,
    };
  }, [snapshot]);
}

export function ContextUsageTrigger({ snapshot, placement = "toolbar" }: ContextUsagePanelProps) {
  const [open, setOpen] = useState(false);
  const breakdown = useContextBreakdown(snapshot);

  return (
    <div className={`context-usage${placement === "footer" ? " context-usage--footer" : ""}`}>
      <button
        type="button"
        className="context-usage__trigger"
        onClick={() => setOpen((prev) => !prev)}
        title="上下文用量"
        aria-expanded={open}
      >
        <BarChart3 size={15} strokeWidth={1.8} />
        <span className="context-usage__trigger-text">{breakdown.percent.toFixed(1)}%</span>
      </button>

      {open && (
        <div className="context-usage__panel">
          <div className="context-usage__head">
            <span className="context-usage__title">上下文用量</span>
            <button
              type="button"
              className="context-usage__close"
              onClick={() => setOpen(false)}
              title="关闭"
            >
              <X size={14} strokeWidth={2} />
            </button>
          </div>

          <div className="context-usage__summary">
            <span className="context-usage__percent">{breakdown.percent.toFixed(1)}%</span>
            <span className="context-usage__fraction">
              已使用 {formatK(breakdown.total)} / {formatK(breakdown.contextWindow)}
            </span>
          </div>

          <div className="context-usage__bar-bg">
            <div
              className="context-usage__bar-fill"
              style={{
                width: `${breakdown.percent}%`,
                backgroundColor:
                  breakdown.percent > 90 ? "#ef4444" : breakdown.percent > 75 ? "#f59e0b" : "#22c55e",
              }}
            />
          </div>

          <div className="context-usage__rows">
            {breakdown.rows.map((row) => (
              <div key={row.key} className="context-usage__row">
                <span className="context-usage__dot" style={{ backgroundColor: row.color }} />
                <span className="context-usage__label">{row.label}</span>
                <span className="context-usage__value">~{formatK(row.tokens)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default ContextUsageTrigger;
