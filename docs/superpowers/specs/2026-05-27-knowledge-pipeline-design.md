# Knowledge Pipeline Design

## Goal

Upgrade Omni's knowledge-base import from a synchronous front-end parsing flow into a fully controllable local processing pipeline inspired by WeKnora.

The desired behavior is:

- Uploading a file should create a durable document record and save the original file first.
- Parsing, asset extraction, chunking, embedding, and indexing should run through an observable background pipeline.
- Users should be able to inspect, pause, resume, retry, cancel, and re-run processing at meaningful boundaries.
- The implementation should remain suitable for a local Tauri desktop app and avoid adopting WeKnora's server-cluster dependencies.

## Reference Lessons From WeKnora

WeKnora separates file intake from document processing:

- The upload handler validates file size, type, name, storage configuration, duplicate hash, and quota.
- It creates a knowledge record with a pending parse status and saves the original file.
- It enqueues a processing task that later reads the file, parses content, extracts assets, chunks text, embeds chunks, and updates status.
- Failures are recorded on the knowledge record and task logs rather than making the file disappear.
- Simple formats are handled locally, while complex formats can be routed through configurable document readers.

Omni should borrow the separation, status model, retry behavior, and operator controls. It should not directly copy WeKnora's Asynq, Redis, tenant storage, or service-oriented architecture.

## Scope

This design covers:

- Durable upload intake.
- Local background processing jobs.
- Step-level progress and logs.
- Parser profiles and resource controls.
- Retry, cancel, pause, resume, reparse, rechunk, and revectorize operations.
- Compatibility with existing documents and retrieval.

This design does not require:

- A remote parser service in the first implementation.
- Redis or a distributed queue.
- Multi-tenant storage backends.
- Cloud OCR, VLM, or ASR in the first implementation, though extension points should exist.

## Data Model

### `knowledge_documents`

Extend the existing table with processing-oriented fields:

- `file_hash TEXT`
- `file_size INTEGER`
- `processing_status TEXT NOT NULL DEFAULT 'searchable'`
- `error_message TEXT`
- `active_job_id TEXT`
- `content_version INTEGER NOT NULL DEFAULT 1`
- `parser_profile_id TEXT`
- `last_processed_at INTEGER`

Document statuses:

- `pending`: file is saved but processing has not started.
- `processing`: a job is actively working on the document.
- `searchable`: chunks are available for retrieval.
- `partial`: content or chunks exist, but vectorization or a later step failed.
- `failed`: processing failed and no searchable output is available.
- `canceled`: latest processing was canceled.
- `unsupported`: original file is saved, but the format cannot be parsed into searchable text.

### `knowledge_processing_jobs`

Create a job table for each processing attempt:

- `id TEXT PRIMARY KEY`
- `document_id TEXT NOT NULL`
- `collection_id TEXT NOT NULL`
- `job_type TEXT NOT NULL`
- `status TEXT NOT NULL`
- `current_step TEXT`
- `progress INTEGER NOT NULL DEFAULT 0`
- `attempt INTEGER NOT NULL DEFAULT 0`
- `max_attempts INTEGER NOT NULL DEFAULT 3`
- `cancel_requested INTEGER NOT NULL DEFAULT 0`
- `pause_requested INTEGER NOT NULL DEFAULT 0`
- `error_message TEXT`
- `created_at INTEGER NOT NULL`
- `started_at INTEGER`
- `finished_at INTEGER`
- `updated_at INTEGER NOT NULL`

Job types:

- `initial_import`
- `reparse`
- `rechunk`
- `revectorize`
- `full_rebuild`

Job statuses:

- `queued`
- `running`
- `paused`
- `succeeded`
- `failed`
- `canceled`

### `knowledge_processing_steps`

Record one row per job step:

- `id TEXT PRIMARY KEY`
- `job_id TEXT NOT NULL`
- `document_id TEXT NOT NULL`
- `step_name TEXT NOT NULL`
- `status TEXT NOT NULL`
- `progress INTEGER NOT NULL DEFAULT 0`
- `error_message TEXT`
- `started_at INTEGER`
- `finished_at INTEGER`
- `updated_at INTEGER NOT NULL`

Step names:

- `validate`
- `parse`
- `extract_assets`
- `chunk`
- `embed`
- `index`
- `finalize`

### `knowledge_processing_logs`

Keep human-readable and structured diagnostics:

- `id TEXT PRIMARY KEY`
- `job_id TEXT NOT NULL`
- `document_id TEXT NOT NULL`
- `level TEXT NOT NULL`
- `step_name TEXT`
- `message TEXT NOT NULL`
- `details_json TEXT`
- `created_at INTEGER NOT NULL`

Log retention should be configurable. The default should keep recent failed logs and compact old successful logs.

### `knowledge_parser_profiles`

Store parser and chunking strategy:

