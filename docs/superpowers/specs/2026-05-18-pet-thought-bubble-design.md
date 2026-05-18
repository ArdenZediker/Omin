# Pet Thought Bubble Design

**Goal:** While the main chat is streaming an answer, the compact pet window shows a floating bubble above the pet with the current conversation title and a live preview of the assistant response.

## Scope

- Applies only when the compact window is in `pet` appearance.
- Does not change the existing reply panel, the pet sprite atlas, or any chat session persistence rules.
- Does not affect the `default`, `compact`, or `large` compact appearances.
- Does not turn the pet bubble into a new chat surface. It is a transient status display only.

## User Experience

- The bubble is anchored above the pet head and visually centered on the pet.
- The top line shows the current conversation title.
- The second line shows a live preview of the assistant response as it streams.
- If no assistant text has arrived yet, the bubble should still show a lightweight thinking state instead of collapsing to empty space.
- The bubble should fade out shortly after generation ends or is aborted.
- The bubble should stay out of the way of the compact menu, compact query panel, and compact reply panel. When those overlays are open, the thought bubble should hide.

## Data Model

```ts
export type PetThoughtStatus = "thinking" | "complete" | "cleared" | "error";

export type PetThoughtState = {
  sessionId: string | null;
  sessionTitle: string;
  previewText: string;
  status: PetThoughtStatus;
  updatedAt: number;
};
```

Rules for the fields:

- `sessionId` identifies the active conversation that produced the stream.
- `sessionTitle` must use the same fallback order as the main chat header.
- `previewText` is the streamed assistant text, not a summary or paraphrase.
- `status` drives visibility and fade timing.
- `updatedAt` is used to ignore stale updates and to support late-mounted compact windows.

## Source Of Truth

- The main window owns the live thought state because `executeChatTurn` and its `onChunk` handler run there.
- The compact window only renders the latest state it receives.
- The thought bubble is ephemeral and must not be persisted to SQLite or localStorage as a long-lived setting.

### Title Resolution

The bubble title must match the current conversation title shown in the main chat UI.

Use the same fallback order currently used by `MainChatView`:

1. `activeSession?.title`
2. active assistant title
3. `"Omni"`

If that fallback order changes later, the bubble must follow it automatically rather than duplicating a second title rule.

## Event Bridge

Because the main window and compact window are separate Tauri windows, the state must be synchronized through events.

Use these events:

- `omni-pet-thought-changed`
- `omni-pet-thought-request`

Payload shape for `omni-pet-thought-changed`:

```ts
type PetThoughtEventPayload = PetThoughtState;
```

Synchronization rules:

- The main window emits `omni-pet-thought-changed` when a turn starts, when streamed text changes, when a turn completes, when a turn errors, and when the active turn is cleared.
- The compact window listens for `omni-pet-thought-changed` and stores the latest payload locally.
- When the compact window mounts, it emits `omni-pet-thought-request` so the main window can resend the current state immediately.
- If the compact window opens mid-generation, it must render the latest in-flight preview after the request/response handshake.
- If the compact window is hidden or destroyed, the main window continues to track the active state so it can be restored later.

## Component Boundaries

- `src/hooks/useChatRuntime.ts`
  - Owns the main-window thought lifecycle.
  - Starts the thought state when a chat turn begins.
  - Streams incremental preview text on `onChunk`.
  - Clears or completes the thought state at the end of the turn.

- `src/hooks/useCompactWindowState.ts`
  - Holds the compact-window copy of `petThought`.
  - Listens for the thought events.
  - Requests a fresh snapshot when the compact window mounts.

- `src/components/compact/CompactThoughtBubble.tsx`
  - Renders the title and preview text.
  - Handles truncation, line clamping, and the fade animation.

- `src/components/CompactWindow.tsx`
  - Places the bubble relative to the pet head.
  - Keeps it in the pet window overlay layer.
  - Ensures it does not interfere with drag, resize, or click hit testing.

- `src/App.tsx`
  - Passes the compact thought state into `CompactWindow`.

## Behavior Rules

- Update the preview at most once per animation frame or on a short throttle interval so token streaming does not cause unnecessary layout churn.
- Show the streamed assistant text exactly as generated so far, not a rewritten summary.
- Clamp the bubble to a narrow width so it reads like a speech bubble above the pet, not a full message panel.
- The title should fit on one line with ellipsis if needed.
- The preview should clamp to two lines with ellipsis if it exceeds the bubble width.
- On completion, keep the final preview visible briefly, then clear it.
- On abort or error, clear the bubble without exposing tool/debug text.
- If another chat turn starts before the old one finishes, replace the old thought state immediately.

## Non-Goals

- Do not make the bubble interactive.
- Do not replace `compactReply` with this feature.
- Do not persist the thought bubble across app restarts.
- Do not show the bubble in non-pet appearances.
- Do not change the pet sprite animation rows or atlas layout.

## Validation

The implementation is complete only if all of the following pass:

1. `pnpm exec tsc --noEmit`
2. `pnpm tauri dev`
3. In a long streaming answer, the pet bubble shows the current conversation title and the answer preview updates as tokens arrive.
4. If the compact window is reopened during the same generation, it receives the current thought state and shows the live preview again.
5. When generation finishes or is aborted, the bubble fades out and does not remain stuck on screen.

