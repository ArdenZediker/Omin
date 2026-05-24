import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import type { PetThoughtState } from "../app/types";
import type { PetThoughtPlacement } from "../app/window";
import { getPetThoughtKey } from "../app/petThoughts";
import PetThoughtBubble from "./compact/PetThoughtBubble";

type PetThoughtWindowProps = {
  petSize: { width: number; height: number };
};

const BUBBLE_WIDTH = 250;
const STACK_PADDING_X = 12;

function canUseTauriEvents() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export default function PetThoughtWindow({ petSize }: PetThoughtWindowProps) {
  const stackRef = useRef<HTMLDivElement | null>(null);
  const [thoughts, setThoughts] = useState<PetThoughtState[]>([]);
  const [placement, setPlacement] = useState<PetThoughtPlacement>("top");
  const [anchor, setAnchor] = useState({ x: 168, y: placement === "top" ? 352 : 8 });
  const [badgeAnchor, setBadgeAnchor] = useState({ x: 186, y: 42 });
  const [isCollapsed, setIsCollapsed] = useState(false);
  const stackLeft = STACK_PADDING_X;
  const tailX = Math.max(18, Math.min(BUBBLE_WIDTH - 18, anchor.x - stackLeft));
  const effectiveAnchorY = anchor.y;
  const visibleThoughts = useMemo(() => (placement === "top" ? [...thoughts].reverse() : thoughts), [placement, thoughts]);
  const windowStyle = useMemo(
    () =>
      ({
        "--pet-thought-action-x": `${Math.round(petSize.width * 0.22)}px`,
        "--pet-thought-action-top-y": `${Math.max(4, Math.round(petSize.height * 0.05))}px`,
        "--pet-thought-action-bottom-y": `${Math.max(4, Math.round(petSize.height * 0.05))}px`,
        "--pet-thought-anchor-x": `${anchor.x}px`,
        "--pet-thought-anchor-y": `${effectiveAnchorY}px`,
        "--pet-thought-badge-anchor-x": `${badgeAnchor.x}px`,
        "--pet-thought-badge-anchor-y": `${badgeAnchor.y}px`,
        "--pet-thought-stack-left": `${Math.round(stackLeft)}px`,
        "--pet-thought-tail-x": `${Math.round(tailX)}px`,
      }) as CSSProperties,
    [anchor.x, effectiveAnchorY, badgeAnchor.x, badgeAnchor.y, petSize.height, petSize.width, stackLeft, tailX]
  );

  useEffect(() => {
    if (!canUseTauriEvents()) {
      return;
    }

    let unlistenQueue: (() => void) | undefined;
    let unlistenPlacement: (() => void) | undefined;
    let unlistenCollapse: (() => void) | undefined;

    void listen<PetThoughtState[]>("omni-pet-thought-queue-changed", (event) => {
      setThoughts(Array.isArray(event.payload) ? event.payload : []);
    }).then((cleanup) => {
      unlistenQueue = cleanup;
      void emit("omni-pet-thought-request");
    });

    void listen<{
      placement?: PetThoughtPlacement;
      anchor?: { x?: number; y?: number };
      badgeAnchor?: { x?: number; y?: number };
    }>("omni-pet-thought-placement", (event) => {
      const nextPlacement = event.payload?.placement;
      if (nextPlacement === "top" || nextPlacement === "bottom" || nextPlacement === "left" || nextPlacement === "right") {
        setPlacement(nextPlacement);
      }
      const nextAnchor = event.payload?.anchor;
      if (Number.isFinite(nextAnchor?.x) && Number.isFinite(nextAnchor?.y)) {
        setAnchor({ x: Math.round(nextAnchor?.x as number), y: Math.round(nextAnchor?.y as number) });
      }
      const nextBadgeAnchor = event.payload?.badgeAnchor;
      if (Number.isFinite(nextBadgeAnchor?.x) && Number.isFinite(nextBadgeAnchor?.y)) {
        setBadgeAnchor({ x: Math.round(nextBadgeAnchor?.x as number), y: Math.round(nextBadgeAnchor?.y as number) });
      }
    }).then((cleanup) => {
      unlistenPlacement = cleanup;
    });
    void listen<{ collapsed?: boolean }>("omni-pet-thought-collapse-changed", (event) => {
      setIsCollapsed(Boolean(event.payload?.collapsed));
    }).then((cleanup) => {
      unlistenCollapse = cleanup;
    });

    return () => {
      unlistenQueue?.();
      unlistenPlacement?.();
      unlistenCollapse?.();
    };
  }, []);

  useEffect(() => {
    if (!canUseTauriEvents()) {
      return;
    }
    if (thoughts.length === 0) {
      return;
    }
    // When this window re-mounts (or events race), ask main window to re-broadcast
    // latest thought queue and placement so bubbles don't stay empty.
    void emit("omni-pet-thought-request");
  }, [thoughts.length]);

  useLayoutEffect(() => {
    const stack = stackRef.current;
    if (!stack || placement !== "top") {
      return;
    }

    stack.scrollTop = stack.scrollHeight;
  }, [placement, visibleThoughts.length]);

  return (
    <div className="pet-thought-window" style={windowStyle}>
      <div ref={stackRef} className={`pet-thought-window__stack pet-thought-window__stack--${placement}`}>
        {visibleThoughts.map((thought) => (
          <PetThoughtBubble
            key={getPetThoughtKey(thought)}
            thought={thought}
            placement={placement}
            usePortal={false}
            stacked
            collapsed={isCollapsed}
          />
        ))}
      </div>
    </div>
  );
}
