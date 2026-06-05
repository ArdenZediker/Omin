#![allow(dead_code)]

use crate::{
    find_exact_usable_knowledge_multimodal_model, infer_preview_type,
    load_knowledge_collection_multimodal_config, load_knowledge_multimodal_config,
    validate_knowledge_multimodal_upload, KnowledgeCollectionMultimodalConfigRecord,
    KnowledgeMultimodalModelConfigRecord,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use regex::Regex;
use reqwest::blocking::{multipart, Client as BlockingHttpClient};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
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

const PIPELINE_STEPS: [&str; 8] = [
    "validate",
    "parse",
    "enrich_image",
    "enrich_audio",
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
    pub document_name: Option<String>,
    pub collection_id: String,
    pub collection_name: Option<String>,
    pub job_type: String,
    pub job_type_label: String,
    pub status: String,
    pub status_label: String,
    pub user_message: String,
    pub user_action: Option<String>,
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
            keep_successful_logs_days: 1,
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

#[derive(Debug, Clone, Default)]
struct EnrichmentOutput {
    content: Option<String>,
    warning: Option<String>,
    ocr_text: Option<String>,
    summary: Option<String>,
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
    mime_type: Option<String>,
    file_extension: Option<String>,
    preview_type: Option<String>,
    content: Option<String>,
}

#[derive(Debug, Clone)]
struct PersistedEmbeddedImageAsset {
    asset_id: String,
    source_name: String,
    stored_file_path: String,
    mime_type: Option<String>,
    file_extension: Option<String>,
    page_index: Option<i64>,
    asset_index: i64,
    anchor_text: Option<String>,
    ocr_text: Option<String>,
    caption_text: Option<String>,
    thumbnail_data_url: Option<String>,
}

#[derive(Debug, Clone)]
struct EmbeddedImageChildChunkCandidate {
    title: Option<String>,
    content: String,
    chunk_type: String,
    parent_chunk_index: usize,
    asset_id: String,
    image_info: String,
}

#[derive(Debug, Clone)]
struct EmbeddedImageBuildOutput {
    text_chunks: Vec<crate::knowledge_chunker::ChunkSlice>,
    assets: Vec<crate::KnowledgeDocumentAssetRecord>,
    child_chunks: Vec<EmbeddedImageChildChunkCandidate>,
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
    let digest = Sha256::digest(bytes);
    format!("sha256:{:x}", digest)
}

fn validate_upload_size(bytes: &[u8]) -> Result<(), String> {
    const DEFAULT_MAX_FILE_SIZE: usize = 100 * 1024 * 1024;

    if bytes.is_empty() {
        return Err("文件为空，无法上传。".into());
    }
    if bytes.len() > DEFAULT_MAX_FILE_SIZE {
        return Err("文件超过 100MB 上限。".into());
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

fn resolve_preview_types(
    provided_preview_type: Option<&str>,
    extension: Option<&str>,
    mime_type: Option<&str>,
) -> (String, String) {
    let inferred_preview_type = infer_preview_type(extension, mime_type);
    let preview_type = provided_preview_type
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| inferred_preview_type.clone());
    let upload_guard_preview_type = if inferred_preview_type == "unsupported" {
        preview_type.clone()
    } else {
        inferred_preview_type
    };
    (preview_type, upload_guard_preview_type)
}

fn normalize_optional_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn infer_fallback_mime_type(preview_type: &str, extension: Option<&str>) -> &'static str {
    match preview_type {
        "image" => match extension.unwrap_or_default().trim_start_matches('.').to_lowercase().as_str() {
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            "svg" => "image/svg+xml",
            "avif" => "image/avif",
            "ico" => "image/x-icon",
            _ => "image/png",
        },
        "audio" => match extension.unwrap_or_default().trim_start_matches('.').to_lowercase().as_str() {
            "wav" => "audio/wav",
            "m4a" => "audio/mp4",
            "aac" => "audio/aac",
            "flac" => "audio/flac",
            "ogg" | "oga" => "audio/ogg",
            _ => "audio/mpeg",
        },
        _ => "application/octet-stream",
    }
}

fn format_image_placeholder(source_name: &str, mime_type: Option<&str>) -> String {
    let mime_line = mime_type
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("未知");
    format!(
        "图片文件\n文件名: {source_name}\nMIME 类型: {mime_line}\n原始引用: ![{source_name}]({source_name})"
    )
}

fn format_audio_placeholder(source_name: &str, mime_type: Option<&str>) -> String {
    let mime_line = mime_type
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("未知");
    format!("音频文件\n文件名: {source_name}\nMIME 类型: {mime_line}")
}

fn merge_multimodal_content(base: &str, multimodal: &str) -> String {
    let base = base.trim();
    let multimodal = multimodal.trim();
    if base.is_empty() {
        return multimodal.to_string();
    }
    if multimodal.is_empty() {
        return base.to_string();
    }

    format!("{base}\n\n--- 多模态分析 ---\n{multimodal}")
}

fn format_image_enrichment(
    source_name: &str,
    mime_type: Option<&str>,
    ocr_text: Option<&str>,
    summary: Option<&str>,
) -> String {
    let mut sections = vec![format!("图片分析结果：{source_name}")];
    if let Some(mime_type) = mime_type.map(str::trim).filter(|value| !value.is_empty()) {
        sections.push(format!("MIME 类型: {mime_type}"));
    }
    sections.push(String::new());
    sections.push("图片文字提取：".to_string());
    sections.push(
        normalize_optional_text(ocr_text)
            .unwrap_or_else(|| "未识别到可用文字内容。".to_string()),
    );
    sections.push(String::new());
    sections.push("图片摘要：".to_string());
    sections.push(
        normalize_optional_text(summary)
            .unwrap_or_else(|| "未生成图片摘要。".to_string()),
    );
    sections.join("\n")
}

fn format_audio_enrichment(
    source_name: &str,
    mime_type: Option<&str>,
    transcript: Option<&str>,
    summary: Option<&str>,
    keep_transcript: bool,
) -> String {
    let mut sections = vec![format!("音频分析结果：{source_name}")];
    if let Some(mime_type) = mime_type.map(str::trim).filter(|value| !value.is_empty()) {
        sections.push(format!("MIME 类型: {mime_type}"));
    }

    if keep_transcript {
        sections.push(String::new());
        sections.push("音频转写：".to_string());
        sections.push(
            normalize_optional_text(transcript)
                .unwrap_or_else(|| "未检测到清晰可用的语音内容。".to_string()),
        );
    }

    if let Some(summary) = normalize_optional_text(summary) {
        sections.push(String::new());
        sections.push("音频摘要：".to_string());
        sections.push(summary);
    }

    if sections.len() <= 2 {
        sections.push(String::new());
        sections.push("未生成额外的多模态音频文本。".to_string());
    }

    sections.join("\n")
}

fn extract_tagged_block(content: &str, tag_name: &str) -> Option<String> {
    let start_tag = format!("<{tag_name}>");
    let end_tag = format!("</{tag_name}>");
    let start_index = content.find(&start_tag)? + start_tag.len();
    let end_index = content[start_index..].find(&end_tag)? + start_index;
    normalize_optional_text(Some(&content[start_index..end_index]))
}

fn extract_chat_completion_text(payload: &JsonValue) -> Option<String> {
    let choices = payload.get("choices")?.as_array()?;
    let message = choices.first()?.get("message")?;
    match message.get("content")? {
        JsonValue::String(value) => normalize_optional_text(Some(value)),
        JsonValue::Array(parts) => {
            let text = parts
                .iter()
                .filter_map(|part| part.get("text").and_then(JsonValue::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            normalize_optional_text(Some(text.as_str()))
        }
        _ => None,
    }
}

fn build_multimodal_http_client() -> Result<BlockingHttpClient, String> {
    BlockingHttpClient::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|err| err.to_string())
}

fn request_chat_completion(
    client: &BlockingHttpClient,
    model: &KnowledgeMultimodalModelConfigRecord,
    request_body: &JsonValue,
) -> Result<String, String> {
    let response = client
        .post(format!(
            "{}/chat/completions",
            model.base_url.trim_end_matches('/')
        ))
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", model.api_key.trim()))
        .json(request_body)
        .send()
        .map_err(|err| err.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(format!("chat completion request failed ({status}): {body}"));
    }

    let payload: JsonValue = response.json().map_err(|err| err.to_string())?;
    extract_chat_completion_text(&payload)
        .ok_or_else(|| "chat completion response did not contain message content".to_string())
}

fn request_audio_transcription(
    client: &BlockingHttpClient,
    model: &KnowledgeMultimodalModelConfigRecord,
    source_name: &str,
    mime_type: Option<&str>,
    bytes: &[u8],
) -> Result<String, String> {
    let file_name = source_name.to_string();
    let file_part = if let Some(mime_type) = mime_type.map(str::trim).filter(|value| !value.is_empty()) {
        match multipart::Part::bytes(bytes.to_vec())
            .file_name(file_name.clone())
            .mime_str(mime_type)
        {
            Ok(part) => part,
            Err(_) => multipart::Part::bytes(bytes.to_vec()).file_name(file_name),
        }
    } else {
        multipart::Part::bytes(bytes.to_vec()).file_name(file_name)
    };

    let form = multipart::Form::new()
        .text("model", model.model.clone())
        .part("file", file_part);

    let response = client
        .post(format!(
            "{}/audio/transcriptions",
            model.base_url.trim_end_matches('/')
        ))
        .header("Authorization", format!("Bearer {}", model.api_key.trim()))
        .multipart(form)
        .send()
        .map_err(|err| err.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(format!("audio transcription request failed ({status}): {body}"));
    }

    let body = response.text().map_err(|err| err.to_string())?;
    if let Ok(payload) = serde_json::from_str::<JsonValue>(&body) {
        if let Some(text) = payload.get("text").and_then(JsonValue::as_str) {
            return Ok(text.trim().to_string());
        }
        if let Some(text) = payload.get("transcript").and_then(JsonValue::as_str) {
            return Ok(text.trim().to_string());
        }
        if let Some(text) = payload
            .get("data")
            .and_then(|value| value.get("text"))
            .and_then(JsonValue::as_str)
        {
            return Ok(text.trim().to_string());
        }
    }

    Ok(body.trim().to_string())
}

fn resolve_collection_multimodal_config(
    connection: &Connection,
    collection_id: &str,
) -> Result<KnowledgeCollectionMultimodalConfigRecord, String> {
    load_knowledge_collection_multimodal_config(connection, collection_id)
}

fn resolve_multimodal_model(
    connection: &Connection,
    model_id: &str,
    capability: &str,
) -> Result<KnowledgeMultimodalModelConfigRecord, String> {
    let global_config = load_knowledge_multimodal_config(connection)?;
    find_exact_usable_knowledge_multimodal_model(&global_config, capability, model_id)
        .ok_or_else(|| format!("no usable {capability} multimodal model found for id: {model_id}"))
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
    let file_extension = normalize_file_extension(input.file_extension, &source_name);
    let mime_type = input
        .mime_type
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let (preview_type, upload_guard_preview_type) = resolve_preview_types(
        input.preview_type.as_deref(),
        file_extension.as_deref(),
        mime_type.as_deref(),
    );
    validate_knowledge_multimodal_upload(connection, &collection_id, &upload_guard_preview_type)?;
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
    mime_type: Option<&str>,
    preview_type: Option<&str>,
    bytes: &[u8],
    bridged_content: Option<&str>,
) -> Result<ParsedDocument, String> {
    let ext = file_extension
        .unwrap_or_default()
        .trim_start_matches('.')
        .to_lowercase();
    let normalized_preview_type = preview_type
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_lowercase());
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
                .map(sanitize_frontend_bridged_content)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    format!("unsupported file extension .{ext}; original file has been stored")
                })?;
            Ok(ParsedDocument {
                content,
                preview_type: ext.clone(),
                metadata_json: Some("{\"mode\":\"frontend_bridge\"}".into()),
            })
        }
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "avif" | "ico" => Ok(ParsedDocument {
            content: format_image_placeholder(source_name, mime_type),
            preview_type: "image".into(),
            metadata_json: Some("{\"mode\":\"store_with_placeholder\"}".into()),
        }),
        "mp3" | "wav" | "m4a" | "aac" | "flac" | "ogg" | "oga" => Ok(ParsedDocument {
            content: format_audio_placeholder(source_name, mime_type),
            preview_type: "audio".into(),
            metadata_json: Some("{\"mode\":\"store_with_placeholder\"}".into()),
        }),
        "" => match normalized_preview_type.as_deref() {
            Some("image") => Ok(ParsedDocument {
                content: format_image_placeholder(source_name, mime_type),
                preview_type: "image".into(),
                metadata_json: Some("{\"mode\":\"store_with_placeholder\"}".into()),
            }),
            Some("audio") => Ok(ParsedDocument {
                content: format_audio_placeholder(source_name, mime_type),
                preview_type: "audio".into(),
                metadata_json: Some("{\"mode\":\"store_with_placeholder\"}".into()),
            }),
            Some("video") => Err("unsupported file type .video; original file has been stored".into()),
            _ => Err("unable to identify file extension".into()),
        },
        other => match normalized_preview_type.as_deref() {
            Some("image") => Ok(ParsedDocument {
                content: format_image_placeholder(source_name, mime_type),
                preview_type: "image".into(),
                metadata_json: Some("{\"mode\":\"store_with_placeholder\"}".into()),
            }),
            Some("audio") => Ok(ParsedDocument {
                content: format_audio_placeholder(source_name, mime_type),
                preview_type: "audio".into(),
                metadata_json: Some("{\"mode\":\"store_with_placeholder\"}".into()),
            }),
            Some("video") => Err("unsupported file type .video; original file has been stored".into()),
            _ => Err(format!(
                "unsupported file extension .{other}; original file has been stored"
            )),
        },
    }
}

