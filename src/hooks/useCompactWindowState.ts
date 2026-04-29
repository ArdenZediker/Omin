import { useCallback, useEffect, useState } from "react";

export type CompactAppearance = "default" | "compact" | "large" | "character";
export type CharacterModel = "hiyori";

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
  const saved = localStorage.getItem(COMPACT_APPEARANCE_STORAGE_KEY);
  return saved === "compact" || saved === "large" || saved === "character" ? saved : "default";
}

export function getInitialCharacterScale(): number {
  if (typeof window === "undefined") return 1;
  const saved = Number(localStorage.getItem(CHARACTER_SCALE_STORAGE_KEY) || "1");
  return Number.isFinite(saved) ? clampCharacterScale(saved) : 1;
}

export function getInitialCharacterModel(): CharacterModel {
  return "hiyori";
}

export function useCompactWindowState() {
  const [compactAppearance, setCompactAppearance] = useState<CompactAppearance>(getInitialCompactAppearance);
  const [characterScale, setCharacterScale] = useState<number>(getInitialCharacterScale);
  const [characterModel, setCharacterModel] = useState<CharacterModel>(getInitialCharacterModel);
  const [isCompactMenuOpen, setIsCompactMenuOpen] = useState(false);
  const [isCompactModelOpen, setIsCompactModelOpen] = useState(false);
  const [isCompactAppearanceOpen, setIsCompactAppearanceOpen] = useState(false);
  const [isCharacterModelOpen, setIsCharacterModelOpen] = useState(false);
  const [isCharacterMenuPinned, setIsCharacterMenuPinned] = useState(false);
  const [compactMenuSide, setCompactMenuSide] = useState<"left" | "right">("right");
  const [compactSubmenuSide, setCompactSubmenuSide] = useState<"left" | "right">("right");
  const [characterMenuPosition, setCharacterMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [characterPanelSide, setCharacterPanelSide] = useState<"left" | "right">("left");
  const [isCompactQueryOpen, setIsCompactQueryOpen] = useState(false);
  const [compactQuery, setCompactQuery] = useState("");
  const [compactReply, setCompactReply] = useState<{ question: string; answer: string } | null>(null);
  const [isCompactReplyLoading, setIsCompactReplyLoading] = useState(false);

  useEffect(() => {
    const onStorage = () => {
      setCompactAppearance(getInitialCompactAppearance());
      setCharacterScale(getInitialCharacterScale());
      setCharacterModel(getInitialCharacterModel());
    };

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    localStorage.setItem(COMPACT_APPEARANCE_STORAGE_KEY, compactAppearance);
  }, [compactAppearance]);

  useEffect(() => {
    localStorage.setItem(CHARACTER_SCALE_STORAGE_KEY, String(characterScale));
  }, [characterScale]);

  useEffect(() => {
    localStorage.setItem(CHARACTER_MODEL_STORAGE_KEY, characterModel);
  }, [characterModel]);

  const closeCompactMenuPanels = useCallback(() => {
    setIsCompactMenuOpen(false);
    setIsCompactModelOpen(false);
    setIsCompactAppearanceOpen(false);
    setIsCharacterModelOpen(false);
  }, []);

  const closeCompactMenus = useCallback(() => {
    setIsCharacterMenuPinned(false);
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
    characterModel,
    characterPanelSide,
    characterScale,
    clearCompactQuery,
    clearCompactReply,
    closeCompactMenuPanels,
    closeCompactMenus,
    compactAppearance,
    compactQuery,
    compactReply,
    isCharacterMenuPinned,
    isCharacterModelOpen,
    isCompactAppearanceOpen,
    isCompactMenuOpen,
    isCompactModelOpen,
    compactMenuSide,
    compactSubmenuSide,
    isCompactQueryOpen,
    isCompactReplyLoading,
    resetCompactFloatingUi,
    setCharacterMenuPosition,
    setCharacterModel,
    setCharacterPanelSide,
    setCharacterScale,
    setCompactAppearance,
    setCompactQuery,
    setCompactReply,
    setCompactMenuSide,
    setCompactSubmenuSide,
    setIsCharacterMenuPinned,
    setIsCharacterModelOpen,
    setIsCompactAppearanceOpen,
    setIsCompactMenuOpen,
    setIsCompactModelOpen,
    setIsCompactQueryOpen,
    setIsCompactReplyLoading,
  };
}
