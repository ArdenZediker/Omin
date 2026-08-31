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
pub(crate) fn load_knowledge_library_command(
    app: tauri::AppHandle,
) -> Result<KnowledgeLibraryPayload, String> {
    let connection = open_sqlite_connection(&app)?;
    load_knowledge_library(&connection)
}

#[tauri::command]
pub(crate) fn load_knowledge_document_command(
    app: tauri::AppHandle,
    input: LoadKnowledgeDocumentInput,
) -> Result<KnowledgeDocumentDetailPayload, String> {
    let connection = open_sqlite_connection(&app)?;
    load_knowledge_document(&connection, &input.document_id)
}

#[tauri::command]
pub(crate) fn load_knowledge_document_file_command(
    app: tauri::AppHandle,
    input: LoadKnowledgeDocumentFileInput,
) -> Result<KnowledgeDocumentBinaryPayload, String> {
    let connection = open_sqlite_connection(&app)?;
    load_knowledge_document_file(&connection, &input.document_id)
}

#[tauri::command]
pub(crate) fn create_knowledge_collection_command(
    app: tauri::AppHandle,
    name: String,
    description: String,
    multimodal_config_json: Option<String>,
) -> Result<KnowledgeCollectionRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    create_knowledge_collection(&connection, &name, &description, multimodal_config_json)
}

#[tauri::command]
pub(crate) fn ensure_default_knowledge_collection_command(
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
pub(crate) fn update_knowledge_collection_command(
    app: tauri::AppHandle,
    input: UpdateKnowledgeCollectionInput,
) -> Result<KnowledgeCollectionRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    update_knowledge_collection(&connection, input)
}

#[tauri::command]
pub(crate) fn delete_knowledge_collection_command(
    app: tauri::AppHandle,
    collection_id: String,
) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    delete_knowledge_collection(&connection, &collection_id)
}

#[tauri::command]
pub(crate) fn delete_knowledge_document_command(
    app: tauri::AppHandle,
    document_id: String,
) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    delete_knowledge_document(&connection, &document_id)
}

#[tauri::command]
pub(crate) fn import_knowledge_document_command(
    app: tauri::AppHandle,
    input: ImportKnowledgeDocumentInput,
) -> Result<KnowledgeDocumentRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    import_knowledge_document(&app, &connection, input)
}

#[tauri::command]
pub(crate) fn import_knowledge_document_pipeline_command(
    app: tauri::AppHandle,
    input: knowledge_pipeline::PipelineImportInput,
) -> Result<knowledge_pipeline::PipelineImportResult, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::create_pipeline_import(&app, &connection, input)
}

#[tauri::command]
pub(crate) fn load_knowledge_processing_jobs_command(
    app: tauri::AppHandle,
    document_id: Option<String>,
) -> Result<Vec<knowledge_pipeline::KnowledgeProcessingJobRecord>, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::list_processing_jobs(&connection, document_id)
}

#[tauri::command]
pub(crate) fn load_knowledge_processing_job_detail_command(
    app: tauri::AppHandle,
    job_id: String,
) -> Result<knowledge_pipeline::KnowledgeProcessingJobDetail, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::load_processing_job_detail(&connection, &job_id)
}

#[tauri::command]
pub(crate) fn load_knowledge_processing_status_summary_command(
    app: tauri::AppHandle,
    collection_id: Option<String>,
) -> Result<knowledge_pipeline::KnowledgeProcessingStatusSummary, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::load_processing_status_summary(&connection, collection_id)
}

#[tauri::command]
pub(crate) fn load_failed_knowledge_processing_jobs_command(
    app: tauri::AppHandle,
    input: knowledge_pipeline::FailedJobQueryInput,
) -> Result<knowledge_pipeline::FailedJobQueryResult, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::list_failed_processing_jobs(&connection, input)
}

#[tauri::command]
pub(crate) fn retry_failed_knowledge_processing_jobs_command(
    app: tauri::AppHandle,
    input: knowledge_pipeline::RetryFailedJobsInput,
) -> Result<knowledge_pipeline::RetryFailedJobsResult, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::retry_failed_jobs(&connection, input)
}

