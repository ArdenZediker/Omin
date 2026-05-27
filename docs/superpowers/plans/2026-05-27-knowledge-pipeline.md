# Knowledge Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fully controllable local knowledge-file processing pipeline inspired by WeKnora.

**Architecture:** Keep upload intake fast and durable by saving the original file, creating a document record, and queueing a local SQLite-backed processing job. Move parsing, chunking, embedding, indexing, status tracking, logs, retry, cancellation, and UI controls into explicit pipeline units rather than hiding them inside a synchronous import call.

**Tech Stack:** Tauri 2, Rust, rusqlite, React 19, TypeScript, existing `knowledge_chunker.rs`, existing Tauri `invoke` command pattern.

---

## File Structure

- Create: `src-tauri/src/knowledge_pipeline.rs`
  - Owns pipeline data types, SQLite schema helpers, upload-intake helpers, local simple parsers, job execution, retry/cancel/pause state transitions, and query helpers.
- Modify: `src-tauri/src/lib.rs`
  - Registers the module, adds Tauri commands, calls schema migration, and starts the local worker during setup.
- Modify: `src-tauri/src/knowledge_chunker.rs`
  - Only if integration tests reveal chunk metadata or empty-content behavior needs a small adjustment.
- Modify: `src/chat/knowledgeTypes.ts`
  - Adds pipeline status/job/step/log/parser/settings types used by React.
- Modify: `src/components/KnowledgeBaseView.tsx`
  - Switches upload to pipeline intake, displays document processing state, adds processing detail tab, and exposes retry/cancel/pause/resume controls.
- Modify: `docs/rag-flow.md`
  - Updates documentation from synchronous import to controlled pipeline import.
- Test: `src-tauri/src/knowledge_pipeline.rs`
  - Unit tests live in the Rust module under `#[cfg(test)]`.
- Test: `src-tauri/src/knowledge_chunker.rs`
  - Existing tests remain the chunking safety net.

## Working Rules

- Do not revert existing uncommitted user changes in chat-related files.
- Commit after each task that passes verification.
- Keep the old `import_knowledge_document_command` working until the UI has fully moved to the pipeline path.
- Prefer additive schema migrations through `ensure_knowledge_schema`.
- Treat each job attempt as immutable history. Retry creates a new job.

## Task 1: Pipeline Schema And Types

**Files:**
- Create: `src-tauri/src/knowledge_pipeline.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/chat/knowledgeTypes.ts`

- [ ] **Step 1: Add Rust pipeline records and status constants**

Create `src-tauri/src/knowledge_pipeline.rs` with these public records and constants:

```rust
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub const DOCUMENT_STATUS_PENDING: &str = "pending";
pub const DOCUMENT_STATUS_PROCESSING: &str = "processing";
pub const DOCUMENT_STATUS_SEARCHABLE: &str = "searchable";
pub const DOCUMENT_STATUS_PARTIAL: &str = "partial";
pub const DOCUMENT_STATUS_FAILED: &str = "failed";
pub const DOCUMENT_STATUS_CANCELED: &str = "canceled";
pub const DOCUMENT_STATUS_UNSUPPORTED: &str = "unsupported";

pub const JOB_STATUS_QUEUED: &str = "queued";
pub const JOB_STATUS_RUNNING: &str = "running";
pub const JOB_STATUS_PAUSED: &str = "paused";
pub const JOB_STATUS_SUCCEEDED: &str = "succeeded";
pub const JOB_STATUS_FAILED: &str = "failed";
pub const JOB_STATUS_CANCELED: &str = "canceled";

pub const STEP_STATUS_PENDING: &str = "pending";
pub const STEP_STATUS_RUNNING: &str = "running";
pub const STEP_STATUS_SUCCEEDED: &str = "succeeded";
pub const STEP_STATUS_FAILED: &str = "failed";
pub const STEP_STATUS_SKIPPED: &str = "skipped";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeProcessingJobRecord {
    pub id: String,
    pub document_id: String,
    pub collection_id: String,
    pub job_type: String,
    pub status: String,
    pub current_step: Option<String>,
    pub progress: i64,
    pub attempt: i64,
    pub max_attempts: i64,
    pub cancel_requested: bool,
    pub pause_requested: bool,
    pub error_message: Option<String>,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeProcessingStepRecord {
    pub id: String,
    pub job_id: String,
    pub document_id: String,
    pub step_name: String,
    pub status: String,
    pub progress: i64,
    pub error_message: Option<String>,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeProcessingLogRecord {
    pub id: String,
    pub job_id: String,
    pub document_id: String,
    pub level: String,
    pub step_name: Option<String>,
    pub message: String,
    pub details_json: Option<String>,
    pub created_at: i64,
}
```

