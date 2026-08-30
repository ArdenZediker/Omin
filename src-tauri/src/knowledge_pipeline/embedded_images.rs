//! 文档内嵌图片资产的抽取、落盘与子分块构建。
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

pub(crate) fn resolve_embedded_asset_parent_chunk_index(
    text_chunks: &[crate::knowledge_chunker::ChunkSlice],
    anchor_text: Option<&str>,
    asset_index: i64,
    page_index: Option<i64>,
) -> usize {
    if text_chunks.is_empty() {
        return 0;
    }

    if let Some(anchor_text) = anchor_text.map(str::trim).filter(|value| !value.is_empty()) {
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

pub(crate) fn format_embedded_image_chunk_content(
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

pub(crate) fn embedded_asset_file_name(asset_id: &str, asset_index: i64, source_name: &str) -> String {
    let base = sanitize_storage_file_name(source_name);
    let short_id = asset_id.chars().take(8).collect::<String>();
    if base == "document" {
        format!("{:03}-{short_id}.bin", asset_index.max(0))
    } else {
        format!("{:03}-{short_id}-{base}", asset_index.max(0))
    }
}

pub(crate) fn store_embedded_image_asset_bytes(
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

pub(crate) fn cleanup_stored_embedded_asset_files(paths: &[String]) {
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

pub(crate) fn persist_embedded_image_candidates(
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

pub(crate) fn build_embedded_image_assets_and_chunks(
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
