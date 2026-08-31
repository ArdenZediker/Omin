use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

mod codex_pets;
mod database;
mod knowledge_chunker;
mod knowledge_embedded_images;
mod knowledge_files;
mod knowledge_pipeline;
mod knowledge;
mod backup;
mod knowledge_schema;
mod persona;
mod storage;
mod storage_paths;
mod workspace_files;
mod knowledge_embedding_config;
mod knowledge_embedding_batch;
mod knowledge_search;
mod skillhub;

// 从 lib.rs 拆分出去的四个模块，用私有 glob 取回其中的函数与类型。
// 这些模块内部**不要**写 `use super::*`：那会把 crate 根的 `__cmd__*` 宏吸进模块，
// 再通过下面的 glob 拉回 lib.rs，与本地定义撞成 E0255。各模块改为显式 `use crate::...`。
use knowledge_embedding_batch::*;
use knowledge_embedding_config::*;
use knowledge_search::*;
use skillhub::*;

// 需要被其它模块以 `crate::X` 引用的条目，改为显式重导出（显式重导出不会牵扯宏命名空间）。
pub(crate) use knowledge_embedding_config::{
    find_exact_usable_knowledge_multimodal_model, load_knowledge_collection_multimodal_config,
    load_knowledge_multimodal_config, validate_knowledge_multimodal_upload,
};