- [ ] **Step 2: Add schema migration helper**

Add `ensure_pipeline_schema` in `knowledge_pipeline.rs`:

```rust
pub fn ensure_pipeline_schema(connection: &Connection) -> Result<(), String> {
    connection.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS knowledge_processing_jobs (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL,
          collection_id TEXT NOT NULL,
          job_type TEXT NOT NULL,
          status TEXT NOT NULL,
          current_step TEXT,
          progress INTEGER NOT NULL DEFAULT 0,
          attempt INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          cancel_requested INTEGER NOT NULL DEFAULT 0,
          pause_requested INTEGER NOT NULL DEFAULT 0,
          error_message TEXT,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          finished_at INTEGER,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS knowledge_processing_steps (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          document_id TEXT NOT NULL,
          step_name TEXT NOT NULL,
          status TEXT NOT NULL,
          progress INTEGER NOT NULL DEFAULT 0,
          error_message TEXT,
          started_at INTEGER,
          finished_at INTEGER,
          updated_at INTEGER NOT NULL,
          UNIQUE(job_id, step_name)
        );

        CREATE TABLE IF NOT EXISTS knowledge_processing_logs (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          document_id TEXT NOT NULL,
          level TEXT NOT NULL,
          step_name TEXT,
          message TEXT NOT NULL,
          details_json TEXT,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS knowledge_parser_profiles (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          is_default INTEGER NOT NULL DEFAULT 0,
          config_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS knowledge_pipeline_settings (
          id TEXT PRIMARY KEY,
          settings_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        "#,
    ).map_err(|err| err.to_string())?;
    Ok(())
}
```

- [ ] **Step 3: Extend document schema from `lib.rs`**

In `src-tauri/src/lib.rs`, add these columns inside `ensure_knowledge_schema` using the existing `table_has_column` pattern:

```rust
if !table_has_column(connection, "knowledge_documents", "file_hash")? {
    connection.execute("ALTER TABLE knowledge_documents ADD COLUMN file_hash TEXT", []).map_err(|err| err.to_string())?;
}
if !table_has_column(connection, "knowledge_documents", "file_size")? {
    connection.execute("ALTER TABLE knowledge_documents ADD COLUMN file_size INTEGER", []).map_err(|err| err.to_string())?;
}
if !table_has_column(connection, "knowledge_documents", "processing_status")? {
    connection.execute("ALTER TABLE knowledge_documents ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'searchable'", []).map_err(|err| err.to_string())?;
}
if !table_has_column(connection, "knowledge_documents", "error_message")? {
    connection.execute("ALTER TABLE knowledge_documents ADD COLUMN error_message TEXT", []).map_err(|err| err.to_string())?;
}
if !table_has_column(connection, "knowledge_documents", "active_job_id")? {
    connection.execute("ALTER TABLE knowledge_documents ADD COLUMN active_job_id TEXT", []).map_err(|err| err.to_string())?;
}
if !table_has_column(connection, "knowledge_documents", "content_version")? {
    connection.execute("ALTER TABLE knowledge_documents ADD COLUMN content_version INTEGER NOT NULL DEFAULT 1", []).map_err(|err| err.to_string())?;
}
if !table_has_column(connection, "knowledge_documents", "parser_profile_id")? {
    connection.execute("ALTER TABLE knowledge_documents ADD COLUMN parser_profile_id TEXT", []).map_err(|err| err.to_string())?;
}
if !table_has_column(connection, "knowledge_documents", "last_processed_at")? {
    connection.execute("ALTER TABLE knowledge_documents ADD COLUMN last_processed_at INTEGER", []).map_err(|err| err.to_string())?;
}
knowledge_pipeline::ensure_pipeline_schema(connection)?;
```