fn sanitize_frontend_bridged_content(content: &str) -> String {
    let without_data_images = markdown_data_image_regex()
        .replace_all(content, "")
        .to_string();
    let normalized = without_data_images
        .replace("\r\n", "\n")
        .replace('\r', "\n");

    let mut out = String::with_capacity(normalized.len());
    let mut previous_blank = false;
    for line in normalized.lines() {
        let trimmed_end = line.trim_end();
        if trimmed_end.trim().is_empty() {
            if !previous_blank {
                out.push('\n');
                previous_blank = true;
            }
            continue;
        }

        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(trimmed_end);
        previous_blank = false;
    }
    out.trim().to_string()
}

fn enrich_image_document(
    document: &PipelineDocumentSource,
    bytes: &[u8],
    model: &KnowledgeMultimodalModelConfigRecord,
    config: &KnowledgeCollectionMultimodalConfigRecord,
) -> Result<EnrichmentOutput, String> {
    if !config.image.extract_text && !config.image.generate_summary {
        return Ok(EnrichmentOutput::default());
    }

    let mime_type = document
        .mime_type
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| infer_fallback_mime_type("image", document.file_extension.as_deref()));
    let data_url = format!(
        "data:{mime_type};base64,{}",
        BASE64_STANDARD.encode(bytes)
    );
    let prompt = format!(
        "你正在为知识库准备一段可用于中文检索的图片分析文本，文件名是“{}”。\n\
请只返回 XML，格式必须严格如下：\n\
<result>\n<ocr>...</ocr>\n<summary>...</summary>\n</result>\n\
要求：\n\
- `<ocr>` 中输出适合中文向量检索的文字内容。如果图片原文不是中文，请优先输出中文整理版，必要时保留关键原文术语。\n\
- `<summary>` 中输出中文摘要，简洁描述图片中的关键信息、结构、主题和可检索要点。\n\
- 如果某一项未启用或没有结果，请返回空标签。\n\
- 不要输出 Markdown 代码块、解释或额外说明。\n\
- 是否需要 OCR：{}\n\
- 是否需要摘要：{}",
        document.source_name,
        if config.image.extract_text { "是" } else { "否" },
        if config.image.generate_summary { "是" } else { "否" }
    );
    let request_body = serde_json::json!({
        "model": model.model,
        "temperature": 0.1,
        "messages": [
            {
                "role": "system",
                "content": "你负责生成适合中文知识库检索的图片 OCR 文本和图片摘要。"
            },
            {
                "role": "user",
                "content": [
                    { "type": "text", "text": prompt },
                    { "type": "image_url", "image_url": { "url": data_url } }
                ]
            }
        ]
    });

    let client = build_multimodal_http_client()?;
    let raw_text = request_chat_completion(&client, model, &request_body)?;
    let mut ocr_text = if config.image.extract_text {
        extract_tagged_block(&raw_text, "ocr")
    } else {
        None
    };
    let mut summary = if config.image.generate_summary {
        extract_tagged_block(&raw_text, "summary")
    } else {
        None
    };
    if ocr_text.is_none() && summary.is_none() {
        if config.image.generate_summary {
            summary = normalize_optional_text(Some(raw_text.as_str()));
        } else if config.image.extract_text {
            ocr_text = normalize_optional_text(Some(raw_text.as_str()));
        }
    }

    Ok(EnrichmentOutput {
        content: Some(format_image_enrichment(
            &document.source_name,
            Some(mime_type),
            ocr_text.as_deref(),
            summary.as_deref(),
        )),
        warning: None,
        ocr_text,
        summary,
    })
}

