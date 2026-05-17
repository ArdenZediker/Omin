import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { readSqliteBackedValue, saveSqliteBackedValue } from "../app/sqliteStorage";

export type CompactAppearance = "default" | "compact" | "large" | "pet";
export type CharacterModel = never;

export const COMPACT_APPEARANCE_STORAGE_KEY = "omni_compact_appearance";
export const CHARACTER_SCALE_STORAGE_KEY = "omni_character_scale";
export const CHARACTER_MODEL_STORAGE_KEY = "omni_character_model";
export const CHARACTER_SCALE_BASELINE = 2;
const MIN_CHARACTER_SCALE = 0.45;
export const MAX_CHARACTER_SCALE = 4.2;

export function clampCharacterScale(value: number) {
  return Math.min(MAX_CHARACTER_SCALE, Math.max(MIN_CHARACTER_SCALE, Number(value.toFixed(2))));
}

export function getInitialCompactAppearance(): CompactAppearance {
  if (typeof window === "undefined") return "default";
  const saved = readSqliteBackedValue(COMPACT_APPEARANCE_STORAGE_KEY);
  return saved === "compact" || saved === "large" || saved === "pet" ? saved : "default";
}

export function getInitialCharacterScale(): number {
  if (typeof window === "undefined") return 1;
  const saved = Number(readSqliteBackedValue(CHARACTER_SCALE_STORAGE_KEY) || "1");
  return Number.isFinite(saved) ? clampCharacterScale(saved) : 1;
}

export function getInitialCharacterModel(): CharacterModel {
  return undefined as never;
}

export function useCompactWindowState() {
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

  useEffect(() => {
    const onStorage = () => {
      setCompactAppearance(getInitialCompactAppearance());
      setCharacterScale(getInitialCharacterScale());
    };

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
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
  };
}
