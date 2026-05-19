import { ChevronDown, CircleAlert } from "lucide-react";
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
  tailX: number;
  tailY: number;
  actionLeft: number;
  actionTop: number;
  ready: boolean;
};

const VIEWPORT_MARGIN = 12;
const BUBBLE_GAP = 14;
const MIN_TAIL_HORIZONTAL_INSET = 24;
const MIN_TAIL_VERTICAL_INSET = 18;
const REPOSITION_POLL_MS = 180;
const ACTION_FALLBACK_SIZE = 20;
const COUNTER_FALLBACK_SIZE = 26;
const BUBBLE_VERTICAL_OFFSET = 0.56;

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
  const actionRef = useRef<HTMLButtonElement | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const isError = thought?.status === "error";
  const previewText =
    thought?.status === "thinking" && !thought.previewText.trim()
      ? "Thinking..."
      : thought?.status === "error" && !thought.previewText.trim()
        ? "Response failed"
        : thought?.previewText.trim() ?? "";
  const [layout, setLayout] = useState<BubbleLayout>({
    bubbleLeft: VIEWPORT_MARGIN,
    bubbleTop: VIEWPORT_MARGIN,
    tailX: 48,
    tailY: 28,
    actionLeft: VIEWPORT_MARGIN,
    actionTop: VIEWPORT_MARGIN,
    ready: false,
  });

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
      if (lockPlacement) {
        return;
      }

      const bubble = bubbleRef.current;
      const action = actionRef.current;
      const anchorRect = anchor.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      const actionWidth =
        action?.getBoundingClientRect().width ?? (isCollapsed ? COUNTER_FALLBACK_SIZE : ACTION_FALLBACK_SIZE);
      const actionHeight =
        action?.getBoundingClientRect().height ?? (isCollapsed ? COUNTER_FALLBACK_SIZE : ACTION_FALLBACK_SIZE);
      const actionLeft = clamp(
        anchorRect.right - actionWidth * 0.5,
        VIEWPORT_MARGIN,
        viewportWidth - actionWidth - VIEWPORT_MARGIN
      );
      const actionTop = clamp(
        anchorRect.top + anchorRect.height * 0.08,
        VIEWPORT_MARGIN,
        viewportHeight - actionHeight - VIEWPORT_MARGIN
      );

      if (isCollapsed) {
        setLayout((current) => {
          if (
            current.ready &&
            Math.abs(current.actionLeft - actionLeft) < 1 &&
            Math.abs(current.actionTop - actionTop) < 1
          ) {
            return current;
          }
          return {
            ...current,
            actionLeft,
            actionTop,
            ready: true,
          };
        });
        return;
      }

      if (!bubble) {
        return;
      }

      const bubbleRect = bubble.getBoundingClientRect();
      const anchorCenterY = anchorRect.top + anchorRect.height / 2;
      const bubbleLeft = clamp(
        anchorRect.left - bubbleRect.width - BUBBLE_GAP,
        VIEWPORT_MARGIN,
        viewportWidth - bubbleRect.width - VIEWPORT_MARGIN
      );
      const bubbleTop = clamp(
        anchorCenterY - bubbleRect.height * BUBBLE_VERTICAL_OFFSET,
        VIEWPORT_MARGIN,
        viewportHeight - bubbleRect.height - VIEWPORT_MARGIN
      );
      const anchorCenterX = anchorRect.left + anchorRect.width / 2;
      const tailX = clamp(
        anchorCenterX - bubbleLeft,
        MIN_TAIL_HORIZONTAL_INSET,
        bubbleRect.width - MIN_TAIL_HORIZONTAL_INSET
      );
      const tailY = clamp(
        anchorCenterY - bubbleTop,
        MIN_TAIL_VERTICAL_INSET,
        bubbleRect.height - MIN_TAIL_VERTICAL_INSET
      );

      setLayout((current) => {
        if (
          current.ready &&
          Math.abs(current.bubbleLeft - bubbleLeft) < 1 &&
          Math.abs(current.bubbleTop - bubbleTop) < 1 &&
          Math.abs(current.tailX - tailX) < 1 &&
          Math.abs(current.tailY - tailY) < 1 &&
          Math.abs(current.actionLeft - actionLeft) < 1 &&
          Math.abs(current.actionTop - actionTop) < 1
        ) {
          return current;
        }
        return {
          bubbleLeft,
          bubbleTop,
          tailX,
          tailY,
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
    visibility: layout.ready ? "visible" : "hidden",
    "--pet-thought-tail-x": `${layout.tailX}px`,
    "--pet-thought-tail-y": `${layout.tailY}px`,
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
          className={`pet-thought-bubble pet-thought-bubble--${thought.status} pet-thought-bubble--left no-drag`}
          style={bubbleStyle}
        >
          <div className="pet-thought-bubble__body">
            <div className="pet-thought-bubble__title" title={thought.sessionTitle}>
              {thought.sessionTitle}
            </div>
            {previewText ? (
              <div className="pet-thought-bubble__preview" title={previewText}>
                {previewText}
              </div>
            ) : null}
          </div>
          {isError ? (
            <CircleAlert
              className="pet-thought-bubble__badge"
              size={16}
              strokeWidth={2.2}
              aria-hidden="true"
              focusable="false"
            />
          ) : null}
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
          className="pet-thought-counter no-drag"
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