fn summarize_audio_transcript(
    client: &BlockingHttpClient,
    model: &KnowledgeMultimodalModelConfigRecord,
    source_name: &str,
    transcript: &str,
) -> Result<String, String> {
    let prompt = format!(
        "请基于音频文件“{source_name}”的转写内容，生成一段适合中文知识库检索的摘要。\n\
要求：\n\
- 使用中文输出。\n\
- 保留重要的人名、地名、数字、日期、结论和决策。\n\
- 用 3 到 6 句话概括。\n\
- 只返回纯文本，不要加标题或 Markdown。\n\n转写内容：\n{transcript}"
    );
    let request_body = serde_json::json!({
        "model": model.model,
        "temperature": 0.1,
        "messages": [
            {
                "role": "system",
                "content": "你负责把音频转写整理成适合中文知识库检索的精炼摘要。"
            },
            {
                "role": "user",
                "content": prompt
            }
        ]
    });

    request_chat_completion(client, model, &request_body)
}

fn enrich_audio_document(
    document: &PipelineDocumentSource,
    bytes: &[u8],
    model: &KnowledgeMultimodalModelConfigRecord,
    config: &KnowledgeCollectionMultimodalConfigRecord,
) -> Result<EnrichmentOutput, String> {
    if !config.audio.keep_transcript && !config.audio.generate_summary {
        return Ok(EnrichmentOutput::default());
    }

    let mime_type = document
        .mime_type
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| infer_fallback_mime_type("audio", document.file_extension.as_deref()));
    let client = build_multimodal_http_client()?;
    let transcript = request_audio_transcription(
        &client,
        model,
        &document.source_name,
        Some(mime_type),
        bytes,
    )?;

    let mut warning = None;
    let summary = if config.audio.generate_summary && !transcript.trim().is_empty() {
        match summarize_audio_transcript(&client, model, &document.source_name, &transcript) {
            Ok(summary) => normalize_optional_text(Some(summary.as_str())),
            Err(err) => {
                warning = Some(format!("音频摘要生成失败: {err}"));
                None
            }
        }
    } else {
        None
    };

    Ok(EnrichmentOutput {
        content: Some(format_audio_enrichment(
            &document.source_name,
            Some(mime_type),
            Some(transcript.as_str()),
            summary.as_deref(),
            config.audio.keep_transcript,
        )),
        warning,
        ocr_text: None,
        summary: None,
    })
}

fn markdown_data_image_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"!\[[^\]]*\]\(\s*data:image/[^)]+?\)")
            .expect("valid markdown data image regex")
    })
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

fn dead_letter_job_type_label(job_type: &str) -> &'static str {
    match job_type {
        "initial_import" => "初次导入",
        "reindex" => "重新处理",
        "refresh_preview" => "刷新预览",
        "refresh_embeddings" => "刷新向量索引",
        _ => "处理任务",
    }
}

fn dead_letter_status_label(status: &str) -> &'static str {
    match status {
        "failed" => "失败",
        "replayed" => "已回放",
        "running" => "处理中",
        "queued" => "排队中",
        "canceled" => "已取消",
        _ => "未知状态",
    }
}

fn dead_letter_snapshot_text(metadata_json: Option<&str>, field: &str) -> Option<String> {
    metadata_json
        .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
        .and_then(|value| value.get(field).and_then(|item| item.as_str()).map(str::trim).map(str::to_string))
        .filter(|value| !value.is_empty())
}

fn dead_letter_user_message(error_message: Option<&str>) -> String {
    let Some(message) = error_message.map(str::trim).filter(|value| !value.is_empty()) else {
        return "处理失败，请查看详情。".to_string();
    };

    let lower = message.to_lowercase();
    if lower.contains("query returned no rows") || lower.contains("job not found") {
        return "没有找到对应的处理记录。".to_string();
    }
    if lower.contains("timeout") || lower.contains("timed out") {
        return "任务处理超时。".to_string();
    }
    if lower.contains("permission denied") || lower.contains("access is denied") {
        return "没有足够权限访问这个文件。".to_string();
    }
    if lower.contains("not found") || lower.contains("no such file") {
        return "找不到对应文件，可能已被移动或删除。".to_string();
    }
    if lower.contains("parse") || lower.contains("decode") {
        return "文档解析失败。".to_string();
    }
    if lower.contains("sqlite") || lower.contains("database") {
        return "处理记录写入失败。".to_string();
    }
    "处理失败，请查看详情。".to_string()
}

fn dead_letter_user_action(error_message: Option<&str>, status: &str) -> Option<String> {
    if status == "replayed" {
        return Some("该任务已回放，可稍后刷新查看最新状态。".to_string());
    }

    let lower = error_message.unwrap_or_default().to_lowercase();
    if lower.contains("query returned no rows") || lower.contains("job not found") {
        return Some("建议确认文档和任务记录仍存在，再尝试回放。".to_string());
    }
    if lower.contains("timeout") || lower.contains("timed out") {
        return Some("建议先回放一次；若仍失败，再检查文档内容或超时设置。".to_string());
    }
    if lower.contains("permission denied") || lower.contains("access is denied") {
        return Some("请检查文件权限或文件是否被其他程序占用。".to_string());
    }
    if lower.contains("not found") || lower.contains("no such file") {
        return Some("请确认原文件路径有效，必要时重新导入文档。".to_string());
    }
    Some("可尝试回放一次；若仍失败，请展开详情查看原始错误。".to_string())
}

