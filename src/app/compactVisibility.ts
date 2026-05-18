import { readSqliteBackedValue, removeSqliteBackedValue, saveSqliteBackedValue } from "./sqliteStorage";

export const COMPACT_PET_HIDDEN_STORAGE_KEY = "omni_compact_pet_hidden";

export function isCompactPetHidden() {
  if (typeof window === "undefined") {
    return false;
  }

  return readSqliteBackedValue(COMPACT_PET_HIDDEN_STORAGE_KEY) === "1";
}

export function setCompactPetHidden(hidden: boolean) {
  if (typeof window === "undefined") {
    return;
  }

  if (hidden) {
    saveSqliteBackedValue(COMPACT_PET_HIDDEN_STORAGE_KEY, "1");
    return;
  }

  removeSqliteBackedValue(COMPACT_PET_HIDDEN_STORAGE_KEY);
}
