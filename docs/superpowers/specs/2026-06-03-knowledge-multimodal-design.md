# Knowledge Multimodal Enrichment Design

## Goal

Upgrade Omni's knowledge-base pipeline so image and audio files can be analyzed asynchronously, then merged back into the normal knowledge retrieval flow.

The design follows the same high-level idea we borrowed from WeKnora:

- Original files are stored first.
- Multimodal analysis runs in the background as part of the local knowledge pipeline.
- Analysis output becomes searchable knowledge text.
- Retrieval and chat continue to consume normal chunks instead of adding a separate multimodal query path.

This design reuses Omni's existing online model configuration system and adds knowledge-base-level multimodal controls.

## Desired Behavior

- Users configure reusable multimodal models once in Settings.
- Each knowledge base decides whether image and audio analysis are enabled and which models it uses.
- Uploading an image or audio file still creates a durable document immediately.
- The background worker analyzes supported files, merges the results into document content, then continues through chunking and embedding.
- Failed analysis does not discard the original file or make the document disappear.
- Retrieval and question answering can reference OCR text, image descriptions, audio transcripts, and audio summaries through the existing chunk search flow.

## Scope

This design covers:

- Global multimodal model configuration.
- Knowledge-base-level multimodal strategy.
- Background image and audio analysis.
- Merging analysis results into normal document content.
- UI entry points for multimodal settings.
- Status, logging, fallback behavior, and verification requirements.

This design does not require:

- Video understanding in the first version.
- A separate multimodal vector index.
- A new retrieval path outside the existing knowledge chunk pipeline.
- Provider-specific optimization beyond the shared OpenAI-compatible model layer.

## Product Decisions

### Configuration split

Use two layers of configuration:

1. Global model pool in `Settings -> Model Configuration`.
2. Knowledge-base-level multimodal strategy in `Knowledge Base -> Collection Settings`.

This keeps provider credentials and endpoint details global while letting each knowledge base choose whether and how to use the capability.

### Processing model

Use asynchronous enrichment instead of front-end-only extraction:

- Images: run OCR and image understanding in the background.
- Audio: run ASR transcription and optional summarization in the background.
- The output is normalized into plain text and appended to the document's searchable content.

### Retrieval model

Do not create a special multimodal retrieval stack in v1.

Instead:

- Multimodal analysis produces normalized text.
- The text is chunked and embedded through the existing knowledge pipeline.
- Chat retrieval keeps using the current knowledge chunk search implementation.

This keeps the first version small and compatible with the current architecture.

## Configuration Architecture

## Global model configuration

Add a new model category beside the existing `chat` and `embedding` sections:

- `multimodal`

This section manages reusable models for knowledge analysis.

Each configured multimodal model record should include:

- `id`
- `name`
- `provider`
- `baseUrl`
- `model`
- `apiKey`
- `capability`

Capability values in v1:

- `image`
- `audio`

Suggested storage key:

- `omni_knowledge_multimodal_profile`

Suggested record shape:

```json
{
  "enabled": true,
  "models": [
    {
      "id": "openai:gpt-4.1-mini:image:0",
      "name": "Image OCR and Understanding",
      "provider": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4.1-mini",
      "apiKey": "",
      "capability": "image"
    },
    {
      "id": "openai:gpt-4o-mini-transcribe:audio:0",
      "name": "Audio Transcription",
      "provider": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4o-mini-transcribe",
      "apiKey": "",
      "capability": "audio"
    }
  ]
}
```

The normalization and validation rules should mirror the current knowledge embedding config:

- ensure non-empty ids
- default base URLs by provider
- reject unsupported providers
- keep credentials local to the configured model record

## Knowledge-base configuration

Add a multimodal config block to each knowledge collection.

Recommended storage:

- new column on `knowledge_collections`: `multimodal_config_json TEXT`

Suggested shape:

```json
{
  "enabled": true,
  "image": {
    "enabled": true,
    "modelId": "openai:gpt-4.1-mini:image:0",
    "extractText": true,
    "generateSummary": true
  },
  "audio": {
    "enabled": true,
    "modelId": "openai:gpt-4o-mini-transcribe:audio:0",
    "keepTranscript": true,
    "generateSummary": true
  },
  "mergeMode": "append"
}
```

V1 behavior rules:

- `enabled = false` disables all multimodal enrichment for the collection.
- `image.enabled = true` only applies to image documents.
- `audio.enabled = true` only applies to audio documents.
- `mergeMode = append` means analysis text is appended to the parsed content in a stable template.

No advanced per-collection tuning is required in v1 for:

- timeout
- retry count
- concurrency
- output length

Those remain controlled by the existing pipeline settings and provider behavior.