- [ ] **Step 4: Register module**

At the top of `src-tauri/src/lib.rs`, add:

```rust
mod knowledge_pipeline;
```

- [ ] **Step 5: Add TypeScript types**

In `src/chat/knowledgeTypes.ts`, extend `KnowledgeDocument`:

```ts
  fileHash?: string | null;
  fileSize?: number | null;
  processingStatus?: "pending" | "processing" | "searchable" | "partial" | "failed" | "canceled" | "unsupported" | null;
  errorMessage?: string | null;
  activeJobId?: string | null;
  contentVersion?: number | null;
  parserProfileId?: string | null;
  lastProcessedAt?: number | null;
```

Add:

```ts
export type KnowledgeProcessingJob = {
  id: string;
  documentId: string;
  collectionId: string;
  jobType: "initial_import" | "reparse" | "rechunk" | "revectorize" | "full_rebuild";
  status: "queued" | "running" | "paused" | "succeeded" | "failed" | "canceled";
  currentStep?: string | null;
  progress: number;
  attempt: number;
  maxAttempts: number;
  cancelRequested: boolean;
  pauseRequested: boolean;
  errorMessage?: string | null;
  createdAt: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  updatedAt: number;
};

export type KnowledgeProcessingStep = {
  id: string;
  jobId: string;
  documentId: string;
  stepName: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  progress: number;
  errorMessage?: string | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  updatedAt: number;
};

export type KnowledgeProcessingLog = {
  id: string;
  jobId: string;
  documentId: string;
  level: "info" | "warn" | "error";
  stepName?: string | null;
  message: string;
  detailsJson?: string | null;
  createdAt: number;
};

export type KnowledgeProcessingJobDetail = {
  job: KnowledgeProcessingJob;
  steps: KnowledgeProcessingStep[];
  logs: KnowledgeProcessingLog[];
};
```

- [ ] **Step 6: Verify schema compiles**

Run:

```bash
pnpm build
```

Expected: TypeScript and Vite build exit 0.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/knowledge_pipeline.rs src-tauri/src/lib.rs src/chat/knowledgeTypes.ts
git commit -m "feat: add knowledge pipeline schema"
```

## Task 2: Upload Intake And Job Creation

**Files:**
- Modify: `src-tauri/src/knowledge_pipeline.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/chat/knowledgeTypes.ts`

- [ ] **Step 1: Add upload input/output types**

In `knowledge_pipeline.rs`:

```rust
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineImportInput {
    pub collection_id: Option<String>,
    pub source_name: String,
    pub source_path: Option<String>,
    pub content_bytes: Vec<u8>,
    pub mime_type: Option<String>,
    pub file_extension: Option<String>,
    pub preview_type: Option<String>,
    pub thumbnail_data_url: Option<String>,
    pub parser_profile_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineImportResult {
    pub document_id: String,
    pub job_id: Option<String>,
    pub duplicate_document_id: Option<String>,
    pub status: String,
}
```

- [ ] **Step 2: Implement helpers for hash and file limits**

Add:

```rust
fn content_hash(bytes: &[u8]) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn validate_upload_size(bytes: &[u8]) -> Result<(), String> {
    const DEFAULT_MAX_FILE_SIZE: usize = 100 * 1024 * 1024;
    if bytes.is_empty() {
        return Err("文件为空，无法上传".into());
    }
    if bytes.len() > DEFAULT_MAX_FILE_SIZE {
        return Err("文件超过 100MB 上限".into());
    }
    Ok(())
}
```

- [ ] **Step 3: Implement `create_pipeline_import`**

Add a function that:

- Normalizes collection id with the existing collection id behavior in `lib.rs`.
- Validates file size.
- Computes hash.
- Checks duplicate per collection.
- Saves bytes using existing storage helper from `lib.rs` or a new public wrapper.
- Inserts document with `processing_status = 'pending'`.
- Inserts `initial_import` job.
- Inserts all default step rows.
- Returns `PipelineImportResult`.

Use this exact step list:

```rust
const PIPELINE_STEPS: [&str; 7] = ["validate", "parse", "extract_assets", "chunk", "embed", "index", "finalize"];
```

The duplicate query should be:

```sql
SELECT id FROM knowledge_documents
WHERE collection_id = ?1 AND file_hash = ?2
ORDER BY created_at DESC
LIMIT 1
```

- [ ] **Step 4: Add Tauri command**

In `src-tauri/src/lib.rs`:

```rust
#[tauri::command]
fn import_knowledge_document_pipeline_command(
    app: tauri::AppHandle,
    input: knowledge_pipeline::PipelineImportInput,
) -> Result<knowledge_pipeline::PipelineImportResult, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::create_pipeline_import(&app, &connection, input)
}
```

Register it in `tauri::generate_handler!`.

- [ ] **Step 5: Add TypeScript input/result types**

In `src/chat/knowledgeTypes.ts`:

```ts
export type PipelineImportResult = {
  documentId: string;
  jobId?: string | null;
  duplicateDocumentId?: string | null;
  status: "queued" | "duplicate";
};
```

- [ ] **Step 6: Verify**

Run:

```bash
pnpm build
```

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/knowledge_pipeline.rs src-tauri/src/lib.rs src/chat/knowledgeTypes.ts
git commit -m "feat: queue knowledge imports"
```

