# Pet Thought Bubble Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a floating thought bubble above the compact pet while a chat turn is streaming, with the current conversation title on the first line and a live preview of the assistant response on the second line.

**Architecture:** Keep the chat runtime as the source of truth for the in-flight thought state, then mirror that state into the compact window through Tauri events so the pet window can render it independently. Add a dedicated pet-thought component and pet-thought styles instead of extending the existing reply panel, because the bubble is transient status UI rather than a reply surface. Reuse the existing session title helper so the bubble stays aligned with the main chat header logic.

**Tech Stack:** React, TypeScript, Tauri events, existing chat runtime, existing compact-window rendering, existing CSS in `src/App.css`.

---

### Task 1: Add a dedicated pet-thought state bridge

**Files:**
- Modify: `src/app/types.ts`
- Modify: `src/hooks/useCompactWindowState.ts`
- Modify: `src/hooks/useChatRuntime.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: Define the pet-thought state shape and event payload**

```ts
export type PetThoughtState = {
  sessionId: string | null;
  sessionTitle: string;
  previewText: string;
  status: "thinking" | "complete" | "cleared" | "error";
  updatedAt: number;
};
```

- [ ] **Step 2: Add compact-window state for the pet thought bubble**

```ts
const [petThought, setPetThought] = useState<PetThoughtState | null>(null);
```

- [ ] **Step 3: Listen for thought updates and snapshot requests in the compact window**

```ts
void listen<PetThoughtState>("omni-pet-thought-changed", (event) => {
  setPetThought(event.payload);
});

void listen("omni-pet-thought-request", async () => {
  await emit("omni-pet-thought-requested");
});
```

- [ ] **Step 4: Expose the new thought state through the compact-window hook return value**

```ts
return {
  ...
  petThought,
  setPetThought,
};
```

- [ ] **Step 5: Thread the compact pet-thought state through `App.tsx` into `CompactWindow`**

```tsx
<CompactWindow
  ...
  petThought={petThought}
/>
```

- [ ] **Step 6: Confirm the new types compile before touching the renderer**

Run: `pnpm exec tsc --noEmit`
Expected: pass without type errors from the new pet-thought types or event wiring.

### Task 2: Drive the live thought state from chat streaming

**Files:**
- Modify: `src/hooks/useChatRuntime.ts`
- Modify: `src/chat/engine.ts`
- Modify: `src/chat/storage.ts`

- [ ] **Step 1: Reuse the existing session title helper instead of inventing a second title rule**

```ts
import { getChatSessionTitle } from "../chat/storage";
```

- [ ] **Step 2: Add a tiny thought-state helper inside the chat runtime**

```ts
const emitPetThought = async (state: PetThoughtState | null) => {
  await emit("omni-pet-thought-changed", state);
};
```

- [ ] **Step 3: Populate the thought state when a turn starts**

```ts
await emitPetThought({
  sessionId,
  sessionTitle: activeSession?.title ?? activeAssistant?.title ?? "Omni",
  previewText: "",
  status: "thinking",
  updatedAt: Date.now(),
});
```

- [ ] **Step 4: Update the preview on every streamed chunk**

```ts
onChunk: (chunk) => {
  ...
  previewText += chunk;
  void emitPetThought({
    sessionId,
    sessionTitle,
    previewText,
    status: "thinking",
    updatedAt: Date.now(),
  });
}
```

- [ ] **Step 5: Mark the thought as complete, error, or cleared at the end of the turn**

```ts
await emitPetThought({
  sessionId,
  sessionTitle,
  previewText: finalPreview,
  status: "complete",
  updatedAt: Date.now(),
});
```

- [ ] **Step 6: Clear the thought state on abort or when a new turn replaces the old one**

```ts
await emitPetThought({
  sessionId: null,
  sessionTitle: "",
  previewText: "",
  status: "cleared",
  updatedAt: Date.now(),
});
```

- [ ] **Step 7: Verify streaming still works after adding the event emits**

Run: `pnpm exec tsc --noEmit`
Expected: pass with no regression in the main chat runtime.

### Task 3: Render the pet-thought bubble above the pet

**Files:**
- Create: `src/components/compact/PetThoughtBubble.tsx`
- Modify: `src/components/CompactWindow.tsx`
- Modify: `src/components/DesktopPet.tsx` only if the bubble needs a tighter anchor helper

- [ ] **Step 1: Create a dedicated bubble component**

```tsx
type PetThoughtBubbleProps = {
  thought: PetThoughtState | null;
};

