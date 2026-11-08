import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Database } from "lucide-react";
import type { ChatTurnUsage } from "../adapters/types";
import { formatCompactTokenCount, formatExactTokenCount } from "../chat/turnUsage";

const PANEL_WIDTH = 320;
const VIEWPORT_GAP = 12;

type PanelPosition = {
  left: number;
  bottom: number;
  width: number;
};

export default function TurnUsagePanel({ usage }: { usage: ChatTurnUsage }) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PanelPosition | null>(null);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(PANEL_WIDTH, Math.max(220, window.innerWidth - VIEWPORT_GAP * 2));
    const left = Math.max(
      VIEWPORT_GAP,
      Math.min(rect.left, window.innerWidth - width - VIEWPORT_GAP),
    );
    setPosition({
      left,
      bottom: Math.max(VIEWPORT_GAP, window.innerHeight - rect.top + 8),
      width,
    });
  }, []);

  useEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }

    updatePosition();
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, updatePosition]);

  const estimated = usage.estimated === true;
  const totalLabel = `${estimated ? "估算" : "用量"} ${formatCompactTokenCount(usage.totalTokens)} tok`;
  const panelTitle = estimated ? "本轮估算用量" : "本轮用量";
  const panel = open && position && typeof document !== "undefined"
    ? createPortal(
        <div
          ref={panelRef}
          className="message-turn-usage__panel"
          role="dialog"
          aria-label={panelTitle}
          style={{ left: position.left, bottom: position.bottom, width: position.width }}
        >
          <div className="message-turn-usage__head">
            <span className="message-turn-usage__title">
              <Database size={14} strokeWidth={1.8} />
              {panelTitle}
            </span>
            <strong>
              {estimated ? "≈ " : ""}
              {formatExactTokenCount(usage.totalTokens)} tok
            </strong>
          </div>
          <dl className="message-turn-usage__details" data-turn-usage-details>
            <div>
              <dt>提供方 / 模型</dt>
              <dd>{usage.model}</dd>
            </div>
            <div>
              <dt>{estimated ? "估算输入" : "未缓存输入"}</dt>
              <dd>{formatExactTokenCount(usage.inputTokens)} tok</dd>
            </div>
            <div>
              <dt>输出</dt>
              <dd>{formatExactTokenCount(usage.outputTokens)} tok</dd>
            </div>
            {estimated && (
              <div>
                <dt>统计口径</dt>
                <dd>模型未返回精确用量，此处为本地估算值</dd>
              </div>
            )}
          </dl>
        </div>,
        document.body,
      )
    : null;

  return (
    <span ref={rootRef} className="message-turn-usage">
      <button
        ref={triggerRef}
        type="button"
        className="message-turn-usage__trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={totalLabel}
        title={estimated ? "查看本轮 token 估算用量" : "查看本轮 token 用量"}
        onClick={() => setOpen((current) => !current)}
      >
        <Database size={14} strokeWidth={1.8} />
        <span>{totalLabel}</span>
      </button>
      {panel}
    </span>
  );
}
