import { useCallback, useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { readSqliteBackedValue, saveSqliteBackedValue } from "../app/sqliteStorage";
import { CHARACTER_SCALE_STORAGE_KEY, clampCharacterScale, getStoredCharacterScale } from "../app/compactPetScale";
import type { PetThoughtState } from "../app/types";
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

    let unlisten: (() => void) | undefined;
    void listen<PetThoughtState>("omni-pet-thought-changed", (event) => {
      setPetThought(event.payload ?? null);
    }).then((cleanup) => {
      unlisten = cleanup;
      void emit("omni-pet-thought-request");
    });

    return () => {
      unlisten?.();
    };
  }, [isCompactWindow]);

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
  };
}
