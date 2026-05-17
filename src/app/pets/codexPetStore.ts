import { invoke } from "@tauri-apps/api/core";
import { loadAppKvEntries, saveSqliteBackedValue } from "../sqliteStorage";
import { CODEX_PET_LIBRARY_STATE_STORAGE_KEY } from "../constants";
import type { CodexPetLibraryState, CodexPetPackageResponse } from "./codexPetTypes";

type CodexPetLibraryStorage = {
  activePetId: string | null;
  updatedAt?: number;
};

function canUseTauriInvoke() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function loadCodexPetPackages(): Promise<CodexPetPackageResponse> {
  if (!canUseTauriInvoke()) {
    return {
      packages: [],
      activePetId: null,
      codexHome: "",
    };
  }

  return invoke<CodexPetPackageResponse>("load_codex_pet_packages");
}

export async function loadCodexPetLibraryState(defaults: CodexPetLibraryState): Promise<CodexPetLibraryState> {
  const entries = await loadAppKvEntries([CODEX_PET_LIBRARY_STATE_STORAGE_KEY]);
  const raw = entries[CODEX_PET_LIBRARY_STATE_STORAGE_KEY];

  if (!raw) {
    return defaults;
  }

  try {
    const parsed = JSON.parse(raw) as CodexPetLibraryStorage;
    return {
      activePetId: parsed.activePetId ?? defaults.activePetId,
      updatedAt: parsed.updatedAt ?? defaults.updatedAt,
    };
  } catch {
    return defaults;
  }
}

export async function saveCodexPetLibraryState(state: CodexPetLibraryState) {
  saveSqliteBackedValue(CODEX_PET_LIBRARY_STATE_STORAGE_KEY, JSON.stringify(state));
}

export async function createCodexPetPackage() {
  if (!canUseTauriInvoke()) {
    throw new Error("Codex pet creation is unavailable outside Tauri");
  }

  return invoke<import("./codexPetTypes").CodexPetPackage>("create_codex_pet_package");
}