export default function PetThoughtBubble({ thought }: PetThoughtBubbleProps) {
  if (!thought || thought.status === "cleared") {
    return null;
  }

  return (
    <div className="pet-thought-bubble animate-fade-in no-drag">
      <div className="pet-thought-bubble__title">{thought.sessionTitle}</div>
      <div className="pet-thought-bubble__preview">
        {thought.status === "thinking" && !thought.previewText ? "正在思考..." : thought.previewText}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Mount the bubble in the pet window overlay layer**

```tsx
{isPetAppearance ? <PetThoughtBubble thought={petThought} /> : null}
```

- [ ] **Step 3: Keep the bubble hidden whenever a floating compact overlay is open**

```tsx
const hasFloatingOverlay = Boolean(isCompactMenuOpen || isCompactQueryOpen || isCompactReplyLoading || compactReply);
```

- [ ] **Step 4: Keep click, drag, and resize hit testing unchanged**

```tsx
onMouseDown={(event) => {
  if (event.target.closest(".pet-thought-bubble")) {
    event.stopPropagation();
    return;
  }
}}
```

- [ ] **Step 5: Verify the pet still reacts to primary click and drag exactly as before**

Run: `pnpm tauri dev`
Expected: the bubble appears above the pet during streaming and does not block pet interaction.

### Task 4: Add the bubble styling and motion

**Files:**
- Modify: `src/App.css`

- [ ] **Step 1: Add a compact bubble style near the existing compact reply styles**

```css
.pet-thought-bubble {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 12px);
  transform: translateX(-50%);
  min-width: 180px;
  max-width: min(320px, calc(100vw - 36px));
  padding: 10px 12px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.95);
  border: 1px solid rgba(209, 213, 219, 0.8);
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.12);
  z-index: 34;
}
```

- [ ] **Step 2: Make the title line clamp and the preview line stay readable**

```css
.pet-thought-bubble__title {
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pet-thought-bubble__preview {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
```

- [ ] **Step 3: Add a brief fade-out transition for the complete state**

```css
.pet-thought-bubble--complete {
  animation: fadeIn 180ms ease-out, fadeOut 240ms ease-in 900ms forwards;
}
```

- [ ] **Step 4: Add theme overrides so the bubble matches light and dark surfaces**

```css
:root[data-omni-theme="dark"] .pet-thought-bubble {
  background: rgba(17, 17, 17, 0.95);
  border-color: rgba(255, 255, 255, 0.12);
}
```

- [ ] **Step 5: Verify the bubble reads cleanly on both themes**

Run: `pnpm tauri dev`
Expected: the pet bubble looks like a compact speech bubble and stays visually separate from the reply panel.

### Task 5: Validate the full interaction flow

**Files:**
- No new code expected

- [ ] **Step 1: Run a full type check**

Run: `pnpm exec tsc --noEmit`
Expected: pass.

- [ ] **Step 2: Launch the app and stream a long answer**

Run: `pnpm tauri dev`
Expected:
- the bubble shows the current conversation title
- the preview text updates as the assistant streams
- the bubble disappears after completion or abort

- [ ] **Step 3: Reopen the compact window while a turn is in flight**

Expected:
- the compact window receives the current thought snapshot
- the bubble resumes with the latest preview text

- [ ] **Step 4: Confirm no existing compact reply behavior regressed**

Expected:
- the existing compact reply panel still works
- the pet click / drag / resize behavior is unchanged
- non-pet compact appearances are unaffected