## Task 3: Local Worker And Simple Parsers

**Files:**
- Modify: `src-tauri/src/knowledge_pipeline.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add parser result type**

In `knowledge_pipeline.rs`:

```rust
#[derive(Debug, Clone)]
struct ParsedDocument {
    content: String,
    preview_type: String,
    metadata_json: Option<String>,
}
```

- [ ] **Step 2: Implement simple parser**

Add:

```rust
fn parse_simple_document(source_name: &str, file_extension: Option<&str>, bytes: &[u8]) -> Result<ParsedDocument, String> {
    let ext = file_extension.unwrap_or_default().trim_start_matches('.').to_lowercase();
    let text = String::from_utf8_lossy(bytes).to_string();
    match ext.as_str() {
        "md" | "markdown" => Ok(ParsedDocument { content: text, preview_type: "markdown".into(), metadata_json: None }),
        "txt" | "text" | "log" | "html" | "htm" | "xml" | "yml" | "yaml" | "json" => {
            Ok(ParsedDocument { content: text, preview_type: "text".into(), metadata_json: None })
        }
        "csv" => Ok(ParsedDocument { content: csv_to_markdown(&text, ','), preview_type: "markdown".into(), metadata_json: None }),
        "tsv" => Ok(ParsedDocument { content: csv_to_markdown(&text, '\t'), preview_type: "markdown".into(), metadata_json: None }),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "avif" => {
            Ok(ParsedDocument {
                content: format!("![{}]({})", source_name, source_name),
                preview_type: "image".into(),
                metadata_json: Some("{\"mode\":\"store_with_placeholder\"}".into()),
            })
        }
        "" => Err("无法识别文件扩展名".into()),
        other => Err(format!("暂不支持解析 .{other} 文件，原文件已保存")),
    }
}

