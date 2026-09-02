import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, ShieldAlert } from "lucide-react";
import {
  getPendingConfirmation,
  resolveConfirmation,
  subscribeConfirmation,
  type ConfirmationRequest,
  type RiskLevel,
} from "../chat/confirmationGate";

type PendingEntry = ConfirmationRequest & { id: string };

const RISK_META: Record<RiskLevel, { label: string; tone: string }> = {
  irreversible: { label: "不可逆操作", tone: "irreversible" },
  destructive: { label: "破坏性操作", tone: "destructive" },
  write: { label: "写入操作", tone: "write" },
};

/**
 * 全局危险操作确认弹窗。
 *
 * 挂在 App 根，订阅 confirmationGate 的待确认请求：任何来源（AI 工具调用、
 * 用户点击删除）发起的危险操作都会在这里拍板，执行层拿不到批准就不会动手。
 */
export function ConfirmationDialog() {
  const [pending, setPending] = useState<PendingEntry | null>(() => getPendingConfirmation());

  useEffect(() => subscribeConfirmation(setPending), []);

  useEffect(() => {
    if (!pending) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        resolveConfirmation(pending.id, false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pending]);

  if (!pending) return null;

  const risk = RISK_META[pending.riskLevel];
  const isSevere = pending.riskLevel === "irreversible";

  return createPortal(
    <div
      className="omni-confirm-overlay"
      onClick={() => resolveConfirmation(pending.id, false)}
      role="presentation"
    >
      <div
        className={`omni-confirm-dialog confirm-dialog confirm-dialog--${risk.tone}`}
        onClick={(event) => event.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        <div className="confirm-dialog__header">
          <span className="confirm-dialog__icon" aria-hidden="true">
            {isSevere ? <ShieldAlert size={16} strokeWidth={2} /> : <AlertTriangle size={16} strokeWidth={2} />}
          </span>
          <div className="confirm-dialog__heading">
            <h3 className="omni-confirm-dialog__title" id="confirm-dialog-title">
              {pending.title}
            </h3>
            <span className={`confirm-dialog__badge confirm-dialog__badge--${risk.tone}`}>{risk.label}</span>
          </div>
        </div>

        <div className="confirm-dialog__body">
          <p className="confirm-dialog__summary">{pending.summary}</p>

          {pending.details.length > 0 && (
            <div className="confirm-dialog__section">
              <span className="confirm-dialog__section-title">本次参数</span>
              <dl className="confirm-dialog__details">
                {pending.details.map((detail) => (
                  <div className="confirm-dialog__detail-row" key={detail.label}>
                    <dt>{detail.label}</dt>
                    <dd>{detail.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {pending.targets.length > 0 && (
            <div className="confirm-dialog__section">
              <span className="confirm-dialog__section-title">影响对象</span>
              <ul className="confirm-dialog__targets">
                {pending.targets.map((target) => (
                  <li key={target}>{target}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="confirm-dialog__warning">
            <AlertTriangle size={13} strokeWidth={2} />
            <span>{pending.warning}</span>
          </div>
        </div>

        <div className="omni-confirm-dialog__actions confirm-dialog__actions">
          <button
            type="button"
            className="omni-confirm-dialog__button"
            onClick={() => resolveConfirmation(pending.id, false)}
          >
            <span>取消</span>
          </button>
          <button
            type="button"
            className={`omni-confirm-dialog__button ${isSevere ? "omni-confirm-dialog__button--danger" : "omni-confirm-dialog__button--primary"}`}
            onClick={() => resolveConfirmation(pending.id, true)}
            autoFocus
          >
            <Check size={14} strokeWidth={2.2} />
            <span>{pending.confirmLabel ?? "确认执行"}</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
