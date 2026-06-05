# Knowledge Assets Layout Refresh Design

## Goal

Refresh the document-detail `Assets` page in Omni so the layout feels like a focused product workspace instead of a debugging surface.

The approved direction is the `A` option from brainstorming:

- a calm, fixed-width asset navigation rail on the left
- a larger, more readable inspection workspace on the right
- a clear top action bar that keeps the current text-labeled detail tabs
- stronger reading comfort for long OCR and caption content

This design is intentionally visual and structural only. It does not change any data contracts, extraction logic, Tauri commands, or asset-processing behavior.

## Desired Outcome

When a user opens the `图片资产` tab in document detail:

- the current image is immediately obvious
- the selected image preview becomes the visual focal point
- OCR and caption content are easy to scan and read
- the left asset list feels lightweight and navigational, not like a second content pane
- the page remains usable on narrower desktop widths without collapsing into cramped text blocks

## Current Problems

The current implementation in [KnowledgeBaseView.tsx](/D:/AI-Coding/omni/src/components/KnowledgeBaseView.tsx) and [App.css](/D:/AI-Coding/omni/src/App.css) has several issues:

- the left asset cards are visually heavy and compete with the main preview area
- the right side feels like a white container holding several unrelated blocks rather than one coherent reading surface
- OCR and caption are placed as large bottom boxes with weak information hierarchy
- the top detail navigation and action controls feel fragmented because multiple button groups compete for attention
- placeholder copy is mixed between English and Chinese, which makes the UI feel unfinished
- responsive behavior reduces width, but does not yet produce a layout that feels intentionally adapted

## Scope

This design covers:

- the document detail header control styling related to the `Assets` page context
- the internal layout of the `Assets` view
- card structure, spacing, hierarchy, and empty-state copy for asset browsing
- responsive behavior for medium and narrow widths

This design does not cover:

- backend or pipeline changes
- thumbnail generation changes
- asset filtering, search, pagination, or sorting
- new metadata fields
- changes to other detail tabs beyond maintaining visual consistency with the shared header controls

## Product Decision

Use a `workbench` layout instead of a `gallery + inspector` layout.

We considered two directions during brainstorming:

- `A: workbench`
- `B: gallery + inspector`

The approved direction is `A` because the current product behavior is centered on selecting one asset and then reading its preview, OCR, and summary in detail. The `gallery + inspector` direction would help with rapid scanning across many assets, but it would make the current long-text reading experience tighter and more panel-like.

## Layout Design

### Overall structure

The `Assets` page should render as a two-column workspace on desktop:

- left rail: asset navigation
- right panel: selected asset workspace

Recommended desktop proportions:

- left rail around `280px` to `320px`
- right panel takes the remaining width

The page should feel like one composed screen, not a collection of equally weighted boxes.

### Left rail

The left rail should act as lightweight navigation only.

Each asset item should show:

- thumbnail
- source name
- one short preview line

It should not try to expose full OCR or long summaries.

Visual behavior:

- compact stacked cards
- clear selected state
- quieter non-selected cards
- consistent thumbnail dimensions
- reduced padding compared to the current implementation

The left rail should keep scrolling independent from the right panel when asset counts are high.

### Right workspace

The right side should be reordered into one reading path:

1. selected asset preview header
2. large preview surface
3. asset metadata strip
4. OCR and caption reading cards

This sequence should make the main preview dominant and let users move from image to context to interpretation naturally.

### Preview surface

The preview area should feel like a centered canvas rather than a generic bordered rectangle.

Visual rules:

- larger minimum height than today
- soft background treatment to distinguish the preview stage from text cards
- centered image placement
- preserve image aspect ratio with `object-contain`
- provide a calm empty preview state if no thumbnail is available

### Metadata strip

Move small identifying details into a compact strip directly below the preview.

This strip should contain:

- filename
- asset index
- page index when available
- derived status-style indicators only if already available from current data

This prevents small labels from interrupting the main text-reading blocks.

### OCR and caption cards

OCR and caption should remain separate, but they should become reading cards rather than utility boxes.

Each card should have:

- a small label header
- stronger line-height
- more breathing room
- softer card surface than the main page background
- natural Chinese empty-state copy

Recommended content rules:

- `暂无 OCR 文本`
- `暂无图片描述`

Keep them side-by-side on larger widths and stack them vertically when width becomes constrained.

## Header Controls

The recent text-labeled detail view controls already added in [KnowledgeBaseView.tsx](/D:/AI-Coding/omni/src/components/KnowledgeBaseView.tsx) should be preserved.