pub(crate) use database::open_sqlite_connection;
pub(crate) use knowledge_files::{
    delete_stored_document_file, delete_stored_document_files, infer_preview_type,
    normalize_file_extension, store_knowledge_document_bytes,
};
pub(crate) use knowledge_schema::ensure_knowledge_defaults;
#[cfg(test)]
pub(crate) use knowledge_schema::ensure_knowledge_schema;
#[cfg(test)]
pub(crate) use knowledge_schema::table_has_column;
pub(crate) use storage::{
    delete_project_by_id, delete_chat_session_by_id, has_structured_chat_storage,
    load_automation_storage, load_manifest_storage,
    load_memory_storage, load_structured_chat_storage, read_kv, read_structured_app_value,
    remove_structured_app_value, save_automation_storage, save_manifest_storage,
    save_memory_storage, save_structured_chat_storage, write_kv, write_structured_app_value,
    AutomationStoragePayload, ChatStoragePayload, ManifestStoragePayload, MemoryStoragePayload,
    KNOWLEDGE_EMBEDDING_CONFIG_KEY, KNOWLEDGE_MULTIMODAL_CONFIG_KEY,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppStoragePayload {
    pub(crate) entries: HashMap<String, String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeCollectionRecord {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) retrieval_mode: String,
    pub(crate) embedding_profile_id: Option<String>,
    pub(crate) multimodal_config_json: Option<String>,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeDocumentRecord {
    pub(crate) id: String,
    pub(crate) collection_id: String,
    pub(crate) source_name: String,
    pub(crate) source_path: Option<String>,
    pub(crate) stored_file_path: Option<String>,
    pub(crate) mime_type: Option<String>,
    pub(crate) file_extension: Option<String>,
    pub(crate) preview_type: Option<String>,
    pub(crate) content: Option<String>,
    pub(crate) content_preview: String,
    pub(crate) thumbnail_data_url: Option<String>,
    pub(crate) file_hash: Option<String>,
    pub(crate) file_size: Option<i64>,
    pub(crate) processing_status: Option<String>,
    pub(crate) error_message: Option<String>,
    pub(crate) active_job_id: Option<String>,
    pub(crate) content_version: Option<i64>,
    pub(crate) parser_profile_id: Option<String>,
    pub(crate) last_processed_at: Option<i64>,
    pub(crate) chunk_count: i64,
    pub(crate) vectorized_chunk_count: i64,
    pub(crate) vectorization_state: String,
    pub(crate) tags: Vec<String>,
    pub(crate) favorite: bool,
    pub(crate) access_count: i64,
    pub(crate) last_accessed_at: Option<i64>,
    pub(crate) title_hierarchy: Option<String>,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeDocumentAssetRecord {
    pub(crate) id: String,
    pub(crate) document_id: String,
    pub(crate) collection_id: String,
    pub(crate) asset_kind: String,
    pub(crate) source_name: String,
    pub(crate) stored_file_path: String,
    pub(crate) mime_type: Option<String>,
    pub(crate) file_extension: Option<String>,
    pub(crate) preview_type: String,
    pub(crate) thumbnail_data_url: Option<String>,
    pub(crate) ocr_text: Option<String>,
    pub(crate) caption_text: Option<String>,
    pub(crate) content_preview: String,
    pub(crate) page_index: Option<i64>,
    pub(crate) asset_index: i64,
    pub(crate) metadata_json: Option<String>,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeChunkImageInfoRecord {
    pub(crate) asset_id: String,
    pub(crate) source_name: String,
    pub(crate) page_index: Option<i64>,
    pub(crate) asset_index: i64,
    pub(crate) original_markdown: Option<String>,
    pub(crate) thumbnail_data_url: Option<String>,
    pub(crate) ocr_text: Option<String>,
    pub(crate) caption_text: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeChunkRecord {
    pub(crate) id: String,
    pub(crate) document_id: String,
    pub(crate) collection_id: String,
    pub(crate) chunk_index: i64,
    pub(crate) title: Option<String>,
    pub(crate) content: String,
    pub(crate) chunk_type: Option<String>,
    pub(crate) parent_chunk_id: Option<String>,
    pub(crate) asset_id: Option<String>,
    pub(crate) image_info: Option<String>,
    pub(crate) embedding_json: Option<String>,
    pub(crate) embedding_model_key: Option<String>,
    pub(crate) created_at: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeLibraryPayload {
    pub(crate) collections: Vec<KnowledgeCollectionRecord>,
    pub(crate) documents: Vec<KnowledgeDocumentRecord>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeDocumentDetailPayload {
    pub(crate) document: KnowledgeDocumentRecord,
    pub(crate) assets: Vec<KnowledgeDocumentAssetRecord>,
    pub(crate) chunks: Vec<KnowledgeChunkRecord>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportKnowledgeDocumentInput {
    pub(crate) collection_id: Option<String>,
    pub(crate) source_name: String,
    pub(crate) source_path: Option<String>,
    pub(crate) content: String,
    pub(crate) content_bytes: Option<Vec<u8>>,
    pub(crate) mime_type: Option<String>,
    pub(crate) file_extension: Option<String>,
    pub(crate) preview_type: Option<String>,
    pub(crate) thumbnail_data_url: Option<String>,
    pub(crate) tags: Option<Vec<String>>,
    pub(crate) title_hierarchy: Option<String>,
    pub(crate) favorite: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateKnowledgeCollectionInput {
    pub(crate) collection_id: String,
    pub(crate) name: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) retrieval_mode: Option<String>,
    pub(crate) multimodal_config_json: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeEmbeddingModelConfigRecord {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) provider: String,
    pub(crate) base_url: String,
    pub(crate) model: String,
    pub(crate) api_key: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeEmbeddingConfigRecord {
    pub(crate) enabled: bool,
    pub(crate) active_model_id: String,
    pub(crate) models: Vec<KnowledgeEmbeddingModelConfigRecord>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeMultimodalModelConfigRecord {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) capability: String,
    pub(crate) provider: String,
    pub(crate) base_url: String,
    pub(crate) model: String,
    pub(crate) api_key: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeMultimodalConfigRecord {
    pub(crate) enabled: bool,
    pub(crate) active_image_model_id: Option<String>,
    pub(crate) active_audio_model_id: Option<String>,
    pub(crate) models: Vec<KnowledgeMultimodalModelConfigRecord>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct KnowledgeCollectionImageMultimodalConfigRecord {
    pub(crate) enabled: bool,
    pub(crate) model_id: Option<String>,
    pub(crate) extract_text: bool,
    pub(crate) generate_summary: bool,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct KnowledgeCollectionAudioMultimodalConfigRecord {
    pub(crate) enabled: bool,
    pub(crate) model_id: Option<String>,
    pub(crate) keep_transcript: bool,
    pub(crate) generate_summary: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeCollectionMultimodalConfigRecord {
    pub(crate) enabled: bool,
    pub(crate) merge_mode: String,
    pub(crate) image: KnowledgeCollectionImageMultimodalConfigRecord,
    pub(crate) audio: KnowledgeCollectionAudioMultimodalConfigRecord,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchKnowledgeChunksInput {
    pub(crate) query: String,
    pub(crate) limit: Option<usize>,
    pub(crate) collection_id: Option<String>,
    pub(crate) query_embedding: Option<Vec<f64>>,
    pub(crate) query_embedding_model_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RevectorizeKnowledgeDocumentInput {
    pub(crate) document_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoadKnowledgeDocumentInput {
    pub(crate) document_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoadKnowledgeDocumentFileInput {
    pub(crate) document_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeDocumentBinaryPayload {
    pub(crate) bytes: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchKnowledgeChunkResult {
    pub(crate) chunk: KnowledgeChunkRecord,
    pub(crate) matched_chunk: Option<KnowledgeChunkRecord>,
    pub(crate) display_chunk: Option<KnowledgeChunkRecord>,
    pub(crate) matched_chunk_type: Option<String>,
    pub(crate) parent_chunk_id: Option<String>,
    pub(crate) image_info: Option<String>,
    pub(crate) matched_asset: Option<KnowledgeDocumentAssetRecord>,
    pub(crate) score: f64,
    pub(crate) source_name: String,
    pub(crate) source_path: Option<String>,
    pub(crate) collection_name: String,
    pub(crate) tags: Vec<String>,
    pub(crate) favorite: bool,
    pub(crate) access_count: i64,
    pub(crate) last_accessed_at: Option<i64>,
    pub(crate) title_hierarchy: Option<String>,
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("你好，{}！欢迎使用 Omni AI 助手！", name)
}

#[tauri::command]
fn load_codex_pet_packages() -> Result<codex_pets::CodexPetPackageListPayload, String> {
    codex_pets::load_packages()
}

#[tauri::command]
fn import_codex_pet_package(
    input: codex_pets::ImportCodexPetPackageInput,
) -> Result<codex_pets::CodexPetPackageRecord, String> {
    codex_pets::import_package(input)
}

pub(crate) fn workspace_root() -> Result<PathBuf, String> {
    let current_dir = std::env::current_dir().map_err(|err| err.to_string())?;
    if current_dir.file_name().and_then(|name| name.to_str()) == Some("src-tauri") {
        return current_dir
            .parent()
            .map(PathBuf::from)
            .ok_or_else(|| "Unable to resolve workspace root".to_string());
    }
    Ok(current_dir)
}

#[tauri::command]
fn load_workspace_pet_dir_command() -> Result<String, String> {
    codex_pets::load_workspace_pet_dir()
}

pub(crate) fn current_timestamp_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn normalize_knowledge_collection_id(value: Option<String>) -> String {
    value
        .unwrap_or_default()
        .trim()
        .to_string()
        .if_empty_then("")
}

pub(crate) fn derive_vectorization_state(chunk_count: i64, vectorized_chunk_count: i64) -> String {
    if chunk_count <= 0 {
        "empty".to_string()
    } else if vectorized_chunk_count <= 0 {
        "unvectorized".to_string()
    } else if vectorized_chunk_count >= chunk_count {
        "vectorized".to_string()
    } else {
        "partial".to_string()
    }
}

pub(crate) fn count_vectorized_chunks(chunks: &[Option<String>]) -> i64 {
    chunks.iter().filter(|value| value.is_some()).count() as i64
}

pub(crate) fn normalize_knowledge_retrieval_mode(_value: &str) -> String {
    "hybrid".to_string()
}



pub(crate) trait EmptyFallback {
    fn if_empty_then(self, fallback: &str) -> String;
}

impl EmptyFallback for String {
    fn if_empty_then(self, fallback: &str) -> String {
        if self.trim().is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

pub(crate) fn normalize_text_for_search(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .to_lowercase()
}

pub(crate) fn tokenize_search_query(value: &str) -> Vec<String> {
    normalize_text_for_search(value)
        .split(|character: char| !character.is_alphanumeric())
        .map(str::trim)
        .filter(|term| !term.is_empty())
        .map(ToString::to_string)
        .collect()
}

pub(crate) fn preview_text(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim();
    let count = trimmed.chars().count();
    if count <= max_chars {
        return trimmed.to_string();
    }
    let clipped: String = trimmed.chars().take(max_chars.saturating_sub(3)).collect();
    format!("{clipped}...")
}

pub(crate) fn parse_tags_json(value: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(value).unwrap_or_default()
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

pub(crate) fn load_knowledge_library(connection: &Connection) -> Result<KnowledgeLibraryPayload, String> {
    ensure_knowledge_defaults(connection)?;

    let mut collections_stmt = connection
        .prepare(
            r#"
            SELECT id, name, description, retrieval_mode, embedding_profile_id, multimodal_config_json, created_at, updated_at
            FROM knowledge_collections
            ORDER BY created_at ASC, id ASC
            "#,
        )
        .map_err(|err| err.to_string())?;
    let collections = collections_stmt
        .query_map([], |row| {
            Ok(KnowledgeCollectionRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                retrieval_mode: row.get(3)?,
                embedding_profile_id: row.get(4)?,
                multimodal_config_json: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    let mut documents_stmt = connection
        .prepare(
            r#"
            SELECT id, collection_id, source_name, source_path, stored_file_path, mime_type, file_extension, preview_type,
                   content, content_preview, chunk_count, thumbnail_data_url, tags_json, favorite,
                   access_count, last_accessed_at, title_hierarchy, created_at, updated_at,
                   file_hash, file_size, processing_status, error_message, active_job_id, content_version,
                   parser_profile_id, last_processed_at,
                   (
                     SELECT COUNT(1)
                     FROM knowledge_chunks c
                     WHERE c.document_id = knowledge_documents.id
                       AND c.embedding_json IS NOT NULL
                       AND TRIM(c.embedding_json) <> ''
                   ) AS vectorized_chunk_count
            FROM knowledge_documents
            ORDER BY updated_at DESC, created_at DESC, id DESC
            "#,
        )
        .map_err(|err| err.to_string())?;
    let documents = documents_stmt
        .query_map([], |row| {
            let tags_json: String = row.get(12)?;
            let chunk_count: i64 = row.get(10)?;
            let vectorized_chunk_count: i64 = row.get(27)?;
            Ok(KnowledgeDocumentRecord {
                id: row.get(0)?,
                collection_id: row.get(1)?,
                source_name: row.get(2)?,
                source_path: row.get(3)?,
                stored_file_path: row.get(4)?,
                mime_type: row.get(5)?,
                file_extension: row.get(6)?,
                preview_type: row.get(7)?,
                content: None,
                content_preview: row.get(9)?,
                chunk_count,
                thumbnail_data_url: row.get(11)?,
                file_hash: row.get(19)?,
                file_size: row.get(20)?,
                processing_status: row.get(21)?,
                error_message: row.get(22)?,
                active_job_id: row.get(23)?,
                content_version: row.get(24)?,
                parser_profile_id: row.get(25)?,
                last_processed_at: row.get(26)?,
                vectorized_chunk_count,
                vectorization_state: derive_vectorization_state(
                    chunk_count,
                    vectorized_chunk_count,
                ),
                tags: parse_tags_json(&tags_json),
                favorite: row.get::<_, i64>(13)? != 0,
                access_count: row.get(14)?,
                last_accessed_at: row.get(15)?,
                title_hierarchy: row.get(16)?,
                created_at: row.get(17)?,
                updated_at: row.get(18)?,
            })
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    Ok(KnowledgeLibraryPayload {
        collections,
        documents,
    })
}

pub(crate) fn load_knowledge_document(
    connection: &Connection,
    document_id: &str,
) -> Result<KnowledgeDocumentDetailPayload, String> {
    ensure_knowledge_defaults(connection)?;

    let document = connection
        .query_row(
            r#"
            SELECT id, collection_id, source_name, source_path, stored_file_path, mime_type, file_extension, preview_type,
                   content, content_preview, chunk_count, thumbnail_data_url, tags_json, favorite,
                   access_count, last_accessed_at, title_hierarchy, created_at, updated_at,
                   file_hash, file_size, processing_status, error_message, active_job_id, content_version,
                   parser_profile_id, last_processed_at,
                   (
                     SELECT COUNT(1)
                     FROM knowledge_chunks c
                     WHERE c.document_id = knowledge_documents.id
                       AND c.embedding_json IS NOT NULL
                       AND TRIM(c.embedding_json) <> ''
                   ) AS vectorized_chunk_count
            FROM knowledge_documents
            WHERE id = ?1
            "#,
            params![document_id],
            |row| {
                let tags_json: String = row.get(12)?;
                let chunk_count: i64 = row.get(10)?;
                let vectorized_chunk_count: i64 = row.get(27)?;
                Ok(KnowledgeDocumentRecord {
                    id: row.get(0)?,
                    collection_id: row.get(1)?,
                    source_name: row.get(2)?,
                    source_path: row.get(3)?,
                    stored_file_path: row.get(4)?,
                    mime_type: row.get(5)?,
                    file_extension: row.get(6)?,
                    preview_type: row.get(7)?,
                    content: row.get(8)?,
                    content_preview: row.get(9)?,
                    chunk_count,
                    thumbnail_data_url: row.get(11)?,
                    file_hash: row.get(19)?,
                    file_size: row.get(20)?,
                    processing_status: row.get(21)?,
                    error_message: row.get(22)?,
                    active_job_id: row.get(23)?,
                    content_version: row.get(24)?,
                    parser_profile_id: row.get(25)?,
                    last_processed_at: row.get(26)?,
                    vectorized_chunk_count,
                    vectorization_state: derive_vectorization_state(chunk_count, vectorized_chunk_count),
                    tags: parse_tags_json(&tags_json),
                    favorite: row.get::<_, i64>(13)? != 0,
                    access_count: row.get(14)?,
                    last_accessed_at: row.get(15)?,
                    title_hierarchy: row.get(16)?,
                    created_at: row.get(17)?,
                    updated_at: row.get(18)?,
                })
            },
        )
        .map_err(|err| err.to_string())?;

    let mut asset_stmt = connection
        .prepare(
            r#"
            SELECT id, document_id, collection_id, asset_kind, source_name, stored_file_path, mime_type,
                   file_extension, preview_type, thumbnail_data_url, ocr_text, caption_text,
                   content_preview, page_index, asset_index, metadata_json, created_at, updated_at
            FROM knowledge_document_assets
            WHERE document_id = ?1
            ORDER BY asset_index ASC, created_at ASC, id ASC
            "#,
        )
        .map_err(|err| err.to_string())?;
    let assets = asset_stmt
        .query_map(params![document_id], |row| {
            Ok(KnowledgeDocumentAssetRecord {
                id: row.get(0)?,
                document_id: row.get(1)?,
                collection_id: row.get(2)?,
                asset_kind: row.get(3)?,
                source_name: row.get(4)?,
                stored_file_path: row.get(5)?,
                mime_type: row.get(6)?,
                file_extension: row.get(7)?,
                preview_type: row.get(8)?,
                thumbnail_data_url: row.get(9)?,
                ocr_text: row.get(10)?,
                caption_text: row.get(11)?,
                content_preview: row.get(12)?,
                page_index: row.get(13)?,
                asset_index: row.get(14)?,
                metadata_json: row.get(15)?,
                created_at: row.get(16)?,
                updated_at: row.get(17)?,
            })
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    let mut chunk_stmt = connection
        .prepare(
            r#"
            SELECT id, document_id, collection_id, chunk_index, title, content, chunk_type, parent_chunk_id,
                   asset_id, image_info, embedding_json, embedding_model_key, created_at
            FROM knowledge_chunks
            WHERE document_id = ?1
            ORDER BY chunk_index ASC, created_at ASC, id ASC
            "#,
        )
        .map_err(|err| err.to_string())?;
    let chunks = chunk_stmt
        .query_map(params![document_id], |row| {
            Ok(KnowledgeChunkRecord {
                id: row.get(0)?,
                document_id: row.get(1)?,
                collection_id: row.get(2)?,
                chunk_index: row.get(3)?,
                title: row.get(4)?,
                content: row.get(5)?,
                chunk_type: row.get(6)?,
                parent_chunk_id: row.get(7)?,
                asset_id: row.get(8)?,
                image_info: row.get(9)?,
                embedding_json: row.get(10)?,
                embedding_model_key: row.get(11)?,
                created_at: row.get(12)?,
            })
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    Ok(KnowledgeDocumentDetailPayload {
        document,
        assets,
        chunks,
    })
}

pub(crate) fn load_knowledge_document_file(
    connection: &Connection,
    document_id: &str,
) -> Result<KnowledgeDocumentBinaryPayload, String> {
    ensure_knowledge_defaults(connection)?;

    let stored_file_path = connection
        .query_row(
            "SELECT stored_file_path FROM knowledge_documents WHERE id = ?1",
            params![document_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .flatten()
        .ok_or_else(|| "文档没有可用的原文件".to_string())?;

    let bytes = fs::read(&stored_file_path).map_err(|err| err.to_string())?;
    Ok(KnowledgeDocumentBinaryPayload { bytes })
}

pub(crate) fn create_knowledge_collection(
    connection: &Connection,
    name: &str,
    description: &str,
    multimodal_config_json: Option<String>,
) -> Result<KnowledgeCollectionRecord, String> {
    let now = current_timestamp_ms();
    let id = uuid::Uuid::new_v4().to_string();
    let name = name.trim();
    let description = description.trim();

    if name.is_empty() {
        return Err("知识库名称不能为空".into());
    }

    let multimodal_config_json =
        normalize_collection_multimodal_config_json_for_storage(multimodal_config_json)?;

    connection
        .execute(
            r#"
            INSERT INTO knowledge_collections (
              id, name, description, retrieval_mode, embedding_profile_id, multimodal_config_json, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            "#,
            params![
                id,
                name,
                description,
                "hybrid",
                Option::<String>::None,
                multimodal_config_json.clone(),
                now,
                now
            ],
        )
        .map_err(|err| err.to_string())?;

    Ok(KnowledgeCollectionRecord {
        id,
        name: name.to_string(),
        description: description.to_string(),
        retrieval_mode: "hybrid".to_string(),
        embedding_profile_id: None,
        multimodal_config_json,
        created_at: now,
        updated_at: now,
    })
}

pub(crate) fn update_knowledge_collection(
    connection: &Connection,
    input: UpdateKnowledgeCollectionInput,
) -> Result<KnowledgeCollectionRecord, String> {
    let collection_id = input.collection_id.trim().to_string();
    if collection_id.is_empty() {
        return Err("知识库 ID 不能为空".into());
    }

    let existing = connection
        .query_row(
            r#"
            SELECT id, name, description, retrieval_mode, embedding_profile_id, multimodal_config_json, created_at, updated_at
            FROM knowledge_collections
            WHERE id = ?1
            "#,
            params![collection_id],
            |row| {
                Ok(KnowledgeCollectionRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    retrieval_mode: row.get(3)?,
                    embedding_profile_id: row.get(4)?,
                    multimodal_config_json: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            },
        )
        .optional()
        .map_err(|err| err.to_string())?
        .ok_or_else(|| format!("知识库不存在: {collection_id}"))?;

    let name = input.name.unwrap_or(existing.name).trim().to_string();
    let description = input
        .description
        .unwrap_or(existing.description)
        .trim()
        .to_string();
    let retrieval_mode = input
        .retrieval_mode
        .map(|value| normalize_knowledge_retrieval_mode(&value))
        .unwrap_or_else(|| existing.retrieval_mode.clone());
    let multimodal_config_json = match input.multimodal_config_json {
        Some(value) => normalize_collection_multimodal_config_json_for_storage(Some(value))?,
        None => existing.multimodal_config_json.clone(),
    };
    let updated_at = current_timestamp_ms();

    connection
        .execute(
            r#"
            UPDATE knowledge_collections
            SET name = ?2, description = ?3, retrieval_mode = ?4, multimodal_config_json = ?5, updated_at = ?6
            WHERE id = ?1
            "#,
            params![
                collection_id,
                name,
                description,
                retrieval_mode,
                multimodal_config_json,
                updated_at
            ],
        )
        .map_err(|err| err.to_string())?;

    Ok(KnowledgeCollectionRecord {
        id: existing.id,
        name,
        description,
        retrieval_mode,
        embedding_profile_id: existing.embedding_profile_id,
        multimodal_config_json,
        created_at: existing.created_at,
        updated_at,
    })
}

pub(crate) fn delete_knowledge_collection(connection: &Connection, collection_id: &str) -> Result<(), String> {
    let collection_id = collection_id.trim();
    if collection_id.is_empty() {
        return Err("知识库 ID 不能为空".into());
    }

    let stored_document_paths = {
        let mut stmt = connection
            .prepare(
                r#"
                SELECT stored_file_path
                FROM knowledge_documents
                WHERE collection_id = ?1
                "#,
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![collection_id], |row| {
                row.get::<_, Option<String>>(0)
            })
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?;
        rows
    };
    let stored_asset_paths = {
        let mut stmt = connection
            .prepare(
                r#"
                SELECT stored_file_path
                FROM knowledge_document_assets
                WHERE collection_id = ?1
                "#,
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![collection_id], |row| {
                row.get::<_, Option<String>>(0)
            })
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?;
        rows
    };

    let tx = connection
        .unchecked_transaction()
        .map_err(|err| err.to_string())?;
    tx.execute(
        "DELETE FROM knowledge_document_assets WHERE collection_id = ?1",
        params![collection_id],
    )
    .map_err(|err| err.to_string())?;
    tx.execute(
        "DELETE FROM knowledge_chunks WHERE collection_id = ?1",
        params![collection_id],
    )
    .map_err(|err| err.to_string())?;
    tx.execute(
        "DELETE FROM knowledge_documents WHERE collection_id = ?1",
        params![collection_id],
    )
    .map_err(|err| err.to_string())?;
    tx.execute(
        "DELETE FROM knowledge_collections WHERE id = ?1",
        params![collection_id],
    )
    .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;

    delete_stored_document_files(&stored_asset_paths);
    delete_stored_document_files(&stored_document_paths);

    Ok(())
}

pub(crate) fn delete_knowledge_document(connection: &Connection, document_id: &str) -> Result<(), String> {
    let document_id = document_id.trim();
    if document_id.is_empty() {
        return Err("文档 ID 不能为空".into());
    }

    let stored_file_path = connection
        .query_row(
            "SELECT stored_file_path FROM knowledge_documents WHERE id = ?1",
            params![document_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .flatten();
    let stored_asset_paths = {
        let mut stmt = connection
            .prepare(
                r#"
                SELECT stored_file_path
                FROM knowledge_document_assets
                WHERE document_id = ?1
                "#,
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![document_id], |row| row.get::<_, Option<String>>(0))
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
        params![document_id],
    )
    .map_err(|err| err.to_string())?;
    tx.execute(
        "DELETE FROM knowledge_chunks WHERE document_id = ?1",
        params![document_id],
    )
    .map_err(|err| err.to_string())?;
    tx.execute(
        "DELETE FROM knowledge_documents WHERE id = ?1",
        params![document_id],
    )
    .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;

    delete_stored_document_files(&stored_asset_paths);
    delete_stored_document_file(stored_file_path.as_deref());
    Ok(())
}

pub(crate) fn import_knowledge_document(
    app: &tauri::AppHandle,
    connection: &Connection,
    input: ImportKnowledgeDocumentInput,
) -> Result<KnowledgeDocumentRecord, String> {
    ensure_knowledge_defaults(connection)?;

    let collection_id = normalize_knowledge_collection_id(input.collection_id);
    if !collection_exists(connection, &collection_id)? {
        return Err(format!("知识库不存在: {collection_id}"));
    }

    let source_name = input.source_name.trim();
    if source_name.is_empty() {
        return Err("sourceName 不能为空".into());
    }

    let content = input.content.trim().to_string();

    let now = current_timestamp_ms();
    let document_id = uuid::Uuid::new_v4().to_string();
    let tags = input.tags.unwrap_or_default();
    let tags_json = serde_json::to_string(&tags).map_err(|err| err.to_string())?;
    let title_hierarchy = input
        .title_hierarchy
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let file_extension = normalize_file_extension(input.file_extension, source_name);
    let mime_type = input
        .mime_type
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let preview_type = input
        .preview_type
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| infer_preview_type(file_extension.as_deref(), mime_type.as_deref()));
    let inferred_preview_type = infer_preview_type(file_extension.as_deref(), mime_type.as_deref());
    let upload_guard_preview_type = if inferred_preview_type == "unsupported" {
        preview_type.as_str()
    } else {
        inferred_preview_type.as_str()
    };
    validate_knowledge_multimodal_upload(connection, &collection_id, upload_guard_preview_type)?;
    let thumbnail_data_url = input
        .thumbnail_data_url
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let chunks = if content.trim().is_empty() {
        Vec::new()
    } else {
        knowledge_chunker::split_document_text(
            &content,
            source_name,
            Some(preview_type.as_str()),
            file_extension.as_deref(),
            knowledge_chunker::DEFAULT_CHUNK_SIZE,
            knowledge_chunker::DEFAULT_CHUNK_OVERLAP,
        )
    };
    let chunk_count = chunks.len() as i64;
    let (chunk_embeddings, embedding_model_key) =
        generate_chunk_embeddings_safe(connection, &chunks);
    let vectorized_chunk_count = count_vectorized_chunks(&chunk_embeddings);
    let content_preview = if content.trim().is_empty() {
        preview_text(source_name, 240)
    } else {
        preview_text(&content, 240)
    };
    let favorite = input.favorite.unwrap_or(false);
    let stored_file_path = input
        .content_bytes
        .as_ref()
        .filter(|bytes| !bytes.is_empty())
        .map(|bytes| {
            store_knowledge_document_bytes(app, &collection_id, &document_id, source_name, bytes)
        })
        .transpose()?
        .map(|path| path.to_string_lossy().to_string());
    let stored_file_size = input
        .content_bytes
        .as_ref()
        .filter(|_| stored_file_path.is_some())
        .map(|bytes| bytes.len() as i64);

    let tx = connection
        .unchecked_transaction()
        .map_err(|err| err.to_string())?;
    tx.execute(
        r#"
        INSERT INTO knowledge_documents (
          id, collection_id, source_name, source_path, stored_file_path, mime_type, file_extension, preview_type,
          content, content_preview, chunk_count, thumbnail_data_url, tags_json, favorite,
          access_count, last_accessed_at, title_hierarchy, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 0, NULL, ?15, ?16, ?17)
        "#,
        params![
            document_id,
            collection_id,
            source_name,
            input.source_path,
            stored_file_path,
            mime_type,
            file_extension,
            preview_type,
            content,
            content_preview,
            chunk_count,
            thumbnail_data_url,
            tags_json,
            if favorite { 1_i64 } else { 0_i64 },
            title_hierarchy,
            now,
            now,
        ],
    )
    .map_err(|err| err.to_string())?;

    {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO knowledge_chunks (
                  id, document_id, collection_id, chunk_index, title, content, embedding_json, embedding_model_key, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                "#,
            )
            .map_err(|err| err.to_string())?;

        for (index, chunk_content) in chunks.into_iter().enumerate() {
            let chunk_id = uuid::Uuid::new_v4().to_string();
            let chunk_title = chunk_content.title.or_else(|| {
                if index == 0 {
                    Some(source_name.to_string())
                } else {
                    None
                }
            });
            stmt.execute(params![
                chunk_id,
                document_id,
                collection_id,
                index as i64,
                chunk_title,
                chunk_content.content,
                chunk_embeddings.get(index).cloned().unwrap_or(None),
                embedding_model_key.clone(),
                now,
            ])
            .map_err(|err| err.to_string())?;
        }
    }

    tx.commit().map_err(|err| err.to_string())?;

    Ok(KnowledgeDocumentRecord {
        id: document_id,
        collection_id,
        source_name: source_name.to_string(),
        source_path: input.source_path,
        stored_file_path,
        mime_type,
        file_extension,
        preview_type: Some(preview_type),
        content: if content.trim().is_empty() {
            None
        } else {
            Some(content)
        },
        content_preview,
        thumbnail_data_url,
        file_hash: None,
        file_size: stored_file_size,
        processing_status: Some(knowledge_pipeline::DOCUMENT_STATUS_SEARCHABLE.to_string()),
        error_message: None,
        active_job_id: None,
        content_version: Some(1),
        parser_profile_id: None,
        last_processed_at: Some(now),
        chunk_count,
        vectorized_chunk_count,
        vectorization_state: derive_vectorization_state(chunk_count, vectorized_chunk_count),
        tags,
        favorite,
        access_count: 0,
        last_accessed_at: None,
        title_hierarchy,
        created_at: now,
        updated_at: now,
    })
}

pub(crate) fn rebuild_document_embeddings(
    connection: &Connection,
    document_id: &str,
) -> Result<KnowledgeDocumentRecord, String> {
    ensure_knowledge_defaults(connection)?;

    let document = load_knowledge_document(connection, document_id)?.document;

    let mut chunk_stmt = connection
        .prepare(
            r#"
            SELECT chunk_index, content
            FROM knowledge_chunks
            WHERE document_id = ?1
            ORDER BY chunk_index ASC, created_at ASC, id ASC
            "#,
        )
        .map_err(|err| err.to_string())?;
    let chunk_rows = chunk_stmt
        .query_map(params![document_id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    let chunk_slices = chunk_rows
        .into_iter()
        .map(|(_, content)| knowledge_chunker::ChunkSlice {
            content,
            title: None,
        })
        .collect::<Vec<_>>();

    let (embeddings, embedding_model_key) =
        generate_chunk_embeddings_safe(connection, &chunk_slices);
    let vectorized_chunk_count = count_vectorized_chunks(&embeddings);
    let now = current_timestamp_ms();

    let tx = connection
        .unchecked_transaction()
        .map_err(|err| err.to_string())?;
    {
        let mut stmt = tx
            .prepare("UPDATE knowledge_chunks SET embedding_json = ?2, embedding_model_key = ?3 WHERE document_id = ?1 AND chunk_index = ?4")
            .map_err(|err| err.to_string())?;
        for (index, embedding_json) in embeddings.into_iter().enumerate() {
            stmt.execute(params![
                document_id,
                embedding_json,
                embedding_model_key.clone(),
                index as i64
            ])
            .map_err(|err| err.to_string())?;
        }
    }

    tx.execute(
        "UPDATE knowledge_documents SET updated_at = ?2 WHERE id = ?1",
        params![document_id, now],
    )
    .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;

    Ok(KnowledgeDocumentRecord {
        vectorized_chunk_count,
        vectorization_state: derive_vectorization_state(
            document.chunk_count,
            vectorized_chunk_count,
        ),
        updated_at: now,
        ..document
    })
}


#[tauri::command]
fn load_knowledge_library_command(
    app: tauri::AppHandle,
) -> Result<KnowledgeLibraryPayload, String> {
    let connection = open_sqlite_connection(&app)?;
    load_knowledge_library(&connection)
}

#[tauri::command]
fn load_knowledge_document_command(
    app: tauri::AppHandle,
    input: LoadKnowledgeDocumentInput,
) -> Result<KnowledgeDocumentDetailPayload, String> {
    let connection = open_sqlite_connection(&app)?;
    load_knowledge_document(&connection, &input.document_id)
}

#[tauri::command]
fn load_knowledge_document_file_command(
    app: tauri::AppHandle,
    input: LoadKnowledgeDocumentFileInput,
) -> Result<KnowledgeDocumentBinaryPayload, String> {
    let connection = open_sqlite_connection(&app)?;
    load_knowledge_document_file(&connection, &input.document_id)
}

#[tauri::command]
fn create_knowledge_collection_command(
    app: tauri::AppHandle,
    name: String,
    description: String,
    multimodal_config_json: Option<String>,
) -> Result<KnowledgeCollectionRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    create_knowledge_collection(&connection, &name, &description, multimodal_config_json)
}

#[tauri::command]
fn ensure_default_knowledge_collection_command(
    app: tauri::AppHandle,
) -> Result<KnowledgeCollectionRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    ensure_knowledge_defaults(&connection)?;

    connection
        .query_row(
            r#"
            SELECT id, name, description, retrieval_mode, embedding_profile_id, multimodal_config_json, created_at, updated_at
            FROM knowledge_collections
            WHERE id = 'default'
            "#,
            [],
            |row| {
                Ok(KnowledgeCollectionRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    retrieval_mode: row.get(3)?,
                    embedding_profile_id: row.get(4)?,
                    multimodal_config_json: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            },
        )
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn update_knowledge_collection_command(
    app: tauri::AppHandle,
    input: UpdateKnowledgeCollectionInput,
) -> Result<KnowledgeCollectionRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    update_knowledge_collection(&connection, input)
}

#[tauri::command]
fn delete_knowledge_collection_command(
    app: tauri::AppHandle,
    collection_id: String,
) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    delete_knowledge_collection(&connection, &collection_id)
}

#[tauri::command]
fn delete_knowledge_document_command(
    app: tauri::AppHandle,
    document_id: String,
) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    delete_knowledge_document(&connection, &document_id)
}

#[tauri::command]
fn import_knowledge_document_command(
    app: tauri::AppHandle,
    input: ImportKnowledgeDocumentInput,
) -> Result<KnowledgeDocumentRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    import_knowledge_document(&app, &connection, input)
}

#[tauri::command]
fn import_knowledge_document_pipeline_command(
    app: tauri::AppHandle,
    input: knowledge_pipeline::PipelineImportInput,
) -> Result<knowledge_pipeline::PipelineImportResult, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::create_pipeline_import(&app, &connection, input)
}

#[tauri::command]
fn load_knowledge_processing_jobs_command(
    app: tauri::AppHandle,
    document_id: Option<String>,
) -> Result<Vec<knowledge_pipeline::KnowledgeProcessingJobRecord>, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::list_processing_jobs(&connection, document_id)
}

#[tauri::command]
fn load_knowledge_processing_job_detail_command(
    app: tauri::AppHandle,
    job_id: String,
) -> Result<knowledge_pipeline::KnowledgeProcessingJobDetail, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::load_processing_job_detail(&connection, &job_id)
}

#[tauri::command]
fn load_knowledge_processing_status_summary_command(
    app: tauri::AppHandle,
    collection_id: Option<String>,
) -> Result<knowledge_pipeline::KnowledgeProcessingStatusSummary, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::load_processing_status_summary(&connection, collection_id)
}

#[tauri::command]
fn load_failed_knowledge_processing_jobs_command(
    app: tauri::AppHandle,
    input: knowledge_pipeline::FailedJobQueryInput,
) -> Result<knowledge_pipeline::FailedJobQueryResult, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::list_failed_processing_jobs(&connection, input)
}

#[tauri::command]
fn retry_failed_knowledge_processing_jobs_command(
    app: tauri::AppHandle,
    input: knowledge_pipeline::RetryFailedJobsInput,
) -> Result<knowledge_pipeline::RetryFailedJobsResult, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::retry_failed_jobs(&connection, input)
}

#[tauri::command]
fn load_knowledge_processing_dead_letters_command(
    app: tauri::AppHandle,
    input: knowledge_pipeline::DeadLetterQueryInput,
) -> Result<knowledge_pipeline::DeadLetterQueryResult, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::list_dead_letters(&connection, input)
}

#[tauri::command]
fn replay_knowledge_processing_dead_letters_command(
    app: tauri::AppHandle,
    input: knowledge_pipeline::ReplayDeadLettersInput,
) -> Result<knowledge_pipeline::ReplayDeadLettersResult, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::replay_dead_letters(&connection, input)
}

#[tauri::command]
fn pause_knowledge_processing_job_command(
    app: tauri::AppHandle,
    job_id: String,
) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::request_job_pause(&connection, &job_id)
}

#[tauri::command]
fn resume_knowledge_processing_job_command(
    app: tauri::AppHandle,
    job_id: String,
) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::request_job_resume(&connection, &job_id)
}

#[tauri::command]
fn cancel_knowledge_processing_job_command(
    app: tauri::AppHandle,
    job_id: String,
) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::request_job_cancel(&connection, &job_id)
}

#[tauri::command]
fn retry_knowledge_processing_job_command(
    app: tauri::AppHandle,
    job_id: String,
) -> Result<knowledge_pipeline::KnowledgeProcessingJobRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::retry_job(&connection, &job_id)
}

#[tauri::command]
fn reparse_knowledge_document_command(
    app: tauri::AppHandle,
    document_id: String,
) -> Result<knowledge_pipeline::KnowledgeProcessingJobRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::create_document_job(&connection, &document_id, "reparse")
}

#[tauri::command]
fn rechunk_knowledge_document_command(
    app: tauri::AppHandle,
    document_id: String,
) -> Result<knowledge_pipeline::KnowledgeProcessingJobRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::create_document_job(&connection, &document_id, "rechunk")
}

#[tauri::command]
fn revectorize_knowledge_document_command(
    app: tauri::AppHandle,
    document_id: String,
) -> Result<knowledge_pipeline::KnowledgeProcessingJobRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::create_document_job(&connection, &document_id, "revectorize")
}

#[tauri::command]
fn load_knowledge_pipeline_settings_command(
    app: tauri::AppHandle,
) -> Result<knowledge_pipeline::KnowledgePipelineSettings, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::load_pipeline_settings(&connection)
}

#[tauri::command]
fn save_knowledge_pipeline_settings_command(
    app: tauri::AppHandle,
    settings: knowledge_pipeline::KnowledgePipelineSettings,
) -> Result<knowledge_pipeline::KnowledgePipelineSettings, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::save_pipeline_settings(&connection, settings)
}

#[tauri::command]
fn cleanup_knowledge_processing_logs_command(app: tauri::AppHandle) -> Result<i64, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::cleanup_processing_logs(&connection)
}

#[tauri::command]
fn load_knowledge_multimodal_config_command(
    app: tauri::AppHandle,
) -> Result<KnowledgeMultimodalConfigRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    load_knowledge_multimodal_config(&connection)
}

#[tauri::command]
fn save_knowledge_multimodal_config_command(
    app: tauri::AppHandle,
    config: KnowledgeMultimodalConfigRecord,
) -> Result<KnowledgeMultimodalConfigRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    save_knowledge_multimodal_config(&connection, config)
}

#[tauri::command]
fn rebuild_knowledge_document_embeddings_command(
    app: tauri::AppHandle,
    input: RevectorizeKnowledgeDocumentInput,
) -> Result<KnowledgeDocumentRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    rebuild_document_embeddings(&connection, &input.document_id)
}

#[tauri::command]
fn search_knowledge_chunks_command(
    app: tauri::AppHandle,
    input: SearchKnowledgeChunksInput,
) -> Result<Vec<SearchKnowledgeChunkResult>, String> {
    let connection = open_sqlite_connection(&app)?;
    search_knowledge_chunks(&connection, input)
}

#[tauri::command]
fn list_workspace_files(
    project_path: Option<String>,
    query: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<workspace_files::WorkspaceFileEntry>, String> {
    workspace_files::list_files(project_path, query, limit)
}

#[tauri::command]
fn read_workspace_file(project_path: Option<String>, path: String, max_chars: Option<usize>) -> Result<String, String> {
    workspace_files::read_file(project_path, path, max_chars)
}

#[tauri::command]
fn search_workspace_files(
    project_path: Option<String>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<workspace_files::WorkspaceSearchMatch>, String> {
    workspace_files::search_files(project_path, query, limit)
}

/// 读取项目工作目录下的 AGENTS.md（仿 codex / deepseek 的指令文件约定）。
/// AGENTS.override.md 优先于 AGENTS.md。目录为空或文件不存在时返回空串。
#[tauri::command]
fn read_project_agents_md(project_path: Option<String>) -> String {
    let raw = match project_path {
        Some(value) => value.trim().to_string(),
        None => return String::new(),
    };
    if raw.is_empty() {
        return String::new();
    }
    let root = std::path::Path::new(&raw);
    let override_md = root.join("AGENTS.override.md");
    if override_md.exists() {
        return std::fs::read_to_string(&override_md).unwrap_or_default();
    }
    let agents_md = root.join("AGENTS.md");
    if agents_md.exists() {
        return std::fs::read_to_string(&agents_md).unwrap_or_default();
    }
    String::new()
}

#[tauri::command]
fn load_chat_storage(
    app: tauri::AppHandle,
    legacy_projects_json: Option<String>,
    legacy_sessions_json: Option<String>,
) -> Result<ChatStoragePayload, String> {
    let connection = open_sqlite_connection(&app)?;

    let has_structured = has_structured_chat_storage(&connection)?;
    if has_structured {
        return load_structured_chat_storage(&connection);
    }

    let payload = ChatStoragePayload {
        projects_json: legacy_projects_json.filter(|value| !value.trim().is_empty()),
        sessions_json: legacy_sessions_json.filter(|value| !value.trim().is_empty()),
    };

    if payload.projects_json.is_some() || payload.sessions_json.is_some() {
        save_structured_chat_storage(
            &connection,
            payload.projects_json.as_deref().unwrap_or("[]"),
            payload.sessions_json.as_deref().unwrap_or("[]"),
        )?;
        return load_structured_chat_storage(&connection);
    }

    Ok(payload)
}

#[tauri::command]
fn save_chat_storage(
    app: tauri::AppHandle,
    projects_json: String,
    sessions_json: String,
) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    save_structured_chat_storage(&connection, &projects_json, &sessions_json)?;
    Ok(())
}

#[tauri::command]
fn delete_chat_session(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    delete_chat_session_by_id(&connection, &id)
}

#[tauri::command]
fn delete_project(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    delete_project_by_id(&connection, &id)
}

#[tauri::command]
fn load_manifest_storage_command(app: tauri::AppHandle) -> Result<ManifestStoragePayload, String> {
    let connection = open_sqlite_connection(&app)?;
    load_manifest_storage(&connection)
}

#[tauri::command]
fn save_manifest_storage_command(
    app: tauri::AppHandle,
    project_presets_json: Option<String>,
    tool_manifests_json: Option<String>,
    skill_manifests_json: Option<String>,
) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    save_manifest_storage(
        &connection,
        project_presets_json.as_deref(),
        tool_manifests_json.as_deref(),
        skill_manifests_json.as_deref(),
    )
}

#[tauri::command]
fn load_memory_storage_command(app: tauri::AppHandle) -> Result<MemoryStoragePayload, String> {
    let connection = open_sqlite_connection(&app)?;
    load_memory_storage(&connection)
}

#[tauri::command]
fn save_memory_storage_command(
    app: tauri::AppHandle,
    project_memories_json: Option<String>,
    user_preferences_json: Option<String>,
    session_summaries_json: Option<String>,
) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    save_memory_storage(
        &connection,
        project_memories_json.as_deref(),
        user_preferences_json.as_deref(),
        session_summaries_json.as_deref(),
    )
}

#[tauri::command]
fn load_automation_storage_command(
    app: tauri::AppHandle,
) -> Result<AutomationStoragePayload, String> {
    let connection = open_sqlite_connection(&app)?;
    load_automation_storage(&connection)
}

#[tauri::command]
fn save_automation_storage_command(
    app: tauri::AppHandle,
    scheduled_tasks_json: Option<String>,
) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    save_automation_storage(&connection, scheduled_tasks_json.as_deref())
}

#[tauri::command]
fn load_app_kv(
    app: tauri::AppHandle,
    keys: Vec<String>,
    legacy_entries: Option<HashMap<String, String>>,
) -> Result<AppStoragePayload, String> {
    let connection = open_sqlite_connection(&app)?;
    let mut entries = HashMap::new();
    let legacy_entries = legacy_entries.unwrap_or_default();

    for key in keys {
        let mut value = read_structured_app_value(&connection, &key)?;
        if value.is_none() {
            if let Some(legacy_value) = legacy_entries
                .get(&key)
                .filter(|value| !value.trim().is_empty())
            {
                write_structured_app_value(&connection, &key, legacy_value)?;
                value = Some(legacy_value.clone());
            }
        }

        if let Some(value) = value {
            entries.insert(key, value);
        }
    }

    Ok(AppStoragePayload { entries })
}

#[tauri::command]
fn save_app_kv(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    write_structured_app_value(&connection, &key, &value)
}

#[tauri::command]
fn remove_app_kv(app: tauri::AppHandle, key: String) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    remove_structured_app_value(&connection, &key)?;
    connection
        .execute("DELETE FROM app_kv WHERE key = ?1", params![key])
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_data_root_info(
    app: tauri::AppHandle,
) -> Result<storage_paths::DataRootInfo, String> {
    storage_paths::data_root_info(&app)
}

#[tauri::command]
fn set_data_root(
    app: tauri::AppHandle,
    new_path: String,
) -> Result<storage_paths::DataRootInfo, String> {
    storage_paths::set_custom_root(&app, &new_path)
}

#[tauri::command]
fn reset_data_root(
    app: tauri::AppHandle,
) -> Result<storage_paths::DataRootInfo, String> {
    storage_paths::clear_custom_root(&app)
}

#[tauri::command]
fn open_data_dir(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let info = storage_paths::data_root_info(&app)?;
    app.opener()
        .open_path(info.path.clone(), None::<&str>)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn export_data_backup(
    app: tauri::AppHandle,
    target_path: String,
    secret: Option<String>,
) -> Result<backup::BackupManifest, String> {
    let root = storage_paths::resolve_data_root(&app)?;
    if let Some(reason) = storage_paths::path_risk(&root) {
        return Err(format!("当前数据目录存在风险，无法备份：{}", reason));
    }
    backup::build_backup(&root, std::path::Path::new(&target_path), secret.as_deref())
}

#[tauri::command]
fn import_data_backup(
    app: tauri::AppHandle,
    source_path: String,
    target_dir: String,
    secret: Option<String>,
) -> Result<backup::BackupManifest, String> {
    let target = std::path::Path::new(&target_dir);
    if let Some(reason) = storage_paths::path_risk(target) {
        return Err(reason);
    }
    storage_paths::ensure_writable(target)?;
    let manifest =
        backup::restore_backup(std::path::Path::new(&source_path), target, secret.as_deref())?;
    storage_paths::commit_custom_root(&app, target)?;
    Ok(manifest)
}

#[tauri::command]
fn read_persona_files(app: tauri::AppHandle) -> Result<persona::PersonaConfigDto, String> {
    persona::read_persona_files(&app)
}

#[tauri::command]
fn write_persona_file(app: tauri::AppHandle, key: String, content: String) -> Result<(), String> {
    persona::write_persona_file(&app, key, content)
}

pub(crate) fn show_main_window(app: &tauri::AppHandle) {
    let main_window = app.get_webview_window("main");
    let compact_window = app.get_webview_window("compact");

    if let Some(window) = main_window.as_ref() {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = window.emit("omni-focus-input", ());
        return;
    }

    if let Some(window) = compact_window.as_ref() {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed
                        && (shortcut.to_string() == "Ctrl+Shift+Space"
                            || shortcut.to_string() == "Ctrl+Alt+Space")
                    {
                        show_main_window(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            greet,
            load_workspace_pet_dir_command,
            load_codex_pet_packages,
            import_codex_pet_package,
            list_workspace_files,
            read_workspace_file,
            search_workspace_files,
            read_project_agents_md,
            load_knowledge_library_command,
            load_knowledge_document_command,
            load_knowledge_document_file_command,
            create_knowledge_collection_command,
            ensure_default_knowledge_collection_command,
            update_knowledge_collection_command,
            delete_knowledge_collection_command,
            delete_knowledge_document_command,
            import_knowledge_document_command,
            import_knowledge_document_pipeline_command,
            load_knowledge_processing_jobs_command,
            load_knowledge_processing_job_detail_command,
            load_knowledge_processing_status_summary_command,
            load_failed_knowledge_processing_jobs_command,
            retry_failed_knowledge_processing_jobs_command,
            load_knowledge_processing_dead_letters_command,
            replay_knowledge_processing_dead_letters_command,
            pause_knowledge_processing_job_command,
            resume_knowledge_processing_job_command,
            cancel_knowledge_processing_job_command,
            retry_knowledge_processing_job_command,
            reparse_knowledge_document_command,
            rechunk_knowledge_document_command,
            revectorize_knowledge_document_command,
            load_knowledge_pipeline_settings_command,
            save_knowledge_pipeline_settings_command,
            cleanup_knowledge_processing_logs_command,
            load_knowledge_multimodal_config_command,
            save_knowledge_multimodal_config_command,
            rebuild_knowledge_document_embeddings_command,
            search_knowledge_chunks_command,
            load_chat_storage,
            save_chat_storage,
            load_manifest_storage_command,
            save_manifest_storage_command,
            load_memory_storage_command,
            save_memory_storage_command,
            load_automation_storage_command,
            save_automation_storage_command,
            load_app_kv,
            save_app_kv,
            remove_app_kv,
            delete_chat_session,
            delete_project,
            get_data_root_info,
            set_data_root,
            reset_data_root,
            open_data_dir,
            export_data_backup,
            import_data_backup,
            read_persona_files,
            write_persona_file,
            install_skillhub_skill,
            uninstall_skillhub_skill,
            list_skillhub_skills,
            list_skillhub_plugins,
            list_skillhub_skill_categories,
            list_skillhub_plugin_categories
        ])
        .setup(|app| {
            use tauri_plugin_global_shortcut::GlobalShortcutExt;

            let show_hide = MenuItemBuilder::with_id("toggle", "打开主界面").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出 Omni").build(app)?;
            let tray_menu = MenuBuilder::new(app)
                .item(&show_hide)
                .separator()
                .item(&quit)
                .build()?;

            if let Some(tray_icon) = app.default_window_icon().cloned() {
                TrayIconBuilder::with_id("main")
                    .icon(tray_icon)
                    .tooltip("Omni 助手")
                    .menu(&tray_menu)
                    .show_menu_on_left_click(false)
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            show_main_window(&tray.app_handle());
                        }
                    })
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "toggle" => show_main_window(app),
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .build(app)?;
            } else {
                eprintln!("[Omni] 托盘图标不可用，已跳过托盘初始化");
            }

            let primary_shortcut = tauri_plugin_global_shortcut::Shortcut::new(
                Some(
                    tauri_plugin_global_shortcut::Modifiers::CONTROL
                        | tauri_plugin_global_shortcut::Modifiers::SHIFT,
                ),
                tauri_plugin_global_shortcut::Code::Space,
            );
            let fallback_shortcut = tauri_plugin_global_shortcut::Shortcut::new(
                Some(
                    tauri_plugin_global_shortcut::Modifiers::CONTROL
                        | tauri_plugin_global_shortcut::Modifiers::ALT,
                ),
                tauri_plugin_global_shortcut::Code::Space,
            );

            if app.global_shortcut().register(primary_shortcut).is_ok() {
                eprintln!("[Omni] 已注册全局快捷键 Ctrl+Shift+Space");
            } else if app.global_shortcut().register(fallback_shortcut).is_ok() {
                eprintln!("[Omni] Ctrl+Shift+Space 不可用，已回退到 Ctrl+Alt+Space");
            } else {
                eprintln!("[Omni] Ctrl+Shift+Space 和 Ctrl+Alt+Space 都注册失败");
            }

            let worker_app = app.handle().clone();
            std::thread::spawn(move || loop {
                if let Err(err) = knowledge_pipeline::run_pipeline_worker_tick(&worker_app) {
                    eprintln!("[Omni] knowledge pipeline worker error: {err}");
                }
                std::thread::sleep(std::time::Duration::from_millis(750));
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("运行 Omni 时发生错误");
}

