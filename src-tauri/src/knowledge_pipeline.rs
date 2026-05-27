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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeProcessingJobDetail {
    pub job: KnowledgeProcessingJobRecord,
    pub steps: Vec<KnowledgeProcessingStepRecord>,
    pub logs: Vec<KnowledgeProcessingLogRecord>,
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
        cancel_requested: row.get(9)?,
        pause_requested: row.get(10)?,
        error_message: row.get(11)?,
        created_at: row.get(12)?,
        started_at: row.get(13)?,
        finished_at: row.get(14)?,
        updated_at: row.get(15)?,
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

fn load_job_record(
    connection: &Connection,
    job_id: &str,
) -> Result<KnowledgeProcessingJobRecord, String> {
    connection
        .query_row(
            r#"
            SELECT id, document_id, collection_id, job_type, status, current_step, progress,
                   attempt, max_attempts, cancel_requested, pause_requested, error_message,
                   created_at, started_at, finished_at, updated_at
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
    now: i64,
) -> Result<KnowledgeProcessingJobRecord, String> {
    let job_id = uuid::Uuid::new_v4().to_string();
    connection
        .execute(
            r#"
            INSERT INTO knowledge_processing_jobs (
              id, document_id, collection_id, job_type, status, current_step, progress, attempt,
              max_attempts, cancel_requested, pause_requested, error_message, created_at,
              started_at, finished_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, 0, 0, NULL, ?9, NULL, NULL, ?10)
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
               attempt, max_attempts, cancel_requested, pause_requested, error_message,
               created_at, started_at, finished_at, updated_at
        FROM knowledge_processing_jobs
        WHERE document_id = ?1
        ORDER BY created_at DESC, id DESC
        "#
    } else {
        r#"
        SELECT id, document_id, collection_id, job_type, status, current_step, progress,
               attempt, max_attempts, cancel_requested, pause_requested, error_message,
               created_at, started_at, finished_at, updated_at
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
            SET pause_requested = 0, status = ?2, updated_at = ?3
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
            SET status = ?2, progress = 100, finished_at = ?3, updated_at = ?4
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
    let job = insert_job_record(&tx, &document_id, &collection_id, job_type, 0, 3, now)?;
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

fn claim_next_job(connection: &Connection) -> Result<Option<PipelineJobClaim>, String> {
    let Some(job) = connection
        .query_row(
            r#"
            SELECT id, document_id, collection_id
            FROM knowledge_processing_jobs
            WHERE status = ?1 AND cancel_requested = 0 AND pause_requested = 0
            ORDER BY created_at ASC, id ASC
            LIMIT 1
            "#,
            params![JOB_STATUS_QUEUED],
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

    let now = current_timestamp_ms();
    let changed = connection
        .execute(
            r#"
            UPDATE knowledge_processing_jobs
            SET status = ?2, current_step = ?3, progress = 1, started_at = COALESCE(started_at, ?4),
                updated_at = ?5
            WHERE id = ?1 AND status = ?6 AND cancel_requested = 0 AND pause_requested = 0
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
                SET status = ?2, progress = 100, finished_at = ?3, updated_at = ?4
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
                SET status = ?2, updated_at = ?3
                WHERE id = ?1
                "#,
                params![job.id, JOB_STATUS_PAUSED, now],
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

fn fail_job(
    connection: &Connection,
    job: &PipelineJobClaim,
    step_name: Option<&str>,
    error_message: &str,
) -> Result<(), String> {
    let now = current_timestamp_ms();
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
    connection
        .execute(
            r#"
            UPDATE knowledge_processing_jobs
            SET status = ?2, progress = 100, error_message = ?3, finished_at = ?4, updated_at = ?5
            WHERE id = ?1
            "#,
            params![job.id, JOB_STATUS_FAILED, error_message, now, now],
        )
        .map_err(|err| err.to_string())?;
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
    finish_step(connection, job, "embed", STEP_STATUS_SKIPPED, 100, None)?;
    log_job(
        connection,
        &job.id,
        &job.document_id,
        "warn",
        Some("embed"),
        "embedding skipped; document indexed without vectors",
        parsed.metadata_json.as_deref(),
    )?;
    if matches!(check_job_control(connection, job)?, ControlFlow::Stop) {
        return Ok(());
    }

    start_step(connection, job, "index", 80)?;
    let now = current_timestamp_ms();
    let content_preview = preview_text(&parsed.content, 240);
    let chunk_count = chunks.len() as i64;
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
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, ?7)
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
            DOCUMENT_STATUS_PARTIAL,
            "indexed without embeddings",
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
            SET processing_status = ?2, active_job_id = NULL, last_processed_at = ?3,
                updated_at = ?4
            WHERE id = ?1
            "#,
            params![job.document_id, DOCUMENT_STATUS_PARTIAL, now, now],
        )
        .map_err(|err| err.to_string())?;
    connection
        .execute(
            r#"
            UPDATE knowledge_processing_jobs
            SET status = ?2, progress = 100, error_message = ?3, finished_at = ?4, updated_at = ?5
            WHERE id = ?1
            "#,
            params![
                job.id,
                JOB_STATUS_SUCCEEDED,
                "indexed without embeddings",
                now,
                now,
            ],
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
        "job completed as partial",
        None,
    )
}

pub fn run_next_pipeline_job(app: &tauri::AppHandle) -> Result<bool, String> {
    let connection = open_pipeline_connection(app)?;
    let Some(job) = claim_next_job(&connection)? else {
        return Ok(false);
    };

    let result = (|| -> Result<(), String> {
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

        start_step(&connection, &job, "validate", 5)?;
        let document = load_document_source(&connection, &job.document_id)?;
        if document.collection_id != job.collection_id || document.id != job.document_id {
            return Err("document/job mismatch".into());
        }
        let stored_file_path = document
            .stored_file_path
            .as_ref()
            .ok_or_else(|| "stored file path is missing".to_string())?;
        let bytes = fs::read(stored_file_path).map_err(|err| err.to_string())?;
        validate_upload_size(&bytes)?;
        finish_step(
            &connection,
            &job,
            "validate",
            STEP_STATUS_SUCCEEDED,
            100,
            None,
        )?;
        if matches!(check_job_control(&connection, &job)?, ControlFlow::Stop) {
            return Ok(());
        }

        start_step(&connection, &job, "parse", 20)?;
        let parsed = match parse_simple_document(
            &document.source_name,
            document.file_extension.as_deref(),
            &bytes,
            document.content.as_deref(),
        ) {
            Ok(parsed) => parsed,
            Err(err) => {
                mark_unsupported(&connection, &job, &err)?;
                return Ok(());
            }
        };
        finish_step(&connection, &job, "parse", STEP_STATUS_SUCCEEDED, 100, None)?;
        if matches!(check_job_control(&connection, &job)?, ControlFlow::Stop) {
            return Ok(());
        }

        start_step(&connection, &job, "extract_assets", 35)?;
        skip_step(
            &connection,
            &job,
            "extract_assets",
            "no asset extraction needed for simple parser",
        )?;
        if matches!(check_job_control(&connection, &job)?, ControlFlow::Stop) {
            return Ok(());
        }

        complete_partial_job(&connection, &job, parsed)
    })();

    if let Err(err) = result {
        fail_job(&connection, &job, None, &err)?;
    }

    Ok(true)
}

pub fn run_pipeline_worker_tick(app: &tauri::AppHandle) -> Result<bool, String> {
    run_next_pipeline_job(app)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let parsed = parse_simple_document("report.pdf", Some("pdf"), b"%PDF", Some("Extracted text")).unwrap();

        assert_eq!(parsed.preview_type, "pdf");
        assert_eq!(parsed.content, "Extracted text");
        assert_eq!(parsed.metadata_json.as_deref(), Some("{\"mode\":\"frontend_bridge\"}"));
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
}
