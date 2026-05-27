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
    let content_preview = preview_text(&source_name, 240);
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
          ?8, NULL, ?9, 0, ?10, '[]',
          0, 0, NULL, NULL, ?11, ?12,
          ?13, NULL, ?14, 1, ?15,
          NULL, ?16, ?17
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
          max_attempts, cancel_requested, pause_requested, error_message, created_at, started_at,
          finished_at, updated_at
        ) VALUES (?1, ?2, ?3, 'initial_import', ?4, ?5, 0, 0, 3, 0, 0, NULL, ?6, NULL, NULL, ?7)
        "#,
        params![
            job_id,
            document_id,
            collection_id,
            JOB_STATUS_QUEUED,
            PIPELINE_STEPS[0],
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
