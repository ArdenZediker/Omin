#![allow(dead_code)]

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

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

const PIPELINE_STEPS: [&str; 7] = [
    "validate",
    "parse",
    "extract_assets",
    "chunk",
    "embed",
    "index",
    "finalize",
];
const DEFAULT_JOB_PRIORITY: i64 = 0;
const RETRY_BACKOFF_MS: [i64; 3] = [30_000, 120_000, 600_000];

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
    pub priority: i64,
    pub fail_count: i64,
    pub next_run_at: Option<i64>,
    pub source_job_id: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeProcessingStatusSummary {
    pub scope: String,
    pub collection_id: Option<String>,
    pub queued: i64,
    pub running: i64,
    pub failed: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedJobQueryInput {
    pub collection_id: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedJobQueryResult {
    pub scope: String,
    pub collection_id: Option<String>,
    pub total: i64,
    pub has_more: bool,
    pub jobs: Vec<KnowledgeProcessingJobRecord>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryFailedJobsInput {
    pub collection_id: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryFailedJobsResult {
    pub scope: String,
    pub collection_id: Option<String>,
    pub attempted: i64,
    pub retried: i64,
    pub skipped: i64,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeProcessingDeadLetterRecord {
    pub id: String,
    pub job_id: String,
    pub document_id: String,
    pub collection_id: String,
    pub job_type: String,
    pub status: String,
    pub error_message: Option<String>,
    pub fail_count: i64,
    pub attempt: i64,
    pub max_attempts: i64,
    pub first_failed_at: i64,
    pub last_failed_at: i64,
    pub replayed_at: Option<i64>,
    pub replayed_job_id: Option<String>,
    pub resolved_at: Option<i64>,
    pub metadata_json: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeadLetterQueryInput {
    pub collection_id: Option<String>,
    pub status: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeadLetterQueryResult {
    pub scope: String,
    pub collection_id: Option<String>,
    pub status: Option<String>,
    pub total: i64,
    pub has_more: bool,
    pub items: Vec<KnowledgeProcessingDeadLetterRecord>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayDeadLettersInput {
    pub collection_id: Option<String>,
    pub status: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayDeadLettersResult {
    pub scope: String,
    pub collection_id: Option<String>,
    pub attempted: i64,
    pub replayed: i64,
    pub skipped: i64,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeProcessingJobDetail {
    pub job: KnowledgeProcessingJobRecord,
    pub steps: Vec<KnowledgeProcessingStepRecord>,
    pub logs: Vec<KnowledgeProcessingLogRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct KnowledgePipelineSettings {
    pub enabled: bool,
    pub max_concurrent_jobs: i64,
    pub per_collection_max_running: i64,
    pub max_file_size_mb: i64,
    pub max_attempts: i64,
    pub max_auto_retries: i64,
    pub job_timeout_ms: i64,
    pub step_timeout_ms: i64,
    pub keep_successful_logs_days: i64,
    pub keep_failed_logs_days: i64,
}

impl Default for KnowledgePipelineSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            max_concurrent_jobs: 2,
            per_collection_max_running: 1,
            max_file_size_mb: 100,
            max_attempts: 3,
            max_auto_retries: 3,
            job_timeout_ms: 300_000,
            step_timeout_ms: 120_000,
            keep_successful_logs_days: 7,
            keep_failed_logs_days: 30,
        }
    }
}

impl KnowledgePipelineSettings {
    fn clamped(mut self) -> Self {
        const MIN_TIMEOUT_MS: i64 = 10_000;

        self.max_concurrent_jobs = self.max_concurrent_jobs.clamp(1, 4);
        self.per_collection_max_running = self.per_collection_max_running.clamp(1, 4);
        if self.per_collection_max_running > self.max_concurrent_jobs {
            self.per_collection_max_running = self.max_concurrent_jobs;
        }
        self.max_file_size_mb = self.max_file_size_mb.clamp(1, 1024);
        self.max_attempts = self.max_attempts.clamp(0, 10);
        self.max_auto_retries = self.max_auto_retries.clamp(0, 10);
        self.job_timeout_ms = self.job_timeout_ms.max(MIN_TIMEOUT_MS);
        self.step_timeout_ms = self.step_timeout_ms.max(MIN_TIMEOUT_MS);
        self.keep_successful_logs_days = self.keep_successful_logs_days.max(0);
        self.keep_failed_logs_days = self.keep_failed_logs_days.max(0);

        self
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineImportInput {
    pub collection_id: Option<String>,
    pub source_name: String,
    pub source_path: Option<String>,
    pub content: Option<String>,
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

#[derive(Debug, Clone)]
struct ParsedDocument {
    content: String,
    preview_type: String,
    metadata_json: Option<String>,
}

#[derive(Debug, Clone)]
struct PipelineJobClaim {
    id: String,
    document_id: String,
    collection_id: String,
}

#[derive(Debug, Clone)]
struct PipelineDocumentSource {
    id: String,
    collection_id: String,
    source_name: String,
    stored_file_path: Option<String>,
    file_extension: Option<String>,
    content: Option<String>,
}

fn table_has_column(connection: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let sql = format!("PRAGMA table_info({table})");
    let mut stmt = connection.prepare(&sql).map_err(|err| err.to_string())?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    Ok(columns.iter().any(|item| item == column))
}

pub fn ensure_pipeline_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
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
          priority INTEGER NOT NULL DEFAULT 0,
          fail_count INTEGER NOT NULL DEFAULT 0,
          next_run_at INTEGER,
          source_job_id TEXT,
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

        CREATE TABLE IF NOT EXISTS knowledge_processing_dead_letters (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL UNIQUE,
          document_id TEXT NOT NULL,
          collection_id TEXT NOT NULL,
          job_type TEXT NOT NULL,
          status TEXT NOT NULL,
          error_message TEXT,
          fail_count INTEGER NOT NULL DEFAULT 0,
          attempt INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 0,
          first_failed_at INTEGER NOT NULL,
          last_failed_at INTEGER NOT NULL,
          replayed_at INTEGER,
          replayed_job_id TEXT,
          resolved_at INTEGER,
          metadata_json TEXT
        );
        "#,
        )
        .map_err(|err| err.to_string())?;

    if !table_has_column(connection, "knowledge_processing_jobs", "priority")? {
        connection
            .execute(
                "ALTER TABLE knowledge_processing_jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|err| err.to_string())?;
    }
    if !table_has_column(connection, "knowledge_processing_jobs", "fail_count")? {
        connection
            .execute(
                "ALTER TABLE knowledge_processing_jobs ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|err| err.to_string())?;
    }
    if !table_has_column(connection, "knowledge_processing_jobs", "next_run_at")? {
        connection
            .execute(
                "ALTER TABLE knowledge_processing_jobs ADD COLUMN next_run_at INTEGER",
                [],
            )
            .map_err(|err| err.to_string())?;
    }
    if !table_has_column(connection, "knowledge_processing_jobs", "source_job_id")? {
        connection
            .execute(
                "ALTER TABLE knowledge_processing_jobs ADD COLUMN source_job_id TEXT",
                [],
            )
            .map_err(|err| err.to_string())?;
    }
    connection
        .execute_batch(
            r#"
        CREATE INDEX IF NOT EXISTS idx_knowledge_processing_jobs_status_next_run_created
          ON knowledge_processing_jobs(status, next_run_at, created_at, id);

        CREATE INDEX IF NOT EXISTS idx_knowledge_processing_jobs_collection_status_created
          ON knowledge_processing_jobs(collection_id, status, created_at, id);

        CREATE INDEX IF NOT EXISTS idx_knowledge_dead_letters_collection_status_failed_at
          ON knowledge_processing_dead_letters(collection_id, status, last_failed_at, id);
        "#,
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn current_timestamp_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn normalize_knowledge_collection_id(value: Option<String>) -> String {
    value.unwrap_or_default().trim().to_string()
}

fn collection_exists(connection: &Connection, collection_id: &str) -> Result<bool, String> {
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(1) FROM knowledge_collections WHERE id = ?1",
            params![collection_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    Ok(count > 0)
}

fn content_hash(bytes: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("fnv1a64:{hash:016x}")
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

fn sanitize_storage_file_name(value: &str) -> String {
    let mut cleaned = value
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ if ch.is_control() => '_',
            _ => ch,
        })
        .collect::<String>();
    cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.is_empty() {
        "document".to_string()
    } else {
        cleaned
    }
}

fn file_extension_from_name(value: &str) -> Option<String> {
    Path::new(value)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.trim().to_lowercase())
        .filter(|ext| !ext.is_empty())
}

fn normalize_file_extension(extension: Option<String>, source_name: &str) -> Option<String> {
    extension
        .and_then(|value| {
            let trimmed = value.trim().trim_start_matches('.').to_lowercase();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        })
        .or_else(|| file_extension_from_name(source_name))
}

fn infer_preview_type(extension: Option<&str>, mime_type: Option<&str>) -> String {
    let extension = extension.unwrap_or_default().to_lowercase();
    let mime_type = mime_type.unwrap_or_default().to_lowercase();

    if matches!(
        extension.as_str(),
        "md" | "markdown"
            | "txt"
            | "log"
            | "json"
            | "csv"
            | "tsv"
            | "html"
            | "htm"
            | "xml"
            | "yml"
            | "yaml"
            | "js"
            | "jsx"
            | "ts"
            | "tsx"
            | "py"
            | "rs"
            | "css"
            | "toml"
            | "ini"
            | "sql"
            | "sh"
            | "bat"
            | "cmd"
    ) || mime_type.starts_with("text/")
        || mime_type == "application/json"
    {
        return if extension == "md" || extension == "markdown" {
            "markdown".to_string()
        } else {
            "text".to_string()
        };
    }

    if extension == "pdf" || mime_type == "application/pdf" {
        return "pdf".to_string();
    }

    if extension == "docx"
        || mime_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    {
        return "docx".to_string();
    }

    if matches!(
        extension.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "avif" | "ico"
    ) || mime_type.starts_with("image/")
    {
        return "image".to_string();
    }

    "unsupported".to_string()
}

fn preview_text(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let clipped: String = trimmed.chars().take(max_chars.saturating_sub(3)).collect();
    format!("{clipped}...")
}

fn knowledge_files_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    let root = app_data_dir.join("knowledge_files");
    fs::create_dir_all(&root).map_err(|err| err.to_string())?;
    Ok(root)
}

fn document_file_name(source_name: &str, document_id: &str) -> String {
    let base = sanitize_storage_file_name(source_name);
    if base == "document" {
        format!("{document_id}.bin")
    } else {
        base
    }
}

fn store_knowledge_document_bytes(
    app: &tauri::AppHandle,
    collection_id: &str,
    document_id: &str,
    source_name: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    let collection_dir = sanitize_storage_file_name(collection_id);
    let document_dir = sanitize_storage_file_name(document_id);
    let file_name = document_file_name(source_name, document_id);
    let stored_path = knowledge_files_root(app)?
        .join(collection_dir)
        .join(document_dir)
        .join(file_name);
    if let Some(parent) = stored_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(&stored_path, bytes).map_err(|err| err.to_string())?;
    Ok(stored_path)
}

pub fn create_pipeline_import(
    app: &tauri::AppHandle,
    connection: &Connection,
    input: PipelineImportInput,
) -> Result<PipelineImportResult, String> {
    let collection_id = normalize_knowledge_collection_id(input.collection_id);
    if !collection_exists(connection, &collection_id)? {
        return Err(format!("知识库不存在: {collection_id}"));
    }

    let source_name = input.source_name.trim().to_string();
    if source_name.is_empty() {
        return Err("sourceName 不能为空".into());
    }

    validate_upload_size(&input.content_bytes)?;
    let file_hash = content_hash(&input.content_bytes);
    if let Some(duplicate_document_id) = connection
        .query_row(
            r#"
            SELECT id FROM knowledge_documents
            WHERE collection_id = ?1 AND file_hash = ?2
            ORDER BY created_at DESC
            LIMIT 1
            "#,
            params![collection_id, file_hash],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?
    {
        return Ok(PipelineImportResult {
            document_id: duplicate_document_id.clone(),
            job_id: None,
            duplicate_document_id: Some(duplicate_document_id),
            status: "duplicate".to_string(),
        });
    }

    let now = current_timestamp_ms();
    let document_id = uuid::Uuid::new_v4().to_string();
    let job_id = uuid::Uuid::new_v4().to_string();
    let file_extension = normalize_file_extension(input.file_extension, &source_name);
    let mime_type = input
        .mime_type
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let preview_type = input
        .preview_type
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| infer_preview_type(file_extension.as_deref(), mime_type.as_deref()));
    let source_path = input
        .source_path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let thumbnail_data_url = input
        .thumbnail_data_url
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let parser_profile_id = input
        .parser_profile_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let stored_file_path = store_knowledge_document_bytes(
        app,
        &collection_id,
        &document_id,
        &source_name,
        &input.content_bytes,
    )?
    .to_string_lossy()
    .to_string();
    let extracted_content = input
        .content
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let content_preview = extracted_content
        .as_deref()
        .map(|content| preview_text(content, 240))
        .unwrap_or_else(|| preview_text(&source_name, 240));
    let file_size = input.content_bytes.len() as i64;

    let tx = connection
        .unchecked_transaction()
        .map_err(|err| err.to_string())?;
    tx.execute(
        r#"
        INSERT INTO knowledge_documents (
          id, collection_id, source_name, source_path, stored_file_path, mime_type, file_extension,
          preview_type, content, content_preview, chunk_count, thumbnail_data_url, tags_json,
          favorite, access_count, last_accessed_at, title_hierarchy, file_hash, file_size,
          processing_status, error_message, active_job_id, content_version, parser_profile_id,
          last_processed_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7,
          ?8, ?9, ?10, 0, ?11, '[]',
          0, 0, NULL, NULL, ?12, ?13,
          ?14, NULL, ?15, 1, ?16,
          NULL, ?17, ?18
        )
        "#,
        params![
            document_id,
            collection_id,
            source_name,
            source_path,
            stored_file_path,
            mime_type,
            file_extension,
            preview_type,
            extracted_content,
            content_preview,
            thumbnail_data_url,
            file_hash,
            file_size,
            DOCUMENT_STATUS_PENDING,
            job_id,
            parser_profile_id,
            now,
            now,
        ],
    )
    .map_err(|err| err.to_string())?;

    tx.execute(
        r#"
        INSERT INTO knowledge_processing_jobs (
          id, document_id, collection_id, job_type, status, current_step, progress, attempt,
          max_attempts, priority, fail_count, next_run_at, source_job_id, cancel_requested,
          pause_requested, error_message, created_at, started_at, finished_at, updated_at
        ) VALUES (?1, ?2, ?3, 'initial_import', ?4, ?5, 0, 0, 3, ?6, 0, NULL, NULL, 0, 0, NULL, ?7, NULL, NULL, ?8)
        "#,
        params![
            job_id,
            document_id,
            collection_id,
            JOB_STATUS_QUEUED,
            PIPELINE_STEPS[0],
            DEFAULT_JOB_PRIORITY,
            now,
            now,
        ],
    )
    .map_err(|err| err.to_string())?;

    {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO knowledge_processing_steps (
                  id, job_id, document_id, step_name, status, progress, error_message,
                  started_at, finished_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL, NULL, NULL, ?6)
                "#,
            )
            .map_err(|err| err.to_string())?;
        for step_name in PIPELINE_STEPS {
            stmt.execute(params![
                uuid::Uuid::new_v4().to_string(),
                job_id,
                document_id,
                step_name,
                STEP_STATUS_PENDING,
                now,
            ])
            .map_err(|err| err.to_string())?;
        }
    }

    tx.commit().map_err(|err| err.to_string())?;

    Ok(PipelineImportResult {
        document_id,
        job_id: Some(job_id),
        duplicate_document_id: None,
        status: "queued".to_string(),
    })
}

fn parse_simple_document(
    source_name: &str,
    file_extension: Option<&str>,
    bytes: &[u8],
    bridged_content: Option<&str>,
) -> Result<ParsedDocument, String> {
    let ext = file_extension
        .unwrap_or_default()
        .trim_start_matches('.')
        .to_lowercase();
    let text = String::from_utf8_lossy(bytes).to_string();

    match ext.as_str() {
        "md" | "markdown" => Ok(ParsedDocument {
            content: text,
            preview_type: "markdown".into(),
            metadata_json: None,
        }),
        "txt" | "text" | "log" | "html" | "htm" | "xml" | "yml" | "yaml" | "json" => {
            Ok(ParsedDocument {
                content: text,
                preview_type: "text".into(),
                metadata_json: None,
            })
        }
        "csv" => Ok(ParsedDocument {
            content: csv_to_markdown(&text, ','),
            preview_type: "markdown".into(),
            metadata_json: None,
        }),
        "tsv" => Ok(ParsedDocument {
            content: csv_to_markdown(&text, '\t'),
            preview_type: "markdown".into(),
            metadata_json: None,
        }),
        "pdf" | "docx" => {
            let content = bridged_content
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    format!("unsupported file extension .{ext}; original file has been stored")
                })?;
            Ok(ParsedDocument {
                content: content.to_string(),
                preview_type: ext.clone(),
                metadata_json: Some("{\"mode\":\"frontend_bridge\"}".into()),
            })
        }
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "avif" => Ok(ParsedDocument {
            content: format!("![{}]({})", source_name, source_name),
            preview_type: "image".into(),
            metadata_json: Some("{\"mode\":\"store_with_placeholder\"}".into()),
        }),
        "" => Err("unable to identify file extension".into()),
        other => Err(format!(
            "unsupported file extension .{other}; original file has been stored"
        )),
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

fn open_pipeline_connection(app: &tauri::AppHandle) -> Result<Connection, String> {
    crate::open_sqlite_connection(app)
}

fn read_job_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<KnowledgeProcessingJobRecord> {
    Ok(KnowledgeProcessingJobRecord {
        id: row.get(0)?,
        document_id: row.get(1)?,
        collection_id: row.get(2)?,
        job_type: row.get(3)?,
        status: row.get(4)?,
        current_step: row.get(5)?,
        progress: row.get(6)?,
        attempt: row.get(7)?,
        max_attempts: row.get(8)?,
        priority: row.get(9)?,
        fail_count: row.get(10)?,
        next_run_at: row.get(11)?,
        source_job_id: row.get(12)?,
        cancel_requested: row.get(13)?,
        pause_requested: row.get(14)?,
        error_message: row.get(15)?,
        created_at: row.get(16)?,
        started_at: row.get(17)?,
        finished_at: row.get(18)?,
        updated_at: row.get(19)?,
    })
}

fn read_step_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<KnowledgeProcessingStepRecord> {
    Ok(KnowledgeProcessingStepRecord {
        id: row.get(0)?,
        job_id: row.get(1)?,
        document_id: row.get(2)?,
        step_name: row.get(3)?,
        status: row.get(4)?,
        progress: row.get(5)?,
        error_message: row.get(6)?,
        started_at: row.get(7)?,
        finished_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn read_log_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<KnowledgeProcessingLogRecord> {
    Ok(KnowledgeProcessingLogRecord {
        id: row.get(0)?,
        job_id: row.get(1)?,
        document_id: row.get(2)?,
        level: row.get(3)?,
        step_name: row.get(4)?,
        message: row.get(5)?,
        details_json: row.get(6)?,
        created_at: row.get(7)?,
    })
}

fn read_dead_letter_record(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<KnowledgeProcessingDeadLetterRecord> {
    Ok(KnowledgeProcessingDeadLetterRecord {
        id: row.get(0)?,
        job_id: row.get(1)?,
        document_id: row.get(2)?,
        collection_id: row.get(3)?,
        job_type: row.get(4)?,
        status: row.get(5)?,
        error_message: row.get(6)?,
        fail_count: row.get(7)?,
        attempt: row.get(8)?,
        max_attempts: row.get(9)?,
        first_failed_at: row.get(10)?,
        last_failed_at: row.get(11)?,
        replayed_at: row.get(12)?,
        replayed_job_id: row.get(13)?,
        resolved_at: row.get(14)?,
        metadata_json: row.get(15)?,
    })
}

fn load_job_record(
    connection: &Connection,
    job_id: &str,
) -> Result<KnowledgeProcessingJobRecord, String> {
    connection
        .query_row(
            r#"
            SELECT id, document_id, collection_id, job_type, status, current_step, progress,
                   attempt, max_attempts, priority, fail_count, next_run_at, source_job_id,
                   cancel_requested, pause_requested, error_message, created_at, started_at,
                   finished_at, updated_at
            FROM knowledge_processing_jobs
            WHERE id = ?1
            "#,
            params![job_id],
            read_job_record,
        )
        .optional()
        .map_err(|err| err.to_string())?
        .ok_or_else(|| format!("knowledge processing job not found: {job_id}"))
}

fn insert_default_step_rows(
    connection: &Connection,
    job_id: &str,
    document_id: &str,
    now: i64,
) -> Result<(), String> {
    let mut stmt = connection
        .prepare(
            r#"
            INSERT INTO knowledge_processing_steps (
              id, job_id, document_id, step_name, status, progress, error_message,
              started_at, finished_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL, NULL, NULL, ?6)
            "#,
        )
        .map_err(|err| err.to_string())?;

    for step_name in PIPELINE_STEPS {
        stmt.execute(params![
            uuid::Uuid::new_v4().to_string(),
            job_id,
            document_id,
            step_name,
            STEP_STATUS_PENDING,
            now,
        ])
        .map_err(|err| err.to_string())?;
    }

    Ok(())
}

fn insert_job_record(
    connection: &Connection,
    document_id: &str,
    collection_id: &str,
    job_type: &str,
    attempt: i64,
    max_attempts: i64,
    priority: i64,
    fail_count: i64,
    next_run_at: Option<i64>,
    source_job_id: Option<&str>,
    now: i64,
) -> Result<KnowledgeProcessingJobRecord, String> {
    let job_id = uuid::Uuid::new_v4().to_string();
    connection
        .execute(
            r#"
            INSERT INTO knowledge_processing_jobs (
              id, document_id, collection_id, job_type, status, current_step, progress, attempt,
              max_attempts, priority, fail_count, next_run_at, source_job_id, cancel_requested,
              pause_requested, error_message, created_at, started_at, finished_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9, ?10, ?11, ?12, 0, 0, NULL, ?13, NULL, NULL, ?14)
            "#,
            params![
                job_id,
                document_id,
                collection_id,
                job_type,
                JOB_STATUS_QUEUED,
                PIPELINE_STEPS[0],
                attempt,
                max_attempts,
                priority,
                fail_count,
                next_run_at,
                source_job_id,
                now,
                now,
            ],
        )
        .map_err(|err| err.to_string())?;
    insert_default_step_rows(connection, &job_id, document_id, now)?;
    load_job_record(connection, &job_id)
}

pub fn list_processing_jobs(
    connection: &Connection,
    document_id: Option<String>,
) -> Result<Vec<KnowledgeProcessingJobRecord>, String> {
    let normalized_document_id = document_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let sql = if normalized_document_id.is_some() {
        r#"
        SELECT id, document_id, collection_id, job_type, status, current_step, progress,
               attempt, max_attempts, priority, fail_count, next_run_at, source_job_id,
               cancel_requested, pause_requested, error_message, created_at, started_at,
               finished_at, updated_at
        FROM knowledge_processing_jobs
        WHERE document_id = ?1
        ORDER BY created_at DESC, id DESC
        "#
    } else {
        r#"
        SELECT id, document_id, collection_id, job_type, status, current_step, progress,
               attempt, max_attempts, priority, fail_count, next_run_at, source_job_id,
               cancel_requested, pause_requested, error_message, created_at, started_at,
               finished_at, updated_at
        FROM knowledge_processing_jobs
        ORDER BY created_at DESC, id DESC
        "#
    };

    let mut stmt = connection.prepare(sql).map_err(|err| err.to_string())?;
    let rows = if let Some(document_id) = normalized_document_id {
        stmt.query_map(params![document_id], read_job_record)
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
    } else {
        stmt.query_map([], read_job_record)
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
    };

    rows.map_err(|err| err.to_string())
}

pub fn load_processing_job_detail(
    connection: &Connection,
    job_id: &str,
) -> Result<KnowledgeProcessingJobDetail, String> {
    let job = load_job_record(connection, job_id)?;

    let mut steps_stmt = connection
        .prepare(
            r#"
            SELECT id, job_id, document_id, step_name, status, progress, error_message,
                   started_at, finished_at, updated_at
            FROM knowledge_processing_steps
            WHERE job_id = ?1
            ORDER BY
              CASE step_name
                WHEN 'validate' THEN 0
                WHEN 'parse' THEN 1
                WHEN 'extract_assets' THEN 2
                WHEN 'chunk' THEN 3
                WHEN 'embed' THEN 4
                WHEN 'index' THEN 5
                WHEN 'finalize' THEN 6
                ELSE 99
              END,
              updated_at ASC
            "#,
        )
        .map_err(|err| err.to_string())?;
    let steps = steps_stmt
        .query_map(params![job_id], read_step_record)
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    let mut logs_stmt = connection
        .prepare(
            r#"
            SELECT id, job_id, document_id, level, step_name, message, details_json, created_at
            FROM knowledge_processing_logs
            WHERE job_id = ?1
            ORDER BY created_at ASC, id ASC
            "#,
        )
        .map_err(|err| err.to_string())?;
    let logs = logs_stmt
        .query_map(params![job_id], read_log_record)
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    Ok(KnowledgeProcessingJobDetail { job, steps, logs })
}

pub fn load_processing_status_summary(
    connection: &Connection,
    collection_id: Option<String>,
) -> Result<KnowledgeProcessingStatusSummary, String> {
    let normalized_collection_id = collection_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let (scope, collection_id) = if let Some(collection_id) = normalized_collection_id {
        ("collection".to_string(), Some(collection_id))
    } else {
        ("global".to_string(), None)
    };

    let (queued, running, failed): (i64, i64, i64) = if let Some(collection_id) = collection_id.as_ref()
    {
        connection
            .query_row(
                r#"
                SELECT
                  SUM(CASE WHEN status = ?2 THEN 1 ELSE 0 END) AS queued_count,
                  SUM(CASE WHEN status = ?3 THEN 1 ELSE 0 END) AS running_count,
                  SUM(CASE WHEN status = ?4 THEN 1 ELSE 0 END) AS failed_count
                FROM knowledge_processing_jobs
                WHERE collection_id = ?1
                "#,
                params![collection_id, JOB_STATUS_QUEUED, JOB_STATUS_RUNNING, JOB_STATUS_FAILED],
                |row| {
                    Ok((
                        row.get::<_, Option<i64>>(0)?.unwrap_or(0),
                        row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                        row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                    ))
                },
            )
            .map_err(|err| err.to_string())?
    } else {
        connection
            .query_row(
                r#"
                SELECT
                  SUM(CASE WHEN status = ?1 THEN 1 ELSE 0 END) AS queued_count,
                  SUM(CASE WHEN status = ?2 THEN 1 ELSE 0 END) AS running_count,
                  SUM(CASE WHEN status = ?3 THEN 1 ELSE 0 END) AS failed_count
                FROM knowledge_processing_jobs
                "#,
                params![JOB_STATUS_QUEUED, JOB_STATUS_RUNNING, JOB_STATUS_FAILED],
                |row| {
                    Ok((
                        row.get::<_, Option<i64>>(0)?.unwrap_or(0),
                        row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                        row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                    ))
                },
            )
            .map_err(|err| err.to_string())?
    };

    Ok(KnowledgeProcessingStatusSummary {
        scope,
        collection_id,
        queued,
        running,
        failed,
    })
}

pub fn list_failed_processing_jobs(
    connection: &Connection,
    input: FailedJobQueryInput,
) -> Result<FailedJobQueryResult, String> {
    let normalized_collection_id = input
        .collection_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let limit = input.limit.unwrap_or(100).clamp(1, 500);
    let offset = input.offset.unwrap_or(0).max(0);

    let (scope, collection_id) = if let Some(collection_id) = normalized_collection_id {
        ("collection".to_string(), Some(collection_id))
    } else {
        ("global".to_string(), None)
    };

    let total: i64 = if let Some(collection_id) = collection_id.as_ref() {
        connection
            .query_row(
                r#"
                SELECT COUNT(1)
                FROM knowledge_processing_jobs
                WHERE status = ?1 AND collection_id = ?2
                "#,
                params![JOB_STATUS_FAILED, collection_id],
                |row| row.get(0),
            )
            .map_err(|err| err.to_string())?
    } else {
        connection
            .query_row(
                r#"
                SELECT COUNT(1)
                FROM knowledge_processing_jobs
                WHERE status = ?1
                "#,
                params![JOB_STATUS_FAILED],
                |row| row.get(0),
            )
            .map_err(|err| err.to_string())?
    };

    let sql_with_collection = r#"
        SELECT id, document_id, collection_id, job_type, status, current_step, progress,
               attempt, max_attempts, priority, fail_count, next_run_at, source_job_id,
               cancel_requested, pause_requested, error_message, created_at, started_at,
               finished_at, updated_at
        FROM knowledge_processing_jobs
        WHERE status = ?1 AND collection_id = ?2
        ORDER BY updated_at DESC, created_at DESC, id DESC
        LIMIT ?3 OFFSET ?4
    "#;
    let sql_global = r#"
        SELECT id, document_id, collection_id, job_type, status, current_step, progress,
               attempt, max_attempts, priority, fail_count, next_run_at, source_job_id,
               cancel_requested, pause_requested, error_message, created_at, started_at,
               finished_at, updated_at
        FROM knowledge_processing_jobs
        WHERE status = ?1
        ORDER BY updated_at DESC, created_at DESC, id DESC
        LIMIT ?2 OFFSET ?3
    "#;

    let mut stmt = connection
        .prepare(if collection_id.is_some() {
            sql_with_collection
        } else {
            sql_global
        })
        .map_err(|err| err.to_string())?;
    let jobs = if let Some(collection_id) = collection_id.as_ref() {
        stmt.query_map(
            params![JOB_STATUS_FAILED, collection_id, limit, offset],
            read_job_record,
        )
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?
    } else {
        stmt.query_map(params![JOB_STATUS_FAILED, limit, offset], read_job_record)
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?
    };

    let has_more = offset.saturating_add(limit) < total;
    Ok(FailedJobQueryResult {
        scope,
        collection_id,
        total,
        has_more,
        jobs,
    })
}

pub fn retry_failed_jobs(
    connection: &Connection,
    input: RetryFailedJobsInput,
) -> Result<RetryFailedJobsResult, String> {
    let normalized_collection_id = input
        .collection_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let limit = input.limit.unwrap_or(200).clamp(1, 1000);
    let (scope, collection_id) = if let Some(collection_id) = normalized_collection_id {
        ("collection".to_string(), Some(collection_id))
    } else {
        ("global".to_string(), None)
    };

    let sql_with_collection = r#"
        SELECT id
        FROM knowledge_processing_jobs
        WHERE status = ?1 AND collection_id = ?2
        ORDER BY updated_at DESC, created_at DESC, id DESC
        LIMIT ?3
    "#;
    let sql_global = r#"
        SELECT id
        FROM knowledge_processing_jobs
        WHERE status = ?1
        ORDER BY updated_at DESC, created_at DESC, id DESC
        LIMIT ?2
    "#;
    let mut stmt = connection
        .prepare(if collection_id.is_some() {
            sql_with_collection
        } else {
            sql_global
        })
        .map_err(|err| err.to_string())?;
    let job_ids = if let Some(collection_id) = collection_id.as_ref() {
        stmt.query_map(params![JOB_STATUS_FAILED, collection_id, limit], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?
    } else {
        stmt.query_map(params![JOB_STATUS_FAILED, limit], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?
    };

    let attempted = job_ids.len() as i64;
    if attempted == 0 {
        return Ok(RetryFailedJobsResult {
            scope,
            collection_id,
            attempted: 0,
            retried: 0,
            skipped: 0,
            errors: Vec::new(),
        });
    }

    let mut retried = 0_i64;
    let mut skipped = 0_i64;
    let mut errors = Vec::new();
    for job_id in job_ids {
        match retry_job(connection, &job_id) {
            Ok(_) => retried = retried.saturating_add(1),
            Err(err) => {
                skipped = skipped.saturating_add(1);
                errors.push(format!("{job_id}: {err}"));
            }
        }
    }

    Ok(RetryFailedJobsResult {
        scope,
        collection_id,
        attempted,
        retried,
        skipped,
        errors,
    })
}

pub fn list_dead_letters(
    connection: &Connection,
    input: DeadLetterQueryInput,
) -> Result<DeadLetterQueryResult, String> {
    let normalized_collection_id = input
        .collection_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let normalized_status = input
        .status
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let limit = input.limit.unwrap_or(100).clamp(1, 500);
    let offset = input.offset.unwrap_or(0).max(0);

    let (scope, collection_id) = if let Some(collection_id) = normalized_collection_id {
        ("collection".to_string(), Some(collection_id))
    } else {
        ("global".to_string(), None)
    };

    let base_select = r#"
        SELECT id, job_id, document_id, collection_id, job_type, status, error_message,
               fail_count, attempt, max_attempts, first_failed_at, last_failed_at,
               replayed_at, replayed_job_id, resolved_at, metadata_json
        FROM knowledge_processing_dead_letters
    "#;
    let base_count = "SELECT COUNT(1) FROM knowledge_processing_dead_letters";
    let order = " ORDER BY last_failed_at DESC, first_failed_at DESC, id DESC ";

    let (total, items) = match (collection_id.as_ref(), normalized_status.as_ref()) {
        (Some(collection_id), Some(status)) => {
            let count_sql = format!("{base_count} WHERE collection_id = ?1 AND status = ?2");
            let list_sql = format!("{base_select} WHERE collection_id = ?1 AND status = ?2 {order} LIMIT ?3 OFFSET ?4");
            let total: i64 = connection
                .query_row(&count_sql, params![collection_id, status], |row| row.get(0))
                .map_err(|err| err.to_string())?;
            let mut stmt = connection.prepare(&list_sql).map_err(|err| err.to_string())?;
            let items = stmt
                .query_map(params![collection_id, status, limit, offset], read_dead_letter_record)
                .map_err(|err| err.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| err.to_string())?;
            (total, items)
        }
        (Some(collection_id), None) => {
            let count_sql = format!("{base_count} WHERE collection_id = ?1");
            let list_sql = format!("{base_select} WHERE collection_id = ?1 {order} LIMIT ?2 OFFSET ?3");
            let total: i64 = connection
                .query_row(&count_sql, params![collection_id], |row| row.get(0))
                .map_err(|err| err.to_string())?;
            let mut stmt = connection.prepare(&list_sql).map_err(|err| err.to_string())?;
            let items = stmt
                .query_map(params![collection_id, limit, offset], read_dead_letter_record)
                .map_err(|err| err.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| err.to_string())?;
            (total, items)
        }
        (None, Some(status)) => {
            let count_sql = format!("{base_count} WHERE status = ?1");
            let list_sql = format!("{base_select} WHERE status = ?1 {order} LIMIT ?2 OFFSET ?3");
            let total: i64 = connection
                .query_row(&count_sql, params![status], |row| row.get(0))
                .map_err(|err| err.to_string())?;
            let mut stmt = connection.prepare(&list_sql).map_err(|err| err.to_string())?;
            let items = stmt
                .query_map(params![status, limit, offset], read_dead_letter_record)
                .map_err(|err| err.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| err.to_string())?;
            (total, items)
        }
        (None, None) => {
            let count_sql = base_count.to_string();
            let list_sql = format!("{base_select} {order} LIMIT ?1 OFFSET ?2");
            let total: i64 = connection
                .query_row(&count_sql, [], |row| row.get(0))
                .map_err(|err| err.to_string())?;
            let mut stmt = connection.prepare(&list_sql).map_err(|err| err.to_string())?;
            let items = stmt
                .query_map(params![limit, offset], read_dead_letter_record)
                .map_err(|err| err.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| err.to_string())?;
            (total, items)
        }
    };
    let has_more = offset.saturating_add(limit) < total;
    Ok(DeadLetterQueryResult {
        scope,
        collection_id,
        status: normalized_status,
        total,
        has_more,
        items,
    })
}

pub fn replay_dead_letters(
    connection: &Connection,
    input: ReplayDeadLettersInput,
) -> Result<ReplayDeadLettersResult, String> {
    let normalized_collection_id = input
        .collection_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let normalized_status = input
        .status
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let limit = input.limit.unwrap_or(200).clamp(1, 1000);
    let (scope, collection_id) = if let Some(collection_id) = normalized_collection_id {
        ("collection".to_string(), Some(collection_id))
    } else {
        ("global".to_string(), None)
    };

    let status_value = normalized_status.unwrap_or_else(|| "failed".to_string());
    let sql_with_collection = r#"
        SELECT job_id, status
        FROM knowledge_processing_dead_letters
        WHERE status = ?1 AND collection_id = ?2
        ORDER BY last_failed_at DESC, id DESC
        LIMIT ?3
    "#;
    let sql_global = r#"
        SELECT job_id, status
        FROM knowledge_processing_dead_letters
        WHERE status = ?1
        ORDER BY last_failed_at DESC, id DESC
        LIMIT ?2
    "#;
    let mut stmt = connection
        .prepare(if collection_id.is_some() {
            sql_with_collection
        } else {
            sql_global
        })
        .map_err(|err| err.to_string())?;
    let dead_letter_candidates = if let Some(collection_id) = collection_id.as_ref() {
        stmt.query_map(params![status_value, collection_id, limit], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?
    } else {
        stmt.query_map(params![status_value, limit], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?
    };

    let attempted = dead_letter_candidates.len() as i64;
    if attempted == 0 {
        return Ok(ReplayDeadLettersResult {
            scope,
            collection_id,
            attempted: 0,
            replayed: 0,
            skipped: 0,
            errors: Vec::new(),
        });
    }

    let mut replayed = 0_i64;
    let mut skipped = 0_i64;
    let mut errors = Vec::new();
    for (job_id, dead_letter_status) in dead_letter_candidates {
        if dead_letter_status != JOB_STATUS_FAILED {
            skipped = skipped.saturating_add(1);
            errors.push(format!(
                "{job_id}: dead letter status is '{dead_letter_status}', only 'failed' can be replayed"
            ));
            continue;
        }
        match retry_job(connection, &job_id) {
            Ok(_) => replayed = replayed.saturating_add(1),
            Err(err) => {
                skipped = skipped.saturating_add(1);
                errors.push(format!("{job_id}: {err}"));
            }
        }
    }

    Ok(ReplayDeadLettersResult {
        scope,
        collection_id,
        attempted,
        replayed,
        skipped,
        errors,
    })
}

pub fn load_pipeline_settings(
    connection: &Connection,
) -> Result<KnowledgePipelineSettings, String> {
    let settings_json = connection
        .query_row(
            "SELECT settings_json FROM knowledge_pipeline_settings WHERE id = 'default'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?;

    let settings = settings_json
        .as_deref()
        .and_then(|value| serde_json::from_str::<KnowledgePipelineSettings>(value).ok())
        .unwrap_or_default()
        .clamped();

    Ok(settings)
}

pub fn save_pipeline_settings(
    connection: &Connection,
    settings: KnowledgePipelineSettings,
) -> Result<KnowledgePipelineSettings, String> {
    let settings = settings.clamped();
    let settings_json = serde_json::to_string(&settings).map_err(|err| err.to_string())?;
    let now = current_timestamp_ms();

    connection
        .execute(
            r#"
            INSERT INTO knowledge_pipeline_settings (id, settings_json, updated_at)
            VALUES ('default', ?1, ?2)
            ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at
            "#,
            params![settings_json, now],
        )
        .map_err(|err| err.to_string())?;

    Ok(settings)
}

pub fn cleanup_processing_logs(connection: &Connection) -> Result<i64, String> {
    let settings = load_pipeline_settings(connection)?;
    let now = current_timestamp_ms();
    let day_ms = 86_400_000_i64;
    let successful_cutoff =
        now.saturating_sub(settings.keep_successful_logs_days.saturating_mul(day_ms));
    let failed_cutoff = now.saturating_sub(settings.keep_failed_logs_days.saturating_mul(day_ms));

    let deleted_successful = connection
        .execute(
            r#"
            DELETE FROM knowledge_processing_logs
            WHERE created_at < ?1
              AND job_id IN (
                SELECT id FROM knowledge_processing_jobs
                WHERE status = ?2
              )
            "#,
            params![successful_cutoff, JOB_STATUS_SUCCEEDED],
        )
        .map_err(|err| err.to_string())?;
    let deleted_failed = connection
        .execute(
            r#"
            DELETE FROM knowledge_processing_logs
            WHERE created_at < ?1
              AND job_id IN (
                SELECT id FROM knowledge_processing_jobs
                WHERE status IN (?2, ?3)
              )
            "#,
            params![failed_cutoff, JOB_STATUS_FAILED, JOB_STATUS_CANCELED],
        )
        .map_err(|err| err.to_string())?;

    Ok((deleted_successful + deleted_failed) as i64)
}

pub fn request_job_pause(connection: &Connection, job_id: &str) -> Result<(), String> {
    let job = load_job_record(connection, job_id)?;
    let now = current_timestamp_ms();
    let status = if job.status == JOB_STATUS_QUEUED {
        JOB_STATUS_PAUSED
    } else {
        job.status.as_str()
    };
    connection
        .execute(
            r#"
            UPDATE knowledge_processing_jobs
            SET pause_requested = 1, status = ?2, updated_at = ?3
            WHERE id = ?1
            "#,
            params![job_id, status, now],
        )
        .map_err(|err| err.to_string())?;
    log_job(
        connection,
        job_id,
        &job.document_id,
        "info",
        None,
        "pause requested",
        None,
    )
}

pub fn request_job_resume(connection: &Connection, job_id: &str) -> Result<(), String> {
    let job = load_job_record(connection, job_id)?;
    let now = current_timestamp_ms();
    let status = if job.status == JOB_STATUS_PAUSED {
        JOB_STATUS_QUEUED
    } else {
        job.status.as_str()
    };
    connection
        .execute(
            r#"
            UPDATE knowledge_processing_jobs
            SET pause_requested = 0, status = ?2, next_run_at = CASE WHEN ?2 = ?4 THEN NULL ELSE next_run_at END, updated_at = ?3
            WHERE id = ?1
            "#,
            params![job_id, status, now, JOB_STATUS_QUEUED],
        )
        .map_err(|err| err.to_string())?;
    log_job(
        connection,
        job_id,
        &job.document_id,
        "info",
        None,
        "resume requested",
        None,
    )
}

pub fn request_job_cancel(connection: &Connection, job_id: &str) -> Result<(), String> {
    let job = load_job_record(connection, job_id)?;
    let now = current_timestamp_ms();
    let tx = connection
        .unchecked_transaction()
        .map_err(|err| err.to_string())?;
    tx.execute(
        r#"
        UPDATE knowledge_processing_jobs
        SET cancel_requested = 1, updated_at = ?2
        WHERE id = ?1
        "#,
        params![job_id, now],
    )
    .map_err(|err| err.to_string())?;

    if matches!(job.status.as_str(), JOB_STATUS_QUEUED | JOB_STATUS_PAUSED) {
        tx.execute(
            r#"
            UPDATE knowledge_processing_steps
            SET status = ?2, finished_at = ?3, updated_at = ?4
            WHERE job_id = ?1 AND status = ?5
            "#,
            params![job_id, STEP_STATUS_SKIPPED, now, now, STEP_STATUS_PENDING],
        )
        .map_err(|err| err.to_string())?;
        tx.execute(
            r#"
            UPDATE knowledge_processing_jobs
            SET status = ?2, progress = 100, next_run_at = NULL, finished_at = ?3, updated_at = ?4
            WHERE id = ?1
            "#,
            params![job_id, JOB_STATUS_CANCELED, now, now],
        )
        .map_err(|err| err.to_string())?;
        tx.execute(
            r#"
            UPDATE knowledge_documents
            SET processing_status = ?2, error_message = NULL, active_job_id = NULL, updated_at = ?3
            WHERE id = ?1 AND active_job_id = ?4
            "#,
            params![job.document_id, DOCUMENT_STATUS_CANCELED, now, job_id],
        )
        .map_err(|err| err.to_string())?;
    }

    tx.commit().map_err(|err| err.to_string())?;
    log_job(
        connection,
        job_id,
        &job.document_id,
        "warn",
        None,
        "cancel requested",
        None,
    )
}

pub fn retry_job(
    connection: &Connection,
    job_id: &str,
) -> Result<KnowledgeProcessingJobRecord, String> {
    let old_job = load_job_record(connection, job_id)?;
    let now = current_timestamp_ms();
    let tx = connection
        .unchecked_transaction()
        .map_err(|err| err.to_string())?;
    let job = insert_job_record(
        &tx,
        &old_job.document_id,
        &old_job.collection_id,
        &old_job.job_type,
        old_job.attempt + 1,
        old_job.max_attempts,
        old_job.priority,
        0,
        None,
        Some(job_id),
        now,
    )?;
    tx.execute(
        r#"
        UPDATE knowledge_documents
        SET processing_status = ?2, error_message = NULL, active_job_id = ?3, updated_at = ?4
        WHERE id = ?1
        "#,
        params![old_job.document_id, DOCUMENT_STATUS_PENDING, job.id, now],
    )
    .map_err(|err| err.to_string())?;
    tx.execute(
        r#"
        UPDATE knowledge_processing_dead_letters
        SET status = ?2, replayed_at = ?3, replayed_job_id = ?4, resolved_at = ?5
        WHERE job_id = ?1
        "#,
        params![job_id, "replayed", now, job.id, now],
    )
    .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;
    log_job(
        connection,
        &job.id,
        &job.document_id,
        "info",
        None,
        "job queued as retry",
        Some(&format!("{{\"sourceJobId\":\"{job_id}\"}}")),
    )?;
    Ok(job)
}

pub fn create_document_job(
    connection: &Connection,
    document_id: &str,
    job_type: &str,
) -> Result<KnowledgeProcessingJobRecord, String> {
    if !matches!(
        job_type,
        "reparse" | "rechunk" | "revectorize" | "full_rebuild"
    ) {
        return Err(format!("unsupported document job type: {job_type}"));
    }

    let (document_id, collection_id): (String, String) = connection
        .query_row(
            "SELECT id, collection_id FROM knowledge_documents WHERE id = ?1",
            params![document_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .ok_or_else(|| format!("knowledge document not found: {document_id}"))?;

    let now = current_timestamp_ms();
    let tx = connection
        .unchecked_transaction()
        .map_err(|err| err.to_string())?;
    let job = insert_job_record(
        &tx,
        &document_id,
        &collection_id,
        job_type,
        0,
        3,
        DEFAULT_JOB_PRIORITY,
        0,
        None,
        None,
        now,
    )?;
    tx.execute(
        r#"
        UPDATE knowledge_documents
        SET processing_status = ?2, error_message = NULL, active_job_id = ?3, updated_at = ?4
        WHERE id = ?1
        "#,
        params![document_id, DOCUMENT_STATUS_PENDING, job.id, now],
    )
    .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;
    log_job(
        connection,
        &job.id,
        &job.document_id,
        "info",
        None,
        "document job queued",
        None,
    )?;
    Ok(job)
}

fn count_running_jobs(connection: &Connection) -> Result<i64, String> {
    connection
        .query_row(
            "SELECT COUNT(1) FROM knowledge_processing_jobs WHERE status = ?1",
            params![JOB_STATUS_RUNNING],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())
}

fn claim_next_job_with_limits(
    connection: &Connection,
    per_collection_max_running: i64,
) -> Result<Option<PipelineJobClaim>, String> {
    let now = current_timestamp_ms();
    let Some(job) = connection
        .query_row(
            r#"
            SELECT q.id, q.document_id, q.collection_id
            FROM knowledge_processing_jobs q
            WHERE q.status = ?1
              AND q.cancel_requested = 0
              AND q.pause_requested = 0
              AND (q.next_run_at IS NULL OR q.next_run_at <= ?2)
              AND (
                SELECT COUNT(1)
                FROM knowledge_processing_jobs r
                WHERE r.collection_id = q.collection_id
                  AND r.status = ?3
              ) < ?4
            ORDER BY
              q.priority DESC,
              COALESCE(q.next_run_at, q.created_at) ASC,
              q.created_at ASC,
              q.id ASC
            LIMIT 1
            "#,
            params![
                JOB_STATUS_QUEUED,
                now,
                JOB_STATUS_RUNNING,
                per_collection_max_running
            ],
            |row| {
                Ok(PipelineJobClaim {
                    id: row.get(0)?,
                    document_id: row.get(1)?,
                    collection_id: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(|err| err.to_string())?
    else {
        return Ok(None);
    };

    let changed = connection
        .execute(
            r#"
            UPDATE knowledge_processing_jobs
            SET status = ?2,
                current_step = ?3,
                progress = 1,
                started_at = COALESCE(started_at, ?4),
                updated_at = ?5
            WHERE id = ?1
              AND status = ?6
              AND cancel_requested = 0
              AND pause_requested = 0
              AND (next_run_at IS NULL OR next_run_at <= ?4)
            "#,
            params![
                job.id,
                JOB_STATUS_RUNNING,
                PIPELINE_STEPS[0],
                now,
                now,
                JOB_STATUS_QUEUED
            ],
        )
        .map_err(|err| err.to_string())?;

    if changed == 0 {
        Ok(None)
    } else {
        Ok(Some(job))
    }
}

fn load_document_source(
    connection: &Connection,
    document_id: &str,
) -> Result<PipelineDocumentSource, String> {
    connection
        .query_row(
            r#"
            SELECT id, collection_id, source_name, stored_file_path, file_extension, content
            FROM knowledge_documents
            WHERE id = ?1
            "#,
            params![document_id],
            |row| {
                Ok(PipelineDocumentSource {
                    id: row.get(0)?,
                    collection_id: row.get(1)?,
                    source_name: row.get(2)?,
                    stored_file_path: row.get(3)?,
                    file_extension: row.get(4)?,
                    content: row.get(5)?,
                })
            },
        )
        .map_err(|err| err.to_string())
}

fn log_job(
    connection: &Connection,
    job_id: &str,
    document_id: &str,
    level: &str,
    step_name: Option<&str>,
    message: &str,
    details_json: Option<&str>,
) -> Result<(), String> {
    connection
        .execute(
            r#"
            INSERT INTO knowledge_processing_logs (
              id, job_id, document_id, level, step_name, message, details_json, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            "#,
            params![
                uuid::Uuid::new_v4().to_string(),
                job_id,
                document_id,
                level,
                step_name,
                message,
                details_json,
                current_timestamp_ms(),
            ],
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn start_step(
    connection: &Connection,
    job: &PipelineJobClaim,
    step_name: &str,
    progress: i64,
) -> Result<(), String> {
    let now = current_timestamp_ms();
    connection
        .execute(
            r#"
            UPDATE knowledge_processing_steps
            SET status = ?3, progress = 0, error_message = NULL,
                started_at = COALESCE(started_at, ?4), finished_at = NULL, updated_at = ?5
            WHERE job_id = ?1 AND step_name = ?2
            "#,
            params![job.id, step_name, STEP_STATUS_RUNNING, now, now],
        )
        .map_err(|err| err.to_string())?;
    connection
        .execute(
            r#"
            UPDATE knowledge_processing_jobs
            SET current_step = ?2, progress = ?3, updated_at = ?4
            WHERE id = ?1
            "#,
            params![job.id, step_name, progress, now],
        )
        .map_err(|err| err.to_string())?;
    log_job(
        connection,
        &job.id,
        &job.document_id,
        "info",
        Some(step_name),
        "step started",
        None,
    )
}

fn finish_step(
    connection: &Connection,
    job: &PipelineJobClaim,
    step_name: &str,
    status: &str,
    progress: i64,
    error_message: Option<&str>,
) -> Result<(), String> {
    let now = current_timestamp_ms();
    connection
        .execute(
            r#"
            UPDATE knowledge_processing_steps
            SET status = ?3, progress = ?4, error_message = ?5, finished_at = ?6, updated_at = ?7
            WHERE job_id = ?1 AND step_name = ?2
            "#,
            params![job.id, step_name, status, progress, error_message, now, now],
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn skip_step(
    connection: &Connection,
    job: &PipelineJobClaim,
    step_name: &str,
    message: &str,
) -> Result<(), String> {
    finish_step(connection, job, step_name, STEP_STATUS_SKIPPED, 100, None)?;
    log_job(
        connection,
        &job.id,
        &job.document_id,
        "info",
        Some(step_name),
        message,
        None,
    )
}

enum ControlFlow {
    Continue,
    Stop,
}

fn check_job_control(
    connection: &Connection,
    job: &PipelineJobClaim,
) -> Result<ControlFlow, String> {
    let (cancel_requested, pause_requested): (i64, i64) = connection
        .query_row(
            "SELECT cancel_requested, pause_requested FROM knowledge_processing_jobs WHERE id = ?1",
            params![job.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|err| err.to_string())?;

    if cancel_requested != 0 {
        let now = current_timestamp_ms();
        connection
            .execute(
                r#"
                UPDATE knowledge_processing_steps
                SET status = ?2, finished_at = ?3, updated_at = ?4
                WHERE job_id = ?1 AND status = ?5
                "#,
                params![job.id, STEP_STATUS_SKIPPED, now, now, STEP_STATUS_RUNNING],
            )
            .map_err(|err| err.to_string())?;
        connection
            .execute(
                r#"
                UPDATE knowledge_processing_jobs
                SET status = ?2, progress = 100, next_run_at = NULL, finished_at = ?3, updated_at = ?4
                WHERE id = ?1
                "#,
                params![job.id, JOB_STATUS_CANCELED, now, now],
            )
            .map_err(|err| err.to_string())?;
        connection
            .execute(
                r#"
                UPDATE knowledge_documents
                SET processing_status = ?2, error_message = NULL, active_job_id = NULL, updated_at = ?3
                WHERE id = ?1
                "#,
                params![job.document_id, DOCUMENT_STATUS_CANCELED, now],
            )
            .map_err(|err| err.to_string())?;
        log_job(
            connection,
            &job.id,
            &job.document_id,
            "warn",
            None,
            "job canceled",
            None,
        )?;
        return Ok(ControlFlow::Stop);
    }

    if pause_requested != 0 {
        let now = current_timestamp_ms();
        connection
            .execute(
                r#"
                UPDATE knowledge_processing_jobs
                SET status = ?2, next_run_at = CASE WHEN ?2 = ?4 THEN NULL ELSE next_run_at END, updated_at = ?3
                WHERE id = ?1
                "#,
                params![job.id, JOB_STATUS_PAUSED, now, JOB_STATUS_PAUSED],
            )
            .map_err(|err| err.to_string())?;
        log_job(
            connection,
            &job.id,
            &job.document_id,
            "info",
            None,
            "job paused",
            None,
        )?;
        return Ok(ControlFlow::Stop);
    }

    Ok(ControlFlow::Continue)
}

fn compute_retry_delay_ms(fail_count: i64) -> i64 {
    if fail_count <= 0 {
        return 0;
    }
    let index = usize::try_from(fail_count - 1).unwrap_or(usize::MAX);
    *RETRY_BACKOFF_MS
        .get(index)
        .unwrap_or(RETRY_BACKOFF_MS.last().unwrap_or(&600_000))
}

fn upsert_dead_letter(
    connection: &Connection,
    job: &PipelineJobClaim,
    job_record: &KnowledgeProcessingJobRecord,
    error_message: &str,
    now: i64,
) -> Result<(), String> {
    connection
        .execute(
            r#"
            INSERT INTO knowledge_processing_dead_letters (
              id, job_id, document_id, collection_id, job_type, status, error_message,
              fail_count, attempt, max_attempts, first_failed_at, last_failed_at, metadata_json
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
            ON CONFLICT(job_id) DO UPDATE SET
              status = excluded.status,
              error_message = excluded.error_message,
              fail_count = excluded.fail_count,
              attempt = excluded.attempt,
              max_attempts = excluded.max_attempts,
              last_failed_at = excluded.last_failed_at,
              metadata_json = excluded.metadata_json
            "#,
            params![
                uuid::Uuid::new_v4().to_string(),
                job.id,
                job.document_id,
                job.collection_id,
                job_record.job_type,
                JOB_STATUS_FAILED,
                error_message,
                job_record.fail_count,
                job_record.attempt,
                job_record.max_attempts,
                now,
                now,
                Some(format!(
                    "{{\"source\":\"pipeline\",\"final\":true,\"jobStatus\":\"{}\"}}",
                    JOB_STATUS_FAILED
                )),
            ],
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn fail_job(
    connection: &Connection,
    job: &PipelineJobClaim,
    step_name: Option<&str>,
    error_message: &str,
    max_auto_retries: i64,
) -> Result<(), String> {
    let now = current_timestamp_ms();
    let (current_fail_count, max_attempts): (i64, i64) = connection
        .query_row(
            "SELECT fail_count, max_attempts FROM knowledge_processing_jobs WHERE id = ?1",
            params![job.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|err| err.to_string())?;
    let next_fail_count = current_fail_count.saturating_add(1);
    let retry_cap = max_auto_retries.min(max_attempts).max(0);
    let should_retry = next_fail_count <= retry_cap;

    if let Some(step_name) = step_name {
        finish_step(
            connection,
            job,
            step_name,
            STEP_STATUS_FAILED,
            100,
            Some(error_message),
        )?;
    } else {
        connection
            .execute(
                r#"
                UPDATE knowledge_processing_steps
                SET status = ?2, error_message = ?3, finished_at = ?4, updated_at = ?5
                WHERE job_id = ?1 AND status = ?6
                "#,
                params![
                    job.id,
                    STEP_STATUS_FAILED,
                    error_message,
                    now,
                    now,
                    STEP_STATUS_RUNNING
                ],
            )
            .map_err(|err| err.to_string())?;
    }
    if should_retry {
        let retry_at = now.saturating_add(compute_retry_delay_ms(next_fail_count));
        connection
            .execute(
                r#"
                UPDATE knowledge_processing_jobs
                SET status = ?2, fail_count = ?3, next_run_at = ?4, error_message = ?5,
                    finished_at = NULL, updated_at = ?6
                WHERE id = ?1
                "#,
                params![
                    job.id,
                    JOB_STATUS_QUEUED,
                    next_fail_count,
                    retry_at,
                    error_message,
                    now
                ],
            )
            .map_err(|err| err.to_string())?;
        connection
            .execute(
                r#"
                UPDATE knowledge_documents
                SET processing_status = ?2, error_message = ?3, active_job_id = ?4, updated_at = ?5
                WHERE id = ?1
                "#,
                params![
                    job.document_id,
                    DOCUMENT_STATUS_PENDING,
                    error_message,
                    job.id,
                    now
                ],
            )
            .map_err(|err| err.to_string())?;
        log_job(
            connection,
            &job.id,
            &job.document_id,
            "warn",
            step_name,
            "job failed and re-queued",
            Some(&format!(
                "{{\"failCount\":{next_fail_count},\"retryAt\":{retry_at},\"error\":\"{}\"}}",
                error_message.replace('\"', "\\\"")
            )),
        )?;
        return Ok(());
    }

    connection
        .execute(
            r#"
            UPDATE knowledge_processing_jobs
            SET status = ?2, fail_count = ?3, progress = 100, error_message = ?4,
                next_run_at = NULL, finished_at = ?5, updated_at = ?6
            WHERE id = ?1
            "#,
            params![
                job.id,
                JOB_STATUS_FAILED,
                next_fail_count,
                error_message,
                now,
                now
            ],
        )
        .map_err(|err| err.to_string())?;
    let failed_job_record = load_job_record(connection, &job.id)?;
    upsert_dead_letter(connection, job, &failed_job_record, error_message, now)?;
    connection
        .execute(
            r#"
            UPDATE knowledge_documents
            SET processing_status = ?2, error_message = ?3, active_job_id = NULL, updated_at = ?4
            WHERE id = ?1
            "#,
            params![job.document_id, DOCUMENT_STATUS_FAILED, error_message, now],
        )
        .map_err(|err| err.to_string())?;
    log_job(
        connection,
        &job.id,
        &job.document_id,
        "error",
        step_name,
        error_message,
        None,
    )
}

fn mark_unsupported(
    connection: &Connection,
    job: &PipelineJobClaim,
    error_message: &str,
) -> Result<(), String> {
    let now = current_timestamp_ms();
    finish_step(
        connection,
        job,
        "parse",
        STEP_STATUS_SKIPPED,
        100,
        Some(error_message),
    )?;
    for step_name in ["extract_assets", "chunk", "embed", "index", "finalize"] {
        finish_step(connection, job, step_name, STEP_STATUS_SKIPPED, 100, None)?;
    }
    connection
        .execute(
            r#"
            UPDATE knowledge_documents
            SET processing_status = ?2, error_message = ?3, last_processed_at = ?4,
                active_job_id = NULL, updated_at = ?5
            WHERE id = ?1
            "#,
            params![
                job.document_id,
                DOCUMENT_STATUS_UNSUPPORTED,
                error_message,
                now,
                now
            ],
        )
        .map_err(|err| err.to_string())?;
    connection
        .execute(
            r#"
            UPDATE knowledge_processing_jobs
            SET status = ?2, progress = 100, error_message = ?3, finished_at = ?4, updated_at = ?5
            WHERE id = ?1
            "#,
            params![job.id, JOB_STATUS_SUCCEEDED, error_message, now, now],
        )
        .map_err(|err| err.to_string())?;
    log_job(
        connection,
        &job.id,
        &job.document_id,
        "warn",
        Some("parse"),
        error_message,
        None,
    )
}

fn complete_partial_job(
    connection: &Connection,
    job: &PipelineJobClaim,
    parsed: ParsedDocument,
) -> Result<(), String> {
    start_step(connection, job, "chunk", 45)?;
    let chunks = crate::knowledge_chunker::split_document_text(
        &parsed.content,
        "",
        Some(parsed.preview_type.as_str()),
        None,
        crate::knowledge_chunker::DEFAULT_CHUNK_SIZE,
        crate::knowledge_chunker::DEFAULT_CHUNK_OVERLAP,
    );
    finish_step(connection, job, "chunk", STEP_STATUS_SUCCEEDED, 100, None)?;
    if matches!(check_job_control(connection, job)?, ControlFlow::Stop) {
        return Ok(());
    }

    start_step(connection, job, "embed", 65)?;
    let (chunk_embeddings, embedding_model_key) =
        crate::generate_chunk_embeddings(connection, &chunks);
    let vectorized_chunk_count = crate::count_vectorized_chunks(&chunk_embeddings);
    let embedding_error = if chunks.is_empty() {
        None
    } else if vectorized_chunk_count <= 0 {
        Some("indexed without embeddings")
    } else if vectorized_chunk_count < chunks.len() as i64 {
        Some("partially vectorized")
    } else {
        None
    };
    finish_step(
        connection,
        job,
        "embed",
        if embedding_error.is_some() {
            STEP_STATUS_SKIPPED
        } else {
            STEP_STATUS_SUCCEEDED
        },
        100,
        embedding_error,
    )?;
    if let Some(message) = embedding_error {
        log_job(
            connection,
            &job.id,
            &job.document_id,
            "warn",
            Some("embed"),
            message,
            parsed.metadata_json.as_deref(),
        )?;
    }
    if matches!(check_job_control(connection, job)?, ControlFlow::Stop) {
        return Ok(());
    }

    start_step(connection, job, "index", 80)?;
    let now = current_timestamp_ms();
    let content_preview = preview_text(&parsed.content, 240);
    let chunk_count = chunks.len() as i64;
    let document_status = if chunk_count <= 0 || vectorized_chunk_count >= chunk_count {
        DOCUMENT_STATUS_SEARCHABLE
    } else {
        DOCUMENT_STATUS_PARTIAL
    };
    let document_error = embedding_error;
    let tx = connection
        .unchecked_transaction()
        .map_err(|err| err.to_string())?;
    tx.execute(
        "DELETE FROM knowledge_chunks WHERE document_id = ?1",
        params![job.document_id],
    )
    .map_err(|err| err.to_string())?;
    {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO knowledge_chunks (
                  id, document_id, collection_id, chunk_index, title, content,
                  embedding_json, embedding_model_key, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                "#,
            )
            .map_err(|err| err.to_string())?;
        for (index, chunk) in chunks.into_iter().enumerate() {
            stmt.execute(params![
                uuid::Uuid::new_v4().to_string(),
                job.document_id,
                job.collection_id,
                index as i64,
                chunk.title,
                chunk.content,
                chunk_embeddings.get(index).cloned().unwrap_or(None),
                embedding_model_key.clone(),
                now,
            ])
            .map_err(|err| err.to_string())?;
        }
    }
    tx.execute(
        r#"
        UPDATE knowledge_documents
        SET preview_type = ?2, content = ?3, content_preview = ?4, chunk_count = ?5,
            processing_status = ?6, error_message = ?7, content_version = content_version + 1,
            last_processed_at = ?8, updated_at = ?9
        WHERE id = ?1
        "#,
        params![
            job.document_id,
            parsed.preview_type,
            parsed.content,
            content_preview,
            chunk_count,
            document_status,
            document_error,
            now,
            now,
        ],
    )
    .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;
    finish_step(connection, job, "index", STEP_STATUS_SUCCEEDED, 100, None)?;
    if matches!(check_job_control(connection, job)?, ControlFlow::Stop) {
        return Ok(());
    }

    start_step(connection, job, "finalize", 95)?;
    let now = current_timestamp_ms();
    connection
        .execute(
            r#"
            UPDATE knowledge_documents
            SET processing_status = ?2, error_message = ?3, active_job_id = NULL, last_processed_at = ?4,
                updated_at = ?5
            WHERE id = ?1
            "#,
            params![job.document_id, document_status, document_error, now, now],
        )
        .map_err(|err| err.to_string())?;
    connection
        .execute(
            r#"
            UPDATE knowledge_processing_jobs
            SET status = ?2, progress = 100, error_message = ?3, fail_count = 0, next_run_at = NULL,
                finished_at = ?4, updated_at = ?5
            WHERE id = ?1
            "#,
            params![job.id, JOB_STATUS_SUCCEEDED, document_error, now, now,],
        )
        .map_err(|err| err.to_string())?;
    finish_step(
        connection,
        job,
        "finalize",
        STEP_STATUS_SUCCEEDED,
        100,
        None,
    )?;
    log_job(
        connection,
        &job.id,
        &job.document_id,
        "info",
        Some("finalize"),
        if document_status == DOCUMENT_STATUS_SEARCHABLE {
            "job completed as searchable"
        } else {
            "job completed as partial"
        },
        None,
    )
}

fn recover_timed_out_running_jobs(
    connection: &Connection,
    timeout_ms: i64,
    max_auto_retries: i64,
) -> Result<i64, String> {
    let now = current_timestamp_ms();
    let cutoff = now.saturating_sub(timeout_ms.max(10_000));
    let timeout_message = format!("job timed out after {} ms", timeout_ms.max(10_000));

    let mut stmt = connection
        .prepare(
            r#"
            SELECT id, document_id, current_step
            FROM knowledge_processing_jobs
            WHERE status = ?1 AND updated_at < ?2
            "#,
        )
        .map_err(|err| err.to_string())?;
    let stale_jobs = stmt
        .query_map(params![JOB_STATUS_RUNNING, cutoff], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    for (job_id, document_id, step_name) in &stale_jobs {
        let (fail_count, max_attempts): (i64, i64) = connection
            .query_row(
                "SELECT fail_count, max_attempts FROM knowledge_processing_jobs WHERE id = ?1",
                params![job_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|err| err.to_string())?;
        let next_fail_count = fail_count.saturating_add(1);
        let retry_cap = max_auto_retries.min(max_attempts).max(0);
        let should_retry = next_fail_count <= retry_cap;

        connection
            .execute(
                r#"
                UPDATE knowledge_processing_steps
                SET status = ?2, error_message = ?3, finished_at = ?4, updated_at = ?5
                WHERE job_id = ?1 AND status = ?6
                "#,
                params![
                    job_id,
                    STEP_STATUS_FAILED,
                    timeout_message,
                    now,
                    now,
                    STEP_STATUS_RUNNING
                ],
            )
            .map_err(|err| err.to_string())?;
        if should_retry {
            let retry_at = now.saturating_add(compute_retry_delay_ms(next_fail_count));
            connection
                .execute(
                    r#"
                    UPDATE knowledge_processing_jobs
                    SET status = ?2, fail_count = ?3, next_run_at = ?4, error_message = ?5,
                        finished_at = NULL, updated_at = ?6
                    WHERE id = ?1
                    "#,
                    params![
                        job_id,
                        JOB_STATUS_QUEUED,
                        next_fail_count,
                        retry_at,
                        timeout_message,
                        now
                    ],
                )
                .map_err(|err| err.to_string())?;
            connection
                .execute(
                    r#"
                    UPDATE knowledge_documents
                    SET processing_status = ?2, error_message = ?3, active_job_id = ?4, updated_at = ?5
                    WHERE id = ?1 AND active_job_id = ?4
                    "#,
                    params![document_id, DOCUMENT_STATUS_PENDING, timeout_message, job_id, now],
                )
                .map_err(|err| err.to_string())?;
            log_job(
                connection,
                job_id,
                document_id,
                "warn",
                step_name.as_deref(),
                "timed out and re-queued",
                Some(&format!(
                    "{{\"failCount\":{next_fail_count},\"retryAt\":{retry_at},\"timeoutMs\":{}}}",
                    timeout_ms.max(10_000)
                )),
            )?;
        } else {
            connection
                .execute(
                    r#"
                    UPDATE knowledge_processing_jobs
                    SET status = ?2, fail_count = ?3, progress = 100, error_message = ?4,
                        next_run_at = NULL, finished_at = ?5, updated_at = ?6
                    WHERE id = ?1
                    "#,
                    params![job_id, JOB_STATUS_FAILED, next_fail_count, timeout_message, now, now],
                )
                .map_err(|err| err.to_string())?;
            let failed_job_record = load_job_record(connection, job_id)?;
            let failed_job_claim = PipelineJobClaim {
                id: job_id.clone(),
                document_id: document_id.clone(),
                collection_id: failed_job_record.collection_id.clone(),
            };
            upsert_dead_letter(
                connection,
                &failed_job_claim,
                &failed_job_record,
                &timeout_message,
                now,
            )?;
            connection
                .execute(
                    r#"
                    UPDATE knowledge_documents
                    SET processing_status = ?2, error_message = ?3, active_job_id = NULL, updated_at = ?4
                    WHERE id = ?1 AND active_job_id = ?5
                    "#,
                    params![document_id, DOCUMENT_STATUS_FAILED, timeout_message, now, job_id],
                )
                .map_err(|err| err.to_string())?;
            log_job(
                connection,
                job_id,
                document_id,
                "error",
                step_name.as_deref(),
                &timeout_message,
                None,
            )?;
        }
    }

    Ok(stale_jobs.len() as i64)
}

fn execute_claimed_job(connection: &Connection, job: &PipelineJobClaim) -> Result<(), String> {
    let now = current_timestamp_ms();
    connection
        .execute(
            r#"
            UPDATE knowledge_documents
            SET processing_status = ?2, error_message = NULL, active_job_id = ?3, updated_at = ?4
            WHERE id = ?1
            "#,
            params![job.document_id, DOCUMENT_STATUS_PROCESSING, job.id, now],
        )
        .map_err(|err| err.to_string())?;

    start_step(connection, job, "validate", 5)?;
    let document = load_document_source(connection, &job.document_id)?;
    if document.collection_id != job.collection_id || document.id != job.document_id {
        return Err("document/job mismatch".into());
    }
    let stored_file_path = document
        .stored_file_path
        .as_ref()
        .ok_or_else(|| "stored file path is missing".to_string())?;
    let bytes = fs::read(stored_file_path).map_err(|err| err.to_string())?;
    validate_upload_size(&bytes)?;
    finish_step(connection, job, "validate", STEP_STATUS_SUCCEEDED, 100, None)?;
    if matches!(check_job_control(connection, job)?, ControlFlow::Stop) {
        return Ok(());
    }

    start_step(connection, job, "parse", 20)?;
    let parsed = match parse_simple_document(
        &document.source_name,
        document.file_extension.as_deref(),
        &bytes,
        document.content.as_deref(),
    ) {
        Ok(parsed) => parsed,
        Err(err) => {
            mark_unsupported(connection, job, &err)?;
            return Ok(());
        }
    };
    finish_step(connection, job, "parse", STEP_STATUS_SUCCEEDED, 100, None)?;
    if matches!(check_job_control(connection, job)?, ControlFlow::Stop) {
        return Ok(());
    }

    start_step(connection, job, "extract_assets", 35)?;
    skip_step(
        connection,
        job,
        "extract_assets",
        "no asset extraction needed for simple parser",
    )?;
    if matches!(check_job_control(connection, job)?, ControlFlow::Stop) {
        return Ok(());
    }

    complete_partial_job(connection, job, parsed)
}

fn process_claimed_job(
    app: &tauri::AppHandle,
    job: PipelineJobClaim,
    max_auto_retries: i64,
) -> Result<(), String> {
    let connection = open_pipeline_connection(app)?;
    if let Err(err) = execute_claimed_job(&connection, &job) {
        fail_job(&connection, &job, None, &err, max_auto_retries)?;
    }
    Ok(())
}

pub fn run_next_pipeline_job(app: &tauri::AppHandle) -> Result<bool, String> {
    let connection = open_pipeline_connection(app)?;
    let settings = load_pipeline_settings(&connection)?;
    let Some(job) =
        claim_next_job_with_limits(&connection, settings.per_collection_max_running)?
    else {
        return Ok(false);
    };
    process_claimed_job(app, job, settings.max_auto_retries)?;
    Ok(true)
}

pub fn run_pipeline_worker_tick(app: &tauri::AppHandle) -> Result<bool, String> {
    let connection = open_pipeline_connection(app)?;
    let settings = load_pipeline_settings(&connection)?;
    if !settings.enabled {
        return Ok(false);
    }

    recover_timed_out_running_jobs(
        &connection,
        settings.job_timeout_ms,
        settings.max_auto_retries,
    )?;
    let running_jobs = count_running_jobs(&connection)?;
    let mut capacity = (settings.max_concurrent_jobs - running_jobs).max(0);
    if capacity <= 0 {
        return Ok(false);
    }

    let mut launched = 0_i64;
    while capacity > 0 {
        let maybe_job = claim_next_job_with_limits(&connection, settings.per_collection_max_running)?;
        let Some(job) = maybe_job else {
            break;
        };

        let worker_app = app.clone();
        let retry_limit = settings.max_auto_retries;
        std::thread::spawn(move || {
            if let Err(err) = process_claimed_job(&worker_app, job, retry_limit) {
                eprintln!("[Omni] knowledge pipeline job execution error: {err}");
            }
        });
        launched += 1;
        capacity -= 1;
    }

    Ok(launched > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn new_test_connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS knowledge_collections (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  description TEXT NOT NULL,
                  retrieval_mode TEXT NOT NULL DEFAULT 'hybrid',
                  embedding_profile_id TEXT,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS knowledge_documents (
                  id TEXT PRIMARY KEY,
                  collection_id TEXT NOT NULL,
                  source_name TEXT NOT NULL,
                  source_path TEXT,
                  stored_file_path TEXT,
                  mime_type TEXT,
                  file_extension TEXT,
                  preview_type TEXT,
                  content TEXT,
                  content_preview TEXT NOT NULL,
                  thumbnail_data_url TEXT,
                  file_hash TEXT,
                  file_size INTEGER,
                  processing_status TEXT NOT NULL DEFAULT 'searchable',
                  error_message TEXT,
                  active_job_id TEXT,
                  content_version INTEGER NOT NULL DEFAULT 1,
                  parser_profile_id TEXT,
                  last_processed_at INTEGER,
                  chunk_count INTEGER NOT NULL,
                  tags_json TEXT NOT NULL,
                  favorite INTEGER NOT NULL DEFAULT 0,
                  access_count INTEGER NOT NULL DEFAULT 0,
                  last_accessed_at INTEGER,
                  title_hierarchy TEXT,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS knowledge_chunks (
                  id TEXT PRIMARY KEY,
                  document_id TEXT NOT NULL,
                  collection_id TEXT NOT NULL,
                  chunk_index INTEGER NOT NULL,
                  title TEXT,
                  content TEXT NOT NULL,
                  embedding_json TEXT,
                  embedding_model_key TEXT,
                  created_at INTEGER NOT NULL,
                  UNIQUE(document_id, chunk_index)
                );
                "#,
            )
            .unwrap();
        ensure_pipeline_schema(&connection).unwrap();
        connection
    }

    fn seed_collection_and_document(connection: &Connection) -> (String, String) {
        let now = current_timestamp_ms();
        let collection_id = "col-test".to_string();
        let document_id = "doc-test".to_string();
        connection
            .execute(
                r#"
                INSERT INTO knowledge_collections (
                  id, name, description, retrieval_mode, embedding_profile_id, created_at, updated_at
                ) VALUES (?1, ?2, ?3, 'hybrid', NULL, ?4, ?5)
                "#,
                params![collection_id, "测试库", "测试用", now, now],
            )
            .unwrap();
        connection
            .execute(
                r#"
                INSERT INTO knowledge_documents (
                  id, collection_id, source_name, source_path, stored_file_path, mime_type, file_extension,
                  preview_type, content, content_preview, chunk_count, tags_json, favorite, access_count,
                  last_accessed_at, title_hierarchy, created_at, updated_at
                ) VALUES (?1, ?2, ?3, NULL, NULL, NULL, 'txt', 'text', 'hello', 'hello', 0, '[]', 0, 0, NULL, NULL, ?4, ?5)
                "#,
                params![document_id, collection_id, "smoke.txt", now, now],
            )
            .unwrap();
        (collection_id, document_id)
    }

    #[test]
    fn csv_to_markdown_pads_and_escapes_cells() {
        let markdown = csv_to_markdown("name,value\nalpha,1\npipe,a|b", ',');

        assert_eq!(
            markdown,
            "| name | value |\n| --- | --- |\n| alpha | 1 |\n| pipe | a\\|b |\n"
        );
    }

    #[test]
    fn parse_markdown_keeps_markdown_preview() {
        let parsed = parse_simple_document("notes.md", Some("md"), b"# Title\nBody", None).unwrap();

        assert_eq!(parsed.content, "# Title\nBody");
        assert_eq!(parsed.preview_type, "markdown");
        assert!(parsed.metadata_json.is_none());
    }

    #[test]
    fn parse_csv_converts_to_markdown_table() {
        let parsed = parse_simple_document("data.csv", Some(".csv"), b"a,b\n1,2", None).unwrap();

        assert_eq!(parsed.preview_type, "markdown");
        assert!(parsed.content.contains("| a | b |"));
        assert!(parsed.content.contains("| 1 | 2 |"));
    }

    #[test]
    fn parse_pdf_uses_frontend_bridge_content() {
        let parsed =
            parse_simple_document("report.pdf", Some("pdf"), b"%PDF", Some("Extracted text"))
                .unwrap();

        assert_eq!(parsed.preview_type, "pdf");
        assert_eq!(parsed.content, "Extracted text");
        assert_eq!(
            parsed.metadata_json.as_deref(),
            Some("{\"mode\":\"frontend_bridge\"}")
        );
    }

    #[test]
    fn parse_image_uses_placeholder() {
        let parsed = parse_simple_document("photo.png", Some("png"), &[1, 2, 3], None).unwrap();

        assert_eq!(parsed.preview_type, "image");
        assert_eq!(parsed.content, "![photo.png](photo.png)");
        assert_eq!(
            parsed.metadata_json.as_deref(),
            Some("{\"mode\":\"store_with_placeholder\"}")
        );
    }

    #[test]
    fn parse_unknown_extension_is_unsupported() {
        let err = parse_simple_document("archive.zip", Some("zip"), &[1, 2, 3], None).unwrap_err();

        assert!(err.contains(".zip"));
    }

    #[test]
    fn dead_letter_flow_failed_then_replayed() {
        let connection = new_test_connection();
        let (collection_id, document_id) = seed_collection_and_document(&connection);
        let now = current_timestamp_ms();

        let job = insert_job_record(
            &connection,
            &document_id,
            &collection_id,
            "initial_import",
            0,
            3,
            DEFAULT_JOB_PRIORITY,
            0,
            None,
            None,
            now,
        )
        .unwrap();
        let claim = PipelineJobClaim {
            id: job.id.clone(),
            document_id: document_id.clone(),
            collection_id: collection_id.clone(),
        };
        fail_job(&connection, &claim, Some("parse"), "smoke failure", 0).unwrap();

        let failed_job = load_job_record(&connection, &job.id).unwrap();
        assert_eq!(failed_job.status, JOB_STATUS_FAILED);

        let failed_result = list_dead_letters(
            &connection,
            DeadLetterQueryInput {
                collection_id: Some(collection_id.clone()),
                status: Some("failed".to_string()),
                limit: Some(10),
                offset: Some(0),
            },
        )
        .unwrap();
        assert_eq!(failed_result.total, 1);
        assert_eq!(failed_result.items.len(), 1);
        assert_eq!(failed_result.items[0].status, JOB_STATUS_FAILED);

        let replay_result = replay_dead_letters(
            &connection,
            ReplayDeadLettersInput {
                collection_id: Some(collection_id.clone()),
                status: Some("failed".to_string()),
                limit: Some(10),
            },
        )
        .unwrap();
        assert_eq!(replay_result.attempted, 1);
        assert_eq!(replay_result.replayed, 1);
        assert_eq!(replay_result.skipped, 0);

        let replayed_result = list_dead_letters(
            &connection,
            DeadLetterQueryInput {
                collection_id: Some(collection_id.clone()),
                status: Some("replayed".to_string()),
                limit: Some(10),
                offset: Some(0),
            },
        )
        .unwrap();
        assert_eq!(replayed_result.total, 1);
        assert_eq!(replayed_result.items.len(), 1);
        assert_eq!(replayed_result.items[0].status, "replayed");
        assert!(replayed_result.items[0].replayed_job_id.is_some());

        let queued_jobs: i64 = connection
            .query_row(
                "SELECT COUNT(1) FROM knowledge_processing_jobs WHERE status = ?1 AND collection_id = ?2",
                params![JOB_STATUS_QUEUED, collection_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(queued_jobs, 1);

        let current_document_status: String = connection
            .query_row(
                "SELECT processing_status FROM knowledge_documents WHERE id = ?1",
                params![document_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(current_document_status, DOCUMENT_STATUS_PENDING);
    }

    #[test]
    fn dead_letter_replay_status_filter_blocks_replayed_items() {
        let connection = new_test_connection();
        let (collection_id, document_id) = seed_collection_and_document(&connection);
        let now = current_timestamp_ms();

        let job = insert_job_record(
            &connection,
            &document_id,
            &collection_id,
            "initial_import",
            0,
            3,
            DEFAULT_JOB_PRIORITY,
            0,
            None,
            None,
            now,
        )
        .unwrap();
        let claim = PipelineJobClaim {
            id: job.id.clone(),
            document_id: document_id.clone(),
            collection_id: collection_id.clone(),
        };
        fail_job(&connection, &claim, Some("parse"), "smoke failure", 0).unwrap();

        let first_replay = replay_dead_letters(
            &connection,
            ReplayDeadLettersInput {
                collection_id: Some(collection_id.clone()),
                status: Some("failed".to_string()),
                limit: Some(10),
            },
        )
        .unwrap();
        assert_eq!(first_replay.attempted, 1);
        assert_eq!(first_replay.replayed, 1);

        let second_replay = replay_dead_letters(
            &connection,
            ReplayDeadLettersInput {
                collection_id: Some(collection_id.clone()),
                status: Some("replayed".to_string()),
                limit: Some(10),
            },
        )
        .unwrap();
        assert_eq!(second_replay.attempted, 1);
        assert_eq!(second_replay.replayed, 0);
        assert_eq!(second_replay.skipped, 1);
    }
}
