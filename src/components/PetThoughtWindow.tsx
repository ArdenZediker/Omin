import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { PET_THOUGHT_WINDOW_LABEL } from "../app/constants";
import type { PetThoughtState } from "../app/types";
import type { PetThoughtPlacement } from "../app/window";
import { getPetThoughtKey } from "../app/petThoughts";
import PetThoughtBubble from "./compact/PetThoughtBubble";

type PetThoughtWindowProps = {
  petSize: { width: number; height: number };
};

const BUBBLE_WIDTH = 250;
const STACK_PADDING_X = 12;
const PET_THOUGHT_SYNC_RETRY_LIMIT = 40;
const PET_THOUGHT_SYNC_RETRY_DELAY_MS = 250;

type PetThoughtSyncResponsePayload = {
  requestId?: string;
  queue?: PetThoughtState[] | null;
  currentThought?: PetThoughtState | null;
};

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
    let unlistenSyncResponse: (() => void) | undefined;
    let disposed = false;
    let syncRetryTimer: number | null = null;
    let syncRetryCount = 0;
    let hasReceivedInitialThought = false;

    const clearSyncRetryTimer = () => {
      if (syncRetryTimer !== null) {
        window.clearTimeout(syncRetryTimer);
        syncRetryTimer = null;
      }
    };

    const markInitialThoughtSynced = () => {
      if (hasReceivedInitialThought) {
        return;
      }
      hasReceivedInitialThought = true;
      clearSyncRetryTimer();
    };

    const applyThoughtQueue = (queue: PetThoughtState[]) => {
      setThoughts(queue);
    };

    const requestThoughtSnapshot = () => {
      if (disposed || hasReceivedInitialThought) {
        return;
      }
      syncRetryCount += 1;
      const requestId = `${PET_THOUGHT_WINDOW_LABEL}:${Date.now()}:${syncRetryCount}`;
      void emit("omni-pet-thought-sync-request", {
        requesterLabel: PET_THOUGHT_WINDOW_LABEL,
        requestId,
      }).catch(() => undefined);
      if (syncRetryCount === 1) {
        void emit("omni-pet-thought-request").catch(() => undefined);
      }
      if (syncRetryCount >= PET_THOUGHT_SYNC_RETRY_LIMIT) {
        return;
      }
      clearSyncRetryTimer();
      syncRetryTimer = window.setTimeout(() => {
        requestThoughtSnapshot();
      }, PET_THOUGHT_SYNC_RETRY_DELAY_MS);
    };

    void Promise.all([
      listen<PetThoughtState[]>("omni-pet-thought-queue-changed", (event) => {
        const queue = Array.isArray(event.payload) ? event.payload : [];
        if (queue.length > 0) {
          markInitialThoughtSynced();
        }
        applyThoughtQueue(queue);
      }),
      listen<PetThoughtSyncResponsePayload>("omni-pet-thought-sync-response", (event) => {
        const queue = Array.isArray(event.payload?.queue) ? event.payload?.queue : [];
        if (queue.length > 0 || event.payload?.currentThought) {
          markInitialThoughtSynced();
        }
        applyThoughtQueue(queue);
      }),
      listen<{
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
      }),
      listen<{ collapsed?: boolean }>("omni-pet-thought-collapse-changed", (event) => {
        setIsCollapsed(Boolean(event.payload?.collapsed));
      }),
    ]).then(([queueCleanup, syncResponseCleanup, placementCleanup, collapseCleanup]) => {
      if (disposed) {
        queueCleanup();
        syncResponseCleanup();
        placementCleanup();
        collapseCleanup();
        return;
      }
      unlistenQueue = queueCleanup;
      unlistenSyncResponse = syncResponseCleanup;
      unlistenPlacement = placementCleanup;
      unlistenCollapse = collapseCleanup;
      requestThoughtSnapshot();
    });

    return () => {
      disposed = true;
      clearSyncRetryTimer();
      unlistenQueue?.();
      unlistenSyncResponse?.();
      unlistenPlacement?.();
      unlistenCollapse?.();
    };
  }, []);

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
