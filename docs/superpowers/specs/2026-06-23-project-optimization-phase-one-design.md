# Project Optimization Phase One Design

## Goal

Improve Omni's near-term maintainability and frontend performance without changing product behavior.

The approved first phase focuses on three concrete areas:

- split the oversized `KnowledgeBaseView.tsx` into focused, testable UI units
- lazy-load heavy knowledge/document-preview code so the main chat path stays lighter
- add a minimal frontend test foundation for high-risk pure logic and extracted view helpers

This phase is intentionally conservative. It should reduce future development friction while preserving the current Tauri commands, database schema, knowledge pipeline behavior, and user-facing workflows.

## Current Problems

The project currently builds successfully, but several areas make continued iteration expensive:

- `src/components/KnowledgeBaseView.tsx` is about 3.8k lines and mixes collection navigation, document detail, asset inspection, task center behavior, import flows, rendering helpers, and local UI state.
- `pnpm build` emits a large chunk warning. The main application bundle is carrying knowledge/document-preview code that is not needed for the default chat-first path.
- The repo does not currently have an automated frontend test runner. Regressions in chat context composition, storage fallback behavior, and future extracted knowledge view helpers are only protected by build checks and manual use.
- The existing frontend has valuable logic embedded inside large components, making it difficult to test or reuse without rendering the whole screen.

## Scope

This phase covers:

- component extraction from `KnowledgeBaseView.tsx`
- small helper extraction where it directly supports the component split or tests
- lazy loading of knowledge-related screens or heavy document-preview dependencies
- Vitest-based frontend test setup
- a small initial test suite for stable, high-value logic
- build verification and bundle-size comparison

This phase does not cover:

- Rust module refactoring
- SQLite schema changes
- knowledge pipeline behavior changes
- new product features
- visual redesign beyond preserving the current UI while moving code
- model adapter rewrites
- Tauri capability changes
- full end-to-end test automation

## Design Direction

Use a behavior-preserving extraction rather than a redesign.

The optimization should make the code easier to reason about without forcing users to relearn the product. Existing CSS class names, copy, event flows, and component behavior should be preserved unless a tiny adjustment is required by the extraction.

The first implementation should favor clear file boundaries over clever abstractions. Repeated JSX that has distinct product meaning should become named components. Repeated formatting or selection logic should become plain helper functions only when it is reused or worth testing.

## Knowledge View Decomposition

### Target file layout

Create a focused knowledge component folder:

```text
src/components/knowledge/
|-- KnowledgeBaseView.tsx
|-- KnowledgeCollectionSidebar.tsx
|-- KnowledgeDocumentList.tsx
|-- KnowledgeDocumentDetail.tsx
|-- KnowledgeAssetInspector.tsx
|-- KnowledgeProcessingPanel.tsx
|-- knowledgeViewHelpers.ts
|-- knowledgeViewTypes.ts
```

The existing `src/components/KnowledgeBaseView.tsx` should remain as the public import path during this phase. It can become a thin re-export or wrapper so existing imports in `App.tsx` do not churn.

### Responsibilities

`KnowledgeBaseView.tsx` should own top-level data loading, Tauri command orchestration, and composition.

`KnowledgeCollectionSidebar.tsx` should own collection selection, collection actions, and collection summary presentation.

`KnowledgeDocumentList.tsx` should own document list rendering, filtering display, and document selection controls.

`KnowledgeDocumentDetail.tsx` should own the selected document detail shell, tabs, document action buttons, and shared detail header.

`KnowledgeAssetInspector.tsx` should own the embedded image asset tab, selected asset display, OCR/caption display, and asset empty states.

`KnowledgeProcessingPanel.tsx` should own task center, failed jobs, dead-letter display, and job action controls that are currently embedded in the main view.

`knowledgeViewHelpers.ts` should contain pure helpers such as preview-type labels, safe text clipping, file extension handling, and small presentation transforms that can be tested without React.

`knowledgeViewTypes.ts` should hold view-local prop and helper types only. Shared domain types should continue to live where they already live.

