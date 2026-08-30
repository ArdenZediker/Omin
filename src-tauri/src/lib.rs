use reqwest::blocking::Client as BlockingHttpClient;
use reqwest::Client as HttpClient;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::{
    cmp::Ordering,
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

pub(crate) use database::open_sqlite_connection;
use knowledge_files::{
    delete_stored_document_file, delete_stored_document_files, infer_preview_type,
    normalize_file_extension, store_knowledge_document_bytes,
};
pub(crate) use knowledge_schema::ensure_knowledge_defaults;
#[cfg(test)]
pub(crate) use knowledge_schema::ensure_knowledge_schema;
#[cfg(test)]
pub(crate) use knowledge_schema::table_has_column;
use storage::{
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
struct AppStoragePayload {
    entries: HashMap<String, String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeCollectionRecord {
    id: String,
    name: String,
    description: String,
    retrieval_mode: String,
    embedding_profile_id: Option<String>,
    multimodal_config_json: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeDocumentRecord {
    id: String,
    collection_id: String,
    source_name: String,
    source_path: Option<String>,
    stored_file_path: Option<String>,
    mime_type: Option<String>,
    file_extension: Option<String>,
    preview_type: Option<String>,
    content: Option<String>,
    content_preview: String,
    thumbnail_data_url: Option<String>,
    file_hash: Option<String>,
    file_size: Option<i64>,
    processing_status: Option<String>,
    error_message: Option<String>,
    active_job_id: Option<String>,
    content_version: Option<i64>,
    parser_profile_id: Option<String>,
    last_processed_at: Option<i64>,
    chunk_count: i64,
    vectorized_chunk_count: i64,
    vectorization_state: String,
    tags: Vec<String>,
    favorite: bool,
    access_count: i64,
    last_accessed_at: Option<i64>,
    title_hierarchy: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct KnowledgeDocumentAssetRecord {
    id: String,
    document_id: String,
    collection_id: String,
    asset_kind: String,
    source_name: String,
    stored_file_path: String,
    mime_type: Option<String>,
    file_extension: Option<String>,
    preview_type: String,
    thumbnail_data_url: Option<String>,
    ocr_text: Option<String>,
    caption_text: Option<String>,
    content_preview: String,
    page_index: Option<i64>,
    asset_index: i64,
    metadata_json: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct KnowledgeChunkImageInfoRecord {
    asset_id: String,
    source_name: String,
    page_index: Option<i64>,
    asset_index: i64,
    original_markdown: Option<String>,
    thumbnail_data_url: Option<String>,
    ocr_text: Option<String>,
    caption_text: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct KnowledgeChunkRecord {
    id: String,
    document_id: String,
    collection_id: String,
    chunk_index: i64,
    title: Option<String>,
    content: String,
    chunk_type: Option<String>,
    parent_chunk_id: Option<String>,
    asset_id: Option<String>,
    image_info: Option<String>,
    embedding_json: Option<String>,
    embedding_model_key: Option<String>,
    created_at: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeLibraryPayload {
    collections: Vec<KnowledgeCollectionRecord>,
    documents: Vec<KnowledgeDocumentRecord>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeDocumentDetailPayload {
    document: KnowledgeDocumentRecord,
    assets: Vec<KnowledgeDocumentAssetRecord>,
    chunks: Vec<KnowledgeChunkRecord>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportKnowledgeDocumentInput {
    collection_id: Option<String>,
    source_name: String,
    source_path: Option<String>,
    content: String,
    content_bytes: Option<Vec<u8>>,
    mime_type: Option<String>,
    file_extension: Option<String>,
    preview_type: Option<String>,
    thumbnail_data_url: Option<String>,
    tags: Option<Vec<String>>,
    title_hierarchy: Option<String>,
    favorite: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateKnowledgeCollectionInput {
    collection_id: String,
    name: Option<String>,
    description: Option<String>,
    retrieval_mode: Option<String>,
    multimodal_config_json: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct KnowledgeEmbeddingModelConfigRecord {
    id: String,
    name: String,
    provider: String,
    base_url: String,
    model: String,
    api_key: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct KnowledgeEmbeddingConfigRecord {
    enabled: bool,
    active_model_id: String,
    models: Vec<KnowledgeEmbeddingModelConfigRecord>,
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
struct SearchKnowledgeChunksInput {
    query: String,
    limit: Option<usize>,
    collection_id: Option<String>,
    query_embedding: Option<Vec<f64>>,
    query_embedding_model_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RevectorizeKnowledgeDocumentInput {
    document_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadKnowledgeDocumentInput {
    document_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadKnowledgeDocumentFileInput {
    document_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeDocumentBinaryPayload {
    bytes: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchKnowledgeChunkResult {
    chunk: KnowledgeChunkRecord,
    matched_chunk: Option<KnowledgeChunkRecord>,
    display_chunk: Option<KnowledgeChunkRecord>,
    matched_chunk_type: Option<String>,
    parent_chunk_id: Option<String>,
    image_info: Option<String>,
    matched_asset: Option<KnowledgeDocumentAssetRecord>,
    score: f64,
    source_name: String,
    source_path: Option<String>,
    collection_name: String,
    tags: Vec<String>,
    favorite: bool,
    access_count: i64,
    last_accessed_at: Option<i64>,
    title_hierarchy: Option<String>,
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

fn current_timestamp_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn normalize_knowledge_collection_id(value: Option<String>) -> String {
    value
        .unwrap_or_default()
        .trim()
        .to_string()
        .if_empty_then("")
}

fn derive_vectorization_state(chunk_count: i64, vectorized_chunk_count: i64) -> String {
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

fn normalize_knowledge_retrieval_mode(_value: &str) -> String {
    "hybrid".to_string()
}

const OPENAI_COMPATIBLE_EMBEDDING_PROVIDERS: [&str; 6] = [
    "openai",
    "openrouter",
    "moonshot",
    "siliconflow",
    "dashscope",
    "zhipu",
];

const DEFAULT_EMBEDDING_MODEL: &str = "text-embedding-3-small";
const DEFAULT_BASE_URL_FALLBACK: &str = "https://api.openai.com/v1";
const EMBEDDING_BATCH_SIZE: usize = 8;

fn provider_supports_embeddings(provider: &str) -> bool {
    OPENAI_COMPATIBLE_EMBEDDING_PROVIDERS.contains(&provider)
}

fn fingerprint_text(value: &str) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

impl Default for KnowledgeCollectionMultimodalConfigRecord {
    fn default() -> Self {
        Self {
            enabled: false,
            merge_mode: "append".to_string(),
            image: KnowledgeCollectionImageMultimodalConfigRecord {
                enabled: false,
                model_id: None,
                extract_text: true,
                generate_summary: true,
            },
            audio: KnowledgeCollectionAudioMultimodalConfigRecord {
                enabled: false,
                model_id: None,
                keep_transcript: true,
                generate_summary: true,
            },
        }
    }
}

fn default_knowledge_embedding_config() -> KnowledgeEmbeddingConfigRecord {
    KnowledgeEmbeddingConfigRecord {
        enabled: false,
        active_model_id: format!("openai:{DEFAULT_EMBEDDING_MODEL}:0"),
        models: vec![KnowledgeEmbeddingModelConfigRecord {
            id: format!("openai:{DEFAULT_EMBEDDING_MODEL}:0"),
            name: "默认向量模型".to_string(),
            provider: "openai".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            model: DEFAULT_EMBEDDING_MODEL.to_string(),
            api_key: String::new(),
        }],
    }
}

fn default_knowledge_multimodal_config() -> KnowledgeMultimodalConfigRecord {
    KnowledgeMultimodalConfigRecord {
        enabled: false,
        active_image_model_id: Some("image:default".to_string()),
        active_audio_model_id: Some("audio:default".to_string()),
        models: vec![
            KnowledgeMultimodalModelConfigRecord {
                id: "image:default".to_string(),
                name: "Default Image Multimodal Model".to_string(),
                capability: "image".to_string(),
                provider: "openai".to_string(),
                base_url: DEFAULT_BASE_URL_FALLBACK.to_string(),
                model: "gpt-4.1-mini".to_string(),
                api_key: String::new(),
            },
            KnowledgeMultimodalModelConfigRecord {
                id: "audio:default".to_string(),
                name: "Default Audio Multimodal Model".to_string(),
                capability: "audio".to_string(),
                provider: "openai".to_string(),
                base_url: DEFAULT_BASE_URL_FALLBACK.to_string(),
                model: "gpt-4o-mini-transcribe".to_string(),
                api_key: String::new(),
            },
        ],
    }
}

fn normalize_multimodal_capability(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "audio" => "audio".to_string(),
        _ => "image".to_string(),
    }
}

fn normalize_knowledge_embedding_config_record(
    input: KnowledgeEmbeddingConfigRecord,
) -> KnowledgeEmbeddingConfigRecord {
    let default_model_id = input
        .active_model_id
        .trim()
        .to_string()
        .if_empty_then(&format!("openai:{DEFAULT_EMBEDDING_MODEL}:0"));
    let mut seen_ids = std::collections::HashSet::new();
    let mut models = Vec::new();
    for (index, model) in input.models.into_iter().enumerate() {
        let provider = if provider_supports_embeddings(&model.provider) {
            model.provider.trim().to_string()
        } else {
            "openai".to_string()
        };
        let raw_model = model.model.trim();
        let model_value = if raw_model.is_empty() {
            DEFAULT_EMBEDDING_MODEL.to_string()
        } else {
            raw_model.to_string()
        };
        let model_name = model.name.trim().to_string();
        let model_id = if model.id.trim().is_empty() {
            format!("{provider}:{model_value}:{index}")
        } else {
            model.id.trim().to_string()
        };
        let base_url = {
            let trimmed = model.base_url.trim();
            if trimmed.is_empty() {
                DEFAULT_BASE_URL_FALLBACK.to_string()
            } else {
                trimmed.to_string()
            }
        };
        let unique_id = if seen_ids.contains(&model_id) {
            format!("{model_id}-{index}")
        } else {
            model_id
        };
        seen_ids.insert(unique_id.clone());
        models.push(KnowledgeEmbeddingModelConfigRecord {
            id: unique_id,
            name: if model_name.is_empty() {
                model_value.clone()
            } else {
                model_name
            },
            provider,
            base_url,
            model: model_value,
            api_key: model.api_key.trim().to_string(),
        });
    }

    if models.is_empty() {
        models = vec![KnowledgeEmbeddingModelConfigRecord {
            id: default_model_id.clone(),
            name: "默认向量模型".to_string(),
            provider: "openai".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            model: DEFAULT_EMBEDDING_MODEL.to_string(),
            api_key: String::new(),
        }];
    }

    let active_model_id = if models.iter().any(|model| model.id == input.active_model_id) {
        input.active_model_id
    } else {
        default_model_id.clone()
    };

    KnowledgeEmbeddingConfigRecord {
        enabled: input.enabled,
        active_model_id,
        models,
    }
}

fn normalize_knowledge_multimodal_config_record(
    input: KnowledgeMultimodalConfigRecord,
) -> KnowledgeMultimodalConfigRecord {
    let default = default_knowledge_multimodal_config();
    let mut seen_ids = std::collections::HashSet::new();
    let mut models = Vec::new();

    for (index, model) in input.models.into_iter().enumerate() {
        let capability = normalize_multimodal_capability(&model.capability);
        let provider = if provider_supports_embeddings(&model.provider) {
            model.provider.trim().to_string()
        } else {
            "openai".to_string()
        };
        let model_value = model
            .model
            .trim()
            .to_string()
            .if_empty_then(match capability.as_str() {
                "audio" => "gpt-4o-mini-transcribe",
                _ => "gpt-4.1-mini",
            });
        let model_id = model
            .id
            .trim()
            .to_string()
            .if_empty_then(&format!("{capability}:{model_value}:{index}"));
        let unique_id = if seen_ids.contains(&model_id) {
            format!("{model_id}-{index}")
        } else {
            model_id
        };
        seen_ids.insert(unique_id.clone());
        models.push(KnowledgeMultimodalModelConfigRecord {
            id: unique_id,
            name: model.name.trim().to_string().if_empty_then(&model_value),
            capability,
            provider,
            base_url: model
                .base_url
                .trim()
                .to_string()
                .if_empty_then(DEFAULT_BASE_URL_FALLBACK),
            model: model_value,
            api_key: model.api_key.trim().to_string(),
        });
    }

    if models.is_empty() {
        models = default.models;
    }

    let active_image_model_id = input
        .active_image_model_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .filter(|id| {
            models
                .iter()
                .any(|model| model.capability == "image" && model.id == *id)
        })
        .or_else(|| {
            models
                .iter()
                .find(|model| model.capability == "image")
                .map(|model| model.id.clone())
        });
    let active_audio_model_id = input
        .active_audio_model_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .filter(|id| {
            models
                .iter()
                .any(|model| model.capability == "audio" && model.id == *id)
        })
        .or_else(|| {
            models
                .iter()
                .find(|model| model.capability == "audio")
                .map(|model| model.id.clone())
        });

    KnowledgeMultimodalConfigRecord {
        enabled: input.enabled,
        active_image_model_id,
        active_audio_model_id,
        models,
    }
}

fn normalize_collection_multimodal_flag_model(model_id: Option<String>) -> Option<String> {
    model_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(crate) fn normalize_knowledge_collection_multimodal_config_record(
    input: KnowledgeCollectionMultimodalConfigRecord,
) -> KnowledgeCollectionMultimodalConfigRecord {
    let default = KnowledgeCollectionMultimodalConfigRecord::default();
    KnowledgeCollectionMultimodalConfigRecord {
        enabled: input.enabled,
        merge_mode: match input.merge_mode.trim().to_lowercase().as_str() {
            "append" => "append".to_string(),
            _ => default.merge_mode,
        },
        image: KnowledgeCollectionImageMultimodalConfigRecord {
            enabled: input.image.enabled,
            model_id: normalize_collection_multimodal_flag_model(input.image.model_id),
            extract_text: input.image.extract_text,
            generate_summary: input.image.generate_summary,
        },
        audio: KnowledgeCollectionAudioMultimodalConfigRecord {
            enabled: input.audio.enabled,
            model_id: normalize_collection_multimodal_flag_model(input.audio.model_id),
            keep_transcript: input.audio.keep_transcript,
            generate_summary: input.audio.generate_summary,
        },
    }
}

fn normalize_collection_multimodal_config_json_for_storage(
    raw: Option<String>,
) -> Result<Option<String>, String> {
    let Some(value) = raw.map(|item| item.trim().to_string()) else {
        return Ok(None);
    };
    if value.is_empty() {
        return Ok(None);
    }

    let parsed = serde_json::from_str::<KnowledgeCollectionMultimodalConfigRecord>(&value)
        .map_err(|err| err.to_string())?;
    let normalized = normalize_knowledge_collection_multimodal_config_record(parsed);
    serde_json::to_string(&normalized)
        .map(Some)
        .map_err(|err| err.to_string())
}

pub(crate) fn parse_knowledge_collection_multimodal_config_json(
    raw: Option<&str>,
) -> KnowledgeCollectionMultimodalConfigRecord {
    raw.and_then(|value| {
        serde_json::from_str::<KnowledgeCollectionMultimodalConfigRecord>(value).ok()
    })
    .map(normalize_knowledge_collection_multimodal_config_record)
    .unwrap_or_default()
}

fn load_knowledge_embedding_config(
    connection: &Connection,
) -> Result<KnowledgeEmbeddingConfigRecord, String> {
    let raw = read_kv(connection, KNOWLEDGE_EMBEDDING_CONFIG_KEY)?;
    match raw {
        Some(value) => match serde_json::from_str::<KnowledgeEmbeddingConfigRecord>(&value) {
            Ok(parsed) => Ok(normalize_knowledge_embedding_config_record(parsed)),
            Err(_) => load_legacy_knowledge_embedding_config(connection)
                .map(|value| value.unwrap_or_else(default_knowledge_embedding_config)),
        },
        None => Ok(default_knowledge_embedding_config()),
    }
}

pub(crate) fn load_knowledge_multimodal_config(
    connection: &Connection,
) -> Result<KnowledgeMultimodalConfigRecord, String> {
    let raw = read_kv(connection, KNOWLEDGE_MULTIMODAL_CONFIG_KEY)?;
    match raw {
        Some(value) => serde_json::from_str::<KnowledgeMultimodalConfigRecord>(&value)
            .map(normalize_knowledge_multimodal_config_record)
            .map_err(|err| err.to_string()),
        None => Ok(default_knowledge_multimodal_config()),
    }
}

fn save_knowledge_multimodal_config(
    connection: &Connection,
    config: KnowledgeMultimodalConfigRecord,
) -> Result<KnowledgeMultimodalConfigRecord, String> {
    let normalized = normalize_knowledge_multimodal_config_record(config);
    let json = serde_json::to_string(&normalized).map_err(|err| err.to_string())?;
    write_kv(connection, KNOWLEDGE_MULTIMODAL_CONFIG_KEY, &json)?;
    Ok(normalized)
}

pub(crate) fn load_knowledge_collection_multimodal_config(
    connection: &Connection,
    collection_id: &str,
) -> Result<KnowledgeCollectionMultimodalConfigRecord, String> {
    let raw = connection
        .query_row(
            "SELECT multimodal_config_json FROM knowledge_collections WHERE id = ?1",
            params![collection_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .flatten();
    Ok(parse_knowledge_collection_multimodal_config_json(
        raw.as_deref(),
    ))
}

fn is_usable_knowledge_multimodal_model(
    model: &KnowledgeMultimodalModelConfigRecord,
    capability: &str,
) -> bool {
    model.capability == capability
        && !model.api_key.trim().is_empty()
        && !model.base_url.trim().is_empty()
        && !model.model.trim().is_empty()
        && provider_supports_embeddings(&model.provider)
}

pub(crate) fn find_exact_usable_knowledge_multimodal_model(
    config: &KnowledgeMultimodalConfigRecord,
    capability: &str,
    required_model_id: &str,
) -> Option<KnowledgeMultimodalModelConfigRecord> {
    if !config.enabled {
        return None;
    }

    let capability = normalize_multimodal_capability(capability);
    let required_model_id = required_model_id.trim();
    if required_model_id.is_empty() {
        return None;
    }

    config
        .models
        .iter()
        .find(|model| {
            model.id == required_model_id
                && is_usable_knowledge_multimodal_model(model, &capability)
        })
        .cloned()
}

pub(crate) fn validate_knowledge_multimodal_upload(
    connection: &Connection,
    collection_id: &str,
    preview_type: &str,
) -> Result<(), String> {
    let normalized_preview_type = preview_type.trim().to_lowercase();
    if normalized_preview_type == "video" {
        return Err(
            "已阻止本次上传：当前版本暂不支持视频上传到知识库，请先移除视频文件后再上传。"
                .to_string(),
        );
    }

    let capability = match normalized_preview_type.as_str() {
        "image" => "image",
        "audio" => "audio",
        _ => return Ok(()),
    };
    let label = if capability == "image" {
        "图片"
    } else {
        "音频"
    };

    let collection_config = load_knowledge_collection_multimodal_config(connection, collection_id)?;
    if !collection_config.enabled {
        return Err(format!(
            "已阻止本次上传：当前知识库未开启多模态分析，请先到知识库设置 -> 多模态中启用并配置{label}模型后再上传{label}。"
        ));
    }

    let selected_model_id = if capability == "image" {
        if !collection_config.image.enabled {
            return Err(format!(
                "已阻止本次上传：当前知识库未开启{label}多模态分析，请先到知识库设置 -> 多模态中开启并配置{label}模型后再上传{label}。"
            ));
        }
        collection_config.image.model_id.as_deref()
    } else {
        if !collection_config.audio.enabled {
            return Err(format!(
                "已阻止本次上传：当前知识库未开启{label}多模态分析，请先到知识库设置 -> 多模态中开启并配置{label}模型后再上传{label}。"
            ));
        }
        collection_config.audio.model_id.as_deref()
    };

    let selected_model_id = selected_model_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            format!(
                "已阻止本次上传：当前知识库尚未选择{label}模型，请先到知识库设置 -> 多模态中完成{label}模型配置后再上传{label}。"
            )
        })?;

    let global_config = load_knowledge_multimodal_config(connection)?;
    if find_exact_usable_knowledge_multimodal_model(&global_config, capability, selected_model_id)
        .is_none()
    {
        return Err(format!(
            "已阻止本次上传：当前知识库缺少可用的{label}多模态模型，请先到设置 -> 模型配置 -> 多模态中补充可用模型，并确认知识库设置里已选中对应{label}模型后再上传。"
        ));
    }

    Ok(())
}

fn load_knowledge_embedding_active_model(
    connection: &Connection,
) -> Result<
    Option<(
        KnowledgeEmbeddingConfigRecord,
        KnowledgeEmbeddingModelConfigRecord,
    )>,
    String,
> {
    let config = load_knowledge_embedding_config(connection)?;
    if !config.enabled {
        return Ok(None);
    }

    let active = config
        .models
        .iter()
        .find(|model| model.id == config.active_model_id)
        .cloned()
        .or_else(|| config.models.first().cloned())
        .filter(|model| {
            !model.api_key.trim().is_empty() && provider_supports_embeddings(&model.provider)
        });

    Ok(active.map(|model| (config, model)))
}

fn load_legacy_knowledge_embedding_config(
    connection: &Connection,
) -> Result<Option<KnowledgeEmbeddingConfigRecord>, String> {
    let raw = read_kv(connection, KNOWLEDGE_EMBEDDING_CONFIG_KEY)?;
    let Some(value) = raw else {
        return Ok(None);
    };

    let parsed: JsonValue = serde_json::from_str(&value).map_err(|err| err.to_string())?;
    let Some(object) = parsed.as_object() else {
        return Ok(None);
    };

    let enabled = object
        .get("enabled")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    let active_model_id = object
        .get("activeModelId")
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .to_string();
    let api_key = object
        .get("apiKey")
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .to_string();

    let models = object
        .get("models")
        .and_then(JsonValue::as_array)
        .map(|entries| {
            entries
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    let model = item.as_object();
                    let model_name = model
                        .and_then(|value| value.get("name"))
                        .and_then(JsonValue::as_str)
                        .unwrap_or("")
                        .to_string();
                    let model_provider = model
                        .and_then(|value| value.get("provider"))
                        .and_then(JsonValue::as_str)
                        .unwrap_or("openai")
                        .to_string();
                    let model_base_url = model
                        .and_then(|value| value.get("baseUrl"))
                        .and_then(JsonValue::as_str)
                        .unwrap_or("https://api.openai.com/v1")
                        .to_string();
                    let model_id = model
                        .and_then(|value| value.get("id"))
                        .and_then(JsonValue::as_str)
                        .unwrap_or("")
                        .to_string();
                    let model_value = model
                        .and_then(|value| value.get("model"))
                        .and_then(JsonValue::as_str)
                        .unwrap_or(DEFAULT_EMBEDDING_MODEL)
                        .to_string();
                    let model_api_key = model
                        .and_then(|value| value.get("apiKey"))
                        .and_then(JsonValue::as_str)
                        .unwrap_or("")
                        .to_string();

                    KnowledgeEmbeddingModelConfigRecord {
                        id: if model_id.is_empty() {
                            format!("{}:{}:{}", model_provider, model_value, index)
                        } else {
                            model_id
                        },
                        name: if model_name.is_empty() {
                            model_value.clone()
                        } else {
                            model_name
                        },
                        provider: model_provider,
                        base_url: model_base_url,
                        model: model_value,
                        api_key: if model_api_key.is_empty() {
                            api_key.clone()
                        } else {
                            model_api_key
                        },
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(Some(normalize_knowledge_embedding_config_record(
        KnowledgeEmbeddingConfigRecord {
            enabled,
            active_model_id,
            models,
        },
    )))
}

#[derive(Deserialize)]
struct EmbeddingApiItem {
    embedding: Vec<f64>,
    index: usize,
}

#[derive(Deserialize)]
struct EmbeddingApiResponse {
    data: Vec<EmbeddingApiItem>,
}

fn request_embedding_batch(
    client: &BlockingHttpClient,
    base_url: &str,
    api_key: &str,
    model: &str,
    input: &[&str],
) -> Result<Vec<Option<String>>, String> {
    let request_body = serde_json::json!({
        "model": model,
        "input": input,
    });

    let response = client
        .post(format!("{}/embeddings", base_url.trim_end_matches('/')))
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&request_body)
        .send()
        .map_err(|err| err.to_string())?;

    if !response.status().is_success() {
        return Err(response.text().unwrap_or_default());
    }

    let payload: EmbeddingApiResponse = response.json().map_err(|err| err.to_string())?;
    let mut embeddings = vec![None; input.len()];
    for item in payload.data {
        if item.index >= embeddings.len() {
            continue;
        }
        embeddings[item.index] = serde_json::to_string(&item.embedding).ok();
    }

    Ok(embeddings)
}

fn collect_missing_embedding_spans(embeddings: &[Option<String>]) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut span_start = None;

    for (index, value) in embeddings.iter().enumerate() {
        if value.is_none() {
            if span_start.is_none() {
                span_start = Some(index);
            }
            continue;
        }

        if let Some(start) = span_start.take() {
            spans.push((start, index));
        }
    }

    if let Some(start) = span_start {
        spans.push((start, embeddings.len()));
    }

    spans
}

fn recover_embedding_batch<F>(
    batch: &[knowledge_chunker::ChunkSlice],
    provider: &str,
    request_embeddings: &mut F,
) -> Vec<Option<String>>
where
    F: FnMut(&[knowledge_chunker::ChunkSlice]) -> Result<Vec<Option<String>>, String>,
{
    if batch.is_empty() {
        return Vec::new();
    }

    let requested = batch.len();
    let response = request_embeddings(batch);
    match response {
        Ok(mut embeddings) => {
            if embeddings.len() < requested {
                embeddings.resize(requested, None);
            } else if embeddings.len() > requested {
                embeddings.truncate(requested);
            }

            let missing_spans = collect_missing_embedding_spans(&embeddings);
            if missing_spans.is_empty() {
                return embeddings;
            }

            let missing_count = missing_spans
                .iter()
                .map(|(start, end)| end - start)
                .sum::<usize>();
            eprintln!(
                "Knowledge embedding batch returned partial data ({provider}) requested={requested} recovered={} missing={missing_count}",
                requested.saturating_sub(missing_count)
            );

            if requested == 1 {
                return embeddings;
            }

            if missing_spans.len() == 1 && missing_spans[0] == (0, requested) {
                let split = requested / 2;
                let mut left =
                    recover_embedding_batch(&batch[..split], provider, request_embeddings);
                let right = recover_embedding_batch(&batch[split..], provider, request_embeddings);
                left.extend(right);
                return left;
            }

            for (start, end) in missing_spans {
                let recovered =
                    recover_embedding_batch(&batch[start..end], provider, request_embeddings);
                for (offset, embedding) in recovered.into_iter().enumerate() {
                    if embedding.is_some() {
                        embeddings[start + offset] = embedding;
                    }
                }
            }

            embeddings
        }
        Err(err) => {
            eprintln!(
                "Knowledge embedding batch request failed ({provider}) requested={requested}: {err}"
            );
            if requested == 1 {
                return vec![None];
            }

            let split = requested / 2;
            let mut left = recover_embedding_batch(&batch[..split], provider, request_embeddings);
            let right = recover_embedding_batch(&batch[split..], provider, request_embeddings);
            left.extend(right);
            left
        }
    }
}

fn generate_chunk_embeddings_resilient(
    active_model: &KnowledgeEmbeddingModelConfigRecord,
    provider: &str,
    base_url: &str,
    api_key: &str,
    chunks: &[knowledge_chunker::ChunkSlice],
) -> Result<Vec<Option<String>>, String> {
    let client = BlockingHttpClient::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|err| format!("知识库 embedding 客户端创建失败 ({provider}): {err}"))?;

    let mut embeddings = vec![None; chunks.len()];
    for (batch_index, batch) in chunks.chunks(EMBEDDING_BATCH_SIZE).enumerate() {
        let batch_start = batch_index * EMBEDDING_BATCH_SIZE;
        let mut request_embeddings =
            |items: &[knowledge_chunker::ChunkSlice]| -> Result<Vec<Option<String>>, String> {
                let input: Vec<&str> = items.iter().map(|chunk| chunk.content.as_str()).collect();
                request_embedding_batch(&client, base_url, api_key, &active_model.model, &input)
            };
        let recovered = recover_embedding_batch(batch, provider, &mut request_embeddings);

        for (offset, embedding) in recovered.into_iter().enumerate() {
            let target = batch_start + offset;
            if target >= embeddings.len() {
                break;
            }
            embeddings[target] = embedding;
        }
    }

    Ok(embeddings)
}

pub(crate) fn generate_chunk_embeddings_safe(
    connection: &Connection,
    chunks: &[knowledge_chunker::ChunkSlice],
) -> (Vec<Option<String>>, Option<String>) {
    if chunks.is_empty() {
        return (Vec::new(), None);
    }

    let Some((_, active_model)) = load_knowledge_embedding_active_model(connection)
        .ok()
        .flatten()
    else {
        return (vec![None; chunks.len()], None);
    };

    let provider = active_model.provider.clone();
    let base_url = active_model.base_url.trim();
    let api_key = active_model.api_key.trim();
    if base_url.is_empty() || api_key.is_empty() {
        return (vec![None; chunks.len()], None);
    }

    let embeddings = match generate_chunk_embeddings_resilient(
        &active_model,
        &provider,
        base_url,
        api_key,
        chunks,
    ) {
        Ok(embeddings) => embeddings,
        Err(err) => {
            eprintln!("{err}");
            vec![None; chunks.len()]
        }
    };

    let model_key = format!(
        "{}:{}:{}",
        active_model.provider,
        active_model.model,
        fingerprint_text(active_model.api_key.trim())
    );
    (embeddings, Some(model_key))
}

// ===== 异步孪生：非阻塞 embedding（P1）=====
//
// 与 `generate_chunk_embeddings_safe` 行为一致，但 HTTP 调用走 `reqwest` 异步客户端，
// 不在调用线程上阻塞。可在 tokio 运行时中并发处理批量文档，避免 worker 线程被
// 长时 HTTP（120s 超时）卡死、并发吞吐受限。同步版保持不变，所有既有调用方零影响。

async fn request_embedding_batch_async(
    client: &HttpClient,
    base_url: &str,
    api_key: &str,
    model: &str,
    batch: &[knowledge_chunker::ChunkSlice],
) -> Result<Vec<Option<String>>, String> {
    let input: Vec<&str> = batch.iter().map(|c| c.content.as_str()).collect();
    let request_body = serde_json::json!({
        "model": model,
        "input": input,
    });

    let response = client
        .post(format!(
            "{}/embeddings",
            base_url.trim_end_matches('/')
        ))
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&request_body)
        .send()
        .await
        .map_err(|err| err.to_string())?;

    if !response.status().is_success() {
        return Err(response.text().await.unwrap_or_default());
    }

    let payload: EmbeddingApiResponse = response.json().await.map_err(|err| err.to_string())?;
    let mut embeddings = vec![None; input.len()];
    for item in payload.data {
        if item.index >= embeddings.len() {
            continue;
        }
        embeddings[item.index] = serde_json::to_string(&item.embedding).ok();
    }

    Ok(embeddings)
}

/// 异步版缺失片段收集（与同步版 `collect_missing_embedding_spans` 同语义）。
fn collect_missing_embedding_spans_async(embeddings: &[Option<String>]) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut span_start: Option<usize> = None;

    for (index, value) in embeddings.iter().enumerate() {
        if value.is_none() {
            if span_start.is_none() {
                span_start = Some(index);
            }
            continue;
        }
        if let Some(start) = span_start.take() {
            spans.push((start, index));
        }
    }
    if let Some(start) = span_start {
        spans.push((start, embeddings.len()));
    }
    spans
}

/// 异步版批量重试/分治恢复（与同步版 `recover_embedding_batch` 同语义）。
///
/// 直接持有 `reqwest` 异步客户端与模型参数，递归地对缺失/失败片段做二分重试，
/// 不再依赖高阶闭包（`AsyncFnMut` 在复杂递归里易触发类型推导问题）。
fn recover_embedding_batch_async<'a>(
    client: &'a HttpClient,
    provider: &'a str,
    base_url: &'a str,
    api_key: &'a str,
    model: &'a str,
    batch: &'a [knowledge_chunker::ChunkSlice],
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<Option<String>>> + Send + 'a>> {
    Box::pin(async move {
        if batch.is_empty() {
            return Vec::new();
        }

        let requested = batch.len();
        let response = request_embedding_batch_async(client, base_url, api_key, model, batch).await;
        match response {
            Ok(mut embeddings) => {
                if embeddings.len() < requested {
                    embeddings.resize(requested, None);
                } else if embeddings.len() > requested {
                    embeddings.truncate(requested);
                }

                let missing_spans = collect_missing_embedding_spans_async(&embeddings);
                if missing_spans.is_empty() {
                    return embeddings;
                }

                let missing_count =
                    missing_spans.iter().map(|(start, end)| end - start).sum::<usize>();
                eprintln!(
                    "Knowledge embedding batch returned partial data ({provider}) requested={requested} recovered={} missing={missing_count}",
                    requested.saturating_sub(missing_count)
                );

                if requested == 1 {
                    return embeddings;
                }

                if missing_spans.len() == 1 && missing_spans[0] == (0, requested) {
                    let split = requested / 2;
                    let mut left = recover_embedding_batch_async(
                        client,
                        provider,
                        base_url,
                        api_key,
                        model,
                        &batch[..split],
                    )
                    .await;
                    let right = recover_embedding_batch_async(
                        client,
                        provider,
                        base_url,
                        api_key,
                        model,
                        &batch[split..],
                    )
                    .await;
                    left.extend(right);
                    return left;
                }

                for (start, end) in missing_spans {
                    let recovered = recover_embedding_batch_async(
                        client,
                        provider,
                        base_url,
                        api_key,
                        model,
                        &batch[start..end],
                    )
                    .await;
                    for (offset, embedding) in recovered.into_iter().enumerate() {
                        if embedding.is_some() {
                            embeddings[start + offset] = embedding;
                        }
                    }
                }

                embeddings
            }
            Err(err) => {
                eprintln!(
                    "Knowledge embedding batch request failed ({provider}) requested={requested}: {err}"
                );
                if requested == 1 {
                    return vec![None];
                }

                let split = requested / 2;
                let mut left = recover_embedding_batch_async(
                    client,
                    provider,
                    base_url,
                    api_key,
                    model,
                    &batch[..split],
                )
                .await;
                let right = recover_embedding_batch_async(
                    client,
                    provider,
                    base_url,
                    api_key,
                    model,
                    &batch[split..],
                )
                .await;
                left.extend(right);
                left
            }
        }
    })
}

async fn generate_chunk_embeddings_resilient_async(
    active_model: &KnowledgeEmbeddingModelConfigRecord,
    provider: &str,
    base_url: &str,
    api_key: &str,
    chunks: &[knowledge_chunker::ChunkSlice],
) -> Result<Vec<Option<String>>, String> {
    let client = HttpClient::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|err| format!("知识库 embedding 客户端创建失败 ({provider}): {err}"))?;

    // P1-#1：各 batch 并发在飞——用 `futures_util::join_all` 把多个 batch 的
    // 恢复/重试 future 一次性派发，真正抬升吞吐（底层 `reqwest` 异步客户端
    // 在 tokio 运行时内并发处理多个 HTTP 请求，不再串行等待）。
    let mut batch_futures: Vec<_> = Vec::new();
    for batch in chunks.chunks(EMBEDDING_BATCH_SIZE) {
        let future = recover_embedding_batch_async(
            &client,
            provider,
            base_url,
            api_key,
            &active_model.model,
            batch,
        );
        batch_futures.push(future);
    }
    let batch_results = futures_util::future::join_all(batch_futures).await;

    let mut embeddings = vec![None; chunks.len()];
    for (batch_index, recovered) in batch_results.into_iter().enumerate() {
        let batch_start = batch_index * EMBEDDING_BATCH_SIZE;
        for (offset, embedding) in recovered.into_iter().enumerate() {
            let target = batch_start + offset;
            if target >= embeddings.len() {
                break;
            }
            embeddings[target] = embedding;
        }
    }

    Ok(embeddings)
}

/// 异步版批量生成 chunk embedding（与 `generate_chunk_embeddings_safe` 同返回形状）。
///
/// 非阻塞：HTTP 走 `reqwest` 异步客户端，可在 tokio 运行时中并发调用，避免
/// 调用线程被长时 HTTP 卡死。降级逻辑与同步版一致（无模型/无密钥/请求失败 → 返回 `None`）。
/// 当前毫秒时间戳（向量缓存落库用）。
fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) async fn generate_chunk_embeddings_async(
    connection: &Connection,
    chunks: &[knowledge_chunker::ChunkSlice],
) -> (Vec<Option<String>>, Option<String>) {
    if chunks.is_empty() {
        return (Vec::new(), None);
    }

    let Some((_, active_model)) = load_knowledge_embedding_active_model(connection)
        .ok()
        .flatten()
    else {
        return (vec![None; chunks.len()], None);
    };

    let provider = active_model.provider.clone();
    let base_url = active_model.base_url.trim();
    let api_key = active_model.api_key.trim();
    if base_url.is_empty() || api_key.is_empty() {
        return (vec![None; chunks.len()], None);
    }

    let model_key = format!(
        "{}:{}:{}",
        active_model.provider,
        active_model.model,
        fingerprint_text(active_model.api_key.trim())
    );

    // === 向量缓存（P3-#8，best-effort）===
    // 命中缓存的片段直接复用，仅未命中的才真正请求模型；请求成功后再回填缓存。
    // 任何缓存异常都被忽略（缓存是加速层，不应影响主链路）。
    let mut embeddings: Vec<Option<String>> = Vec::with_capacity(chunks.len());
    let mut miss_indices: Vec<usize> = Vec::new();
    for (index, chunk) in chunks.iter().enumerate() {
        let content_hash = fingerprint_text(&chunk.content);
        let cached = connection
            .query_row(
                "SELECT embedding_json FROM embedding_cache WHERE model_key = ?1 AND content_hash = ?2",
                rusqlite::params![model_key, content_hash],
                |row| row.get::<_, String>(0),
            )
            .ok();
        match cached {
            Some(json) => embeddings.push(Some(json)),
            None => {
                embeddings.push(None);
                miss_indices.push(index);
            }
        }
    }

    if !miss_indices.is_empty() {
        let miss_chunks: Vec<knowledge_chunker::ChunkSlice> =
            miss_indices.iter().map(|i| chunks[*i].clone()).collect();
        let miss_embeddings = match generate_chunk_embeddings_resilient_async(
            &active_model,
            &provider,
            base_url,
            api_key,
            &miss_chunks,
        )
        .await
        {
            Ok(e) => e,
            Err(err) => {
                eprintln!("{err}");
                vec![None; miss_chunks.len()]
            }
        };
        for (offset, emb) in miss_embeddings.into_iter().enumerate() {
            let target = miss_indices[offset];
            embeddings[target] = emb.clone();
            if let Some(json) = &emb {
                let content_hash = fingerprint_text(&miss_chunks[offset].content);
                let _ = connection.execute(
                    "INSERT OR REPLACE INTO embedding_cache (model_key, content_hash, embedding_json, created_at) VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![model_key, content_hash, json, now_ms()],
                );
            }
        }
    }

    (embeddings, Some(model_key))
}

/// 在 worker 线程上以"当前线程 tokio 运行时 + `block_on`"方式调用异步 embedding，
/// 返回形状与 `generate_chunk_embeddings_safe` 完全一致，下游落库逻辑无需任何改动。
///
/// 这是 P1 "把异步路径接线到 worker" 的最小侵入实现：底层 HTTP 改走 `reqwest`
/// 异步客户端（事件循环驱动，不再占用 `reqwest::blocking` 的线程池），避免长时
/// embedding 请求把 worker 线程钉死。运行时创建失败时自动回退到同步实现，保证不降级。
pub(crate) fn generate_chunk_embeddings_async_blocking(
    connection: &Connection,
    chunks: &[knowledge_chunker::ChunkSlice],
) -> (Vec<Option<String>>, Option<String>) {
    if chunks.is_empty() {
        return (Vec::new(), None);
    }
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(err) => {
            eprintln!("知识库 embedding 异步运行时创建失败，回退同步路径: {err}");
            return generate_chunk_embeddings_safe(connection, chunks);
        }
    };
    rt.block_on(generate_chunk_embeddings_async(connection, chunks))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(content: &str) -> knowledge_chunker::ChunkSlice {
        knowledge_chunker::ChunkSlice {
            content: content.to_string(),
            title: None,
        }
    }

    #[test]
    fn recover_embedding_batch_recovers_partial_responses() {
        let chunks = vec![
            chunk("chunk-0"),
            chunk("chunk-1"),
            chunk("chunk-2"),
            chunk("chunk-3"),
            chunk("chunk-4"),
        ];
        let mut request_embeddings =
            |items: &[knowledge_chunker::ChunkSlice]| -> Result<Vec<Option<String>>, String> {
                let mut values = vec![None; items.len()];
                if let Some(first) = items.first() {
                    values[0] = Some(format!("embed:{}", first.content));
                }
                Ok(values)
            };

        let recovered = recover_embedding_batch(&chunks, "test", &mut request_embeddings);

        assert_eq!(recovered.len(), chunks.len());
        for (index, embedding) in recovered.iter().enumerate() {
            assert_eq!(
                embedding.as_deref(),
                Some(format!("embed:chunk-{index}").as_str())
            );
        }
    }

    #[test]
    fn recover_embedding_batch_recovers_failed_batches() {
        let chunks = vec![
            chunk("chunk-a"),
            chunk("chunk-b"),
            chunk("chunk-c"),
            chunk("chunk-d"),
        ];
        let mut request_embeddings =
            |items: &[knowledge_chunker::ChunkSlice]| -> Result<Vec<Option<String>>, String> {
                if items.len() > 1 {
                    return Err("batch too large".into());
                }
                Ok(vec![Some(format!("embed:{}", items[0].content))])
            };

        let recovered = recover_embedding_batch(&chunks, "test", &mut request_embeddings);

        assert_eq!(recovered.len(), chunks.len());
        assert_eq!(
            recovered,
            vec![
                Some("embed:chunk-a".to_string()),
                Some("embed:chunk-b".to_string()),
                Some("embed:chunk-c".to_string()),
                Some("embed:chunk-d".to_string())
            ]
        );
    }

    #[test]
    fn async_blocking_bridge_returns_early_for_empty_chunks() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        let chunks: Vec<knowledge_chunker::ChunkSlice> = Vec::new();
        let (embeddings, model_key) =
            generate_chunk_embeddings_async_blocking(&connection, &chunks);
        assert!(embeddings.is_empty());
        assert_eq!(model_key, None);
    }

    #[test]
    fn async_blocking_bridge_runs_without_model_config() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        let chunks = vec![chunk("hello"), chunk("world")];
        // 无 embedding 模型配置 → 全部 None，且不触网、不 panic。
        let (embeddings, model_key) =
            generate_chunk_embeddings_async_blocking(&connection, &chunks);
        assert_eq!(embeddings, vec![None, None]);
        assert_eq!(model_key, None);
    }
}

trait EmptyFallback {
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

fn normalize_text_for_search(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .to_lowercase()
}

fn tokenize_search_query(value: &str) -> Vec<String> {
    normalize_text_for_search(value)
        .split(|character: char| !character.is_alphanumeric())
        .map(str::trim)
        .filter(|term| !term.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn preview_text(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim();
    let count = trimmed.chars().count();
    if count <= max_chars {
        return trimmed.to_string();
    }
    let clipped: String = trimmed.chars().take(max_chars.saturating_sub(3)).collect();
    format!("{clipped}...")
}

fn parse_tags_json(value: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(value).unwrap_or_default()
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

fn load_knowledge_library(connection: &Connection) -> Result<KnowledgeLibraryPayload, String> {
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

fn load_knowledge_document(
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

fn load_knowledge_document_file(
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

fn create_knowledge_collection(
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

fn update_knowledge_collection(
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

fn delete_knowledge_collection(connection: &Connection, collection_id: &str) -> Result<(), String> {
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

fn delete_knowledge_document(connection: &Connection, document_id: &str) -> Result<(), String> {
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

fn import_knowledge_document(
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

fn rebuild_document_embeddings(
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

fn score_search_candidate(
    query: &str,
    query_terms: &[String],
    query_embedding: Option<&[f64]>,
    retrieval_mode: &str,
    candidate: &KnowledgeSearchCandidate,
) -> f64 {
    let mut score = 0.0;
    let haystack = normalize_text_for_search(&format!(
        "{} {} {} {} {} {}",
        candidate.source_name,
        candidate.source_path.as_deref().unwrap_or_default(),
        candidate.title_hierarchy.as_deref().unwrap_or_default(),
        candidate.title.as_deref().unwrap_or_default(),
        candidate.tags.join(" "),
        candidate.content
    ));

    if haystack.contains(query) {
        score += 8.0;
    }

    for term in query_terms {
        if haystack.contains(term) {
            score += 1.5;
        }
    }

    let allow_embedding = matches!(retrieval_mode, "hybrid" | "vector");
    if allow_embedding {
        if let Some(query_embedding) = query_embedding {
            if let Some(candidate_embedding) = candidate
                .embedding_json
                .as_deref()
                .and_then(parse_embedding_json)
            {
                score += cosine_similarity(query_embedding, &candidate_embedding) * 2.0;
            }
        }
    }

    if matches!(retrieval_mode, "vector") {
        score += 0.2;
    }

    if matches!(retrieval_mode, "keyword") {
        score += 0.1;
    }

    score
}

fn parse_embedding_json(value: &str) -> Option<Vec<f64>> {
    serde_json::from_str::<Vec<f64>>(value).ok()
}

fn cosine_similarity(left: &[f64], right: &[f64]) -> f64 {
    let len = left.len().min(right.len());
    if len == 0 {
        return 0.0;
    }

    let mut dot = 0.0;
    let mut left_norm = 0.0;
    let mut right_norm = 0.0;

    for index in 0..len {
        let l = left[index];
        let r = right[index];
        dot += l * r;
        left_norm += l * l;
        right_norm += r * r;
    }

    let denominator = left_norm.sqrt() * right_norm.sqrt();
    if denominator == 0.0 {
        0.0
    } else {
        dot / denominator
    }
}

struct KnowledgeSearchCandidate {
    chunk_id: String,
    document_id: String,
    collection_id: String,
    chunk_index: i64,
    title: Option<String>,
    content: String,
    chunk_type: Option<String>,
    parent_chunk_id: Option<String>,
    asset_id: Option<String>,
    image_info: Option<String>,
    embedding_json: Option<String>,
    embedding_model_key: Option<String>,
    created_at: i64,
    source_name: String,
    source_path: Option<String>,
    collection_name: String,
    retrieval_mode: String,
    tags: Vec<String>,
    favorite: bool,
    access_count: i64,
    last_accessed_at: Option<i64>,
    title_hierarchy: Option<String>,
}

fn build_chunk_record_from_candidate(candidate: &KnowledgeSearchCandidate) -> KnowledgeChunkRecord {
    KnowledgeChunkRecord {
        id: candidate.chunk_id.clone(),
        document_id: candidate.document_id.clone(),
        collection_id: candidate.collection_id.clone(),
        chunk_index: candidate.chunk_index,
        title: candidate.title.clone(),
        content: candidate.content.clone(),
        chunk_type: candidate.chunk_type.clone(),
        parent_chunk_id: candidate.parent_chunk_id.clone(),
        asset_id: candidate.asset_id.clone(),
        image_info: candidate.image_info.clone(),
        embedding_json: candidate.embedding_json.clone(),
        embedding_model_key: candidate.embedding_model_key.clone(),
        created_at: candidate.created_at,
    }
}

fn load_chunk_record_by_id(
    connection: &Connection,
    chunk_id: &str,
) -> Result<Option<KnowledgeChunkRecord>, String> {
    connection
        .query_row(
            r#"
            SELECT id, document_id, collection_id, chunk_index, title, content, chunk_type, parent_chunk_id,
                   asset_id, image_info, embedding_json, embedding_model_key, created_at
            FROM knowledge_chunks
            WHERE id = ?1
            "#,
            params![chunk_id],
            |row| {
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
            },
        )
        .optional()
        .map_err(|err| err.to_string())
}

fn load_asset_record_by_id(
    connection: &Connection,
    asset_id: &str,
) -> Result<Option<KnowledgeDocumentAssetRecord>, String> {
    connection
        .query_row(
            r#"
            SELECT id, document_id, collection_id, asset_kind, source_name, stored_file_path, mime_type,
                   file_extension, preview_type, thumbnail_data_url, ocr_text, caption_text,
                   content_preview, page_index, asset_index, metadata_json, created_at, updated_at
            FROM knowledge_document_assets
            WHERE id = ?1
            "#,
            params![asset_id],
            |row| {
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
            },
        )
        .optional()
        .map_err(|err| err.to_string())
}

fn resolve_search_display_chunk(
    connection: &Connection,
    candidate: &KnowledgeSearchCandidate,
) -> Result<
    (
        KnowledgeChunkRecord,
        Option<KnowledgeChunkRecord>,
        Option<KnowledgeDocumentAssetRecord>,
    ),
    String,
> {
    let matched_chunk = build_chunk_record_from_candidate(candidate);
    let matched_asset = candidate
        .asset_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(|asset_id| load_asset_record_by_id(connection, asset_id))
        .transpose()?
        .flatten();

    if matches!(
        candidate.chunk_type.as_deref(),
        Some("image_ocr" | "image_caption")
    ) {
        if let Some(parent_chunk_id) = candidate
            .parent_chunk_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            if let Some(parent_chunk) = load_chunk_record_by_id(connection, parent_chunk_id)? {
                return Ok((parent_chunk, Some(matched_chunk), matched_asset));
            }
        }
    }

    Ok((matched_chunk.clone(), Some(matched_chunk), matched_asset))
}

fn search_knowledge_chunks(
    connection: &Connection,
    input: SearchKnowledgeChunksInput,
) -> Result<Vec<SearchKnowledgeChunkResult>, String> {
    let query = normalize_text_for_search(&input.query);
    if query.is_empty() {
        return Ok(Vec::new());
    }

    ensure_knowledge_defaults(connection)?;
    let query_terms = tokenize_search_query(&query);
    let normalized_query = if query_terms.is_empty() {
        query.clone()
    } else {
        query_terms.join(" ")
    };
    let limit = input.limit.unwrap_or(10).clamp(1, 50);
    let query_model_key = input
        .query_embedding_model_key
        .as_deref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let collection_filter = input.collection_id.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });
    let query_embedding = input.query_embedding;
    let mut stmt = connection
        .prepare(
            r#"
            SELECT
              c.id,
              c.document_id,
              c.collection_id,
              c.chunk_index,
              c.title,
              c.content,
              c.chunk_type,
              c.parent_chunk_id,
              c.asset_id,
              c.image_info,
              c.embedding_json,
              c.embedding_model_key,
              c.created_at,
              d.source_name,
              d.source_path,
              d.tags_json,
              d.favorite,
              d.access_count,
              d.last_accessed_at,
              d.title_hierarchy,
              k.name,
              k.retrieval_mode
            FROM knowledge_chunks c
            JOIN knowledge_documents d ON d.id = c.document_id
            JOIN knowledge_collections k ON k.id = c.collection_id
            "#,
        )
        .map_err(|err| err.to_string())?;

    let candidates = stmt
        .query_map([], |row| {
            let tags_json: String = row.get(15)?;
            Ok(KnowledgeSearchCandidate {
                chunk_id: row.get(0)?,
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
                source_name: row.get(13)?,
                source_path: row.get(14)?,
                tags: parse_tags_json(&tags_json),
                favorite: row.get::<_, i64>(16)? != 0,
                access_count: row.get(17)?,
                last_accessed_at: row.get(18)?,
                title_hierarchy: row.get(19)?,
                collection_name: row.get(20)?,
                retrieval_mode: row.get(21)?,
            })
        })
        .map_err(|err| err.to_string())?
        .filter_map(|row| row.ok())
        .filter(|candidate| {
            collection_filter
                .as_ref()
                .map(|collection_id| &candidate.collection_id == collection_id)
                .unwrap_or(true)
        })
        .collect::<Vec<_>>();

    let mut scored = Vec::new();
    for candidate in candidates {
        let retrieval_mode = normalize_knowledge_retrieval_mode(candidate.retrieval_mode.as_str());
        let embedding_matches = query_model_key
            .as_deref()
            .map(|model_key| {
                candidate
                    .embedding_model_key
                    .as_deref()
                    .map(|value| value == model_key)
                    .unwrap_or(false)
            })
            .unwrap_or(true);
        if !embedding_matches {
            continue;
        }

        let effective_embedding = if matches!(retrieval_mode.as_str(), "hybrid" | "vector") {
            query_embedding.as_deref()
        } else {
            None
        };
        let score = score_search_candidate(
            &normalized_query,
            &query_terms,
            effective_embedding,
            &retrieval_mode,
            &candidate,
        );
        if score <= 0.0
            && !normalize_text_for_search(&candidate.content).contains(&normalized_query)
        {
            continue;
        }

        scored.push((score, candidate));
    }

    scored.sort_by(|left, right| {
        right
            .0
            .partial_cmp(&left.0)
            .unwrap_or(Ordering::Equal)
            .then_with(|| right.1.access_count.cmp(&left.1.access_count))
            .then_with(|| left.1.created_at.cmp(&right.1.created_at))
    });

    let mut deduped_by_display: HashMap<String, SearchKnowledgeChunkResult> = HashMap::new();
    for (score, candidate) in scored {
        let (display_chunk, matched_chunk, matched_asset) =
            resolve_search_display_chunk(connection, &candidate)?;
        let display_chunk_id = display_chunk.id.clone();
        let next_result = SearchKnowledgeChunkResult {
            chunk: display_chunk.clone(),
            matched_chunk,
            display_chunk: Some(display_chunk.clone()),
            matched_chunk_type: candidate.chunk_type.clone(),
            parent_chunk_id: candidate.parent_chunk_id.clone(),
            image_info: candidate.image_info.clone(),
            matched_asset,
            score,
            source_name: candidate.source_name.clone(),
            source_path: candidate.source_path.clone(),
            collection_name: candidate.collection_name.clone(),
            tags: candidate.tags.clone(),
            favorite: candidate.favorite,
            access_count: candidate.access_count,
            last_accessed_at: candidate.last_accessed_at,
            title_hierarchy: candidate.title_hierarchy.clone(),
        };

        match deduped_by_display.get(&display_chunk_id) {
            Some(existing) if existing.score >= score => {}
            _ => {
                deduped_by_display.insert(display_chunk_id, next_result);
            }
        }
    }

    let mut results = deduped_by_display
        .into_values()
        .collect::<Vec<SearchKnowledgeChunkResult>>();
    results.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(Ordering::Equal)
            .then_with(|| right.access_count.cmp(&left.access_count))
            .then_with(|| left.chunk.created_at.cmp(&right.chunk.created_at))
    });
    results.truncate(limit);
    Ok(results)
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

fn show_main_window(app: &tauri::AppHandle) {
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
            list_skillhub_plugins
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

// ---- SkillHub 技能安装（一切皆插件：从 SkillHub 实时安装 DSH 风格 SKILL.md 技能）----
#[derive(serde::Serialize)]
struct SkillhubInstallResult {
    slug: String,
    path: String,
    skill_md: String,
}

/// 安全地归一化 slug，避免路径穿越与非法文件名。
fn sanitize_skillhub_slug(slug: &str) -> String {
    slug.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == '/' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// 解析默认技能安装目录：DSH 兼容的 ~/.dsh/skills（可被 DeepSeek Harness 发现）。
fn default_skillhub_skills_dir() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "无法解析用户主目录".to_string())?;
    Ok(std::path::PathBuf::from(home)
        .join(".dsh")
        .join("skills"))
}

#[tauri::command]
async fn install_skillhub_skill(
    slug: String,
    skills_dir: Option<String>,
    api_base: Option<String>,
) -> Result<SkillhubInstallResult, String> {
    // 下载是阻塞网络 IO，必须在 spawn_blocking 中执行，否则会卡住 UI 线程
    tauri::async_runtime::spawn_blocking(move || -> Result<SkillhubInstallResult, String> {
        let base = api_base.unwrap_or_else(|| "https://api.skillhub.cn".to_string());
        let safe_slug = sanitize_skillhub_slug(&slug);
        if safe_slug.is_empty() {
            return Err("无效的技能 slug".to_string());
        }

        let dir = match skills_dir {
            Some(d) => std::path::PathBuf::from(d),
            None => default_skillhub_skills_dir()?,
        };
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建技能目录失败: {e}"))?;
        let target = dir.join(&safe_slug);

        let url = format!("{}/api/v1/download?slug={}&source=dsh", base, slug);
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(90))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client.get(&url).send().map_err(|e| format!("下载失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("SkillHub 下载接口返回 {}", resp.status()));
        }
        let bytes = resp
            .bytes()
            .map_err(|e| format!("读取下载内容失败: {e}"))?;

        if target.exists() {
            std::fs::remove_dir_all(&target).map_err(|e| format!("清理旧技能失败: {e}"))?;
        }
        std::fs::create_dir_all(&target).map_err(|e| format!("创建技能目录失败: {e}"))?;

        let reader = std::io::Cursor::new(bytes);
        let mut archive =
            zip::ZipArchive::new(reader).map_err(|e| format!("ZIP 解析失败: {e}"))?;
        for i in 0..archive.len() {
            let mut file = archive
                .by_index(i)
                .map_err(|e| format!("读取 ZIP 条目失败: {e}"))?;
            let Some(enclosed) = file.enclosed_name().map(|p| p.to_path_buf()) else {
                continue; // 跳过无法安全解析的路径
            };
            let out_path = target.join(&enclosed);
            if !out_path.starts_with(&target) {
                return Err("检测到 ZIP 路径穿越，已拒绝安装".to_string());
            }
            if file.is_dir() {
                std::fs::create_dir_all(&out_path).ok();
            } else {
                if let Some(parent) = out_path.parent() {
                    std::fs::create_dir_all(parent).ok();
                }
                let mut outfile =
                    std::fs::File::create(&out_path).map_err(|e| format!("写入文件失败: {e}"))?;
                std::io::copy(&mut file, &mut outfile).map_err(|e| format!("写入文件失败: {e}"))?;
            }
        }

        let skill_md_path = target.join("SKILL.md");
        if !skill_md_path.exists() {
            let _ = std::fs::remove_dir_all(&target);
            return Err("技能包缺少 SKILL.md，已拒绝安装".to_string());
        }
        let skill_md = std::fs::read_to_string(&skill_md_path)
            .map_err(|e| format!("读取 SKILL.md 失败: {e}"))?;

        Ok(SkillhubInstallResult {
            slug: safe_slug,
            path: target.to_string_lossy().to_string(),
            skill_md,
        })
    })
    .await
    .map_err(|e| format!("SkillHub 任务失败: {e}"))?
}

#[tauri::command]
fn uninstall_skillhub_skill(slug: String, skills_dir: Option<String>) -> Result<(), String> {
    let dir = match skills_dir {
        Some(d) => std::path::PathBuf::from(d),
        None => default_skillhub_skills_dir()?,
    };
    let safe_slug = sanitize_skillhub_slug(&slug);
    let target = dir.join(&safe_slug);
    if target.exists() {
        std::fs::remove_dir_all(&target).map_err(|e| format!("卸载失败: {e}"))?;
    }
    Ok(())
}

#[derive(serde::Serialize)]
struct SkillhubListSkillsResult {
    skills: Vec<serde_json::Value>,
}

#[tauri::command]
async fn list_skillhub_skills(
    query: Option<String>,
    page: Option<u32>,
    limit: Option<u32>,
    api_base: Option<String>,
) -> Result<SkillhubListSkillsResult, String> {
    // 关键：这里必须用 spawn_blocking 把阻塞的 HTTP 请求挪出 UI 线程。
    // 同步命令 + reqwest::blocking 会直接卡住界面（滚动都动不了），滚动加载时尤其明显。
    tauri::async_runtime::spawn_blocking(move || -> Result<SkillhubListSkillsResult, String> {
        let _ = query.as_deref(); // 搜索在前端过滤，这里仅保留参数兼容
                                  // /api/skills 服务端不接受 category 参数，传任意值都会 400；支持 page 翻页，每页固定约 20 条
        let base = api_base.unwrap_or_else(|| "https://api.skillhub.cn".to_string());
        let mut url = format!("{}/api/skills?limit={}", base, limit.unwrap_or(60));
        if let Some(p) = page {
            url.push_str(&format!("&page={}", p.max(1)));
        }

        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client
            .get(&url)
            .send()
            .map_err(|e| format!("SkillHub 请求失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("SkillHub 接口返回 {}", resp.status()));
        }
        let json: serde_json::Value = resp.json().map_err(|e| format!("解析失败: {e}"))?;
        let skills = json
            .get("data")
            .and_then(|d| d.get("skills"))
            .and_then(|s| s.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(SkillhubListSkillsResult { skills })
    })
    .await
    .map_err(|e| format!("SkillHub 任务失败: {e}"))?
}

#[tauri::command]
async fn list_skillhub_plugins(
    query: Option<String>,
    category: Option<String>,
    limit: Option<u32>,
    api_base: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    // 同 list_skillhub_skills：阻塞 HTTP 请在 spawn_blocking 中执行，避免卡 UI
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<serde_json::Value>, String> {
        let base = api_base.unwrap_or_else(|| "https://api.skillhub.cn".to_string());
        let mut url = format!("{}/api/v1/plugins?limit={}", base, limit.unwrap_or(60));
        if let Some(c) = category {
            if c != "全部" {
                url.push_str(&format!("&category={}", c));
            }
        }

        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client.get(&url).send().map_err(|e| format!("SkillHub 请求失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("SkillHub 接口返回 {}", resp.status()));
        }
        let json: serde_json::Value = resp.json().map_err(|e| format!("解析失败: {e}"))?;
        let items = json
            .get("items")
            .and_then(|s| s.as_array())
            .cloned()
            .unwrap_or_default();

        let q = query.as_deref().unwrap_or("").trim().to_lowercase();
        if q.is_empty() {
            return Ok(items);
        }
        Ok(items
            .into_iter()
            .filter(|item| {
                let text = format!(
                    "{} {} {}",
                    item.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                    item.get("fullName").and_then(|v| v.as_str()).unwrap_or(""),
                    item.get("description").and_then(|v| v.as_str()).unwrap_or("")
                )
                .to_lowercase();
                text.contains(&q)
            })
            .collect())
    })
    .await
    .map_err(|e| format!("SkillHub 任务失败: {e}"))?
}