## Data Model Changes

### `knowledge_collections`

Extend the collection schema with:

- `multimodal_config_json TEXT`

The `KnowledgeCollectionRecord` payload should expose:

- `multimodal_config_json` on the Rust side
- `multimodalConfig` on the TypeScript side

`create_knowledge_collection` should insert a default config.
`update_knowledge_collection` should accept multimodal config updates.

### `knowledge_documents`

The existing document table already supports asynchronous processing status and remains the primary document source.

No new table is required in v1 if multimodal enrichment is stored as merged content.

Optional future extension:

- `analysis_metadata_json TEXT` for storing raw OCR/ASR/summary metadata separately

That is not required for the first implementation.

### `knowledge_processing_steps`

Extend step usage so multimodal work is visible instead of hiding inside `parse`.

V1 step names should become:

- `validate`
- `parse`
- `enrich_image`
- `enrich_audio`
- `chunk`
- `embed`
- `index`
- `finalize`

Rules:

- image documents can skip `enrich_audio`
- audio documents can skip `enrich_image`
- text and other documents can skip both

## UI Design

## Settings window

In `Settings -> Model Configuration`, add a third category:

- `Multimodal Models`

This panel should:

- list all configured multimodal models
- allow add, edit, remove
- require a capability of `image` or `audio`
- visually show the capability badge
- warn when API key is missing

This keeps the interaction parallel to the current chat and embedding model sections.

## Knowledge base collection menu

The left-side collection `...` menu currently exposes only delete.

Add:

- `Settings`
- `Delete`

Selecting `Settings` opens a collection settings dialog.

## Collection settings dialog

Add a knowledge-base-level settings dialog with two sections in v1:

### Basic information

- collection name
- collection description

### Multimodal

Image analysis controls:

- enable image analysis
- image model selector
- extract text from image
- generate image summary

Audio analysis controls:

- enable audio analysis
- audio model selector
- keep full transcript
- generate audio summary

Shared behavior note:

- analysis results are merged into searchable content
- original files remain available for preview and download

Validation in the dialog:

- if image analysis is enabled but no image model exists, show a blocking validation message
- if audio analysis is enabled but no audio model exists, show a blocking validation message

## Document detail and task visibility

Document detail should expose the result clearly:

- current processing status
- active job state
- whether enrichment was applied
- failure message if analysis failed

Task logs should mention:

- selected multimodal model
- enrichment step start and finish
- whether OCR, transcript, or summary was produced

## Processing Flow

## Upload intake

1. The front end uploads the original file as it does now.
2. The backend creates the document and processing job immediately.
3. The collection's multimodal config is not copied into the file payload; it is resolved server-side using the document's collection id.

This avoids client-side drift and keeps the collection policy authoritative.

## Background pipeline

For each claimed job:

1. parse the file into baseline content
2. inspect file type and collection multimodal config
3. run image enrichment for image files when enabled
4. run audio enrichment for audio files when enabled
5. merge enrichment output into the document content
6. chunk the merged content
7. embed chunks through the current embedding path
8. update document status and logs

## Image enrichment flow

Input:

- original stored image file bytes
- resolved image multimodal model
- collection image options

Provider task:

- OCR-style extraction of visible text
- short image description suitable for retrieval

Normalized output template:

```text
图片文件
文件名: <name>
类型: <mime>

图片文本:
<ocr text or "未提取到明显文字">

图片摘要:
<summary text or "未生成摘要">
```

Rules:

- if `extractText = false`, omit the OCR section
- if `generateSummary = false`, omit the summary section
- if both are disabled, skip enrichment entirely

## Audio enrichment flow

Input:

- original stored audio file bytes
- resolved audio multimodal model
- collection audio options

Provider task:

- speech-to-text transcription
- optional summary generation

Normalized output template:

```text
音频文件
文件名: <name>
类型: <mime>

音频转写:
<transcript text>

音频摘要:
<summary text or "未生成摘要">
```

Rules:

- if `keepTranscript = false`, omit transcript from merged content after summary generation
- if `generateSummary = false`, keep transcript only
- if both are disabled, skip enrichment entirely

## Merge strategy

V1 uses one merge mode:

- `append`

Meaning:

- existing parsed content remains first
- multimodal enrichment text is appended below a stable separator

Suggested separator:

```text

--- 多模态分析 ---
```

This preserves compatibility with current preview and chunking behavior while making analysis output easy to identify.

## Capability Resolution

The multimodal analysis implementation should resolve models from the global multimodal config, not from chat preferences.

Resolution order:

1. load collection multimodal config
2. check whether the file type is supported and enabled
3. find the referenced model by `modelId`
4. verify provider, base URL, model id, and API key
5. if the model is invalid, log a configuration failure and mark the document `partial` or `failed` based on whether baseline content exists