#[tauri::command]
pub(crate) fn load_knowledge_processing_dead_letters_command(
    app: tauri::AppHandle,
    input: knowledge_pipeline::DeadLetterQueryInput,
) -> Result<knowledge_pipeline::DeadLetterQueryResult, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::list_dead_letters(&connection, input)
}

#[tauri::command]
pub(crate) fn replay_knowledge_processing_dead_letters_command(
    app: tauri::AppHandle,
    input: knowledge_pipeline::ReplayDeadLettersInput,
) -> Result<knowledge_pipeline::ReplayDeadLettersResult, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::replay_dead_letters(&connection, input)
}

#[tauri::command]
pub(crate) fn pause_knowledge_processing_job_command(
    app: tauri::AppHandle,
    job_id: String,
) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::request_job_pause(&connection, &job_id)
}

#[tauri::command]
pub(crate) fn resume_knowledge_processing_job_command(
    app: tauri::AppHandle,
    job_id: String,
) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::request_job_resume(&connection, &job_id)
}

#[tauri::command]
pub(crate) fn cancel_knowledge_processing_job_command(
    app: tauri::AppHandle,
    job_id: String,
) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::request_job_cancel(&connection, &job_id)
}

#[tauri::command]
pub(crate) fn retry_knowledge_processing_job_command(
    app: tauri::AppHandle,
    job_id: String,
) -> Result<knowledge_pipeline::KnowledgeProcessingJobRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::retry_job(&connection, &job_id)
}

#[tauri::command]
pub(crate) fn reparse_knowledge_document_command(
    app: tauri::AppHandle,
    document_id: String,
) -> Result<knowledge_pipeline::KnowledgeProcessingJobRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::create_document_job(&connection, &document_id, "reparse")
}

#[tauri::command]
pub(crate) fn rechunk_knowledge_document_command(
    app: tauri::AppHandle,
    document_id: String,
) -> Result<knowledge_pipeline::KnowledgeProcessingJobRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::create_document_job(&connection, &document_id, "rechunk")
}

#[tauri::command]
pub(crate) fn revectorize_knowledge_document_command(
    app: tauri::AppHandle,
    document_id: String,
) -> Result<knowledge_pipeline::KnowledgeProcessingJobRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::create_document_job(&connection, &document_id, "revectorize")
}

#[tauri::command]
pub(crate) fn load_knowledge_pipeline_settings_command(
    app: tauri::AppHandle,
) -> Result<knowledge_pipeline::KnowledgePipelineSettings, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::load_pipeline_settings(&connection)
}

#[tauri::command]
pub(crate) fn save_knowledge_pipeline_settings_command(
    app: tauri::AppHandle,
    settings: knowledge_pipeline::KnowledgePipelineSettings,
) -> Result<knowledge_pipeline::KnowledgePipelineSettings, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::save_pipeline_settings(&connection, settings)
}

#[tauri::command]
pub(crate) fn cleanup_knowledge_processing_logs_command(app: tauri::AppHandle) -> Result<i64, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::cleanup_processing_logs(&connection)
}

#[tauri::command]
pub(crate) fn load_knowledge_multimodal_config_command(
    app: tauri::AppHandle,
) -> Result<KnowledgeMultimodalConfigRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    load_knowledge_multimodal_config(&connection)
}

#[tauri::command]
pub(crate) fn save_knowledge_multimodal_config_command(
    app: tauri::AppHandle,
    config: KnowledgeMultimodalConfigRecord,
) -> Result<KnowledgeMultimodalConfigRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    save_knowledge_multimodal_config(&connection, config)
}

#[tauri::command]
pub(crate) fn rebuild_knowledge_document_embeddings_command(
    app: tauri::AppHandle,
    input: RevectorizeKnowledgeDocumentInput,
) -> Result<KnowledgeDocumentRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    rebuild_document_embeddings(&connection, &input.document_id)
}

#[tauri::command]
pub(crate) fn search_knowledge_chunks_command(
    app: tauri::AppHandle,
    input: SearchKnowledgeChunksInput,
) -> Result<Vec<SearchKnowledgeChunkResult>, String> {
    let connection = open_sqlite_connection(&app)?;
    search_knowledge_chunks(&connection, input)
}
