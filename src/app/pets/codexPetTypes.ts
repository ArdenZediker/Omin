export type CodexPetPackage = {
  id: string;
  displayName: string;
  description: string;
  spritesheetPath: string;
  spritesheetWebPath: string;
  packageDir: string;
  manifestPath: string;
  spritesheetExists: boolean;
  source: "builtin" | "custom" | "unknown";
};

export type CodexPetLibraryState = {
  activePetId: string | null;
  updatedAt: number;
};

export type CodexPetPackageResponse = {
  packages: CodexPetPackage[];
  activePetId: string | null;
  codexHome: string;
};

export const DEFAULT_CODEX_PET_LIBRARY_STATE: CodexPetLibraryState = {
  activePetId: null,
  updatedAt: Date.now(),
};
