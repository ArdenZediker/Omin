# Knowledge Embedded Image Assets Design

## Goal

Upgrade Omni's knowledge pipeline so images embedded inside `docx` and `pdf` documents become first-class child assets of the parent document.

The desired behavior is:

- Importing a `docx` or `pdf` still creates one parent knowledge document.
- Embedded images are extracted as child assets of that parent document instead of becoming top-level documents.
- Each child asset can store its own thumbnail, OCR text, and image summary.
- Image-derived text is merged back into the parent document content so existing chunking, embedding, and retrieval continue to work.
- The main knowledge document list stays clean and does not show extracted images as separate cards.

## Desired Behavior

- A `docx` or `pdf` upload continues to appear as a single document in the main knowledge list.
- If the document contains embedded images, the background pipeline extracts them and persists them under the parent document.
- If collection-level image multimodal analysis is enabled, each extracted image is analyzed with the existing image multimodal flow.
- The OCR and summary output from extracted images becomes part of the parent document's searchable content.
- The document detail screen shows a new `Assets` view where users can browse extracted images, preview them, and inspect their OCR and summaries.
- If image extraction or image analysis partially fails, the parent document can still become searchable with a `partial` processing result instead of disappearing.

## Scope

This design covers:

- Persisted child assets for embedded document images.
- `docx` image extraction in the local background pipeline.
- `pdf` embedded-image extraction in the local background pipeline.
- Reuse of the existing image multimodal enrichment path for extracted images.
- Merging extracted image knowledge into the parent document text.
- Detail-page UI for browsing child image assets.

This design does not require:

- Extracted images appearing in the main top-level document list.
- A separate asset vector index in v1.
- Page-level rasterization for `pdf` in v1.
- OCR of arbitrary vector-only PDF pages in v1.
- Video or audio child assets in v1.

## Product Decisions

### Child assets stay under the parent document

Do not represent extracted images as top-level `knowledge_documents`.

Instead:

- keep one parent document for the original `docx` or `pdf`
- store extracted images in a dedicated child-asset table
- load them only in document detail views

This preserves the mental model that users uploaded one document while still exposing the extracted visual content.

### Search continues to target parent documents

Do not create a separate retrieval path for child assets in v1.

Instead:

- analyze each child image
- normalize the result into plain text
- merge the result into the parent document content before chunking

This keeps all search and chat retrieval compatible with the current chunk search implementation.

### `pdf` first version uses embedded image extraction only

For `pdf`, v1 should only extract images that already exist as embedded image objects in the file.

Do not render full pages to bitmaps in v1.

This keeps the implementation local and lightweight while still covering a meaningful subset of scanned or image-heavy PDFs.

## Data Model

### New table: `knowledge_document_assets`

Add a dedicated table for child assets:

- `id TEXT PRIMARY KEY`
- `document_id TEXT NOT NULL`
- `collection_id TEXT NOT NULL`
- `asset_kind TEXT NOT NULL`
- `source_name TEXT NOT NULL`
- `stored_file_path TEXT NOT NULL`
- `mime_type TEXT`
- `file_extension TEXT`
- `preview_type TEXT NOT NULL`
- `thumbnail_data_url TEXT`
- `content TEXT`
- `content_preview TEXT NOT NULL`
- `page_index INTEGER`
- `asset_index INTEGER NOT NULL`
- `metadata_json TEXT`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`

V1 values:

- `asset_kind = 'embedded_image'`
- `preview_type = 'image'`

Recommended indexes:

- `(document_id, asset_index)`
- `(collection_id, document_id)`

### Parent document relationship

`knowledge_documents` remains the only top-level document entity.

Each asset row belongs to exactly one parent document via `document_id`.

Deleting a parent document must delete its child assets and their stored files.

Reprocessing a parent document must clear old child assets first, then rebuild them from the newest parse.

### TypeScript payloads

Extend [knowledgeTypes.ts](/D:/AI-Coding/omni/src/chat/knowledgeTypes.ts) with:

- `KnowledgeDocumentAsset`
- `KnowledgeDocumentDetail.assets`

Suggested shape:

```ts
export type KnowledgeDocumentAsset = {
  id: string;
  documentId: string;
  collectionId: string;
  assetKind: "embedded_image";
  sourceName: string;
  storedFilePath?: string | null;
  mimeType?: string | null;
  fileExtension?: string | null;
  previewType: "image";
  thumbnailDataUrl?: string | null;
  content?: string | null;
  contentPreview: string;
  pageIndex?: number | null;
  assetIndex: number;
  metadataJson?: string | null;
  createdAt: number;
  updatedAt: number;
};
```

## Processing Architecture

### Existing flow to preserve

Today, `docx` and `pdf` imports rely on text bridged from the front end:

- `docx` text is extracted in the front end before upload.
- `pdf` text is extracted in the front end before upload.
- the local pipeline later treats that bridged text as parsed content.

This text bridge should remain in place so document behavior does not regress when no images are extracted.

### New child-asset extraction phase

Augment the parse-and-enrich portion of the local pipeline:

1. Load the parent document bytes from storage.
2. Parse the parent document text exactly as today.
3. Extract child image assets from the original bytes.
4. Persist those child assets and their stored image files.
5. If image multimodal analysis is enabled, analyze each child image.
6. Merge the extracted image OCR and summary text into the parent document content.
7. Continue with chunking, embedding, and indexing on the parent document.

The parent document remains the unit of chunking and retrieval.

### Step model

Keep the current visible steps:

- `validate`
- `parse`
- `enrich_image`
- `enrich_audio`
- `chunk`
- `embed`
- `index`
- `finalize`

In v1, child image extraction belongs inside the parent document's image enrichment path rather than adding a ninth visible step.

That keeps the operator model small while still making failures visible through the existing `enrich_image` step logs.

## Extraction Strategy

### `docx`

For `docx`, extract images directly from the OOXML zip structure.

V1 behavior:

- inspect the `.docx` archive
- read image entries under `word/media/`
- infer `mime_type` and `file_extension` from entry names when needed
- preserve document order through `asset_index`

This is the highest-confidence extraction path and should be part of the first implementation.

### `pdf`

For `pdf`, v1 should extract embedded image objects only.

V1 behavior:

- inspect the PDF object graph
- locate embedded image streams
- decode supported image stream types into bytes that can be stored and previewed
- assign `page_index` when that association can be derived reliably

V1 should not:

- rasterize each PDF page to a screenshot
- run OCR on the whole page image when no embedded image object is present

If no supported embedded images are found, processing should continue without child assets.

## Asset Persistence

### File storage

Store extracted image bytes under the same document storage root as the parent file.

Suggested layout:

- `knowledge_files/<collection>/<document>/assets/<asset-index>-<safe-name>`

This keeps child assets colocated with the parent document and makes cleanup straightforward.

### Thumbnails

Generate thumbnails for extracted images using the same thumbnail generation style already used for standalone image uploads where possible.

If thumbnail generation fails:

- keep the child asset
- leave `thumbnail_data_url` empty
- do not fail the whole document

## Multimodal Enrichment

### Reuse the existing image multimodal path

The current pipeline already supports image OCR and summary generation for standalone image documents.

V1 should reuse that logic for extracted child images:

- resolve the collection image multimodal config
- resolve the selected image-capable model
- call the existing image enrichment function on each extracted image

If collection image multimodal analysis is disabled:

- still persist the child image asset
- still show it in the `Assets` view
- do not attach OCR or summary text

### Merge format

Child image analysis output should be merged into the parent document content with a stable template.

Recommended structure:

```text
--- Embedded Image Assets ---
Image 1
Source: <name>
Page: <optional page index>
OCR:
...
Summary:
...

