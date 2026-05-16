# Codex Pet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an independent Codex pet module that is surfaced in the settings page's basic settings section, with pet selection, creation, refresh, and wake/sleep state management, while leaving the existing compact-window pet path intact.

**Architecture:** Introduce a small pet domain under `src/app/pets` for types, defaults, and persistence helpers. Render the new pet controls from a dedicated settings subcomponent that is mounted inside `BasicSettingsSection`, and persist pet state using separate storage keys so the module does not pollute `BasicSettings` or the legacy compact pet data.

**Tech Stack:** React, TypeScript, Tauri, existing sqlite-backed storage helpers, existing settings window layout.

---

### Task 1: Add the pet domain model and persistence helpers

**Files:**
- Create: `src/app/pets/codexPetTypes.ts`
- Create: `src/app/pets/codexPetStore.ts`
- Modify: `src/app/constants.ts`
- Modify: `src/app/settingsStore.ts`

- [ ] **Step 1: Define the pet types and defaults**

```ts
export type CodexPetDefinition = {
  id: string;
  name: string;
  description: string;
  source: "builtin" | "custom";
  preview?: string;
  tags?: string[];
};

export type CodexPetAction = "idle" | "awake" | "thinking" | "greeting" | "sleeping";

export type CodexPetRuntimeState = {
  activePetId: string | null;
  isAwake: boolean;
  currentAction: CodexPetAction;
  updatedAt: number;
};
```

- [ ] **Step 2: Add storage keys and a builtin catalog**

```ts
export const CODEX_PET_CATALOG_STORAGE_KEY = "omni_codex_pet_catalog";
export const CODEX_PET_STATE_STORAGE_KEY = "omni_codex_pet_state";
export const DEFAULT_CODEX_PET_STATE: CodexPetRuntimeState = {
  activePetId: "codex-default",
  isAwake: false,
  currentAction: "sleeping",
  updatedAt: Date.now(),
};
```

- [ ] **Step 3: Add load/save helpers**

```ts
export function loadCodexPetCatalog(defaults: CodexPetDefinition[]) {
  return readSqliteBackedJson(CODEX_PET_CATALOG_STORAGE_KEY, defaults);
}

export function saveCodexPetCatalog(catalog: CodexPetDefinition[]) {
  saveSqliteBackedValue(CODEX_PET_CATALOG_STORAGE_KEY, JSON.stringify(catalog));
}

export function loadCodexPetState(defaults: CodexPetRuntimeState) {
  return readSqliteBackedJson(CODEX_PET_STATE_STORAGE_KEY, defaults);
}

export function saveCodexPetState(state: CodexPetRuntimeState) {
  saveSqliteBackedValue(CODEX_PET_STATE_STORAGE_KEY, JSON.stringify(state));
}
```

- [ ] **Step 4: Verify the new helpers compile without touching legacy pet code**

Run: `pnpm exec tsc --noEmit`
Expected: no type errors from the new pet domain files.

### Task 2: Build the settings UI for the Codex pet module

**Files:**
- Create: `src/components/settings/CodexPetSection.tsx`
- Modify: `src/components/settings/BasicSettingsSection.tsx`

- [ ] **Step 1: Implement the pet section component**

```tsx
type Props = {
  catalog: CodexPetDefinition[];
  state: CodexPetRuntimeState;
  onSelectPet: (petId: string) => void;
  onCreatePet: () => void;
  onRefreshPets: () => void;
  onWakePet: () => void;
};
```

- [ ] **Step 2: Render a single-column list with a local scroll container**

```tsx
<div className="max-h-72 overflow-y-auto pr-1">
  {catalog.map((pet) => (
    <button key={pet.id} type="button" onClick={() => onSelectPet(pet.id)} className="...">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{pet.name}</span>
        {pet.id === state.activePetId ? <span className="text-xs">当前选中</span> : null}
      </div>
      <div className="mt-1 text-xs text-slate-500">{pet.description}</div>
    </button>
  ))}
</div>
```

- [ ] **Step 3: Add the three actions from the screenshot**

```tsx
<button type="button" onClick={onCreatePet}>创建自己的宠物</button>
<button type="button" onClick={onRefreshPets}>刷新</button>
<button type="button" onClick={onWakePet}>{state.isAwake ? "休眠宠物" : "唤醒宠物"}</button>
```

