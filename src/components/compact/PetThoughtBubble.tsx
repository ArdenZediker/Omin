import { ChevronDown, CircleAlert } from "lucide-react";
import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { PetThoughtState } from "../../app/types";
import type { PetThoughtPlacement } from "../../app/window";

type BubblePlacement = PetThoughtPlacement;

type PetThoughtBubbleProps = {
  thought: PetThoughtState | null;
  anchorRef: RefObject<HTMLElement | null>;
  placement: BubblePlacement;
  lockPlacement: boolean;
  onPlacementChange: (placement: BubblePlacement) => void;
};

type BubbleLayout = {
  placement: BubblePlacement;
  bubbleLeft: number;
  bubbleTop: number;
  tailX: number;
  tailY: number;
  actionLeft: number;
  actionTop: number;
  ready: boolean;
};

const VIEWPORT_MARGIN = 12;
const BUBBLE_GAP = 12;
const MIN_TAIL_HORIZONTAL_INSET = 24;
const MIN_TAIL_VERTICAL_INSET = 18;
const REPOSITION_POLL_MS = 180;
const HORIZONTAL_PLACEMENT_BONUS = 20;
const PLACEMENT_SWITCH_SCORE_GAP = 36;
const ACTION_FALLBACK_SIZE = 20;
const COUNTER_FALLBACK_SIZE = 26;

function clamp(value: number, min: number, max: number) {
  if (max < min) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function getPlacementFrame(
  placement: BubblePlacement,
  anchorRect: DOMRect,
  bubbleWidth: number,
  bubbleHeight: number
) {
  const centerX = anchorRect.left + anchorRect.width / 2;
  const centerY = anchorRect.top + anchorRect.height / 2;

  switch (placement) {
    case "right":
      return {
        left: anchorRect.right + BUBBLE_GAP,
        top: centerY - bubbleHeight / 2,
      };
    case "left":
      return {
        left: anchorRect.left - BUBBLE_GAP - bubbleWidth,
        top: centerY - bubbleHeight / 2,
      };
    case "bottom":
      return {
        left: centerX - bubbleWidth / 2,
        top: anchorRect.bottom + BUBBLE_GAP,
      };
    case "top":
    default:
      return {
        left: centerX - bubbleWidth / 2,
        top: anchorRect.top - BUBBLE_GAP - bubbleHeight,
      };
  }
}

function resolvePlacement(
  anchorRect: DOMRect,
  bubbleWidth: number,
  bubbleHeight: number,
  currentPlacement: BubblePlacement
) {
  const screenInfo = window.screen as Screen & { availLeft?: number; availTop?: number };
  const availLeft = Number(screenInfo.availLeft ?? 0);
  const availTop = Number(screenInfo.availTop ?? 0);
  const availWidth = Number(screenInfo.availWidth || screenInfo.width || window.innerWidth);
  const availHeight = Number(screenInfo.availHeight || screenInfo.height || window.innerHeight);
  const screenLeft = Number(window.screenX ?? window.screenLeft ?? 0);
  const screenTop = Number(window.screenY ?? window.screenTop ?? 0);
  const anchorScreenRect = {
    left: screenLeft + anchorRect.left,
    right: screenLeft + anchorRect.right,
    top: screenTop + anchorRect.top,
    bottom: screenTop + anchorRect.bottom,
  };
  const monitorRight = availLeft + availWidth;
  const monitorBottom = availTop + availHeight;
  const leftSpace = anchorScreenRect.left - availLeft;
  const rightSpace = monitorRight - anchorScreenRect.right;
  const topSpace = anchorScreenRect.top - availTop;
  const bottomSpace = monitorBottom - anchorScreenRect.bottom;
  const candidates: Array<{
    placement: BubblePlacement;
    fits: boolean;
    score: number;
  }> = [
    {
      placement: "right",
      fits: rightSpace >= bubbleWidth + BUBBLE_GAP + VIEWPORT_MARGIN,
      score: rightSpace - bubbleWidth + HORIZONTAL_PLACEMENT_BONUS,
    },
    {
      placement: "left",
      fits: leftSpace >= bubbleWidth + BUBBLE_GAP + VIEWPORT_MARGIN,
      score: leftSpace - bubbleWidth + HORIZONTAL_PLACEMENT_BONUS,
    },
    {
      placement: "top",
      fits: topSpace >= bubbleHeight + BUBBLE_GAP + VIEWPORT_MARGIN,
      score: topSpace - bubbleHeight,
    },
    {
      placement: "bottom",
      fits: bottomSpace >= bubbleHeight + BUBBLE_GAP + VIEWPORT_MARGIN,
      score: bottomSpace - bubbleHeight,
    },
  ];
  const fits = candidates.filter((candidate) => candidate.fits);
  const pool = fits.length > 0 ? fits : candidates;
  const best = pool.reduce((winner, candidate) => (candidate.score > winner.score ? candidate : winner), pool[0]);
  if (best.placement === currentPlacement) {
    return currentPlacement;
  }
  const current = pool.find((candidate) => candidate.placement === currentPlacement);
  if (current && best.score - current.score < PLACEMENT_SWITCH_SCORE_GAP) {
    return currentPlacement;
  }
  return best.placement;
}

export default function PetThoughtBubble({
  thought,
  anchorRef,
  placement,
  lockPlacement,
  onPlacementChange,
}: PetThoughtBubbleProps) {
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const actionRef = useRef<HTMLButtonElement | null>(null);
  const layoutPlacementRef = useRef<BubblePlacement>(placement);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const isError = thought?.status === "error";
  const previewText =
    thought?.status === "thinking" && !thought.previewText.trim()
      ? "Thinking..."
      : thought?.status === "error" && !thought.previewText.trim()
        ? "Response failed"
        : thought?.previewText.trim() ?? "";
  const [layout, setLayout] = useState<BubbleLayout>({
    placement,
    bubbleLeft: VIEWPORT_MARGIN,
    bubbleTop: VIEWPORT_MARGIN,
    tailX: 48,
    tailY: 28,
    actionLeft: VIEWPORT_MARGIN,
    actionTop: VIEWPORT_MARGIN,
    ready: false,
  });

  useLayoutEffect(() => {
    layoutPlacementRef.current = layout.placement;
  }, [layout.placement]);

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
      const currentPlacement = layoutPlacementRef.current;
      const resolvedPlacement = resolvePlacement(anchorRect, bubbleRect.width, bubbleRect.height, currentPlacement);
      const frameRect = getPlacementFrame(resolvedPlacement, anchorRect, bubbleRect.width, bubbleRect.height);
      const bubbleLeft = clamp(frameRect.left, VIEWPORT_MARGIN, viewportWidth - bubbleRect.width - VIEWPORT_MARGIN);
      const bubbleTop = clamp(frameRect.top, VIEWPORT_MARGIN, viewportHeight - bubbleRect.height - VIEWPORT_MARGIN);
      const anchorCenterX = anchorRect.left + anchorRect.width / 2;
      const anchorCenterY = anchorRect.top + anchorRect.height / 2;
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

      if (!lockPlacement && resolvedPlacement !== placement) {
        onPlacementChange(resolvedPlacement);
      }

      setLayout((current) => {
        if (
          current.ready &&
          current.placement === resolvedPlacement &&
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
          placement: resolvedPlacement,
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
  }, [anchorRef, isCollapsed, lockPlacement, onPlacementChange, placement, previewText, thought]);

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

  return (
    <>
      {!isCollapsed ? (
        <div
          ref={bubbleRef}
          className={`pet-thought-bubble pet-thought-bubble--${thought.status} pet-thought-bubble--${layout.placement} no-drag`}
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
}
