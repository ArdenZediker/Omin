# Knowledge Embedded Image Assets Design

## Goal

Upgrade Omni's knowledge pipeline so images embedded inside `docx` and `pdf` documents become first-class child assets of the parent document, while remaining searchable through a parent-chunk retrieval model explicitly based on WeKnora's `chunk_type` + `parent_chunk_id` + `image_info` implementation.

The desired behavior is:

- Importing a `docx` or `pdf` still creates one parent knowledge document.
- Embedded images are extracted as child assets of that parent document instead of becoming top-level documents.
- Each child asset can store its own thumbnail, OCR text, and image summary.
- OCR and caption output are indexed as child chunks attached to parent text chunks instead of being merged into parent text as plain content only.
- Search and chat retrieval can rank on image-derived text, but final display still rolls back to the parent text chunk so results stay contextual and non-fragmented.
- The main knowledge document list stays clean and does not show extracted images as separate cards.

## Desired Behavior

- A `docx` or `pdf` upload continues to appear as a single document in the main knowledge list.
- If the document contains embedded images, the background pipeline extracts them and persists them under the parent document.
- If collection-level image multimodal analysis is enabled, each extracted image is analyzed with the existing image multimodal flow.
- OCR and caption output from extracted images becomes searchable through child chunks.
- Search hits on image OCR or image captions rank normally, but the displayed result returns the parent text chunk plus image-specific context.
- The document detail screen shows a new `Assets` view where users can browse extracted images, preview them, and inspect their OCR and captions.
- If image extraction or image analysis partially fails, the parent document can still become searchable with a `partial` processing result instead of disappearing.

## Scope

This design covers:

- Persisted child assets for embedded document images.
- `docx` image extraction in the local background pipeline.
- `pdf` embedded-image extraction in the local background pipeline.
- Reuse of the existing image multimodal enrichment path for extracted images.
- Parent text chunks plus derived image child chunks in the shared `knowledge_chunks` table.
- Search-time rollback from image child chunks to parent text chunks.
- Detail-page UI for browsing child image assets.

This design does not require:

- Extracted images appearing in the main top-level document list.
- A separate asset-only retrieval surface in v1.
- A full two-layer `parent_text -> text/image_*` hierarchy in v1.
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

### Chunk linkage follows WeKnora's retrieval contract

For chunk semantics and search-time behavior, Omni v1 should follow WeKnora's implementation pattern rather than inventing a new schema.

The specific references are:

- [chunk.go](/D:/AI-Coding/WeKnora/internal/types/chunk.go): `ChunkTypeText`, `ChunkTypeImageOCR`, `ChunkTypeImageCaption`, `ParentChunkID`, `ImageInfo`
- [image_multimodal.go](/D:/AI-Coding/WeKnora/internal/application/service/image_multimodal.go): create OCR and caption child chunks under a parent text chunk
- [imageinfo.go](/D:/AI-Coding/WeKnora/internal/searchutil/imageinfo.go): collect image info from child chunks and inline it back into result content
- [merge.go](/D:/AI-Coding/WeKnora/internal/application/service/chat_pipeline/merge.go): resolve image child hits back to parent text content for richer context

Omni should align to those field meanings where practical:

- `chunk_type`
- `parent_chunk_id`
- `image_info`
- `image_ocr`
- `image_caption`

### Retrieval uses parent text chunks plus image child chunks

Do not use merge-only indexing for embedded image OCR and captions in v1.

Instead:

- keep normal text chunks as the main retrieval backbone
- create `image_ocr` and `image_caption` child chunks for each analyzed embedded image
- attach those child chunks to a parent text chunk
- when a child chunk is the best match, display and inject the parent text chunk plus image-specific enrichment

This keeps search precise without turning results into isolated image snippets.

### Use a WeKnora-lite hierarchy in v1

Do not implement the full WeKnora `parent_text` hierarchy in the first version.

Instead:

- use one parent level: `text`
- hang derived image chunks directly beneath it: `image_ocr`, `image_caption`

This captures the core retrieval behavior we want while fitting Omni's current flat chunk storage more naturally.

The design should stay compatible with a future upgrade to the full WeKnora chain:

- `parent_text -> text -> image_ocr`
- `parent_text -> text -> image_caption`

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
- `ocr_text TEXT`
- `caption_text TEXT`
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

### Extend `knowledge_chunks`

Keep using the shared chunk table, but add fields needed for parent-child image retrieval:

- `chunk_type TEXT NOT NULL DEFAULT 'text'`
- `parent_chunk_id TEXT`
- `asset_id TEXT`
- `image_info TEXT`

Chunk type values in v1:

- `text`
- `image_ocr`
- `image_caption`

Recommended indexes:

- `(document_id, chunk_type, chunk_index)`
- `(parent_chunk_id)`
- `(asset_id)`

