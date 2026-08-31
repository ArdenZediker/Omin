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
pub(crate) fn load_chat_storage(
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
pub(crate) fn save_chat_storage(
    app: tauri::AppHandle,
    projects_json: String,
    sessions_json: String,
) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    save_structured_chat_storage(&connection, &projects_json, &sessions_json)?;
    Ok(())
}

#[tauri::command]
pub(crate) fn delete_chat_session(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    delete_chat_session_by_id(&connection, &id)
}

#[tauri::command]
pub(crate) fn delete_project(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    delete_project_by_id(&connection, &id)
}

#[tauri::command]
pub(crate) fn load_manifest_storage_command(app: tauri::AppHandle) -> Result<ManifestStoragePayload, String> {
    let connection = open_sqlite_connection(&app)?;
    load_manifest_storage(&connection)
}

#[tauri::command]
pub(crate) fn save_manifest_storage_command(
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
pub(crate) fn load_memory_storage_command(app: tauri::AppHandle) -> Result<MemoryStoragePayload, String> {
    let connection = open_sqlite_connection(&app)?;
    load_memory_storage(&connection)
}

#[tauri::command]
pub(crate) fn save_memory_storage_command(
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
pub(crate) fn load_automation_storage_command(
    app: tauri::AppHandle,
) -> Result<AutomationStoragePayload, String> {
    let connection = open_sqlite_connection(&app)?;
    load_automation_storage(&connection)
}

#[tauri::command]
pub(crate) fn save_automation_storage_command(
    app: tauri::AppHandle,
    scheduled_tasks_json: Option<String>,
) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    save_automation_storage(&connection, scheduled_tasks_json.as_deref())
}

#[tauri::command]
pub(crate) fn load_app_kv(
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
pub(crate) fn save_app_kv(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    write_structured_app_value(&connection, &key, &value)
}

#[tauri::command]
pub(crate) fn remove_app_kv(app: tauri::AppHandle, key: String) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    remove_structured_app_value(&connection, &key)?;
    connection
        .execute("DELETE FROM app_kv WHERE key = ?1", params![key])
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn get_data_root_info(
    app: tauri::AppHandle,
) -> Result<storage_paths::DataRootInfo, String> {
    storage_paths::data_root_info(&app)
}

#[tauri::command]
pub(crate) fn set_data_root(
    app: tauri::AppHandle,
    new_path: String,
) -> Result<storage_paths::DataRootInfo, String> {
    storage_paths::set_custom_root(&app, &new_path)
}

#[tauri::command]
pub(crate) fn reset_data_root(
    app: tauri::AppHandle,
) -> Result<storage_paths::DataRootInfo, String> {
    storage_paths::clear_custom_root(&app)
}

#[tauri::command]
pub(crate) fn open_data_dir(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let info = storage_paths::data_root_info(&app)?;
    app.opener()
        .open_path(info.path.clone(), None::<&str>)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn export_data_backup(
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
pub(crate) fn import_data_backup(
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