fn read_dead_letter_record(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<KnowledgeProcessingDeadLetterRecord> {
    let job_type: String = row.get(6)?;
    let status: String = row.get(7)?;
    let error_message: Option<String> = row.get(8)?;
    let metadata_json: Option<String> = row.get(17)?;
    let document_name = row
        .get::<_, Option<String>>(3)?
        .and_then(|value| {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        })
        .or_else(|| dead_letter_snapshot_text(metadata_json.as_deref(), "sourceName"));
    let collection_name = row
        .get::<_, Option<String>>(5)?
        .and_then(|value| {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        })
        .or_else(|| dead_letter_snapshot_text(metadata_json.as_deref(), "collectionName"));
    Ok(KnowledgeProcessingDeadLetterRecord {
        id: row.get(0)?,
        job_id: row.get(1)?,
        document_id: row.get(2)?,
        document_name,
        collection_id: row.get(4)?,
        collection_name,
        job_type: job_type.clone(),
        job_type_label: dead_letter_job_type_label(&job_type).to_string(),
        status: status.clone(),
        status_label: dead_letter_status_label(&status).to_string(),
        user_message: dead_letter_user_message(error_message.as_deref()),
        user_action: dead_letter_user_action(error_message.as_deref(), &status),
        error_message,
        fail_count: row.get(9)?,
        attempt: row.get(10)?,
        max_attempts: row.get(11)?,
        first_failed_at: row.get(12)?,
        last_failed_at: row.get(13)?,
        replayed_at: row.get(14)?,
        replayed_job_id: row.get(15)?,
        resolved_at: row.get(16)?,
        metadata_json,
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
                WHEN 'enrich_image' THEN 2
                WHEN 'enrich_audio' THEN 3
                WHEN 'chunk' THEN 4
                WHEN 'embed' THEN 5
                WHEN 'index' THEN 6
                WHEN 'finalize' THEN 7
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
        SELECT dl.id, dl.job_id, dl.document_id, d.source_name, dl.collection_id, c.name,
               dl.job_type, dl.status, dl.error_message, dl.fail_count, dl.attempt,
               dl.max_attempts, dl.first_failed_at, dl.last_failed_at, dl.replayed_at,
               dl.replayed_job_id, dl.resolved_at, dl.metadata_json
        FROM knowledge_processing_dead_letters dl
        LEFT JOIN knowledge_documents d ON d.id = dl.document_id
        LEFT JOIN knowledge_collections c ON c.id = dl.collection_id
    "#;
    let base_count = "SELECT COUNT(1) FROM knowledge_processing_dead_letters";
    let order = " ORDER BY dl.last_failed_at DESC, dl.first_failed_at DESC, dl.id DESC ";

    let (total, items) = match (collection_id.as_ref(), normalized_status.as_ref()) {
        (Some(collection_id), Some(status)) => {
            let count_sql = format!("{base_count} WHERE collection_id = ?1 AND status = ?2");
            let list_sql = format!("{base_select} WHERE dl.collection_id = ?1 AND dl.status = ?2 {order} LIMIT ?3 OFFSET ?4");
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
            let list_sql = format!("{base_select} WHERE dl.collection_id = ?1 {order} LIMIT ?2 OFFSET ?3");
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
            let list_sql = format!("{base_select} WHERE dl.status = ?1 {order} LIMIT ?2 OFFSET ?3");
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

    let mut settings = settings_json
        .as_deref()
        .and_then(|value| serde_json::from_str::<KnowledgePipelineSettings>(value).ok())
        .unwrap_or_default();

    // Migrate the old success-log default (7 days) down to the new leaner default.
    // This setting is not user-facing today, so preserving the legacy value mostly
    // means keeping invisible success logs longer than we need.
    if settings.keep_successful_logs_days == 7 {
        settings.keep_successful_logs_days = 1;
    }

    let settings = settings.clamped();

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
            SELECT id, collection_id, source_name, stored_file_path, mime_type, file_extension, preview_type, content
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
                    mime_type: row.get(4)?,
                    file_extension: row.get(5)?,
                    preview_type: row.get(6)?,
                    content: row.get(7)?,
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
    let source_name = connection
        .query_row(
            "SELECT source_name FROM knowledge_documents WHERE id = ?1",
            params![job.document_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let collection_name = connection
        .query_row(
            "SELECT name FROM knowledge_collections WHERE id = ?1",
            params![job.collection_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let metadata_json = serde_json::json!({
        "source": "pipeline",
        "final": true,
        "jobStatus": JOB_STATUS_FAILED,
        "sourceName": source_name,
        "collectionName": collection_name,
    })
    .to_string();

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
                Some(metadata_json),
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
    for step_name in [
        "enrich_image",
        "enrich_audio",
        "chunk",
        "embed",
        "index",
        "finalize",
    ] {
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

fn split_parsed_document_into_chunks(
    parsed: &ParsedDocument,
    source_name: &str,
    file_extension: Option<&str>,
) -> Vec<crate::knowledge_chunker::ChunkSlice> {
    crate::knowledge_chunker::split_document_text(
        &parsed.content,
        source_name,
        Some(parsed.preview_type.as_str()),
        file_extension,
        crate::knowledge_chunker::DEFAULT_CHUNK_SIZE,
        crate::knowledge_chunker::DEFAULT_CHUNK_OVERLAP,
    )
}

fn normalize_attachment_text(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn resolve_embedded_asset_parent_chunk_index(
    text_chunks: &[crate::knowledge_chunker::ChunkSlice],
    anchor_text: Option<&str>,
    asset_index: i64,
    page_index: Option<i64>,
) -> usize {
    if text_chunks.is_empty() {
        return 0;
    }

    if let Some(anchor_text) = anchor_text
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let anchor_key = normalize_attachment_text(anchor_text);
        if let Some(index) = text_chunks.iter().position(|chunk| {
            let mut haystack = chunk.content.clone();
            if let Some(title) = chunk.title.as_deref() {
                haystack.push('\n');
                haystack.push_str(title);
            }
            normalize_attachment_text(&haystack).contains(&anchor_key)
        }) {
            return index;
        }
    }

    let order_hint = page_index
        .map(|value| value.max(0) as usize)
        .unwrap_or_else(|| asset_index.max(0) as usize);
    order_hint.min(text_chunks.len().saturating_sub(1))
}

fn format_embedded_image_chunk_content(
    label: &str,
    source_name: &str,
    page_index: Option<i64>,
    body_label: &str,
    body_text: &str,
) -> String {
    let mut lines = vec![label.to_string(), format!("Source: {source_name}")];
    if let Some(page_index) = page_index {
        lines.push(format!("Page: {}", page_index + 1));
    }
    lines.push(format!("{body_label}:"));
    lines.push(body_text.trim().to_string());
    lines.join("\n")
}

fn embedded_asset_file_name(
    asset_id: &str,
    asset_index: i64,
    source_name: &str,
) -> String {
    let base = sanitize_storage_file_name(source_name);
    let short_id = asset_id.chars().take(8).collect::<String>();
    if base == "document" {
        format!("{:03}-{short_id}.bin", asset_index.max(0))
    } else {
        format!("{:03}-{short_id}-{base}", asset_index.max(0))
    }
}

fn store_embedded_image_asset_bytes(
    app: &tauri::AppHandle,
    collection_id: &str,
    document_id: &str,
    asset_id: &str,
    asset_index: i64,
    source_name: &str,
    bytes: &[u8],
) -> Result<String, String> {
    let collection_dir = sanitize_storage_file_name(collection_id);
    let document_dir = sanitize_storage_file_name(document_id);
    let file_name = embedded_asset_file_name(asset_id, asset_index, source_name);
    let stored_path = knowledge_files_root(app)?
        .join(collection_dir)
        .join(document_dir)
        .join("assets")
        .join(file_name);
    if let Some(parent) = stored_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(&stored_path, bytes).map_err(|err| err.to_string())?;
    Ok(stored_path.to_string_lossy().to_string())
}

fn cleanup_stored_embedded_asset_files(paths: &[String]) {
    for path in paths {
        let stored_path = Path::new(path);
        if stored_path.is_file() {
            let _ = fs::remove_file(stored_path);
        }
        if let Some(parent) = stored_path.parent() {
            let _ = fs::remove_dir(parent);
        }
    }
}

fn persist_embedded_image_candidates(
    app: &tauri::AppHandle,
    collection_id: &str,
    document_id: &str,
    assets: &[crate::knowledge_embedded_images::EmbeddedImageAssetCandidate],
) -> (Vec<PersistedEmbeddedImageAsset>, Vec<String>) {
    let mut persisted = Vec::new();
    let mut warnings = Vec::new();

    for asset in assets {
        let asset_id = uuid::Uuid::new_v4().to_string();
        match store_embedded_image_asset_bytes(
            app,
            collection_id,
            document_id,
            &asset_id,
            asset.asset_index,
            &asset.source_name,
            &asset.bytes,
        ) {
            Ok(stored_file_path) => persisted.push(PersistedEmbeddedImageAsset {
                asset_id,
                source_name: asset.source_name.clone(),
                stored_file_path,
                mime_type: asset.mime_type.clone(),
                file_extension: asset.file_extension.clone(),
                page_index: asset.page_index,
                asset_index: asset.asset_index,
                anchor_text: asset.anchor_text.clone(),
                ocr_text: asset.ocr_text.clone(),
                caption_text: asset.caption_text.clone(),
                thumbnail_data_url: asset.thumbnail_data_url.clone(),
            }),
            Err(err) => warnings.push(format!(
                "failed to store embedded image {}: {err}",
                asset.source_name
            )),
        }
    }

    (persisted, warnings)
}

fn build_embedded_image_assets_and_chunks(
    text_chunks: &[crate::knowledge_chunker::ChunkSlice],
    assets: &[PersistedEmbeddedImageAsset],
    document_id: &str,
    collection_id: &str,
    now: i64,
) -> EmbeddedImageBuildOutput {
    let mut prepared_text_chunks = text_chunks.to_vec();
    if prepared_text_chunks.is_empty()
        && assets.iter().any(|asset| {
            asset
                .ocr_text
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .is_some()
                || asset
                    .caption_text
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .is_some()
        })
    {
        let fallback_name = assets
            .first()
            .map(|asset| asset.source_name.clone())
            .unwrap_or_else(|| "embedded-image".to_string());
        prepared_text_chunks.push(crate::knowledge_chunker::ChunkSlice {
            title: Some(fallback_name.clone()),
            content: format!("Embedded image: {fallback_name}"),
        });
    }

    let mut asset_rows = Vec::new();
    let mut child_chunks = Vec::new();
    for asset in assets {
        let parent_chunk_index = resolve_embedded_asset_parent_chunk_index(
            &prepared_text_chunks,
            asset.anchor_text.as_deref(),
            asset.asset_index,
            asset.page_index,
        );
        let image_info = serde_json::to_string(&crate::KnowledgeChunkImageInfoRecord {
            asset_id: asset.asset_id.clone(),
            source_name: asset.source_name.clone(),
            page_index: asset.page_index,
            asset_index: asset.asset_index,
            original_markdown: Some(format!(
                "![{}](embedded://asset/{})",
                asset.source_name, asset.asset_id
            )),
            thumbnail_data_url: asset.thumbnail_data_url.clone(),
            ocr_text: asset.ocr_text.clone(),
            caption_text: asset.caption_text.clone(),
        })
        .unwrap_or_else(|_| "{}".to_string());

        let content_preview_seed = asset
            .caption_text
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                asset
                    .ocr_text
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
            })
            .unwrap_or(asset.source_name.as_str());
        asset_rows.push(crate::KnowledgeDocumentAssetRecord {
            id: asset.asset_id.clone(),
            document_id: document_id.to_string(),
            collection_id: collection_id.to_string(),
            asset_kind: "embedded_image".to_string(),
            source_name: asset.source_name.clone(),
            stored_file_path: asset.stored_file_path.clone(),
            mime_type: asset.mime_type.clone(),
            file_extension: asset.file_extension.clone(),
            preview_type: "image".to_string(),
            thumbnail_data_url: asset.thumbnail_data_url.clone(),
            ocr_text: asset.ocr_text.clone(),
            caption_text: asset.caption_text.clone(),
            content_preview: preview_text(content_preview_seed, 160),
            page_index: asset.page_index,
            asset_index: asset.asset_index,
            metadata_json: None,
            created_at: now,
            updated_at: now,
        });

        if let Some(ocr_text) = normalize_optional_text(asset.ocr_text.as_deref()) {
            child_chunks.push(EmbeddedImageChildChunkCandidate {
                title: Some(format!("Embedded image {} OCR", asset.asset_index + 1)),
                content: format_embedded_image_chunk_content(
                    "Image OCR",
                    &asset.source_name,
                    asset.page_index,
                    "Text",
                    &ocr_text,
                ),
                chunk_type: "image_ocr".to_string(),
                parent_chunk_index,
                asset_id: asset.asset_id.clone(),
                image_info: image_info.clone(),
            });
        }

        if let Some(caption_text) = normalize_optional_text(asset.caption_text.as_deref()) {
            child_chunks.push(EmbeddedImageChildChunkCandidate {
                title: Some(format!("Embedded image {} Caption", asset.asset_index + 1)),
                content: format_embedded_image_chunk_content(
                    "Image Caption",
                    &asset.source_name,
                    asset.page_index,
                    "Summary",
                    &caption_text,
                ),
                chunk_type: "image_caption".to_string(),
                parent_chunk_index,
                asset_id: asset.asset_id.clone(),
                image_info,
            });
        }
    }

    EmbeddedImageBuildOutput {
        text_chunks: prepared_text_chunks,
        assets: asset_rows,
        child_chunks,
    }
}

fn complete_partial_job(
    app: &tauri::AppHandle,
    connection: &Connection,
    job: &PipelineJobClaim,
    source_name: &str,
    file_extension: Option<&str>,
    parsed: ParsedDocument,
    processing_warnings: Vec<String>,
    embedded_assets: Vec<crate::knowledge_embedded_images::EmbeddedImageAssetCandidate>,
) -> Result<(), String> {
    start_step(connection, job, "chunk", 45)?;
    let text_chunks = split_parsed_document_into_chunks(&parsed, source_name, file_extension);
    finish_step(connection, job, "chunk", STEP_STATUS_SUCCEEDED, 100, None)?;
    if matches!(check_job_control(connection, job)?, ControlFlow::Stop) {
        return Ok(());
    }

    let now = current_timestamp_ms();
    let (persisted_assets, asset_storage_warnings) =
        persist_embedded_image_candidates(app, &job.collection_id, &job.document_id, &embedded_assets);
    let embedded = build_embedded_image_assets_and_chunks(
        &text_chunks,
        &persisted_assets,
        &job.document_id,
        &job.collection_id,
        now,
    );

    let mut prepared_chunks = Vec::new();
    let mut chunk_slices = Vec::new();
    let mut text_chunk_ids = Vec::new();
    for (index, chunk) in embedded.text_chunks.iter().enumerate() {
        let chunk_id = uuid::Uuid::new_v4().to_string();
        text_chunk_ids.push(chunk_id.clone());
        chunk_slices.push(chunk.clone());
        prepared_chunks.push((
            chunk_id,
            index as i64,
            chunk.title.clone(),
            chunk.content.clone(),
            "text".to_string(),
            Option::<String>::None,
            Option::<String>::None,
            Option::<String>::None,
        ));
    }

    let mut next_chunk_index = prepared_chunks.len() as i64;
    for child in &embedded.child_chunks {
        let parent_chunk_id = text_chunk_ids
            .get(child.parent_chunk_index)
            .cloned()
            .or_else(|| text_chunk_ids.last().cloned());
        let chunk_id = uuid::Uuid::new_v4().to_string();
        chunk_slices.push(crate::knowledge_chunker::ChunkSlice {
            title: child.title.clone(),
            content: child.content.clone(),
        });
        prepared_chunks.push((
            chunk_id,
            next_chunk_index,
            child.title.clone(),
            child.content.clone(),
            child.chunk_type.clone(),
            parent_chunk_id,
            Some(child.asset_id.clone()),
            Some(child.image_info.clone()),
        ));
        next_chunk_index += 1;
    }

    start_step(connection, job, "embed", 65)?;
    let (chunk_embeddings, embedding_model_key) =
        crate::generate_chunk_embeddings_safe(connection, &chunk_slices);
    let vectorized_chunk_count = crate::count_vectorized_chunks(&chunk_embeddings);
    let embedding_error = if chunk_slices.is_empty() {
        None
    } else if vectorized_chunk_count <= 0 {
        Some("indexed without embeddings")
    } else if vectorized_chunk_count < chunk_slices.len() as i64 {
        Some("partial")
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
    let content_preview = preview_text(&parsed.content, 240);
    let chunk_count = prepared_chunks.len() as i64;
    let mut warning_messages = processing_warnings;
    warning_messages.extend(asset_storage_warnings);
    if let Some(message) = embedding_error {
        warning_messages.push(message.to_string());
    }
    let document_status =
        if warning_messages.is_empty() && (chunk_count <= 0 || vectorized_chunk_count >= chunk_count)
        {
            DOCUMENT_STATUS_SEARCHABLE
        } else {
            DOCUMENT_STATUS_PARTIAL
        };
    let document_error = if warning_messages.is_empty() {
        None
    } else {
        Some(warning_messages.join(" | "))
    };
    let stale_asset_paths = {
        let mut stmt = connection
            .prepare(
                "SELECT stored_file_path FROM knowledge_document_assets WHERE document_id = ?1",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![job.document_id], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?;
        rows
    };
    let tx = connection
        .unchecked_transaction()
        .map_err(|err| err.to_string())?;
    tx.execute(
        "DELETE FROM knowledge_document_assets WHERE document_id = ?1",
        params![job.document_id],
    )
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
                INSERT INTO knowledge_document_assets (
                  id, document_id, collection_id, asset_kind, source_name, stored_file_path, mime_type,
                  file_extension, preview_type, thumbnail_data_url, ocr_text, caption_text, content_preview,
                  page_index, asset_index, metadata_json, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
                "#,
            )
            .map_err(|err| err.to_string())?;
        for asset in &embedded.assets {
            stmt.execute(params![
                asset.id,
                asset.document_id,
                asset.collection_id,
                asset.asset_kind,
                asset.source_name,
                asset.stored_file_path,
                asset.mime_type,
                asset.file_extension,
                asset.preview_type,
                asset.thumbnail_data_url,
                asset.ocr_text,
                asset.caption_text,
                asset.content_preview,
                asset.page_index,
                asset.asset_index,
                asset.metadata_json,
                asset.created_at,
                asset.updated_at,
            ])
            .map_err(|err| err.to_string())?;
        }
    }
    {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO knowledge_chunks (
                  id, document_id, collection_id, chunk_index, title, content, chunk_type,
                  parent_chunk_id, asset_id, image_info, embedding_json, embedding_model_key, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                "#,
            )
            .map_err(|err| err.to_string())?;
        for (index, chunk) in prepared_chunks.into_iter().enumerate() {
            stmt.execute(params![
                chunk.0,
                job.document_id,
                job.collection_id,
                chunk.1,
                chunk.2,
                chunk.3,
                chunk.4,
                chunk.5,
                chunk.6,
                chunk.7,
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
            document_error.as_deref(),
            now,
            now,
        ],
    )
    .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;
    cleanup_stored_embedded_asset_files(&stale_asset_paths);
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
            params![
                job.document_id,
                document_status,
                document_error.as_deref(),
                now,
                now
            ],
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
            params![
                job.id,
                JOB_STATUS_SUCCEEDED,
                document_error.as_deref(),
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

fn execute_claimed_job(
    app: &tauri::AppHandle,
    connection: &Connection,
    job: &PipelineJobClaim,
) -> Result<(), String> {
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
    let mut parsed = match parse_simple_document(
        &document.source_name,
        document.file_extension.as_deref(),
        document.mime_type.as_deref(),
        document.preview_type.as_deref(),
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

    let collection_multimodal = resolve_collection_multimodal_config(connection, &job.collection_id)?;
    let mut processing_warnings = Vec::new();
    let mut embedded_assets = Vec::new();

    if parsed.preview_type == "image" {
        start_step(connection, job, "enrich_image", 35)?;
        if !collection_multimodal.enabled || !collection_multimodal.image.enabled {
            skip_step(
                connection,
                job,
                "enrich_image",
                "image enrichment disabled for this collection",
            )?;
        } else if !collection_multimodal.image.extract_text
            && !collection_multimodal.image.generate_summary
        {
            skip_step(
                connection,
                job,
                "enrich_image",
                "image enrichment options disabled for this collection",
            )?;
        } else if let Some(model_id) = collection_multimodal
            .image
            .model_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let model = resolve_multimodal_model(connection, model_id, "image")
                .map_err(|err| format!("image enrichment failed: {err}"))?;
            let output = enrich_image_document(&document, &bytes, &model, &collection_multimodal)
                .map_err(|err| format!("image enrichment failed: {err}"))?;
            if let Some(extra_content) = output.content.as_deref() {
                parsed.content = merge_multimodal_content(&parsed.content, extra_content);
            }
            if let Some(warning) = output.warning {
                processing_warnings.push(warning.clone());
                log_job(
                    connection,
                    &job.id,
                    &job.document_id,
                    "warn",
                    Some("enrich_image"),
                    &warning,
                    parsed.metadata_json.as_deref(),
                )?;
            }
            finish_step(connection, job, "enrich_image", STEP_STATUS_SUCCEEDED, 100, None)?;
        } else {
            return Err(
                "image enrichment failed: image multimodal model is missing or unusable"
                    .to_string(),
            );
        }
    } else if matches!(parsed.preview_type.as_str(), "docx" | "pdf") {
        start_step(connection, job, "enrich_image", 35)?;
        let extraction_result = if parsed.preview_type == "docx" {
            crate::knowledge_embedded_images::extract_docx_embedded_images(&bytes)
        } else {
            crate::knowledge_embedded_images::extract_pdf_embedded_images(&bytes)
        };

        match extraction_result {
            Ok(extracted) => {
                if extracted.is_empty() {
                    skip_step(
                        connection,
                        job,
                        "enrich_image",
                        "no embedded images found",
                    )?;
                } else {
                    embedded_assets = extracted;
                    let image_analysis_enabled =
                        collection_multimodal.enabled && collection_multimodal.image.enabled;
                    let image_options_enabled = collection_multimodal.image.extract_text
                        || collection_multimodal.image.generate_summary;
                    let model_id = collection_multimodal
                        .image
                        .model_id
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty());
                    let resolved_model = if image_analysis_enabled && image_options_enabled {
                        match model_id {
                            Some(model_id) => match resolve_multimodal_model(connection, model_id, "image") {
                                Ok(model) => Some(model),
                                Err(err) => {
                                    let message =
                                        format!("embedded image enrichment unavailable: {err}");
                                    processing_warnings.push(message.clone());
                                    log_job(
                                        connection,
                                        &job.id,
                                        &job.document_id,
                                        "warn",
                                        Some("enrich_image"),
                                        &message,
                                        parsed.metadata_json.as_deref(),
                                    )?;
                                    None
                                }
                            },
                            None => {
                                let message = "embedded image enrichment skipped: no usable image multimodal model is configured".to_string();
                                processing_warnings.push(message.clone());
                                log_job(
                                    connection,
                                    &job.id,
                                    &job.document_id,
                                    "warn",
                                    Some("enrich_image"),
                                    &message,
                                    parsed.metadata_json.as_deref(),
                                )?;
                                None
                            }
                        }
                    } else {
                        None
                    };

                    if let Some(model) = resolved_model.as_ref() {
                        for asset in &mut embedded_assets {
                            let asset_source = PipelineDocumentSource {
                                id: format!("{}:asset:{}", document.id, asset.asset_index),
                                collection_id: document.collection_id.clone(),
                                source_name: asset.source_name.clone(),
                                stored_file_path: None,
                                mime_type: asset.mime_type.clone(),
                                file_extension: asset.file_extension.clone(),
                                preview_type: Some("image".to_string()),
                                content: None,
                            };
                            match enrich_image_document(
                                &asset_source,
                                &asset.bytes,
                                model,
                                &collection_multimodal,
                            ) {
                                Ok(output) => {
                                    if output.ocr_text.is_some() {
                                        asset.ocr_text = output.ocr_text;
                                    }
                                    if output.summary.is_some() {
                                        asset.caption_text = output.summary;
                                    }
                                    if let Some(warning) = output.warning {
                                        processing_warnings.push(warning.clone());
                                        log_job(
                                            connection,
                                            &job.id,
                                            &job.document_id,
                                            "warn",
                                            Some("enrich_image"),
                                            &warning,
                                            parsed.metadata_json.as_deref(),
                                        )?;
                                    }
                                }
                                Err(err) => {
                                    let message = format!(
                                        "embedded image enrichment failed for {}: {err}",
                                        asset.source_name
                                    );
                                    processing_warnings.push(message.clone());
                                    log_job(
                                        connection,
                                        &job.id,
                                        &job.document_id,
                                        "warn",
                                        Some("enrich_image"),
                                        &message,
                                        parsed.metadata_json.as_deref(),
                                    )?;
                                }
                            }
                        }
                    } else if !image_analysis_enabled {
                        log_job(
                            connection,
                            &job.id,
                            &job.document_id,
                            "info",
                            Some("enrich_image"),
                            "stored embedded images without multimodal enrichment",
                            None,
                        )?;
                    }

                    finish_step(connection, job, "enrich_image", STEP_STATUS_SUCCEEDED, 100, None)?;
                }
            }
            Err(err) => {
                let message = format!("embedded image extraction failed: {err}");
                processing_warnings.push(message.clone());
                log_job(
                    connection,
                    &job.id,
                    &job.document_id,
                    "warn",
                    Some("enrich_image"),
                    &message,
                    parsed.metadata_json.as_deref(),
                )?;
                skip_step(
                    connection,
                    job,
                    "enrich_image",
                    "embedded image extraction failed",
                )?;
            }
        }
    } else {
        skip_step(
            connection,
            job,
            "enrich_image",
            "image enrichment not applicable",
        )?;
    }
    if matches!(check_job_control(connection, job)?, ControlFlow::Stop) {
        return Ok(());
    }

    if parsed.preview_type == "audio" {
        start_step(connection, job, "enrich_audio", 45)?;
        if !collection_multimodal.enabled || !collection_multimodal.audio.enabled {
            skip_step(
                connection,
                job,
                "enrich_audio",
                "audio enrichment disabled for this collection",
            )?;
        } else if !collection_multimodal.audio.keep_transcript
            && !collection_multimodal.audio.generate_summary
        {
            skip_step(
                connection,
                job,
                "enrich_audio",
                "audio enrichment options disabled for this collection",
            )?;
        } else if let Some(model_id) = collection_multimodal
            .audio
            .model_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let model = resolve_multimodal_model(connection, model_id, "audio")
                .map_err(|err| format!("audio enrichment failed: {err}"))?;
            let output = enrich_audio_document(&document, &bytes, &model, &collection_multimodal)
                .map_err(|err| format!("audio enrichment failed: {err}"))?;
            if let Some(extra_content) = output.content.as_deref() {
                parsed.content = merge_multimodal_content(&parsed.content, extra_content);
            }
            if let Some(warning) = output.warning {
                processing_warnings.push(warning.clone());
                log_job(
                    connection,
                    &job.id,
                    &job.document_id,
                    "warn",
                    Some("enrich_audio"),
                    &warning,
                    parsed.metadata_json.as_deref(),
                )?;
            }
            finish_step(connection, job, "enrich_audio", STEP_STATUS_SUCCEEDED, 100, None)?;
        } else {
            return Err(
                "audio enrichment failed: audio multimodal model is missing or unusable"
                    .to_string(),
            );
        }
    } else {
        skip_step(
            connection,
            job,
            "enrich_audio",
            "audio enrichment not applicable",
        )?;
    }
    if matches!(check_job_control(connection, job)?, ControlFlow::Stop) {
        return Ok(());
    }

    complete_partial_job(
        app,
        connection,
        job,
        &document.source_name,
        document.file_extension.as_deref(),
        parsed,
        processing_warnings,
        embedded_assets,
    )
}

fn running_step_name(connection: &Connection, job_id: &str) -> Result<Option<String>, String> {
    connection
        .query_row(
            r#"
            SELECT step_name
            FROM knowledge_processing_steps
            WHERE job_id = ?1 AND status = ?2
            ORDER BY updated_at DESC, id DESC
            LIMIT 1
            "#,
            params![job_id, STEP_STATUS_RUNNING],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| err.to_string())
}

fn process_claimed_job(
    app: &tauri::AppHandle,
    job: PipelineJobClaim,
    max_auto_retries: i64,
) -> Result<(), String> {
    let connection = open_pipeline_connection(app)?;
    if let Err(err) = execute_claimed_job(app, &connection, &job) {
        let failed_step = running_step_name(&connection, &job.id)?;
        fail_job(
            &connection,
            &job,
            failed_step.as_deref(),
            &err,
            max_auto_retries,
        )?;
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
                  multimodal_config_json TEXT,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS app_kv (
                  key TEXT PRIMARY KEY,
                  value TEXT NOT NULL,
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
        crate::ensure_knowledge_schema(&connection).unwrap();
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

    fn set_collection_multimodal_config(
        connection: &Connection,
        collection_id: &str,
        config_json: &str,
    ) {
        connection
            .execute(
                "UPDATE knowledge_collections SET multimodal_config_json = ?2 WHERE id = ?1",
                params![collection_id, config_json],
            )
            .unwrap();
    }

    fn set_global_multimodal_config(connection: &Connection, config_json: &str) {
        connection
            .execute(
                r#"
                INSERT INTO app_kv (key, value, updated_at)
                VALUES ('omni_knowledge_multimodal_profile', ?1, ?2)
                ON CONFLICT(key) DO UPDATE SET
                  value = excluded.value,
                  updated_at = excluded.updated_at
                "#,
                params![config_json, current_timestamp_ms()],
            )
            .unwrap();
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
        let parsed = parse_simple_document("notes.md", Some("md"), None, None, b"# Title\nBody", None).unwrap();

        assert_eq!(parsed.content, "# Title\nBody");
        assert_eq!(parsed.preview_type, "markdown");
        assert!(parsed.metadata_json.is_none());
    }

    #[test]
    fn parse_csv_converts_to_markdown_table() {
        let parsed = parse_simple_document("data.csv", Some(".csv"), None, None, b"a,b\n1,2", None).unwrap();

        assert_eq!(parsed.preview_type, "markdown");
        assert!(parsed.content.contains("| a | b |"));
        assert!(parsed.content.contains("| 1 | 2 |"));
    }

    #[test]
    fn parse_pdf_uses_frontend_bridge_content() {
        let parsed =
            parse_simple_document("report.pdf", Some("pdf"), None, None, b"%PDF", Some("Extracted text"))
                .unwrap();

        assert_eq!(parsed.preview_type, "pdf");
        assert_eq!(parsed.content, "Extracted text");
        assert_eq!(
            parsed.metadata_json.as_deref(),
            Some("{\"mode\":\"frontend_bridge\"}")
        );
    }

    #[test]
    fn parse_docx_strips_markdown_data_images() {
        let parsed = parse_simple_document(
            "report.docx",
            Some("docx"),
            None,
            None,
            b"PK",
            Some("标题\n\n![](data:image/png;base64,AAAA)\n\n正文"),
        )
        .unwrap();

        assert_eq!(parsed.preview_type, "docx");
        assert_eq!(parsed.content, "标题\n正文");
    }

    #[test]
    fn parse_image_uses_placeholder() {
        let parsed = parse_simple_document("photo.png", Some("png"), Some("image/png"), None, &[1, 2, 3], None).unwrap();

        assert_eq!(parsed.preview_type, "image");
        assert!(parsed.content.contains("图片文件"));
        assert!(parsed.content.contains("photo.png"));
        assert_eq!(
            parsed.metadata_json.as_deref(),
            Some("{\"mode\":\"store_with_placeholder\"}")
        );
    }

    #[test]
    fn parse_audio_uses_placeholder() {
        let parsed = parse_simple_document(
            "meeting.mp3",
            Some("mp3"),
            Some("audio/mpeg"),
            None,
            &[1, 2, 3],
            None,
        )
        .unwrap();

        assert_eq!(parsed.preview_type, "audio");
        assert!(parsed.content.contains("音频文件"));
        assert!(parsed.content.contains("meeting.mp3"));
        assert_eq!(
            parsed.metadata_json.as_deref(),
            Some("{\"mode\":\"store_with_placeholder\"}")
        );
    }

    #[test]
    fn parse_unknown_extension_is_unsupported() {
        let err = parse_simple_document("archive.zip", Some("zip"), None, None, &[1, 2, 3], None).unwrap_err();

        assert!(err.contains(".zip"));
    }

    #[test]
    fn merge_multimodal_content_appends_separator() {
        let merged = merge_multimodal_content("正文", "图片摘要");

        assert!(merged.contains("--- 多模态分析 ---"));
        assert!(merged.contains("图片摘要"));
    }

    #[test]
    fn format_audio_enrichment_keeps_transcript_and_summary() {
        let text = format_audio_enrichment(
            "call.mp3",
            Some("audio/mpeg"),
            Some("你好，世界"),
            Some("简短摘要"),
            true,
        );

        assert!(text.contains("音频转写："));
        assert!(text.contains("你好，世界"));
        assert!(text.contains("音频摘要："));
        assert!(text.contains("简短摘要"));
    }

    #[test]
    fn ensure_knowledge_schema_adds_embedded_image_columns() {
        let connection = new_test_connection();

        crate::ensure_knowledge_schema(&connection).unwrap();

        assert!(crate::table_has_column(&connection, "knowledge_chunks", "chunk_type").unwrap());
        assert!(crate::table_has_column(&connection, "knowledge_chunks", "parent_chunk_id").unwrap());
        assert!(crate::table_has_column(&connection, "knowledge_chunks", "asset_id").unwrap());
        assert!(crate::table_has_column(&connection, "knowledge_chunks", "image_info").unwrap());
        assert!(crate::table_has_column(&connection, "knowledge_document_assets", "id").unwrap());
        assert!(crate::table_has_column(&connection, "knowledge_document_assets", "ocr_text").unwrap());
        assert!(crate::table_has_column(&connection, "knowledge_document_assets", "caption_text").unwrap());
    }

    #[test]
    fn build_embedded_image_child_chunks_attaches_to_text_chunks() {
        let parsed = ParsedDocument {
            content: "Overview\n\nSystem diagram anchor\n\nDetails".to_string(),
            preview_type: "docx".to_string(),
            metadata_json: None,
        };
        let text_chunks = split_parsed_document_into_chunks(&parsed, "report.docx", Some("docx"));
        let now = current_timestamp_ms();
        let assets = vec![PersistedEmbeddedImageAsset {
            asset_id: "asset-1".to_string(),
            source_name: "image1.png".to_string(),
            stored_file_path: "C:/tmp/image1.png".to_string(),
            mime_type: Some("image/png".to_string()),
            file_extension: Some("png".to_string()),
            page_index: None,
            asset_index: 0,
            anchor_text: Some("System diagram anchor".to_string()),
            ocr_text: Some("database connection string".to_string()),
            caption_text: Some("architecture overview".to_string()),
            thumbnail_data_url: None,
        }];

        let output = build_embedded_image_assets_and_chunks(
            &text_chunks,
            &assets,
            "doc-test",
            "col-test",
            now,
        );

        assert_eq!(output.assets.len(), 1);
        assert_eq!(output.child_chunks.len(), 2);
        assert!(output
            .child_chunks
            .iter()
            .all(|chunk| chunk.parent_chunk_index < output.text_chunks.len()));
        assert!(output
            .child_chunks
            .iter()
            .any(|chunk| chunk.chunk_type == "image_ocr"));
        assert!(output
            .child_chunks
            .iter()
            .any(|chunk| chunk.chunk_type == "image_caption"));
    }

    #[test]
    fn search_knowledge_chunks_rolls_child_hits_back_to_parent() {
        let connection = new_test_connection();
        let (collection_id, document_id) = seed_collection_and_document(&connection);
        let now = current_timestamp_ms();

        connection
            .execute(
                "DELETE FROM knowledge_chunks WHERE document_id = ?1",
                params![document_id],
            )
            .unwrap();

        connection
            .execute(
                r#"
                INSERT INTO knowledge_chunks (
                  id, document_id, collection_id, chunk_index, title, content, chunk_type, parent_chunk_id,
                  asset_id, image_info, embedding_json, embedding_model_key, created_at
                ) VALUES (?1, ?2, ?3, 0, 'Parent', 'Parent section describing the system.', 'text', NULL, NULL, NULL, NULL, NULL, ?4)
                "#,
                params!["text-1", document_id, collection_id, now],
            )
            .unwrap();
        connection
            .execute(
                r#"
                INSERT INTO knowledge_chunks (
                  id, document_id, collection_id, chunk_index, title, content, chunk_type, parent_chunk_id,
                  asset_id, image_info, embedding_json, embedding_model_key, created_at
                ) VALUES (?1, ?2, ?3, 1, 'Image OCR', 'database connection string inside image', 'image_ocr', 'text-1', 'asset-1', '{"assetId":"asset-1","sourceName":"diagram.png","ocrText":"database connection string"}', NULL, NULL, ?4)
                "#,
                params!["ocr-1", document_id, collection_id, now],
            )
            .unwrap();
        connection
            .execute(
                r#"
                INSERT INTO knowledge_document_assets (
                  id, document_id, collection_id, asset_kind, source_name, stored_file_path, mime_type, file_extension,
                  preview_type, thumbnail_data_url, ocr_text, caption_text, content_preview, page_index, asset_index,
                  metadata_json, created_at, updated_at
                ) VALUES (?1, ?2, ?3, 'embedded_image', 'diagram.png', 'C:/tmp/diagram.png', 'image/png', 'png', 'image', NULL, 'database connection string', NULL, 'diagram', NULL, 0, NULL, ?4, ?4)
                "#,
                params!["asset-1", document_id, collection_id, now],
            )
            .unwrap();

        let results = crate::search_knowledge_chunks(
            &connection,
            crate::SearchKnowledgeChunksInput {
                query: "database connection".to_string(),
                limit: Some(5),
                collection_id: Some(collection_id),
                query_embedding: None,
                query_embedding_model_key: None,
            },
        )
        .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].chunk.id, "text-1");
        assert_eq!(results[0].display_chunk.as_ref().map(|chunk| chunk.id.as_str()), Some("text-1"));
        assert_eq!(results[0].matched_chunk.as_ref().map(|chunk| chunk.id.as_str()), Some("ocr-1"));
        assert_eq!(results[0].matched_chunk_type.as_deref(), Some("image_ocr"));
        assert_eq!(results[0].matched_asset.as_ref().map(|asset| asset.id.as_str()), Some("asset-1"));
    }

    #[test]
    fn resolve_preview_types_uses_audio_video_inference_for_upload_guard() {
        let (audio_preview_type, audio_guard_preview_type) =
            resolve_preview_types(None, Some("mp3"), None);
        assert_eq!(audio_preview_type, "audio");
        assert_eq!(audio_guard_preview_type, "audio");

        let (video_preview_type, video_guard_preview_type) =
            resolve_preview_types(None, None, Some("video/mp4"));
        assert_eq!(video_preview_type, "video");
        assert_eq!(video_guard_preview_type, "video");
    }

    #[test]
    fn resolve_preview_types_keeps_explicit_type_when_inference_is_unsupported() {
        let (preview_type, upload_guard_preview_type) =
            resolve_preview_types(Some("video"), Some("bin"), None);

        assert_eq!(preview_type, "video");
        assert_eq!(upload_guard_preview_type, "video");
    }

    #[test]
    fn validate_multimodal_upload_rejects_image_without_collection_enablement() {
        let connection = new_test_connection();
        let (collection_id, _) = seed_collection_and_document(&connection);

        let err =
            crate::validate_knowledge_multimodal_upload(&connection, &collection_id, "image")
                .unwrap_err();

        assert!(!err.trim().is_empty());
    }

    #[test]
    fn validate_multimodal_upload_accepts_ready_audio_model() {
        let connection = new_test_connection();
        let (collection_id, _) = seed_collection_and_document(&connection);
        set_collection_multimodal_config(
            &connection,
            &collection_id,
            &serde_json::json!({
                "enabled": true,
                "mergeMode": "append",
                "image": {
                    "enabled": false,
                    "modelId": null,
                    "extractText": true,
                    "generateSummary": true
                },
                "audio": {
                    "enabled": true,
                    "modelId": "audio:test",
                    "keepTranscript": true,
                    "generateSummary": true
                }
            })
            .to_string(),
        );
        set_global_multimodal_config(
            &connection,
            &serde_json::json!({
                "enabled": true,
                "activeImageModelId": null,
                "activeAudioModelId": "audio:test",
                "models": [{
                    "id": "audio:test",
                    "name": "Audio Test",
                    "capability": "audio",
                    "provider": "openai",
                    "baseUrl": "https://api.openai.com/v1",
                    "model": "gpt-4o-mini-transcribe",
                    "apiKey": "test-key"
                }]
            })
            .to_string(),
        );

        crate::validate_knowledge_multimodal_upload(&connection, &collection_id, "audio")
            .unwrap();
    }

    #[test]
    fn validate_multimodal_upload_rejects_video_even_without_config_lookup() {
        let connection = new_test_connection();

        let err = crate::validate_knowledge_multimodal_upload(&connection, "missing", "video")
            .unwrap_err();

        assert!(!err.trim().is_empty());
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