fn csv_to_markdown(text: &str, delimiter: char) -> String {
    let mut rows = Vec::new();
    for line in text.lines() {
        let cells = line
            .split(delimiter)
            .map(|cell| cell.trim().replace('|', "\\|"))
            .collect::<Vec<_>>();
        if !cells.is_empty() {
            rows.push(cells);
        }
    }
    if rows.is_empty() {
        return String::new();
    }
    let width = rows.iter().map(|row| row.len()).max().unwrap_or(0);
    for row in &mut rows {
        while row.len() < width {
            row.push(String::new());
        }
    }
    let mut out = String::new();
    out.push_str("| ");
    out.push_str(&rows[0].join(" | "));
    out.push_str(" |\n|");
    for _ in 0..width {
        out.push_str(" --- |");
    }
    out.push('\n');
    for row in rows.iter().skip(1) {
        out.push_str("| ");
        out.push_str(&row.join(" | "));
        out.push_str(" |\n");
    }
    out
}
```

- [ ] **Step 3: Implement job executor**

Add `run_next_pipeline_job(app: &tauri::AppHandle) -> Result<bool, String>` that:

- Opens the database.
- Selects one queued job.
- Marks it running.
- Loads the document and stored file.
- Runs `validate`, `parse`, `chunk`, `embed`, `index`, and `finalize`.
- Checks cancellation between steps.
- Marks unsupported formats as `unsupported`.
- Marks embedding failure after chunking as `partial`.

Use the existing `knowledge_chunker::split_document_text` and existing embedding helper in `lib.rs`. If private helpers block compilation, move only the minimal shared helper signatures into `knowledge_pipeline.rs` or make narrowly scoped wrappers in `lib.rs`.

- [ ] **Step 4: Start worker in Tauri setup**

In `src-tauri/src/lib.rs` setup closure, after tray setup code is initialized, spawn:

```rust
let worker_app = app.handle().clone();
tauri::async_runtime::spawn(async move {
    loop {
        if let Err(err) = knowledge_pipeline::run_pipeline_worker_tick(&worker_app) {
            eprintln!("[Omni] knowledge pipeline worker error: {err}");
        }
        tokio::time::sleep(std::time::Duration::from_millis(750)).await;
    }
});
```

Implement `run_pipeline_worker_tick` as a small wrapper around `run_next_pipeline_job`.

- [ ] **Step 5: Verify**

Run:

```bash
pnpm build
cd src-tauri
cargo test knowledge_pipeline
```

Expected: `pnpm build` exits 0. Rust tests compile and pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/knowledge_pipeline.rs src-tauri/src/lib.rs
git commit -m "feat: process queued knowledge jobs"
```

## Task 4: Job Query And Control Commands

**Files:**
- Modify: `src-tauri/src/knowledge_pipeline.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/chat/knowledgeTypes.ts`

- [ ] **Step 1: Add query helpers**

Implement:

```rust
pub fn list_processing_jobs(connection: &Connection, document_id: Option<String>) -> Result<Vec<KnowledgeProcessingJobRecord>, String>
pub fn load_processing_job_detail(connection: &Connection, job_id: &str) -> Result<KnowledgeProcessingJobDetail, String>
```

Add:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeProcessingJobDetail {
    pub job: KnowledgeProcessingJobRecord,
    pub steps: Vec<KnowledgeProcessingStepRecord>,
    pub logs: Vec<KnowledgeProcessingLogRecord>,
}
```

- [ ] **Step 2: Add control helpers**

Implement:

```rust
pub fn request_job_pause(connection: &Connection, job_id: &str) -> Result<(), String>
pub fn request_job_resume(connection: &Connection, job_id: &str) -> Result<(), String>
pub fn request_job_cancel(connection: &Connection, job_id: &str) -> Result<(), String>
pub fn retry_job(connection: &Connection, job_id: &str) -> Result<KnowledgeProcessingJobRecord, String>
pub fn create_document_job(connection: &Connection, document_id: &str, job_type: &str) -> Result<KnowledgeProcessingJobRecord, String>
```

Rules:

- Pause sets `pause_requested = 1`.
- Resume changes `paused` back to `queued` and clears `pause_requested`.
- Cancel sets `cancel_requested = 1`.
- Retry copies `document_id`, `collection_id`, `job_type`, and `max_attempts` into a new queued job with `attempt = old.attempt + 1`.
- Reparse/rechunk/revectorize call `create_document_job`.

- [ ] **Step 3: Add Tauri commands**

Add commands in `lib.rs`:

```rust
#[tauri::command]
fn load_knowledge_processing_jobs_command(app: tauri::AppHandle, document_id: Option<String>) -> Result<Vec<knowledge_pipeline::KnowledgeProcessingJobRecord>, String>

#[tauri::command]
fn load_knowledge_processing_job_detail_command(app: tauri::AppHandle, job_id: String) -> Result<knowledge_pipeline::KnowledgeProcessingJobDetail, String>

#[tauri::command]
fn pause_knowledge_processing_job_command(app: tauri::AppHandle, job_id: String) -> Result<(), String>

#[tauri::command]
fn resume_knowledge_processing_job_command(app: tauri::AppHandle, job_id: String) -> Result<(), String>

#[tauri::command]
fn cancel_knowledge_processing_job_command(app: tauri::AppHandle, job_id: String) -> Result<(), String>