This design should refine that area, not replace it.

Rules:

- keep text-labeled buttons for `原文`, `图片资产`, `知识结果`
- keep `处理信息` as a related action in the same visual language
- reduce the feeling of separate floating control groups
- align button sizing, spacing, and weight so the toolbar reads as one coherent control strip

The design should avoid returning to icon-only navigation.

## Visual System

### Hierarchy

The refreshed screen should rely on hierarchy through spacing, grouping, and surface contrast, not through heavy borders everywhere.

Visual priorities should be:

1. selected image preview
2. OCR and caption content
3. asset list navigation
4. small metadata and helper copy

### Surfaces

Recommended surface behavior:

- page background slightly separated from content cards
- left rail and right panel are distinct but related containers
- preview stage gets the strongest visual identity
- reading cards use softer sub-surfaces inside the right panel

### Copy

Use Chinese UI copy consistently throughout the `Assets` view.

Replace English placeholders such as:

- `Assets`
- `No embedded image assets yet.`
- `Preview unavailable`
- `No OCR text`
- `No caption summary`
- `Select an asset to inspect it.`

With product-ready Chinese copy aligned to the rest of the interface.

## Responsive Behavior

### Wide desktop

For wider desktop layouts:

- keep the two-column `rail + workspace` layout
- keep OCR and caption side-by-side

### Medium width

When width becomes tighter:

- keep two main columns as long as the right workspace remains readable
- reduce preview padding before collapsing the content model

### Narrow desktop / tablet-like width

When the two-column experience no longer feels comfortable:

- collapse the page to a single-column stack
- move the asset list above the selected asset workspace
- allow the asset list to become a responsive grid or horizontal card list
- stack OCR and caption vertically

The layout should look intentionally redesigned, not merely compressed.

## Component Impact

### Primary files

Expected implementation touches:

- [KnowledgeBaseView.tsx](/D:/AI-Coding/omni/src/components/KnowledgeBaseView.tsx)
- [App.css](/D:/AI-Coding/omni/src/App.css)

### JSX changes

The `Assets` branch in `KnowledgeBaseView.tsx` should be reorganized to better express:

- the left navigation rail
- the right workspace container
- the preview header
- the metadata strip
- the OCR and caption reading section

The data flow should remain unchanged. Existing `selectedDocumentDetail.assets`, `selectedAsset`, and `selectedAssetId` state should continue to drive the UI.

### CSS changes

The `App.css` asset-related classes should be refactored to support:

- clearer container roles
- improved spacing scale
- more refined selected-state styling
- preview stage treatment
- responsive collapse rules

The implementation should prefer extending the existing `omni-knowledge-assets-*` class family rather than introducing unrelated naming.

## Accessibility

The layout refresh should preserve and improve basic accessibility:

- selected asset state remains visually obvious
- asset buttons remain keyboard-focusable
- text contrast should remain readable on light surfaces
- preview image `alt` text should continue using the source name
- empty states should remain explicit and understandable

## Error Handling and Empty States

The refreshed layout should support the same functional states as today:

- no extracted assets
- selected asset without thumbnail
- selected asset without OCR
- selected asset without caption
- no selected asset

These should remain calm, readable, and product-like rather than debug-like.

## Testing

### Manual verification

Verify:

- asset list selection still updates the right-side preview
- long OCR content remains readable without overflowing its card incorrectly
- cards and preview remain aligned on common desktop widths
- narrow-width collapse keeps the page understandable
- empty-state copy appears in Chinese
- the updated toolbar still behaves correctly with the existing detail-view state

### Regression focus

Do not change:

- how assets are loaded
- which asset is selected by default
- how thumbnails are sourced
- document detail routing or tab switching behavior

## Implementation Order

Recommended implementation sequence:

1. refine the shared detail header control styling only as needed for visual consistency
2. restructure the `Assets` JSX into `left rail + right workspace`
3. restyle asset cards and selected states
4. rebuild the preview surface and metadata strip
5. rebuild OCR and caption cards with improved copy
6. add responsive collapse rules
7. run manual visual verification on multiple widths

## Acceptance Criteria

The design is successful when:

- the `Assets` page feels materially cleaner and more intentional than the current version
- the selected preview clearly dominates the screen
- the left list feels like navigation instead of competing content
- OCR and caption are easy to read for long text
- the refreshed layout remains coherent at narrower widths
- no backend behavior or asset-loading logic needs to change
