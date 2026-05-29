import { CheckCircle2, ChevronRight, CircleAlert, X } from "lucide-react";
import { emit } from "@tauri-apps/api/event";
import { createPortal } from "react-dom";
import { useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import type { PetThoughtState } from "../../app/types";
import type { PetThoughtPlacement } from "../../app/window";

type PetThoughtBubbleProps = {
  thought: PetThoughtState | null;
  placement: PetThoughtPlacement;
  usePortal?: boolean;
  stacked?: boolean;
  collapsed?: boolean;
};

type BubbleLayout = {
  bubblePlacement: PetThoughtPlacement;
  ready: boolean;
};

const FIXED_BUBBLE_WIDTH = 250;

export default function PetThoughtBubble({
  thought,
  placement,
  usePortal = true,
  stacked = false,
  collapsed = false,
}: PetThoughtBubbleProps) {
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const titleRowRef = useRef<HTMLDivElement | null>(null);
  const [placementState, setPlacementState] = useState<PetThoughtPlacement>(placement);
  const [previewMaxWidth, setPreviewMaxWidth] = useState<number | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isReplying, setIsReplying] = useState(false);
  const [isSubmittingReply, setIsSubmittingReply] = useState(false);
  const [replyDraft, setReplyDraft] = useState("");
  const isError = thought?.status === "error";
  const isComplete = thought?.status === "complete";
  const isThinking = thought?.status === "thinking";
  const previewText =
    thought?.status === "thinking" && !thought.previewText.trim()
      ? "Thinking..."
      : thought?.status === "error" && !thought.previewText.trim()
        ? "Response failed"
        : thought?.previewText.trim() ?? "";
  const [layout, setLayout] = useState<BubbleLayout>({
    bubblePlacement: "top",
    ready: false,
  });

  useLayoutEffect(() => {
    if (!thought) {
      return;
    }
    setPlacementState(placement);
    setLayout((current) =>
      current.ready && current.bubblePlacement === placement
        ? current
        : { bubblePlacement: placement, ready: true }
    );
  }, [placement, thought]);

  useLayoutEffect(() => {
    if (!thought || collapsed) {
      return;
    }

    const updatePreviewWidth = () => {
      const titleRow = titleRowRef.current;
      if (!titleRow) {
        return;
      }
      const rowWidth = Math.floor(titleRow.getBoundingClientRect().width);
      if (rowWidth <= 0) {
        return;
      }
      setPreviewMaxWidth((current) => (current === rowWidth ? current : rowWidth));
    };

    updatePreviewWidth();
    window.addEventListener("resize", updatePreviewWidth);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePreviewWidth);
    if (titleRowRef.current) {
      observer?.observe(titleRowRef.current);
    }
    if (bubbleRef.current) {
      observer?.observe(bubbleRef.current);
    }

    return () => {
      window.removeEventListener("resize", updatePreviewWidth);
      observer?.disconnect();
    };
  }, [collapsed, thought, previewText, placementState]);

  if (!thought) {
    return null;
  }

  const closeBubble = () => {
    void emit("omni-pet-thought-close", {
      sessionId: thought.sessionId,
      thoughtId: thought.thoughtId ?? null,
    });
  };

  const submitReply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = replyDraft.trim();
    if (!content || !thought.sessionId) {
      return;
    }

    setIsSubmittingReply(true);
    setReplyDraft("");
    setIsReplying(false);
    void emit("omni-pet-thought-reply", {
      sessionId: thought.sessionId,
      content,
    }).finally(() => setIsSubmittingReply(false));
  };

  const portalTarget = usePortal && !stacked && typeof document !== "undefined" ? document.body : null;

  const bubbleStyle = {
    width: `${FIXED_BUBBLE_WIDTH}px`,
    maxWidth: `${FIXED_BUBBLE_WIDTH}px`,
    minWidth: `${FIXED_BUBBLE_WIDTH}px`,
    visibility: layout.ready ? "visible" : "hidden",
    position: stacked ? ("relative" as const) : ("fixed" as const),
    left: stacked ? "auto" : "50%",
    top: stacked ? "auto" : undefined,
    bottom: stacked ? "auto" : undefined,
    transform: stacked
      ? "none"
      : `translateX(-50%)${collapsed ? " scale(0.96)" : ""}`,
  } as CSSProperties;

  const bubbleNode = (
    <div
      ref={bubbleRef}
      className={`pet-thought-bubble pet-thought-bubble--${thought.status} pet-thought-bubble--${layout.bubblePlacement} ${stacked ? "pet-thought-bubble--stacked" : ""} ${collapsed ? "pet-thought-bubble--collapsed" : ""} ${isExpanded ? "pet-thought-bubble--expanded" : ""} ${isReplying ? "pet-thought-bubble--replying" : ""} no-drag`}
      style={bubbleStyle}
      aria-hidden={collapsed}
    >
      <div className="pet-thought-bubble__body">
        <div ref={titleRowRef} className="pet-thought-bubble__title-row">
          <div className="pet-thought-bubble__title" title={thought.sessionTitle}>
            {thought.sessionTitle}
          </div>
          <span className="pet-thought-bubble__right-actions">
            <button
              type="button"
              className="pet-thought-bubble__hover-button pet-thought-bubble__hover-button--close"
              onClick={closeBubble}
              aria-label="Close bubble"
              title="Close"
            >
              <X size={11} strokeWidth={2.2} aria-hidden="true" focusable="false" />
            </button>
            <button
              type="button"
              className="pet-thought-bubble__hover-button pet-thought-bubble__hover-button--expand"
              onClick={() => setIsExpanded((value) => !value)}
              aria-label={isExpanded ? "Collapse reply" : "Expand reply"}
              title={isExpanded ? "Collapse" : "Expand"}
            >
              <ChevronRight size={14} strokeWidth={2.1} aria-hidden="true" focusable="false" />
            </button>
            <span className="pet-thought-bubble__action-slot">
              {isThinking ? (
                <span
                  className="pet-thought-bubble__badge pet-thought-bubble__badge--thinking"
                  aria-hidden="true"
                />
              ) : null}
              {isComplete ? (
                <CheckCircle2
                  className="pet-thought-bubble__badge pet-thought-bubble__badge--complete"
                  size={16}
                  strokeWidth={2.2}
                  aria-hidden="true"
                  focusable="false"
                />
              ) : null}
              {isError ? (
                <CircleAlert
                  className="pet-thought-bubble__badge pet-thought-bubble__badge--error"
                  size={16}
                  strokeWidth={2.2}
                  aria-hidden="true"
                  focusable="false"
                />
              ) : null}
            </span>
          </span>
        </div>
        {previewText ? (
          <div
            className="pet-thought-bubble__preview"
            title={previewText}
            style={previewMaxWidth ? { maxWidth: `${previewMaxWidth}px` } : undefined}
          >
            {previewText}
          </div>
        ) : null}
        {isReplying ? (
          <form className="pet-thought-bubble__reply-form" onSubmit={submitReply}>
            <input
              className="pet-thought-bubble__reply-input"
              value={replyDraft}
              onChange={(event) => setReplyDraft(event.currentTarget.value)}
              placeholder="回复"
              aria-label="回复这个话题"
              autoFocus
            />
            <button
              type="submit"
              className="pet-thought-bubble__reply-submit"
              disabled={!replyDraft.trim() || !thought.sessionId || isSubmittingReply}
            >
              回复
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="pet-thought-bubble__reply-trigger"
            onClick={() => setIsReplying(true)}
            disabled={!thought.sessionId}
            aria-label="回复这个话题"
            title="回复"
          >
            回复
          </button>
        )}
      </div>
    </div>
  );

  const content = stacked ? (
    <div className={`pet-thought-stack-item ${collapsed ? "pet-thought-stack-item--collapsed" : ""}`}>
      {bubbleNode}
    </div>
  ) : (
    bubbleNode
  );

  if (!portalTarget) {
    return content;
  }
  return createPortal(content, portalTarget);
}
