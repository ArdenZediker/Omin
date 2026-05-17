# Codex Pet Size Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the desktop pet, compact pet button, and settings preview all use the same Codex-style cell size and aspect-ratio fitting so the pet renders consistently everywhere.

**Architecture:** Add one shared sizing module under `src/app/pets` that owns the Codex pet cell dimensions and the math for fitting the sprite sheet into a target box. `DesktopPet` becomes a pure renderer that only consumes the shared sizing output. `App.tsx`, `CompactWindow.tsx`, and `CodexPetSection.tsx` all stop hardcoding pet dimensions and instead derive their bounds from the same helper.

**Tech Stack:** React, TypeScript, existing Tauri app shell, existing pet manifest and settings components.

---

### Task 1: Add the shared Codex pet sizing helper

**Files:**
- Create: `src/app/pets/codexPetSizing.ts`
- Modify: `src/config/pets/omniSchnauzer.ts`

- [ ] **Step 1: Define the canonical Codex pet cell size and fit helper**

```ts
export const CODEX_PET_CELL_SIZE = {
  width: 192,
  height: 208,
} as const;

export const CODEX_PET_MIN_VIEWPORT_HEIGHT = 48;
export const CODEX_PET_COMPACT_MARGIN = 18;

export function getCodexPetViewportHeight(compactWidth: number) {
  return Math.max(CODEX_PET_MIN_VIEWPORT_HEIGHT, compactWidth - CODEX_PET_COMPACT_MARGIN);
}

export function fitCodexPetToBounds(bounds: { width: number; height: number }) {
  const scale = Math.min(bounds.width / CODEX_PET_CELL_SIZE.width, bounds.height / CODEX_PET_CELL_SIZE.height);
  return {
    width: Math.round(CODEX_PET_CELL_SIZE.width * scale),
    height: Math.round(CODEX_PET_CELL_SIZE.height * scale),
    scale,
  };
}
```

- [ ] **Step 2: Make the manifest share the same base cell dimensions**

```ts
import { CODEX_PET_CELL_SIZE } from "../../app/pets/codexPetSizing";

export const OMNI_SCHNAUZER_PET: DesktopPetManifest = {
  ...
  cellWidth: CODEX_PET_CELL_SIZE.width,
  cellHeight: CODEX_PET_CELL_SIZE.height,
  ...
};
```

- [ ] **Step 3: Verify the helper compiles on its own**

Run: `.\node_modules\.bin\tsc.CMD --noEmit`
Expected: no errors from the new helper or the updated manifest import.

### Task 2: Switch the renderer and compact shell to the shared sizing math

**Files:**
- Modify: `src/components/DesktopPet.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/CompactWindow.tsx`

- [ ] **Step 1: Replace the hardcoded sprite-sheet constants in `DesktopPet`**

```ts
import { CODEX_PET_CELL_SIZE, fitCodexPetToBounds } from "../app/pets/codexPetSizing";

const { width: cellWidth, height: cellHeight } = CODEX_PET_CELL_SIZE;
const { width: viewportWidth, height: viewportHeight, scale } = fitCodexPetToBounds({ width, height });
const scaledAtlasWidth = Math.round(cellWidth * atlasColumns * scale);
const scaledAtlasHeight = Math.round(cellHeight * atlasRows * scale);
```

- [ ] **Step 2: Derive the compact pet viewport height from the shared helper in `App.tsx`**

```ts
import { getCodexPetViewportHeight } from "./app/pets/codexPetSizing";

const compactPetViewportHeight = getCodexPetViewportHeight(compactSize.width);

const compactStyle = useMemo<CSSProperties>(() => ({
  ...
  "--compact-character-size": `${compactPetViewportHeight}px`,
  ...
}), [compactPetViewportHeight, compactSize.width, compactSize.height, isAnimatedCompactAppearance]);
```

- [ ] **Step 3: Use the same viewport height in `CompactWindow` when rendering the pet**

```ts
import { CODEX_PET_CELL_SIZE, getCodexPetViewportHeight } from "../app/pets/codexPetSizing";

const petViewportHeight = getCodexPetViewportHeight(compactSize.width);
const petViewportWidth = Math.round((petViewportHeight * CODEX_PET_CELL_SIZE.width) / CODEX_PET_CELL_SIZE.height);

<DesktopPet
  width={petViewportWidth}
  height={petViewportHeight}
  state={petState}
  packageData={codexPetPackage}
/>
```

- [ ] **Step 4: Verify the compact shell still expands and collapses as before**

Run: `pnpm tauri dev`
Expected: the compact pet keeps the same placement behavior, but its size now comes from the shared Codex sizing helper.

### Task 3: Update the settings preview to use the same size rules

**Files:**
- Modify: `src/components/settings/CodexPetSection.tsx`

- [ ] **Step 1: Replace the fixed `34 x 40` preview box with the shared Codex size helper**

```ts
import { CODEX_PET_CELL_SIZE, fitCodexPetToBounds } from "../../app/pets/codexPetSizing";

const previewBounds = fitCodexPetToBounds({ width: 40, height: 40 });

<DesktopPet width={previewBounds.width} height={previewBounds.height} state="idle" packageData={pet} />
```

- [ ] **Step 2: Keep the surrounding card layout unchanged**

```tsx
<div className="flex h-[54px] w-[54px] shrink-0 items-end justify-center overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
  <DesktopPet ... />
</div>
```

- [ ] **Step 3: Verify the settings preview looks like a small live pet rather than a stretched thumbnail**

Run: `pnpm tauri dev`
Expected: the settings page preview matches the same pet proportions used in the compact window.

### Task 4: Validate the unified sizing behavior end to end

**Files:**
- No new code expected

- [ ] **Step 1: Run a type check**

Run: `.\node_modules\.bin\tsc.CMD --noEmit`
Expected: pass.

- [ ] **Step 2: Launch the app and inspect both surfaces**

Run: `pnpm tauri dev`
Expected:
- compact mode pet uses the shared Codex sizing math
- settings basic section preview uses the same aspect ratio
- no hardcoded pet size remains in the renderer path

