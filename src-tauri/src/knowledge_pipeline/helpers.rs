//! 通用工具：时间戳、哈希、文件名/扩展名规范化、CSV 转换等。
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

pub(crate) fn current_timestamp_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn normalize_knowledge_collection_id(value: Option<String>) -> String {
    value.unwrap_or_default().trim().to_string()
}

pub(crate) fn collection_exists(connection: &Connection, collection_id: &str) -> Result<bool, String> {
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(1) FROM knowledge_collections WHERE id = ?1",
            params![collection_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    Ok(count > 0)
}

pub(crate) fn content_hash(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("sha256:{:x}", digest)
}

pub(crate) fn validate_upload_size(bytes: &[u8]) -> Result<(), String> {
    const DEFAULT_MAX_FILE_SIZE: usize = 100 * 1024 * 1024;

    if bytes.is_empty() {
        return Err("文件为空，无法上传。".into());
    }
    if bytes.len() > DEFAULT_MAX_FILE_SIZE {
        return Err("文件超过 100MB 上限。".into());
    }

    Ok(())
}

pub(crate) fn sanitize_storage_file_name(value: &str) -> String {
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

pub(crate) fn file_extension_from_name(value: &str) -> Option<String> {
    Path::new(value)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.trim().to_lowercase())
        .filter(|ext| !ext.is_empty())
}

pub(crate) fn normalize_file_extension(extension: Option<String>, source_name: &str) -> Option<String> {
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

pub(crate) fn resolve_preview_types(
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

pub(crate) fn normalize_optional_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(crate) fn infer_fallback_mime_type(preview_type: &str, extension: Option<&str>) -> &'static str {
    match preview_type {
        "image" => match extension
            .unwrap_or_default()
            .trim_start_matches('.')
            .to_lowercase()
            .as_str()
        {
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            "svg" => "image/svg+xml",
            "avif" => "image/avif",
            "ico" => "image/x-icon",
            _ => "image/png",
        },
        "audio" => match extension
            .unwrap_or_default()
            .trim_start_matches('.')
            .to_lowercase()
            .as_str()
        {
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

pub(crate) fn preview_text(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let clipped: String = trimmed.chars().take(max_chars.saturating_sub(3)).collect();
    format!("{clipped}...")
}

// 原本这里和 knowledge_files.rs 各写了一份相同的逻辑，现在统一复用同一份实现。
pub(crate) use crate::knowledge_files::knowledge_files_root;

pub(crate) fn document_file_name(source_name: &str, document_id: &str) -> String {
    let base = sanitize_storage_file_name(source_name);
    if base == "document" {
        format!("{document_id}.bin")
    } else {
        base
    }
}

pub(crate) fn store_knowledge_document_bytes(
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

pub(crate) fn markdown_data_image_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"!\[[^\]]*\]\(\s*data:image/[^)]+?\)").expect("valid markdown data image regex")
    })
}

pub(crate) fn csv_to_markdown(text: &str, delimiter: char) -> String {
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

pub(crate) fn split_parsed_document_into_chunks(
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

pub(crate) fn normalize_attachment_text(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
