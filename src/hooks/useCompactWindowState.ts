import { useCallback, useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { COMPACT_WINDOW_LABEL } from "../app/constants";
import { readSqliteBackedValue, saveSqliteBackedValue } from "../app/sqliteStorage";
import { CHARACTER_SCALE_STORAGE_KEY, clampCharacterScale, getStoredCharacterScale } from "../app/compactPetScale";
import type { PetThoughtState } from "../app/types";
import type { PetThoughtPlacement } from "../app/window";
export { CHARACTER_SCALE_STORAGE_KEY, clampCharacterScale } from "../app/compactPetScale";

export type CompactAppearance = "default" | "compact" | "large" | "pet";
export type CharacterModel = never;

export const COMPACT_APPEARANCE_STORAGE_KEY = "omni_compact_appearance";
export const CHARACTER_MODEL_STORAGE_KEY = "omni_character_model";

export function getInitialCompactAppearance(): CompactAppearance {
  if (typeof window === "undefined") return "default";
  const saved = readSqliteBackedValue(COMPACT_APPEARANCE_STORAGE_KEY);
  return saved === "compact" || saved === "large" || saved === "pet" ? saved : "default";
}

export function getInitialCharacterScale(): number {
  return getStoredCharacterScale();
}

export function getInitialCharacterModel(): CharacterModel {
  return undefined as never;
}

function canUseTauriEvents() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type UseCompactWindowStateArgs = {
  isCompactWindow: boolean;
};

const PET_THOUGHT_SYNC_RETRY_LIMIT = 3;
const PET_THOUGHT_SYNC_RETRY_DELAY_MS = 120;

type PetThoughtSyncResponsePayload = {
  requestId?: string;
  queue?: PetThoughtState[] | null;
  currentThought?: PetThoughtState | null;
};

export function useCompactWindowState({ isCompactWindow }: UseCompactWindowStateArgs) {
  const [compactAppearance, setCompactAppearance] = useState<CompactAppearance>(getInitialCompactAppearance);
  const [characterScale, setCharacterScale] = useState<number>(getInitialCharacterScale);
  const [isCompactMenuOpen, setIsCompactMenuOpen] = useState(false);
  const [isCompactModelOpen, setIsCompactModelOpen] = useState(false);
  const [isCompactAppearanceOpen, setIsCompactAppearanceOpen] = useState(false);
  const [compactMenuSide, setCompactMenuSide] = useState<"left" | "right">("right");
  const [compactSubmenuSide, setCompactSubmenuSide] = useState<"left" | "right">("right");
  const [characterMenuPosition, setCharacterMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [isCompactQueryOpen, setIsCompactQueryOpen] = useState(false);
  const [compactQuery, setCompactQuery] = useState("");
  const [compactReply, setCompactReply] = useState<{ question: string; answer: string } | null>(null);
  const [isCompactReplyLoading, setIsCompactReplyLoading] = useState(false);
  const [petThought, setPetThought] = useState<PetThoughtState | null>(null);
  const [petThoughtCount, setPetThoughtCount] = useState(0);
  const [petThoughtPlacement, setPetThoughtPlacement] = useState<PetThoughtPlacement>("top");
  const [arePetThoughtsCollapsed, setArePetThoughtsCollapsed] = useState(false);

  useEffect(() => {
    const onStorage = () => {
      setCompactAppearance(getInitialCompactAppearance());
      setCharacterScale(getInitialCharacterScale());
    };

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (!canUseTauriEvents()) {
      return;
    }

    let unlisten: (() => void) | undefined;
    void listen<{ appearance?: CompactAppearance; scale?: number }>("omni-compact-appearance-changed", (event) => {
      const appearance = event.payload?.appearance;
      const scale = event.payload?.scale;
      if (appearance) {
        setCompactAppearance(appearance);
      }
      if (typeof scale === "number" && Number.isFinite(scale)) {
        setCharacterScale(clampCharacterScale(scale));
      }
    }).then((cleanup) => {
      unlisten = cleanup;
    });

    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isCompactWindow || !canUseTauriEvents()) {
      return;
    }

    let unlistenThought: (() => void) | undefined;
    let unlistenThoughtQueue: (() => void) | undefined;
    let unlistenSyncResponse: (() => void) | undefined;
    let unlistenViewed: (() => void) | undefined;
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

    const applyThoughtQueue = (queue: PetThoughtState[], preferredThought?: PetThoughtState | null) => {
      setPetThoughtCount(queue.length);
      setPetThought((currentThought) => {
        const snapshotThought = preferredThought ?? queue[0] ?? null;
        if (!snapshotThought) {
          return queue.length === 0 ? null : currentThought;
        }
        if (currentThought && currentThought.updatedAt > snapshotThought.updatedAt) {
          return currentThought;
        }
        return snapshotThought;
      });
      if (queue.length === 0) {
        setArePetThoughtsCollapsed(false);
      }
    };

    const requestThoughtSnapshot = () => {
      if (disposed || hasReceivedInitialThought) {
        return;
      }
      syncRetryCount += 1;
      const requestId = `${COMPACT_WINDOW_LABEL}:${Date.now()}:${syncRetryCount}`;
      void emit("omni-pet-thought-sync-request", {
        requesterLabel: COMPACT_WINDOW_LABEL,
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
      listen<PetThoughtState | null>("omni-pet-thought-changed", (event) => {
        const nextThought = event.payload ?? null;
        if (nextThought) {
          markInitialThoughtSynced();
        }
        setPetThought((currentThought) => {
          if (!nextThought) {
            return null;
          }
          if (currentThought && currentThought.updatedAt > nextThought.updatedAt) {
            return currentThought;
          }
          return nextThought;
        });
      }),
      listen<PetThoughtState[]>("omni-pet-thought-queue-changed", (event) => {
        const queue = Array.isArray(event.payload) ? event.payload : [];
        if (queue.length > 0) {
          markInitialThoughtSynced();
        }
        applyThoughtQueue(queue);
      }),
      listen<PetThoughtSyncResponsePayload>("omni-pet-thought-sync-response", (event) => {
        const queue = Array.isArray(event.payload?.queue) ? event.payload?.queue : [];
        const snapshotThought = event.payload?.currentThought ?? queue[0] ?? null;
        if (queue.length > 0 || snapshotThought) {
          markInitialThoughtSynced();
        }
        applyThoughtQueue(queue, snapshotThought);
      }),
      listen("omni-pet-thought-viewed", () => {
        setPetThought(null);
        setPetThoughtCount(0);
        setPetThoughtPlacement("top");
        setArePetThoughtsCollapsed(false);
      }),
    ]).then(([thoughtCleanup, queueCleanup, syncResponseCleanup, viewedCleanup]) => {
      if (disposed) {
        thoughtCleanup();
        queueCleanup();
        syncResponseCleanup();
        viewedCleanup();
        return;
      }
      unlistenThought = thoughtCleanup;
      unlistenThoughtQueue = queueCleanup;
      unlistenSyncResponse = syncResponseCleanup;
      unlistenViewed = viewedCleanup;
      requestThoughtSnapshot();
    });

    return () => {
      disposed = true;
      clearSyncRetryTimer();
      unlistenThought?.();
      unlistenThoughtQueue?.();
      unlistenSyncResponse?.();
      unlistenViewed?.();
    };
  }, [isCompactWindow]);

  useEffect(() => {
    setPetThoughtPlacement("top");
  }, [petThought?.sessionId]);

  useEffect(() => {
    saveSqliteBackedValue(COMPACT_APPEARANCE_STORAGE_KEY, compactAppearance);
  }, [compactAppearance]);

  useEffect(() => {
    saveSqliteBackedValue(CHARACTER_SCALE_STORAGE_KEY, String(characterScale));
  }, [characterScale]);

  const closeCompactMenuPanels = useCallback(() => {
    setIsCompactMenuOpen(false);
    setIsCompactModelOpen(false);
    setIsCompactAppearanceOpen(false);
  }, []);

  const closeCompactMenus = useCallback(() => {
    closeCompactMenuPanels();
  }, [closeCompactMenuPanels]);

  const clearCompactReply = useCallback(() => {
    setCompactReply(null);
    setIsCompactReplyLoading(false);
  }, []);

  const clearCompactQuery = useCallback(() => {
    setIsCompactQueryOpen(false);
    setCompactQuery("");
  }, []);

  const resetCompactFloatingUi = useCallback(() => {
    closeCompactMenus();
    clearCompactQuery();
    clearCompactReply();
  }, [clearCompactQuery, clearCompactReply, closeCompactMenus]);

  return {
    characterMenuPosition,
    characterScale,
    clearCompactQuery,
    clearCompactReply,
    closeCompactMenuPanels,
    closeCompactMenus,
    compactAppearance,
    compactQuery,
    compactReply,
    petThought,
    petThoughtCount,
    petThoughtPlacement,
    arePetThoughtsCollapsed,
    isCompactAppearanceOpen,
    isCompactMenuOpen,
    isCompactModelOpen,
    compactMenuSide,
    compactSubmenuSide,
    isCompactQueryOpen,
    isCompactReplyLoading,
    resetCompactFloatingUi,
    setCharacterMenuPosition,
    setCharacterScale,
    setCompactAppearance,
    setCompactQuery,
    setCompactReply,
    setCompactMenuSide,
    setCompactSubmenuSide,
    setIsCompactAppearanceOpen,
    setIsCompactMenuOpen,
    setIsCompactModelOpen,
    setIsCompactQueryOpen,
    setIsCompactReplyLoading,
    setPetThought,
    setPetThoughtPlacement,
    setArePetThoughtsCollapsed,
  };
}