#[tauri::command]
fn retry_knowledge_processing_job_command(app: tauri::AppHandle, job_id: String) -> Result<knowledge_pipeline::KnowledgeProcessingJobRecord, String>

#[tauri::command]
fn reparse_knowledge_document_command(app: tauri::AppHandle, document_id: String) -> Result<knowledge_pipeline::KnowledgeProcessingJobRecord, String>

#[tauri::command]
fn rechunk_knowledge_document_command(app: tauri::AppHandle, document_id: String) -> Result<knowledge_pipeline::KnowledgeProcessingJobRecord, String>

#[tauri::command]
fn revectorize_knowledge_document_command(app: tauri::AppHandle, document_id: String) -> Result<knowledge_pipeline::KnowledgeProcessingJobRecord, String>
```

Register all commands.

- [ ] **Step 4: Verify**

Run:

```bash
pnpm build
```

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/knowledge_pipeline.rs src-tauri/src/lib.rs src/chat/knowledgeTypes.ts
git commit -m "feat: control knowledge processing jobs"
```

## Task 5: Front-End Upload And Status UI

**Files:**
- Modify: `src/components/KnowledgeBaseView.tsx`
- Modify: `src/chat/knowledgeTypes.ts`

- [ ] **Step 1: Switch upload command**

In `KnowledgeBaseView.tsx`, replace `import_knowledge_document_command` inside `importFile` with:

```ts
await invoke<PipelineImportResult>("import_knowledge_document_pipeline_command", {
  input: {
    collectionId,
    sourceName: file.name,
    sourcePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    contentBytes: Array.from(bytes),
    mimeType: file.type || null,
    fileExtension: extension,
    previewType,
    thumbnailDataUrl,
    parserProfileId: null,
  },
});
```

Keep thumbnail generation. Remove front-end PDF/DOCX text extraction from the upload path only after the backend parser bridge is ready. Until then, leave helper functions in place for preview/detail rendering.

- [ ] **Step 2: Add status label helpers**

Add near existing label helpers:

```ts
function getProcessingStatusLabel(status?: KnowledgeDocument["processingStatus"] | null) {
  switch (status) {
    case "pending":
      return "等待处理";
    case "processing":
      return "处理中";
    case "searchable":
      return "可检索";
    case "partial":
      return "部分可用";
    case "failed":
      return "处理失败";
    case "canceled":
      return "已取消";
    case "unsupported":
      return "仅保存";
    default:
      return "可检索";
  }
}
```

- [ ] **Step 3: Show status badges in document cards**

In the document card render block, add a compact status line using:

```tsx
<span className="rounded-none border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600">
  {getProcessingStatusLabel(document.processingStatus)}
</span>
```

If `document.errorMessage` exists, show:

```tsx
<div className="mt-1 line-clamp-1 text-xs text-red-500">{document.errorMessage}</div>
```

- [ ] **Step 4: Add processing tab**

Extend `KnowledgeDocumentDetailView`:

```ts
type KnowledgeDocumentDetailView = "preview" | "chunks" | "processing";
```

Add a tab button next to preview/chunks:

```tsx
<button type="button" onClick={() => setSelectedDocumentDetailView("processing")}>
  处理
</button>
```

Render active status, active job id, error message, chunk count, and vectorized count in the processing view.

- [ ] **Step 5: Add job actions**

For selected documents with `activeJobId`, add buttons that call:

```ts
await invoke("cancel_knowledge_processing_job_command", { jobId: selectedDocument.activeJobId });
await invoke("retry_knowledge_processing_job_command", { jobId: selectedDocument.activeJobId });
await invoke("reparse_knowledge_document_command", { documentId: selectedDocument.id });
await invoke("revectorize_knowledge_document_command", { documentId: selectedDocument.id });
```

After each action, call `refreshLibrary()`.

- [ ] **Step 6: Verify**

Run:

