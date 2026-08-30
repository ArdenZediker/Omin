//! 文档导入：落盘、解析与前端桥接内容清洗。
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

pub(crate) fn parse_simple_document(
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
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "avif" | "ico" => {
            Ok(ParsedDocument {
                content: format_image_placeholder(source_name, mime_type),
                preview_type: "image".into(),
                metadata_json: Some("{\"mode\":\"store_with_placeholder\"}".into()),
            })
        }
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
            Some("video") => {
                Err("unsupported file type .video; original file has been stored".into())
            }
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
            Some("video") => {
                Err("unsupported file type .video; original file has been stored".into())
            }
            _ => Err(format!(
                "unsupported file extension .{other}; original file has been stored"
            )),
        },
    }
}

pub(crate) fn sanitize_frontend_bridged_content(content: &str) -> String {
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
