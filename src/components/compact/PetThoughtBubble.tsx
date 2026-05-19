import { CircleAlert } from "lucide-react";
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
  left: number;
  top: number;
  tailX: number;
  tailY: number;
  ready: boolean;
};

const VIEWPORT_MARGIN = 12;
const BUBBLE_GAP = 12;
const MIN_TAIL_HORIZONTAL_INSET = 24;
const MIN_TAIL_VERTICAL_INSET = 18;
const REPOSITION_POLL_MS = 180;
const HORIZONTAL_PLACEMENT_BONUS = 20;
const PLACEMENT_SWITCH_SCORE_GAP = 36;

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
  const layoutPlacementRef = useRef<BubblePlacement>(placement);
  const isError = thought?.status === "error";
  const previewText =
    thought?.status === "thinking" && !thought.previewText.trim()
      ? "\u6b63\u5728\u601d\u8003..."
      : thought?.status === "error" && !thought.previewText.trim()
        ? "\u56de\u7b54\u5931\u8d25"
        : thought?.previewText.trim() ?? "";
  const [layout, setLayout] = useState<BubbleLayout>({
    placement,
    left: VIEWPORT_MARGIN,
    top: VIEWPORT_MARGIN,
    tailX: 48,
    tailY: 28,
    ready: false,
  });

  useLayoutEffect(() => {
    layoutPlacementRef.current = layout.placement;
  }, [layout.placement]);

  useLayoutEffect(() => {
    if (!thought) {
      return;
    }

    const bubble = bubbleRef.current;
    const anchor = anchorRef.current;
    if (!bubble || !anchor) {
      return;
    }

    let frame = 0;

    const reposition = () => {
      const anchorRect = anchor.getBoundingClientRect();
      const bubbleRect = bubble.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const currentPlacement = lockPlacement ? placement : layoutPlacementRef.current;
      const resolvedPlacement = lockPlacement
        ? placement
        : resolvePlacement(anchorRect, bubbleRect.width, bubbleRect.height, currentPlacement);
      const frameRect = getPlacementFrame(resolvedPlacement, anchorRect, bubbleRect.width, bubbleRect.height);
      const left = clamp(frameRect.left, VIEWPORT_MARGIN, viewportWidth - bubbleRect.width - VIEWPORT_MARGIN);
      const top = clamp(frameRect.top, VIEWPORT_MARGIN, viewportHeight - bubbleRect.height - VIEWPORT_MARGIN);
      const anchorCenterX = anchorRect.left + anchorRect.width / 2;
      const anchorCenterY = anchorRect.top + anchorRect.height / 2;
      const tailX = clamp(anchorCenterX - left, MIN_TAIL_HORIZONTAL_INSET, bubbleRect.width - MIN_TAIL_HORIZONTAL_INSET);
      const tailY = clamp(anchorCenterY - top, MIN_TAIL_VERTICAL_INSET, bubbleRect.height - MIN_TAIL_VERTICAL_INSET);
      if (!lockPlacement && resolvedPlacement !== placement) {
        onPlacementChange(resolvedPlacement);
      }

      setLayout((current) => {
        if (
          current.ready &&
          current.placement === resolvedPlacement &&
          Math.abs(current.left - left) < 1 &&
          Math.abs(current.top - top) < 1 &&
          Math.abs(current.tailX - tailX) < 1 &&
          Math.abs(current.tailY - tailY) < 1
        ) {
          return current;
        }

        return {
          placement: resolvedPlacement,
          left,
          top,
          tailX,
          tailY,
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
    observer?.observe(bubble);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleReposition);
      window.clearInterval(pollTimer);
      observer?.disconnect();
    };
  }, [anchorRef, lockPlacement, onPlacementChange, placement, previewText, thought]);

  if (!thought) {
    return null;
  }

  const bubbleStyle = {
    left: `${layout.left}px`,
    top: `${layout.top}px`,
    visibility: layout.ready ? "visible" : "hidden",
    "--pet-thought-tail-x": `${layout.tailX}px`,
    "--pet-thought-tail-y": `${layout.tailY}px`,
  } as CSSProperties;

  return (
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
        <CircleAlert className="pet-thought-bubble__badge" size={16} strokeWidth={2.2} aria-hidden="true" focusable="false" />
      ) : null}
    </div>
  );
}