```bash
pnpm build
```

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/components/KnowledgeBaseView.tsx src/chat/knowledgeTypes.ts
git commit -m "feat: show knowledge processing status"
```

## Task 6: Settings, Retention, And Documentation

**Files:**
- Modify: `src-tauri/src/knowledge_pipeline.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/components/KnowledgeBaseView.tsx`
- Modify: `docs/rag-flow.md`

- [ ] **Step 1: Add settings records**

In `knowledge_pipeline.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgePipelineSettings {
    pub enabled: bool,
    pub max_concurrent_jobs: i64,
    pub max_file_size_mb: i64,
    pub max_attempts: i64,
    pub job_timeout_ms: i64,
    pub step_timeout_ms: i64,
    pub keep_successful_logs_days: i64,
    pub keep_failed_logs_days: i64,
}

impl Default for KnowledgePipelineSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            max_concurrent_jobs: 1,
            max_file_size_mb: 100,
            max_attempts: 3,
            job_timeout_ms: 300_000,
            step_timeout_ms: 120_000,
            keep_successful_logs_days: 7,
            keep_failed_logs_days: 30,
        }
    }
}
```

- [ ] **Step 2: Add settings commands**

Implement and register:

```rust
load_knowledge_pipeline_settings_command
save_knowledge_pipeline_settings_command
cleanup_knowledge_processing_logs_command
```

Saving settings should clamp values:

- `max_concurrent_jobs`: 1 to 4.
- `max_file_size_mb`: 1 to 1024.
- `max_attempts`: 0 to 10.
- timeouts: minimum 10 seconds.

- [ ] **Step 3: Add a compact task center panel**

In `KnowledgeBaseView.tsx`, add a queue section near the sidebar/footer or header menu that shows:

- number of queued/running/failed jobs.
- buttons for retry failed and cleanup completed logs.

Use existing button styles rather than introducing a new visual system.

- [ ] **Step 4: Update `docs/rag-flow.md`**

Replace the import-stage description with:

```md
上传阶段会先保存原文件和文档记录，然后创建本地处理任务。后台任务按 validate、parse、extract_assets、chunk、embed、index、finalize 的顺序推进。用户可以在知识库页面看到状态、日志、失败原因，并对任务执行暂停、继续、取消、重试、重新解析或重新向量化。
```

- [ ] **Step 5: Verify**

Run:

```bash
pnpm build
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/knowledge_pipeline.rs src-tauri/src/lib.rs src/components/KnowledgeBaseView.tsx docs/rag-flow.md
git commit -m "feat: configure knowledge pipeline controls"
```

## Task 7: End-To-End Verification

**Files:**
- No planned source edits unless verification finds a defect.

- [ ] **Step 1: Run full frontend build**

```bash
pnpm build
```

Expected: exit 0.

- [ ] **Step 2: Run Rust tests**

```bash
cd src-tauri
cargo test
```

Expected: exit 0.

- [ ] **Step 3: Manual smoke test**

Run the app:

```bash
pnpm tauri dev
```

Manual checks:

- Upload a `.txt` file and confirm it appears immediately as pending/processing, then searchable.
- Upload a `.csv` file and confirm chunks contain markdown-table text.
- Upload an unsupported file and confirm original file remains with unsupported status.
- Cancel a queued/running job and confirm original file remains.
- Retry a failed job and confirm a new job is created.
- Ask a chat question against a searchable document and confirm citations still work.

- [ ] **Step 4: Commit fixes if needed**

If verification requires fixes:

```bash
git status --short
git add src-tauri/src/knowledge_pipeline.rs src-tauri/src/lib.rs src-tauri/src/knowledge_chunker.rs src/chat/knowledgeTypes.ts src/components/KnowledgeBaseView.tsx docs/rag-flow.md
git commit -m "fix: stabilize knowledge pipeline"
```

If no fixes are needed, do not create an empty commit.

## Spec Coverage Review

- Durable upload intake: Tasks 1 and 2.
- Local background processing jobs: Task 3.
- Step-level progress and logs: Tasks 1, 3, and 4.
- Parser profiles and resource controls: Tasks 1 and 6.
- Retry, cancel, pause, resume, reparse, rechunk, revectorize: Task 4.
- Existing document compatibility: Task 1 default `searchable` migration.
- UI visibility and controls: Tasks 5 and 6.
- Retrieval compatibility: Task 3 indexing rules and Task 7 smoke test.
- Documentation: Task 6.
