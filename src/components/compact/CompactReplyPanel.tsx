import type { CompactReply } from "../../app/types";

type CompactReplyPanelProps = {
  compactReply: CompactReply | null;
  isCharacterAppearance: boolean;
  isCompactReplyLoading: boolean;
  panelSide?: "left" | "right";
  speakerLabel: string;
  variant?: "default" | "character" | "pet";
  onClose: () => void;
};

export default function CompactReplyPanel({
  compactReply,
  isCharacterAppearance,
  isCompactReplyLoading,
  panelSide = "left",
  speakerLabel,
  variant = isCharacterAppearance ? "character" : "default",
  onClose,
}: CompactReplyPanelProps) {
  if (!isCompactReplyLoading && !compactReply) {
    return null;
  }

  const className =
    variant === "pet"
      ? "compact-reply compact-reply--pet animate-fade-in no-drag"
      : isCharacterAppearance
        ? `compact-reply ${panelSide === "right" ? "compact-reply--right" : ""} animate-fade-in no-drag`
        : "compact-reply compact-reply--inline animate-fade-in no-drag";

  return (
    <div className={className} onMouseDown={(event) => event.stopPropagation()}>
      <button type="button" className="compact-reply__close" onClick={onClose} aria-label="关闭回答">
        ×
      </button>

      {isCompactReplyLoading ? (
        <div className="compact-reply__summary">正在回答...</div>
      ) : (
        <>
          <div className="compact-reply__summary">
            {compactReply?.answer.length && compactReply.answer.length > 84
              ? `${compactReply.answer.slice(0, 84)}...`
              : compactReply?.answer}
          </div>
          {compactReply && (
            <div className="compact-reply__full">
              <div className="compact-reply__qa compact-reply__qa--question">你：{compactReply.question}</div>
              <div className="compact-reply__qa">
                {speakerLabel}：{compactReply.answer}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
