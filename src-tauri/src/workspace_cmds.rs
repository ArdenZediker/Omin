use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::{
    AppStoragePayload,
    AutomationStoragePayload,
    ChatStoragePayload,
    EmptyFallback,
    ImportKnowledgeDocumentInput,
    KNOWLEDGE_EMBEDDING_CONFIG_KEY,
    KNOWLEDGE_MULTIMODAL_CONFIG_KEY,
    KnowledgeChunkImageInfoRecord,
    KnowledgeChunkRecord,
    KnowledgeCollectionAudioMultimodalConfigRecord,
    KnowledgeCollectionImageMultimodalConfigRecord,
    KnowledgeCollectionMultimodalConfigRecord,
    KnowledgeCollectionRecord,
    KnowledgeDocumentAssetRecord,
    KnowledgeDocumentBinaryPayload,
    KnowledgeDocumentDetailPayload,
    KnowledgeDocumentRecord,
    KnowledgeEmbeddingConfigRecord,
    KnowledgeEmbeddingModelConfigRecord,
    KnowledgeLibraryPayload,
    KnowledgeMultimodalConfigRecord,
    KnowledgeMultimodalModelConfigRecord,
    LoadKnowledgeDocumentFileInput,
    LoadKnowledgeDocumentInput,
    ManifestStoragePayload,
    MemoryStoragePayload,
    RevectorizeKnowledgeDocumentInput,
    SearchKnowledgeChunkResult,
    SearchKnowledgeChunksInput,
    UpdateKnowledgeCollectionInput,
    build_chunk_record_from_candidate,
    collect_missing_embedding_spans,
    collect_missing_embedding_spans_async,
    collection_exists,
    cosine_similarity,
    count_vectorized_chunks,
    current_timestamp_ms,
    default_knowledge_embedding_config,
    default_knowledge_multimodal_config,
    default_skillhub_skills_dir,
    delete_chat_session_by_id,
    delete_project_by_id,
    delete_stored_document_file,
    delete_stored_document_files,
    derive_vectorization_state,
    ensure_knowledge_defaults,
    find_exact_usable_knowledge_multimodal_model,
    fingerprint_text,
    generate_chunk_embeddings_async_blocking,
    generate_chunk_embeddings_resilient,
    generate_chunk_embeddings_safe,
    has_structured_chat_storage,
    infer_preview_type,
    is_usable_knowledge_multimodal_model,
    load_asset_record_by_id,
    load_automation_storage,
    load_chunk_record_by_id,
    load_knowledge_collection_multimodal_config,
    load_knowledge_embedding_active_model,
    load_knowledge_embedding_config,
    load_knowledge_multimodal_config,
    load_legacy_knowledge_embedding_config,
    load_manifest_storage,
    load_memory_storage,
    load_structured_chat_storage,
    normalize_collection_multimodal_config_json_for_storage,
    normalize_collection_multimodal_flag_model,
    normalize_file_extension,
    normalize_knowledge_collection_id,
    normalize_knowledge_collection_multimodal_config_record,
    normalize_knowledge_embedding_config_record,
    normalize_knowledge_multimodal_config_record,
    normalize_knowledge_retrieval_mode,
    normalize_multimodal_capability,
    normalize_text_for_search,
    now_ms,
    open_sqlite_connection,
    parse_embedding_json,
    parse_knowledge_collection_multimodal_config_json,
    parse_tags_json,
    preview_text,
    provider_supports_embeddings,
    read_kv,
    read_structured_app_value,
    recover_embedding_batch,
    recover_embedding_batch_async,
    remove_structured_app_value,
    request_embedding_batch,
    resolve_search_display_chunk,
    sanitize_skillhub_slug,
    save_automation_storage,
    save_knowledge_multimodal_config,
    save_manifest_storage,
    save_memory_storage,
    save_structured_chat_storage,
    score_search_candidate,
    search_knowledge_chunks,
    show_main_window,
    store_knowledge_document_bytes,
    tokenize_search_query,
    uninstall_skillhub_skill,
    validate_knowledge_multimodal_upload,
    workspace_root,
    write_kv,
    write_structured_app_value,
};
use crate::{
    knowledge_pipeline,
    knowledge_chunker,
    knowledge_embedding_batch,
    knowledge_embedding_config,
    knowledge_files,
    knowledge_schema,
    knowledge,
    storage,
    codex_pets,
    persona,
    backup,
    workspace_files,
    storage_paths,
    database,
    knowledge_embedded_images,
};

#[tauri::command]
pub(crate) fn list_workspace_files(
    project_path: Option<String>,
    query: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<workspace_files::WorkspaceFileEntry>, String> {
    workspace_files::list_files(project_path, query, limit)
}

#[tauri::command]
pub(crate) fn read_workspace_file(project_path: Option<String>, path: String, max_chars: Option<usize>) -> Result<String, String> {
    workspace_files::read_file(project_path, path, max_chars)
}

#[tauri::command]
pub(crate) fn search_workspace_files(
    project_path: Option<String>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<workspace_files::WorkspaceSearchMatch>, String> {
    workspace_files::search_files(project_path, query, limit)
}

#[tauri::command]
pub(crate) fn read_project_agents_md(project_path: Option<String>) -> String {
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
