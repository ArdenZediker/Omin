import { CircleAlert } from "lucide-react";
import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { PetThoughtState } from "../../app/types";
import type { PetThoughtPlacement } from "../../app/window";

type BubblePlacement = PetThoughtPlacement;

type PetThoughtBubbleProps = {
  thought: PetThoughtState | null;
  anchorRef: RefObject<HTMLElement | null>;
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

function getVisibleArea(left: number, top: number, width: number, height: number, viewportWidth: number, viewportHeight: number) {
  const visibleWidth = Math.max(
    0,
    Math.min(viewportWidth - VIEWPORT_MARGIN, left + width) - Math.max(VIEWPORT_MARGIN, left)
  );
  const visibleHeight = Math.max(
    0,
    Math.min(viewportHeight - VIEWPORT_MARGIN, top + height) - Math.max(VIEWPORT_MARGIN, top)
  );
  return visibleWidth * visibleHeight;
}

function resolvePlacement(anchorRect: DOMRect, bubbleWidth: number, bubbleHeight: number) {
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

  return pool.reduce((best, candidate) => (candidate.score > best.score ? candidate : best), pool[0]).placement;
}

export default function PetThoughtBubble({ thought, anchorRef, onPlacementChange }: PetThoughtBubbleProps) {
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const isError = thought?.status === "error";
  const previewText =
    thought?.status === "thinking" && !thought.previewText.trim()
      ? "\u6b63\u5728\u601d\u8003..."
      : thought?.status === "error" && !thought.previewText.trim()
        ? "\u56de\u7b54\u5931\u8d25"
        : thought?.previewText.trim() ?? "";
  const [layout, setLayout] = useState<BubbleLayout>({
    placement: "top",
    left: VIEWPORT_MARGIN,
    top: VIEWPORT_MARGIN,
    tailX: 48,
    tailY: 28,
    ready: false,
  });

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
      const preferredPlacement = resolvePlacement(anchorRect, bubbleRect.width, bubbleRect.height);
      const placements: BubblePlacement[] = [
        preferredPlacement,
        ...(["right", "left", "top", "bottom"] as BubblePlacement[]).filter((placement) => placement !== preferredPlacement),
      ];
      const candidates = placements.map((placement) => {
        const frameRect = getPlacementFrame(placement, anchorRect, bubbleRect.width, bubbleRect.height);
        return {
          placement,
          frameRect,
          fits:
            frameRect.left >= VIEWPORT_MARGIN &&
            frameRect.top >= VIEWPORT_MARGIN &&
            frameRect.left + bubbleRect.width <= viewportWidth - VIEWPORT_MARGIN &&
            frameRect.top + bubbleRect.height <= viewportHeight - VIEWPORT_MARGIN,
          visibleArea: getVisibleArea(
            frameRect.left,
            frameRect.top,
            bubbleRect.width,
            bubbleRect.height,
            viewportWidth,
            viewportHeight
          ),
        };
      });

      const fallback = candidates.reduce((best, candidate) => (candidate.visibleArea > best.visibleArea ? candidate : best), candidates[0]);
      const resolved = candidates.find((candidate) => candidate.fits) ?? fallback;
      const left = clamp(resolved.frameRect.left, VIEWPORT_MARGIN, viewportWidth - bubbleRect.width - VIEWPORT_MARGIN);
      const top = clamp(resolved.frameRect.top, VIEWPORT_MARGIN, viewportHeight - bubbleRect.height - VIEWPORT_MARGIN);
      const anchorCenterX = anchorRect.left + anchorRect.width / 2;
      const anchorCenterY = anchorRect.top + anchorRect.height / 2;
      const tailX = clamp(anchorCenterX - left, MIN_TAIL_HORIZONTAL_INSET, bubbleRect.width - MIN_TAIL_HORIZONTAL_INSET);
      const tailY = clamp(anchorCenterY - top, MIN_TAIL_VERTICAL_INSET, bubbleRect.height - MIN_TAIL_VERTICAL_INSET);
      onPlacementChange(resolved.placement);

      setLayout((current) => {
        if (
          current.ready &&
          current.placement === resolved.placement &&
          Math.abs(current.left - left) < 1 &&
          Math.abs(current.top - top) < 1 &&
          Math.abs(current.tailX - tailX) < 1 &&
          Math.abs(current.tailY - tailY) < 1
        ) {
          return current;
        }

        return {
          placement: resolved.placement,
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
  }, [anchorRef, onPlacementChange, previewText, thought]);

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