## Lazy Loading

### Knowledge screen boundary

The `knowledge` view should be loaded lazily from `App.tsx`. The chat view is the first screen for most sessions, so knowledge UI code should not need to join the initial render path.

Expected behavior:

- switching from chat to knowledge shows a small in-shell loading state if the chunk is still loading
- once loaded, the knowledge screen behaves exactly as before
- returning to chat should not reset active chat state

### Heavy preview dependencies

PDF and DOCX preview dependencies should be dynamically imported near the code path that actually needs them.

The phase should target these dependencies:

- `pdfjs-dist`
- `docx-preview`
- `mammoth`, if it is only needed for import or preview paths

Expected behavior:

- importing or previewing supported documents still works
- unsupported preview states remain unchanged
- loading failures produce the same style of user-facing error already used by the knowledge view

## Test Foundation

Add Vitest as the minimal frontend test runner.

Recommended files:

```text
vitest.config.ts
src/test/setup.ts
src/chat/engine.test.ts
src/app/sqliteStorage.test.ts
src/components/knowledge/knowledgeViewHelpers.test.ts
```

The first test suite should stay focused:

- helper tests for file type labels and text clipping extracted from the knowledge view
- storage fallback tests for browser/Tauri availability boundaries where mocking is straightforward
- chat engine tests for token/cost helpers only if those helpers are safely extracted without changing runtime behavior

Do not attempt broad component rendering tests in this phase. The current UI is large, Tauri-dependent, and not yet shaped for cheap DOM testing. Component tests can follow after the extraction stabilizes boundaries.

## Error Handling

The extraction must preserve existing error behavior:

- Tauri command failures should continue to show the same error surfaces
- document import and retry failures should not be swallowed
- lazy import failures should be converted into the same local error state pattern used by the knowledge view
- missing optional document preview dependencies should not crash the whole app shell

## Performance Targets

The optimization should be judged by observable build output rather than guesswork.

Before and after the implementation, record:

- `pnpm build` output
- size of the main app JS chunk
- whether Vite still reports chunk warnings

Success does not require eliminating every warning in this phase. A useful first target is that knowledge/document-preview code moves out of the initial application chunk and into separate lazy chunks.

## Testing And Verification

Required verification:

- `pnpm build`
- `cargo check` from `src-tauri`
- `pnpm test` after the test runner is added

Manual smoke checks:

- launch the app in development mode
- open chat view
- switch to knowledge view
- select a collection and document
- open document detail tabs
- inspect embedded image assets when available
- import or preview at least one supported document type if local sample files are available

## Migration Strategy

Implement in small behavior-preserving steps:

1. add test tooling with one tiny passing helper test
2. extract pure helpers from `KnowledgeBaseView.tsx`
3. extract `KnowledgeAssetInspector`
4. extract document detail shell
5. extract collection/sidebar/list pieces
6. extract processing panel
7. lazy-load the knowledge screen
8. lazy-load heavy preview dependencies
9. run build and compare chunk output

Each step should leave the app buildable.

## Acceptance Criteria

This phase is successful when:

- `src/components/KnowledgeBaseView.tsx` is reduced to a top-level composition role or compatibility wrapper
- knowledge UI responsibilities are split across focused files under `src/components/knowledge/`
- the chat-first application path no longer eagerly loads the full knowledge view implementation
- PDF/DOCX preview libraries are only loaded when their feature path needs them
- Vitest exists with a small but meaningful initial test suite
- `pnpm build`, `pnpm test`, and `cargo check` pass
- the user-visible knowledge workflows behave the same as before

## Future Phases

The following optimizations are intentionally deferred:

- splitting `src-tauri/src/lib.rs` into Rust command modules
- splitting `src-tauri/src/knowledge_pipeline.rs` into pipeline state, worker, embedding, and dead-letter modules
- versioned SQLite migrations
- Tauri capability tightening
- broad component rendering tests
- Playwright or Tauri end-to-end smoke tests