- [ ] **Step 4: Mount the section inside basic settings without changing the existing layout contract**

```tsx
<div className="space-y-4 border-t border-slate-100 pt-4">
  <CodexPetSection ... />
</div>
```

- [ ] **Step 5: Verify the settings page still fits in the existing scroll container**

Run: `pnpm tauri dev`
Expected: the new pet section appears inside basic settings and does not overlap the other sections.

### Task 3: Wire state changes into the settings window

**Files:**
- Modify: `src/components/SettingsPanel.tsx`
- Modify: `src/components/SettingsWindow.tsx`
- Modify: `src/app/settingsStore.ts`
- Modify: `src/app/constants.ts`

- [ ] **Step 1: Load the pet catalog and pet runtime state alongside other settings**

```ts
const [petCatalog, setPetCatalog] = useState(() => loadCodexPetCatalog(DEFAULT_CODEX_PET_CATALOG));
const [petState, setPetState] = useState(() => loadCodexPetState(DEFAULT_CODEX_PET_STATE));
```

- [ ] **Step 2: Persist state changes through the shared storage helper**

```ts
const updatePetState = (patch: Partial<CodexPetRuntimeState>) => {
  setPetState((current) => {
    const next = { ...current, ...patch, updatedAt: Date.now() };
    saveCodexPetState(next);
    return next;
  });
};
```

- [ ] **Step 3: Implement refresh and creation as local catalog updates**

```ts
const refreshPets = () => setPetCatalog(loadCodexPetCatalog(DEFAULT_CODEX_PET_CATALOG));
const createPet = () => {
  const nextPet = createBlankCodexPet(petCatalog.length + 1);
  const nextCatalog = [...petCatalog, nextPet];
  setPetCatalog(nextCatalog);
  saveCodexPetCatalog(nextCatalog);
  updatePetState({ activePetId: nextPet.id, currentAction: "awake", isAwake: true });
};
```

- [ ] **Step 4: Pass the new props into the settings basic section**

```tsx
<BasicSettingsSection
  ...
  codexPetCatalog={petCatalog}
  codexPetState={petState}
  onSelectCodexPet={...}
  onCreateCodexPet={createPet}
  onRefreshCodexPets={refreshPets}
  onWakeCodexPet={() => updatePetState({ isAwake: true, currentAction: "awake" })}
/>
```

- [ ] **Step 5: Verify settings bootstrap still includes the new keys**

Run: `pnpm exec tsc --noEmit`
Expected: the settings window compiles and restores pet state on startup.

### Task 4: Keep the legacy compact pet path untouched

**Files:**
- Modify: `src/hooks/useMainWindowController.ts`
- Modify: `src/app/window.ts`
- Modify: `src/hooks/useCompactWindowState.ts`

- [ ] **Step 1: Leave the existing `compactAppearance === "pet"` logic in place**

```ts
if (storedAppearance === "compact" || storedAppearance === "large" || storedAppearance === "character" || storedAppearance === "pet") {
  ...
}
```

- [ ] **Step 2: Only bootstrap the new pet storage keys where settings are loaded**

```ts
bootstrapSqliteStorage([
  ...existingKeys,
  CODEX_PET_CATALOG_STORAGE_KEY,
  CODEX_PET_STATE_STORAGE_KEY,
]);
```

- [ ] **Step 3: Verify no existing compact-window behavior changed**

Run: `pnpm tauri dev`
Expected: the old pet appearance, desktop pet animation, and compact menu behavior still work as before.

### Task 5: Validate the UI and data flow end to end

**Files:**
- No new code expected

- [ ] **Step 1: Run a type check**

Run: `pnpm exec tsc --noEmit`
Expected: pass.

- [ ] **Step 2: Launch the app and open settings**

Run: `pnpm tauri dev`
Expected: the new pet section shows inside basic settings and the page remains visually stable.

- [ ] **Step 3: Exercise the pet actions**

Expected:
- selecting a pet updates the active selection
- refresh restores the builtin catalog
- create adds a custom pet and selects it
- wake toggles the pet into an awake state without affecting chat or the compact window

