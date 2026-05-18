import { CHARACTER_SCALE_BASELINE } from "./constants";

export const CHARACTER_SCALE_STORAGE_KEY = "omni_character_scale";
export const DEFAULT_CHARACTER_SCALE = 1;

export function clampCharacterScale(value: number) {
  void value;
  return DEFAULT_CHARACTER_SCALE;
}

export function getStoredCharacterScale() {
  return DEFAULT_CHARACTER_SCALE;
}

export function getPetWindowScale() {
  return CHARACTER_SCALE_BASELINE;
}