Rules:

- `text` chunks have `parent_chunk_id = NULL`
- `image_ocr` and `image_caption` must point to a parent `text` chunk through `parent_chunk_id`
- `asset_id` is required for `image_ocr` and `image_caption`
- `image_info` is optional for `text` chunks and expected for image-derived chunks

Field intent:

- `chunk_type` and `parent_chunk_id` should mean the same thing they mean in WeKnora.
- `image_info` should store JSON-encoded image metadata in the same spirit as WeKnora's `ImageInfo` field.
- `asset_id` is Omni-specific and exists because Omni also persists a first-class local asset table for previews and file cleanup.

### Parent document relationship

`knowledge_documents` remains the only top-level document entity.

Each asset row belongs to exactly one parent document via `document_id`.

Each image-derived child chunk belongs to:

- one parent document
- one parent text chunk
- one image asset

Deleting a parent document must delete:

- its child assets
- its stored child image files
- its child chunks

Reprocessing a parent document must clear old child assets and child chunks first, then rebuild them from the newest parse.

### TypeScript payloads

Extend [knowledgeTypes.ts](/D:/AI-Coding/omni/src/chat/knowledgeTypes.ts) with:

- `KnowledgeDocumentAsset`
- chunk metadata for `chunkType`, `parentChunkId`, `assetId`, and `imageInfo`
- search result metadata for the matched chunk type, `parentChunkId`, and the display parent chunk
- `KnowledgeDocumentDetail.assets`

Suggested shapes:

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
  ocrText?: string | null;
  captionText?: string | null;
  contentPreview: string;
  pageIndex?: number | null;
  assetIndex: number;
  metadataJson?: string | null;
  createdAt: number;
  updatedAt: number;
};

export type KnowledgeChunkImageInfo = {
  assetId: string;
  sourceName: string;
  pageIndex?: number | null;
  assetIndex: number;
  originalMarkdown?: string | null;
  thumbnailDataUrl?: string | null;
};