This keeps knowledge analysis deterministic and independent from the current chat assistant selection.

## Error Handling and Fallbacks

### Missing configuration

- Collection enables image analysis but has no selected image model: block save in the collection settings dialog.
- Collection enables audio analysis but has no selected audio model: block save in the collection settings dialog.
- Saved collection references a deleted global model: allow the collection to load, but show an invalid configuration warning and skip enrichment until fixed.

### Provider failure

- If baseline parsing succeeded but enrichment fails, keep the document and mark processing as `partial`.
- If baseline parsing produced no usable searchable content and enrichment also fails, mark as `failed`.
- Log the provider error with step context.

### Unsupported file types

- Image and audio enrichment only runs for supported MIME types and file extensions.
- Video remains unsupported in v1 and should stay on the current store-only behavior.

### Retry behavior

- Multimodal enrichment failures should be retryable through the existing processing job retry path.
- Dead-letter replay should preserve the original collection-level multimodal settings at replay time by resolving current config again.

## Retrieval and Chat Integration

No dedicated retrieval changes are required beyond feeding richer text into the existing pipeline.

The current retrieval path remains:

1. user query embedding
2. chunk similarity search
3. knowledge context assembly
4. chat answer generation

Expected improvement:

- image questions can match OCR text and image summary text
- audio questions can match transcript and summary text

This is intentionally text-mediated multimodal retrieval, not native image or audio embeddings.

## Backend Implementation Outline

### Rust types

Add new records for:

- global multimodal model config
- collection multimodal config
- multimodal capability enum

### Storage and commands

Add read/write support for the new global multimodal config key.

Extend collection commands:

- `create_knowledge_collection_command`
- `update_knowledge_collection_command`
- `load_knowledge_library_command`

So the collection payload can round-trip multimodal settings.

### Pipeline integration

Add a multimodal enrichment stage in `knowledge_pipeline.rs`.

Recommended internal boundary:

- `resolve_collection_multimodal_config(...)`
- `resolve_multimodal_model(...)`
- `enrich_image_document(...)`
- `enrich_audio_document(...)`
- `merge_multimodal_content(...)`

This keeps provider invocation and content formatting separate from the general job processor.

### Provider invocation

Reuse the existing OpenAI-compatible provider approach already used in Omni settings.

V1 should support the same provider family used by the current model configuration system:

- `openai`
- `openrouter`
- `moonshot`
- `siliconflow`
- `dashscope`
- `zhipu`

Only providers that can satisfy the requested capability should be shown as valid selections in the UI.

## Frontend Implementation Outline

### TypeScript types

Extend `KnowledgeCollection` with `multimodalConfig`.

Add new front-end config types for:

- multimodal model config
- collection multimodal config

### Settings UI

Add `multimodal` to the model configuration section switcher.

Create a dedicated settings section component, parallel to `KnowledgeEmbeddingSection`.

### Knowledge base UI

Add collection settings state and dialog in `KnowledgeBaseView.tsx`.

Update the collection menu to open settings.

### Validation UX

Use the same in-app feedback style already adopted in the knowledge base workflow:

- inline form validation inside the dialog
- top-centered floating notice for save success or failure

## Testing Strategy

### Backend tests

Add focused tests for:

- collection multimodal config defaulting and normalization
- image enrichment merge formatting
- audio enrichment merge formatting
- missing model resolution
- parse success plus enrichment failure leading to `partial`
- unsupported file types skipping enrichment cleanly

### Frontend tests

Add tests for:

- collection settings dialog validation
- model filtering by capability
- collection update payload shape
- menu action for opening collection settings

### Manual verification

Verify:

1. create a multimodal image model and an audio model
2. create or edit a knowledge base and enable both features
3. upload an image with visible text
4. upload an audio file with speech
5. confirm background jobs show enrichment steps
6. confirm document content contains normalized OCR/transcript output
7. confirm knowledge search can hit the enriched content
8. confirm chat answers can cite the enriched results through normal retrieval

## Rollout Notes

V1 should be implemented in a compatibility-first way:

- existing non-multimodal uploads continue to behave as before
- image uploads without collection enrichment enabled keep the current lightweight behavior
- old documents are not auto-migrated in the first pass

If historical image or audio files need enrichment later, that should be handled as a follow-up rebuild flow rather than hidden migration during this feature.

## Open Follow-Ups

These are intentionally outside the first implementation:

- historical multimodal rebuild for already uploaded files
- video analysis
- native image or audio embeddings
- separate storage of raw OCR timing or ASR segment metadata
- richer extraction strategies such as speaker diarization or structured scene extraction
