import { CheckCircle2, ChevronDown, CircleAlert, LoaderCircle } from "lucide-react";
import { createPortal } from "react-dom";
import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { PetThoughtState } from "../../app/types";
import type { PetThoughtPlacement } from "../../app/window";

type PetThoughtBubbleProps = {
  thought: PetThoughtState | null;
  anchorRef: RefObject<HTMLElement | null>;
  placement: PetThoughtPlacement;
  lockPlacement: boolean;
  onPlacementChange: (placement: PetThoughtPlacement) => void;
};

type BubbleLayout = {
  bubbleLeft: number;
  bubbleTop: number;
  bubblePlacement: PetThoughtPlacement;
  bubbleMaxWidth: number;
  actionLeft: number;
  actionTop: number;
  ready: boolean;
};

const VIEWPORT_MARGIN = 12;
const BUBBLE_GAP = 14;
const MAX_BUBBLE_WIDTH = 320;
const MIN_BUBBLE_WIDTH = 168;
const MIN_BUBBLE_HEIGHT = 52;
const REPOSITION_POLL_MS = 180;
const ACTION_FALLBACK_SIZE = 20;
const COUNTER_FALLBACK_SIZE = 26;
const BUBBLE_VERTICAL_OFFSET = 0.68;
function clamp(value: number, min: number, max: number) {
  if (max < min) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

export default function PetThoughtBubble({
  thought,
  anchorRef,
  placement,
  lockPlacement,
  onPlacementChange,
}: PetThoughtBubbleProps) {
  void placement;
  void onPlacementChange;

  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const titleRowRef = useRef<HTMLDivElement | null>(null);
  const actionRef = useRef<HTMLButtonElement | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [placementState, setPlacementState] = useState<PetThoughtPlacement>(placement);
  const [previewMaxWidth, setPreviewMaxWidth] = useState<number | null>(null);
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
    bubbleLeft: VIEWPORT_MARGIN,
    bubbleTop: VIEWPORT_MARGIN,
    bubblePlacement: "top",
    bubbleMaxWidth: MAX_BUBBLE_WIDTH,
    actionLeft: VIEWPORT_MARGIN,
    actionTop: VIEWPORT_MARGIN,
    ready: false,
  });

  useLayoutEffect(() => {
    if (!thought) {
      return;
    }
    setPlacementState(placement);
  }, [placement, thought]);

  useLayoutEffect(() => {
    if (!thought) {
      return;
    }

    const anchor = anchorRef.current;
    if (!anchor) {
      return;
    }

    let frame = 0;

    const reposition = () => {
      const bubble = bubbleRef.current;
      const action = actionRef.current;
      const anchorRect = anchor.getBoundingClientRect();
      const petViewport = anchor.querySelector<HTMLElement>(".desktop-pet__viewport");
      const actionAnchorRect = (petViewport ?? anchor).getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      const actionWidth =
        action?.getBoundingClientRect().width ?? (isCollapsed ? COUNTER_FALLBACK_SIZE : ACTION_FALLBACK_SIZE);
      const actionHeight =
        action?.getBoundingClientRect().height ?? (isCollapsed ? COUNTER_FALLBACK_SIZE : ACTION_FALLBACK_SIZE);
      const anchorCenterX = anchorRect.left + anchorRect.width / 2;
      const anchorCenterY = anchorRect.top + anchorRect.height / 2;
      const bubbleMaxWidth = Math.min(
        MAX_BUBBLE_WIDTH,
        Math.max(MIN_BUBBLE_WIDTH, viewportWidth - VIEWPORT_MARGIN * 2)
      );
      const bubbleWidthLimit = Math.max(0, Math.round(bubbleMaxWidth));

      if (bubble) {
        bubble.style.maxWidth = `${bubbleWidthLimit}px`;
        bubble.style.minWidth = "0px";
      }

      const bubbleRect = bubble?.getBoundingClientRect();
      if (!bubbleRect) {
        return;
      }

      const bubbleWidth = Math.max(MIN_BUBBLE_WIDTH, bubbleRect.width);
      const bubbleHeight = Math.max(MIN_BUBBLE_HEIGHT, bubbleRect.height);
      const topSpace = anchorRect.top - VIEWPORT_MARGIN - BUBBLE_GAP;
      const bottomSpace = viewportHeight - anchorRect.bottom - VIEWPORT_MARGIN - BUBBLE_GAP;
      const leftSpace = anchorRect.left - VIEWPORT_MARGIN - BUBBLE_GAP;
      const rightSpace = viewportWidth - anchorRect.right - VIEWPORT_MARGIN - BUBBLE_GAP;

      let bubblePlacement: PetThoughtPlacement = "top";
      if (topSpace >= bubbleHeight) {
        bubblePlacement = "top";
      } else if (rightSpace >= bubbleWidth && rightSpace >= leftSpace) {
        bubblePlacement = "right";
      } else if (leftSpace >= bubbleWidth) {
        bubblePlacement = "left";
      } else if (bottomSpace >= bubbleHeight) {
        bubblePlacement = "bottom";
      } else if (rightSpace >= leftSpace) {
        bubblePlacement = "right";
      } else {
        bubblePlacement = "left";
      }

      if (placementState !== bubblePlacement) {
        setPlacementState(bubblePlacement);
        onPlacementChange(bubblePlacement);
      }

      const bubbleLeft =
        bubblePlacement === "left"
          ? clamp(anchorRect.left - bubbleRect.width - BUBBLE_GAP, VIEWPORT_MARGIN, viewportWidth - bubbleRect.width - VIEWPORT_MARGIN)
          : bubblePlacement === "right"
            ? clamp(anchorRect.right + BUBBLE_GAP, VIEWPORT_MARGIN, viewportWidth - bubbleRect.width - VIEWPORT_MARGIN)
            : clamp(anchorCenterX - bubbleRect.width / 2, VIEWPORT_MARGIN, viewportWidth - bubbleRect.width - VIEWPORT_MARGIN);
      const bubbleTop =
        bubblePlacement === "top"
          ? clamp(anchorRect.top + 6, VIEWPORT_MARGIN, viewportHeight - bubbleRect.height - VIEWPORT_MARGIN)
          : bubblePlacement === "bottom"
            ? clamp(anchorRect.bottom + BUBBLE_GAP, VIEWPORT_MARGIN, viewportHeight - bubbleRect.height - VIEWPORT_MARGIN)
            : clamp(anchorCenterY - bubbleRect.height * BUBBLE_VERTICAL_OFFSET, VIEWPORT_MARGIN, viewportHeight - bubbleRect.height - VIEWPORT_MARGIN);

      const actionOffsetX = clamp(Math.round(actionAnchorRect.width * -0.04), -10, -2);
      const actionOffsetY = clamp(Math.round(actionAnchorRect.height * -0.08), -14, -4);
      const actionLeft = clamp(
        actionAnchorRect.right - actionWidth * 0.5 + actionOffsetX,
        VIEWPORT_MARGIN,
        viewportWidth - actionWidth - VIEWPORT_MARGIN
      );
      const actionTop = clamp(
        actionAnchorRect.top + actionOffsetY,
        VIEWPORT_MARGIN,
        viewportHeight - actionHeight - VIEWPORT_MARGIN
      );

      setLayout((current) => {
        if (
          current.ready &&
          Math.abs(current.bubbleLeft - bubbleLeft) < 1 &&
          Math.abs(current.bubbleTop - bubbleTop) < 1 &&
          current.bubblePlacement === bubblePlacement &&
          Math.abs(current.bubbleMaxWidth - bubbleMaxWidth) < 1 &&
          Math.abs(current.actionLeft - actionLeft) < 1 &&
          Math.abs(current.actionTop - actionTop) < 1
        ) {
          return current;
        }
        return {
          bubbleLeft,
          bubbleTop,
          bubblePlacement,
          bubbleMaxWidth,
          actionLeft,
          actionTop,
          ready: true,
        };
      });
    };

    const scheduleReposition = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(reposition);
    };

    scheduleReposition();
    window.addEventListener("resize", scheduleReposition);
    const pollTimer = window.setInterval(scheduleReposition, REPOSITION_POLL_MS);

    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleReposition);
    observer?.observe(anchor);
    if (bubbleRef.current) {
      observer?.observe(bubbleRef.current);
    }
    if (actionRef.current) {
      observer?.observe(actionRef.current);
    }

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleReposition);
      window.clearInterval(pollTimer);
      observer?.disconnect();
    };
  }, [anchorRef, isCollapsed, lockPlacement, previewText, thought]);

  useLayoutEffect(() => {
    if (!thought || isCollapsed) {
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
  }, [isCollapsed, thought, previewText, placementState, layout.bubbleMaxWidth]);

  useLayoutEffect(() => {
    if (!thought) {
      return;
    }
    setIsCollapsed(false);
  }, [thought?.responseCount, thought?.sessionId]);

  if (!thought) {
    return null;
  }

  const responseCount = Math.max(1, thought.responseCount || 1);
  const portalTarget = typeof document === "undefined" ? null : document.body;

  const bubbleStyle = {
    left: `${layout.bubbleLeft}px`,
    top: `${layout.bubbleTop}px`,
    maxWidth: `${Math.round(layout.bubbleMaxWidth)}px`,
    minWidth: "0px",
    visibility: layout.ready ? "visible" : "hidden",
  } as CSSProperties;

  const actionStyle = {
    left: `${layout.actionLeft}px`,
    top: `${layout.actionTop}px`,
    visibility: layout.ready ? "visible" : "hidden",
  } as CSSProperties;

  const content = (
    <>
      {!isCollapsed ? (
        <div
          ref={bubbleRef}
          className={`pet-thought-bubble pet-thought-bubble--${thought.status} pet-thought-bubble--${layout.bubblePlacement} no-drag`}
          style={bubbleStyle}
        >
          <div className="pet-thought-bubble__body">
            <div ref={titleRowRef} className="pet-thought-bubble__title-row">
              <div className="pet-thought-bubble__title" title={thought.sessionTitle}>
                {thought.sessionTitle}
              </div>
              {isThinking ? (
                <LoaderCircle
                  className="pet-thought-bubble__badge pet-thought-bubble__badge--thinking"
                  size={16}
                  strokeWidth={2.2}
                  aria-hidden="true"
                  focusable="false"
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
          </div>
        </div>
      ) : null}
      {!isCollapsed ? (
        <button
          ref={actionRef}
          type="button"
          className="pet-thought-toggle no-drag"
          style={actionStyle}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setIsCollapsed(true);
          }}
          aria-label="Collapse thought bubble"
          title="Collapse thought bubble"
        >
          <ChevronDown size={11} strokeWidth={2.5} aria-hidden="true" focusable="false" />
        </button>
      ) : (
        <button
          ref={actionRef}
          type="button"
          className={`pet-thought-counter pet-thought-counter--${thought.status} no-drag`}
          style={actionStyle}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setIsCollapsed(false);
          }}
          aria-label={`Expand thought bubble, response ${responseCount}`}
          title={`Response ${responseCount}`}
        >
          {responseCount}
        </button>
      )}
    </>
  );

  if (!portalTarget) {
    return content;
  }

  return createPortal(content, portalTarget);
}