export type KnowledgeDocumentChunk = {
  id: string;
  documentId: string;
  collectionId: string;
  chunkIndex: number;
  title?: string | null;
  content: string;
  chunkType?: "text" | "image_ocr" | "image_caption";
  parentChunkId?: string | null;
  assetId?: string | null;
  imageInfo?: KnowledgeChunkImageInfo | null;
  embeddingJson?: string | null;
  embeddingModelKey?: string | null;
  createdAt: number;
};
```

## Processing Architecture

### Existing flow to preserve

Today, `docx` and `pdf` imports rely on text bridged from the front end:

- `docx` text is extracted in the front end before upload.
- `pdf` text is extracted in the front end before upload.
- the local pipeline later treats that bridged text as parsed content.

This text bridge should remain in place so document behavior does not regress when no images are extracted.

### New child-asset extraction and attachment phase

Augment the parse-and-enrich portion of the local pipeline:

1. Load the parent document bytes from storage.
2. Parse the parent document text exactly as today.
3. Chunk the parent text into normal `text` chunks.
4. Extract child image assets from the original bytes.
5. Persist those child assets and their stored image files.
6. If image multimodal analysis is enabled, analyze each child image.
7. For each analyzed image, attach the image to the best parent text chunk.
8. Create `image_ocr` and `image_caption` child chunks from the derived text.
9. Continue with embedding and indexing across both parent text chunks and image child chunks.
10. Keep the parent document as the unit of detail view, search navigation, and lifecycle management.

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

In v1:

- parent text chunking still belongs to `chunk`
- embedded image extraction and image-child-chunk creation belong inside `enrich_image`

This keeps the operator model small while still making failures visible through the existing image-enrichment step logs.

## Extraction Strategy

### `docx`

For `docx`, extract images directly from the OOXML zip structure.

V1 behavior:

- inspect the `.docx` archive
- read image entries under `word/media/`
- infer `mime_type` and `file_extension` from entry names when needed
- preserve document order through `asset_index`
- when possible, capture nearby paragraph text or run order metadata for chunk attachment

This is the highest-confidence extraction path and should be part of the first implementation.

### `pdf`

For `pdf`, v1 should extract embedded image objects only.

V1 behavior:

- inspect the PDF object graph
- locate embedded image streams
- decode supported image stream types into bytes that can be stored and previewed
- assign `page_index` when that association can be derived reliably
- capture nearby text hints only when available without page rasterization

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
- do not create `image_ocr` or `image_caption` chunks

### Attachment rules

For each analyzed image asset, resolve a parent text chunk using this order:

1. best matching text chunk based on nearby extracted text anchor
2. nearest earlier text chunk by document order
3. nearest later text chunk if no earlier chunk exists
4. a synthetic minimal `text` chunk when the document has no usable text chunks at all

The synthetic fallback chunk should be minimal, for example:

```text
Embedded image: <source name>
```

This avoids orphaned image-derived chunks without requiring a full layout engine in v1.

This attachment rule is Omni's lightweight substitute for WeKnora's richer parent-child chunker. The retrieval semantics should still match WeKnora even though Omni v1 does not yet create `parent_text` nodes.

### Child chunk creation rules

For each asset:

- create one `image_ocr` chunk when OCR output is non-empty
- create one `image_caption` chunk when caption output is non-empty
- do not duplicate the parent text inside the child chunk content
- store only the derived image text plus asset metadata

This mirrors the behavior in [image_multimodal.go](/D:/AI-Coding/WeKnora/internal/application/service/image_multimodal.go), where image OCR and caption become separate child chunks rather than being flattened back into the parent chunk body.

Suggested chunk text templates:

```text
Image OCR
Source: <name>
Page: <optional>
Text:
<ocr text>
```

```text
Image Caption
Source: <name>
Page: <optional>
Summary:
<caption text>
```

### Search and render enrichment format

When a matching result needs image context, render the matched image using a stable inline block:

```xml
<image asset_id="..." source_name="diagram-1.png" page="2">
<image_original>![diagram-1](embedded://asset/...)</image_original>
<image_caption>...</image_caption>
<image_ocr>...</image_ocr>
</image>
```

V1 does not require `embedded://asset/...` to be a universally navigable URL. It is a stable semantic marker for prompt construction and future UI rendering.

The XML-style enrichment should follow the same intention as WeKnora's [imageinfo.go](/D:/AI-Coding/WeKnora/internal/searchutil/imageinfo.go): keep the parent passage readable, but inject structured image OCR/caption context when available.

## Search Architecture

### Shared retrieval index

All chunk types participate in the same retrieval pass:

- `text`
- `image_ocr`
- `image_caption`

This keeps Omni's existing search flow intact while broadening what can match.

### Result rollback model

If search matches a `text` chunk:

- return it normally
- optionally enrich it with associated image metadata when useful

If search matches an `image_ocr` or `image_caption` chunk:

- keep the child chunk's retrieval score
- use its parent `text` chunk as the displayed result payload
- include matched image metadata so the UI and chat layer know which embedded image was responsible

This preserves ranking quality while avoiding fragmented result cards.

This is the same core move WeKnora performs in [merge.go](/D:/AI-Coding/WeKnora/internal/application/service/chat_pipeline/merge.go): image child chunks are useful for recall, but parent text chunks are better display and prompt units.

### Search-result payload changes

Extend the search result contract so the frontend can distinguish:

- the chunk that matched
- the parent chunk that should be displayed

Suggested fields:

- `matchedChunk`
- `displayChunk`
- `matchedChunkType`
- `matchedAsset`
- `parentChunkId`
- `imageInfo`

The existing `chunk` field may either:

- evolve into `displayChunk`, or
- remain as a backward-compatible alias for `displayChunk`

The important product rule is that child image hits display as parent text hits with image-source attribution.

Where practical, field names exposed to the frontend should stay close to WeKnora's search result contract:

- `chunkType`
- `parentChunkId`
- `imageInfo`

Omni can add `displayChunk` and `matchedAsset` on top of that because its UI contract is slightly different.

### Result deduplication

When multiple child chunks under the same parent text chunk match strongly:

- keep the best-scoring child chunk as the primary reason
- collapse duplicate display cards by parent text chunk
- attach the relevant matched asset metadata for the strongest hit

This avoids one paragraph producing several nearly identical result cards because multiple embedded images matched.

Unlike WeKnora's more general multi-step merge pipeline, Omni v1 should deduplicate at the final displayed parent-text level because it only needs one rollback hop in the first release.

## UI Design

### Detail navigation

Add a new detail tab in [KnowledgeBaseView.tsx](/D:/AI-Coding/omni/src/components/KnowledgeBaseView.tsx):

- `Preview`
- `Assets`
- `Chunks`
- `Processing`

`Assets` should appear when the selected document detail is loaded. It may show an empty state when no child assets exist.

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
- a short OCR or caption preview

Selecting an asset should show:

- larger image preview
- extracted OCR text
- generated caption

The preview should remain inside the current document detail experience instead of navigating away to a new top-level document.

### Chunks view

In v1, the default `Chunks` view should prioritize readability:

- show parent `text` chunks by default
- do not flood the primary list with `image_ocr` and `image_caption` rows

If engineering later needs deeper debugging, a secondary toggle can expose derived child chunks. That toggle is optional and not required for v1.

### Search-result behavior

When the matched chunk is `image_ocr` or `image_caption`, the UI should:

- display the parent text chunk excerpt
- show a small matched-source label such as `Matched in embedded image OCR` or `Matched in embedded image caption`
- navigate into the parent document and preserve enough metadata to highlight or focus the related asset when practical

This should be treated as the UI projection of the same parent-resolution strategy used in WeKnora search and chat assembly.

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

If an extracted image exists but OCR or caption generation fails:

- keep the asset row
- keep the stored image file
- keep whatever metadata is available
- create only the child chunks supported by successful outputs
- record a warning on the parent processing job
- allow the parent document to finish as `partial` or `searchable` depending on the existing warning policy

### Attachment fallback

If chunk attachment cannot identify a reliable anchor:

- do not fail the document
- fall back to the nearest text chunk by order
- if needed, create the synthetic fallback text chunk

### Unsupported PDFs

If a `pdf` contains no supported embedded image objects:

- create no child assets
- create no image child chunks
- do not mark the document unsupported
- continue with normal text-based processing

## Rebuild and Cleanup Rules

### Reprocess

When a parent document is reparsed or fully rebuilt:

1. remove existing child asset rows for that document
2. delete their stored files if they still exist
3. remove existing image-derived child chunks for that document
4. rerun extraction from the parent bytes
5. recreate child assets and child chunks from scratch

This avoids duplicate assets, stale OCR text, and stale attachment metadata.

### Delete

Deleting a parent document must also:

- delete all `knowledge_document_assets` rows for that document
- remove all child chunks linked to those assets
- remove the `assets/` directory under that document's storage path

## Testing

### Rust pipeline tests

Add unit or integration tests for:

- `docx` image extraction from `word/media/`
- child asset cleanup before rebuild
- child chunk creation for OCR-only, caption-only, and combined outputs
- attachment fallback when no reliable anchor text exists
- synthetic parent text chunk creation when a document has embedded images but no usable text chunks
- `pdf` extraction yielding zero assets without failing processing
- `image_info` JSON generation matching the asset metadata expected by search rendering

### Search tests

Add focused tests for:

- `image_ocr` matches returning parent `text` chunks as display payloads
- `image_caption` matches returning parent `text` chunks as display payloads
- duplicate image-child hits under one parent chunk collapsing into one visible result
- plain text search remaining unchanged when no image child chunks exist
- image-info enrichment assembling OCR and caption from sibling child chunks in a WeKnora-style way

### Front-end tests

Add component-level checks for:

- `Assets` tab visibility and empty state
- asset list rendering
- asset preview selection behavior
- search-result matched-source labels for image-derived hits

### Regression checks

Verify that:

- standalone image uploads still use the current image multimodal path
- `docx` and `pdf` documents without images behave the same as today
- child assets do not appear in the top-level knowledge document list
- child image hits improve recall without replacing the surrounding parent-text context

## Implementation Order

Recommended order:

1. add schema and payload support for child assets and chunk metadata
2. implement `docx` embedded image extraction
3. wire extracted `docx` images into image multimodal enrichment and child chunk creation
4. implement search-result rollback from image child chunks to parent text chunks
5. add detail-page `Assets` UI
6. implement `pdf` embedded image extraction with the agreed v1 boundary
7. add rebuild and delete cleanup
8. add regression tests and manual verification

## Open Boundaries Locked For V1

These decisions are intentionally fixed for the first implementation:

- child image assets do not become top-level documents
- child image assets do not get their own asset-only retrieval surface
- retrieval stays inside the existing shared chunk search path
- `text -> image_ocr/image_caption` is the only parent-child chunk hierarchy required in v1
- full WeKnora `parent_text` layering is deferred, but field semantics should remain compatible with that future upgrade
- all OCR and caption content is not blindly merged into `knowledge_documents.content`
- `pdf` does not use full-page rasterization OCR in v1
- `docx` extraction is required in v1
- `pdf` extraction is best-effort for embedded image objects only

## Reference Mapping To WeKnora

Omni v1 should explicitly map to WeKnora like this:

- `knowledge_document_assets`
  - Omni-specific addition
  - used for local file persistence, previews, cleanup, and detail-page browsing
  - WeKnora does not need this exact table because it stores image references inside chunk-level `image_info`

- `knowledge_chunks.chunk_type`
  - match WeKnora chunk types:
    - `text`
    - `image_ocr`
    - `image_caption`

- `knowledge_chunks.parent_chunk_id`
  - same semantic meaning as WeKnora
  - image-derived child chunks point back to the parent text chunk

- `knowledge_chunks.image_info`
  - same semantic role as WeKnora's `ImageInfo`
  - stores JSON carrying source image context, OCR, caption, and render metadata

- search assembly
  - follow WeKnora's pattern:
    - child chunk participates in recall
    - parent chunk becomes the displayed passage
    - image info is merged back into the rendered passage

- parent hierarchy depth
  - Omni v1: `text -> image_*`
  - WeKnora full model: `parent_text -> text -> image_*`
  - Omni should stop at the first model for now, but avoid naming or payload choices that would block the second.
