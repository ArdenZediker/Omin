//! 流水线数据模型：状态常量、请求/响应结构体、设置与控制流枚举。
//!
//! 由 knowledge_pipeline 单文件拆分而来，保持逻辑不变。

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

use super::*;

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

pub(crate) const PIPELINE_STEPS: [&str; 8] = [
    "validate",
    "parse",
    "enrich_image",
    "enrich_audio",
    "chunk",
    "embed",
    "index",
    "finalize",
];
pub(crate) const DEFAULT_JOB_PRIORITY: i64 = 0;
pub(crate) const RETRY_BACKOFF_MS: [i64; 3] = [30_000, 120_000, 600_000];

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
    pub(crate) fn clamped(mut self) -> Self {
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
pub(crate) struct ParsedDocument {
    pub(crate) content: String,
    pub(crate) preview_type: String,
    pub(crate) metadata_json: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct EnrichmentOutput {
    pub(crate) content: Option<String>,
    pub(crate) warning: Option<String>,
    pub(crate) ocr_text: Option<String>,
    pub(crate) summary: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct PipelineJobClaim {
    pub(crate) id: String,
    pub(crate) document_id: String,
    pub(crate) collection_id: String,
}

#[derive(Debug, Clone)]
pub(crate) struct PipelineDocumentSource {
    pub(crate) id: String,
    pub(crate) collection_id: String,
    pub(crate) source_name: String,
    pub(crate) stored_file_path: Option<String>,
    pub(crate) mime_type: Option<String>,
    pub(crate) file_extension: Option<String>,
    pub(crate) preview_type: Option<String>,
    pub(crate) content: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct PersistedEmbeddedImageAsset {
    pub(crate) asset_id: String,
    pub(crate) source_name: String,
    pub(crate) stored_file_path: String,
    pub(crate) mime_type: Option<String>,
    pub(crate) file_extension: Option<String>,
    pub(crate) page_index: Option<i64>,
    pub(crate) asset_index: i64,
    pub(crate) anchor_text: Option<String>,
    pub(crate) ocr_text: Option<String>,
    pub(crate) caption_text: Option<String>,
    pub(crate) thumbnail_data_url: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct EmbeddedImageChildChunkCandidate {
    pub(crate) title: Option<String>,
    pub(crate) content: String,
    pub(crate) chunk_type: String,
    pub(crate) parent_chunk_index: usize,
    pub(crate) asset_id: String,
    pub(crate) image_info: String,
}

#[derive(Debug, Clone)]
pub(crate) struct EmbeddedImageBuildOutput {
    pub(crate) text_chunks: Vec<crate::knowledge_chunker::ChunkSlice>,
    pub(crate) assets: Vec<crate::KnowledgeDocumentAssetRecord>,
    pub(crate) child_chunks: Vec<EmbeddedImageChildChunkCandidate>,
}

pub(crate) enum ControlFlow {
    Continue,
    Stop,
}
