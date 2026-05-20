import { CHARACTER_SCALE_BASELINE } from "./constants";
import { readSqliteBackedValue } from "./sqliteStorage";

export const CHARACTER_SCALE_STORAGE_KEY = "omni_character_scale";
export const DEFAULT_CHARACTER_SCALE = 1;
const MIN_CHARACTER_SCALE = 0.8;
const MAX_CHARACTER_SCALE = 2.2;

export function clampCharacterScale(value: number) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    return DEFAULT_CHARACTER_SCALE;
  }

  const rounded = Number(normalized.toFixed(2));
  return Math.min(MAX_CHARACTER_SCALE, Math.max(MIN_CHARACTER_SCALE, rounded));
}

export function getStoredCharacterScale() {
  if (typeof window === "undefined") {
    return DEFAULT_CHARACTER_SCALE;
  }

  const saved = Number(readSqliteBackedValue(CHARACTER_SCALE_STORAGE_KEY) ?? "1");
  return Number.isFinite(saved) ? clampCharacterScale(saved) : DEFAULT_CHARACTER_SCALE;
}

export function getPetWindowScale() {
  return getStoredCharacterScale() * CHARACTER_SCALE_BASELINE;
}