Image 2
...
```

This merged text becomes part of the parent document content before chunking.

## UI Design

### Detail navigation

Add a new detail tab in [KnowledgeBaseView.tsx](/D:/AI-Coding/omni/src/components/KnowledgeBaseView.tsx):

- `Preview`
- `Assets`
- `Chunks`
- `Processing`

`Assets` should appear only when the selected document detail is loaded. It may show an empty state when no child assets exist.

### Assets view

The new `Assets` view should show:

- a count of extracted images
- a responsive grid or stacked list of asset cards

V1 does not require an asset search box or asset-specific filter controls.

Each asset card should show:

- thumbnail
- label such as `Image 1`
- `Page N` when available
- filename or generated asset name
- a short OCR or summary preview

Selecting an asset should show:

- larger image preview
- extracted OCR text
- generated summary

The preview should remain inside the current document detail experience instead of navigating away to a new top-level document.

### Main document list stays unchanged

Do not show child assets in the main list produced by `load_knowledge_library`.

This is a hard product requirement for v1.

## Error Handling

### Partial extraction

If one embedded image fails to extract:

- log a warning
- continue extracting other images
- continue parent document processing

### Partial multimodal analysis

If an extracted image exists but OCR or summary generation fails:

- keep the asset row
- keep the stored image file
- keep whatever metadata is available
- record a warning on the parent processing job
- allow the parent document to finish as `partial` or `searchable` depending on the existing warning policy

### Unsupported PDFs

If a `pdf` contains no supported embedded image objects:

- create no child assets
- do not mark the document unsupported
- continue with normal text-based processing

## Rebuild and Cleanup Rules

### Reprocess

When a parent document is reparsed or fully rebuilt:

1. remove existing child asset rows for that document
2. delete their stored files if they still exist
3. rerun extraction from the parent bytes
4. recreate child assets from scratch

This avoids duplicate assets and stale OCR text.

### Delete

Deleting a parent document must also:

- delete all `knowledge_document_assets` rows for that document
- remove the `assets/` directory under that document's storage path

## Testing

### Rust pipeline tests

Add unit or integration tests for:

- `docx` image extraction from `word/media/`
- child asset cleanup before rebuild
- merge formatting for extracted image text
- `pdf` extraction yielding zero assets without failing processing

### Front-end tests

Add component-level checks for:

- `Assets` tab visibility and empty state
- asset list rendering
- asset preview selection behavior

### Regression checks

Verify that:

- standalone image uploads still use the current image multimodal path
- `docx` and `pdf` documents without images behave the same as today
- child assets do not appear in the top-level knowledge document list

## Implementation Order

Recommended order:

1. add schema and payload support for child assets
2. implement `docx` embedded image extraction
3. wire extracted `docx` images into image multimodal enrichment and parent-content merge
4. add detail-page `Assets` UI
5. implement `pdf` embedded image extraction with the agreed v1 boundary
6. add rebuild and delete cleanup
7. add regression tests and manual verification

## Open Boundaries Locked For V1

These decisions are intentionally fixed for the first implementation:

- child image assets do not become top-level documents
- child image assets do not get their own retrieval surface
- parent document chunking remains the only retrieval input
- `pdf` does not use full-page rasterization OCR in v1
- `docx` extraction is required in v1
- `pdf` extraction is best-effort for embedded image objects only