- `id TEXT PRIMARY KEY`
- `name TEXT NOT NULL`
- `is_default INTEGER NOT NULL DEFAULT 0`
- `config_json TEXT NOT NULL`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`

Initial config shape:

```json
{
  "simpleFormats": ["txt", "md", "markdown", "json", "csv", "tsv", "html", "xml", "yml", "yaml"],
  "unsupportedMode": "store_only",
  "pdfParser": "frontend_bridge",
  "docxParser": "frontend_bridge",
  "imageMode": "store_with_placeholder",
  "audioMode": "store_only",
  "chunkSize": 512,
  "chunkOverlap": 80,
  "enableEmbedding": true,
  "enableAssetExtraction": true
}
```

### `knowledge_pipeline_settings`

Store global resource controls:

- `id TEXT PRIMARY KEY`
- `settings_json TEXT NOT NULL`
- `updated_at INTEGER NOT NULL`

Initial settings:

```json
{
  "enabled": true,
  "maxConcurrentJobs": 1,
  "maxFileSizeMb": 100,
  "maxAttempts": 3,
  "jobTimeoutMs": 300000,
  "stepTimeoutMs": 120000,
  "retryBackoffMs": [500, 1500, 5000],
  "keepSuccessfulLogsDays": 7,
  "keepFailedLogsDays": 30
}
```

## Upload Flow

1. The front end collects selected files and relative folder paths.
2. For each file, the front end sends bytes, filename, source path, MIME type, size, and optional parser profile.
3. The backend validates filename, extension, size, and collection existence.
4. The backend calculates a content hash.
5. If an equivalent document already exists, the backend returns a duplicate result instead of creating duplicate chunks.
6. The backend saves the original file under `knowledge_files/<collection>/<document>/`.
7. The backend inserts a document with `processing_status = 'pending'`.
8. The backend inserts an `initial_import` job with `status = 'queued'`.
9. The UI immediately shows the document and job progress.

Batch upload should return per-file results. One failed file must not fail the entire batch unless the whole request cannot be read.

## Processing Worker

Omni should run an in-process local worker managed by Tauri.

Worker behavior:

- Start when the app starts, unless pipeline processing is disabled.
- Poll queued jobs from SQLite.
- Respect `maxConcurrentJobs`.
- Mark stale `running` jobs from a previous crash as `failed` or `queued` based on whether the step is safe to retry.
- Check `pause_requested` and `cancel_requested` between steps and during long-running loops.
- Persist step progress frequently enough for the UI to feel alive.

The worker should be deterministic and local. It should not require Redis, a network service, or a separate daemon.

## Pipeline Steps

### `validate`

Checks:

- Document still exists.
- Original file path exists.
- File type is known or allowed as store-only.
- Parser profile and embedding profile are available.

Failure behavior:

- Missing file: `failed`.
- Unsupported but storable format: `unsupported`.
- Missing embedding profile with embedding enabled: `partial` if chunks can still be created, otherwise `failed`.

### `parse`

Input: original file bytes and parser profile.

Outputs:

- `content` as markdown/text.
- `preview_type`.
- optional parser metadata.

Initial parser behavior:

- `txt`, `md`, `markdown`: decode as text.
- `json`: pretty-print or normalize to fenced/structured markdown.
- `csv`, `tsv`: convert to markdown table with safe row limits for preview and full content for chunking.
- `html`, `xml`, `yaml`: decode as text in the first version.
- `pdf`, `docx`: use a temporary front-end bridge if needed, but the design boundary should be a backend parser interface.
- images: create markdown image placeholder and mark as not text-searchable unless OCR is later enabled.
- audio/video: store only in the first version.

Parse failures should keep the document and job logs.

### `extract_assets`

Initial version:

- Preserve original file path.
- Preserve thumbnail data when available.
- For images, generate a stable placeholder chunk only if configured.

Future extension points:

- OCR.
- VLM captions.
- ASR transcription.
- Extracted images from PDF/DOCX.

### `chunk`

Use the existing Rust `knowledge_chunker`.

Requirements:

- Preserve markdown tables, code fences, links, and image references when possible.
- Use parser profile chunk size and overlap.
- Record chunk count and chunking metadata.
- If content is empty but file is store-only, do not create chunks.

### `embed`

Generate embeddings using the current knowledge embedding config.

Requirements:

- Support retry with backoff for transient API errors.
- Cap single embedding input size before sending to providers.
- Track vectorized chunk count.
- If embedding fails after chunks are created, mark document as `partial`.

### `index`

Write chunks and embeddings in a transaction:

- Remove stale chunks for the document version being rebuilt.
- Insert new chunks.
- Store embedding model key.
- Update content preview and counts.

### `finalize`

Update:

- Document `processing_status`.
- `last_processed_at`.
- `active_job_id`.
- `chunk_count`.
- `vectorized_chunk_count`.
- `updated_at`.

Successful jobs become `succeeded`. Failed, canceled, partial, and unsupported outcomes should be explicit and visible.

## Control Operations

Backend commands should support:

- `load_knowledge_processing_jobs`
- `load_knowledge_processing_job_detail`
- `pause_knowledge_processing_job`
- `resume_knowledge_processing_job`
- `cancel_knowledge_processing_job`
- `retry_knowledge_processing_job`
- `reparse_knowledge_document`
- `rechunk_knowledge_document`
- `revectorize_knowledge_document`
- `update_knowledge_parser_profile`
- `update_knowledge_pipeline_settings`

Semantics:

- Pause should stop before the next step or at a safe checkpoint.
- Cancel should avoid deleting the original file and should not remove previous searchable chunks unless the current job already replaced them.
- Retry should create a new job linked to the same document, preserving the old failed job.
- Reparse should rerun parse, asset extraction, chunking, embedding, and indexing.
- Rechunk should reuse stored content and rerun chunking, embedding, and indexing.
- Revectorize should reuse chunks and rerun only embedding/index metadata.

## Front-End Experience

### Document List

Show:

- Processing status badge.
- Progress bar for active jobs.
- Chunk count and vectorized count.
- Failure summary when present.
- Quick actions: retry, cancel, pause, resume, reprocess.

### Document Detail

Tabs:

- Preview.
- Chunks.
- Processing.
- Original file.

Processing tab should show:

- Current job.
- Step timeline.
- Logs.
- Attempts.
- Error details.

### Task Center

Add a queue view for:

- Running jobs.
- Queued jobs.
- Failed jobs.
- Recently completed jobs.

Controls:

- Pause all.
- Resume all.
- Retry failed.
- Clear completed logs.
- Change resource settings.

## Retrieval Compatibility

Search should include only usable chunks:

- `searchable`: include normally.
- `partial`: include chunks that exist; vector search may be skipped if embeddings are missing.
- `pending`, `processing`, `failed`, `canceled`, `unsupported`: exclude by default.

The chat UI should explain when selected documents are not ready for retrieval.

## Migration Plan

Existing documents:

- Add new columns with safe defaults.
- Mark documents with chunks as `searchable`.
- Mark documents with no chunks but with stored files as `unsupported` or `pending_review`.
- Create no processing jobs for old documents unless the user asks to reprocess them.

Existing upload behavior:

- Keep the current import command temporarily if needed.
- Add new commands for pipeline import.
- Move UI to the pipeline import path once the worker and status display are stable.

## Error Handling

Error categories:

- `validation_error`: invalid filename, unsupported extension, file too large.
- `storage_error`: save/read/delete failure.
- `parse_error`: parser failed or returned invalid output.
- `chunk_error`: chunker failed or produced invalid chunks.
- `embedding_error`: provider or model failure.
- `index_error`: database transaction failure.
- `canceled`: user requested cancellation.

Retry policy:

- Retry transient storage, parser, and embedding failures.
- Do not retry validation errors automatically.
- Do not retry unsupported formats automatically.
- Use exponential backoff.
- Store final error summary on the document and detailed errors in logs.

## Testing Strategy

Backend tests:

- Upload creates document, file, and queued job.
- Duplicate hash detection returns duplicate result.
- Worker processes simple text to searchable chunks.
- CSV converts to markdown table.
- Unsupported files are stored and marked unsupported.
- Failed parser records job, step, and document error.
- Cancel stops at a safe boundary.
- Retry creates a new job without deleting the old job.
- Revectorize does not reparse content.

Chunking tests:

- Existing chunker tests remain.
- Add integration tests for markdown, CSV, JSON, empty text, and large text.

UI tests or manual smoke:

- Batch upload shows per-file states.
- Failed file exposes logs and retry.
- Pause/resume queue behaves predictably.
- Search excludes pending/failed files.

## Implementation Phases

### Phase 1: Schema and Commands

- Add migrations.
- Add types.
- Add upload-intake command.
- Add job listing/detail commands.
- Keep existing import path functional.

### Phase 2: Local Worker

- Implement queue polling.
- Implement job and step state transitions.
- Implement simple format parsing.
- Connect chunking, embedding, and indexing.

### Phase 3: UI Status and Controls

- Show document statuses.
- Add processing tab.
- Add retry/cancel/pause/resume controls.
- Add task center.

### Phase 4: Strategy and Resource Settings

- Add parser profiles.
- Add pipeline settings UI.
- Apply chunking and embedding settings per job.

### Phase 5: Advanced Parsers and Assets

- Move PDF/DOCX parsing behind backend parser interfaces.
- Add optional OCR/VLM/ASR hooks.
- Add extracted asset handling.

## Design Decisions

- The first implementation should keep a temporary front-end bridge for PDF/DOCX to preserve current functionality while the backend parser interface is introduced.
- Duplicate hash detection should be scoped per collection, so the same file can intentionally exist in different collections.
- Successful job logs should be auto-compacted after the configured retention window. Failed logs should be retained longer and can also be cleared manually.
