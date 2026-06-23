use rusqlite::Connection;

pub(crate) fn ensure_knowledge_defaults(_connection: &Connection) -> Result<(), String> {
    Ok(())
}

pub(crate) fn table_has_column(
    connection: &Connection,
    table: &str,
    column: &str,
) -> Result<bool, String> {
    let sql = format!("PRAGMA table_info({table})");
    let mut stmt = connection.prepare(&sql).map_err(|err| err.to_string())?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    Ok(columns.iter().any(|item| item == column))
}

pub(crate) fn ensure_knowledge_schema(connection: &Connection) -> Result<(), String> {
    if !table_has_column(connection, "knowledge_chunks", "embedding_json")? {
        connection
            .execute(
                "ALTER TABLE knowledge_chunks ADD COLUMN embedding_json TEXT",
                [],
            )
            .map_err(|err| err.to_string())?;
    }
    if !table_has_column(connection, "knowledge_chunks", "embedding_model_key")? {
        connection
            .execute(
                "ALTER TABLE knowledge_chunks ADD COLUMN embedding_model_key TEXT",
                [],
            )
            .map_err(|err| err.to_string())?;
    }
    if !table_has_column(connection, "knowledge_chunks", "chunk_type")? {
        connection
            .execute(
                "ALTER TABLE knowledge_chunks ADD COLUMN chunk_type TEXT NOT NULL DEFAULT 'text'",
                [],
            )
            .map_err(|err| err.to_string())?;
    }
    if !table_has_column(connection, "knowledge_chunks", "parent_chunk_id")? {
        connection
            .execute(
                "ALTER TABLE knowledge_chunks ADD COLUMN parent_chunk_id TEXT",
                [],
            )
            .map_err(|err| err.to_string())?;
    }
    if !table_has_column(connection, "knowledge_chunks", "asset_id")? {
        connection
            .execute("ALTER TABLE knowledge_chunks ADD COLUMN asset_id TEXT", [])
            .map_err(|err| err.to_string())?;
    }
    if !table_has_column(connection, "knowledge_chunks", "image_info")? {
        connection
            .execute(
                "ALTER TABLE knowledge_chunks ADD COLUMN image_info TEXT",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "tags_json")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "favorite")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "access_count")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "last_accessed_at")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN last_accessed_at INTEGER",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "title_hierarchy")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN title_hierarchy TEXT",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "stored_file_path")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN stored_file_path TEXT",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "mime_type")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN mime_type TEXT",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "file_extension")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN file_extension TEXT",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "preview_type")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN preview_type TEXT",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "thumbnail_data_url")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN thumbnail_data_url TEXT",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "file_hash")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN file_hash TEXT",
                [],
            )
            .map_err(|err| err.to_string())?;
    }
    connection
        .execute(
            "UPDATE knowledge_documents
             SET file_hash = NULL
             WHERE file_hash IS NOT NULL
               AND substr(file_hash, 1, length('fnv1a64:')) = 'fnv1a64:'",
            [],
        )
        .map_err(|err| err.to_string())?;

    if !table_has_column(connection, "knowledge_documents", "file_size")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN file_size INTEGER",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "processing_status")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'searchable'",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "error_message")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN error_message TEXT",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "active_job_id")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN active_job_id TEXT",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "content_version")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN content_version INTEGER NOT NULL DEFAULT 1",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "parser_profile_id")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN parser_profile_id TEXT",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "last_processed_at")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN last_processed_at INTEGER",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_collections", "retrieval_mode")? {
        connection
            .execute(
                "ALTER TABLE knowledge_collections ADD COLUMN retrieval_mode TEXT NOT NULL DEFAULT 'hybrid'",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_collections", "embedding_profile_id")? {
        connection
            .execute(
                "ALTER TABLE knowledge_collections ADD COLUMN embedding_profile_id TEXT",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(
        connection,
        "knowledge_collections",
        "multimodal_config_json",
    )? {
        connection
            .execute(
                "ALTER TABLE knowledge_collections ADD COLUMN multimodal_config_json TEXT",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    connection
        .execute(
            r#"
            CREATE TABLE IF NOT EXISTS knowledge_document_assets (
              id TEXT PRIMARY KEY,
              document_id TEXT NOT NULL,
              collection_id TEXT NOT NULL,
              asset_kind TEXT NOT NULL,
              source_name TEXT NOT NULL,
              stored_file_path TEXT NOT NULL,
              mime_type TEXT,
              file_extension TEXT,
              preview_type TEXT NOT NULL,
              thumbnail_data_url TEXT,
              ocr_text TEXT,
              caption_text TEXT,
              content_preview TEXT NOT NULL,
              page_index INTEGER,
              asset_index INTEGER NOT NULL,
              metadata_json TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )
            "#,
            [],
        )
        .map_err(|err| err.to_string())?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS idx_knowledge_document_assets_document ON knowledge_document_assets (document_id, asset_index)",
            [],
        )
        .map_err(|err| err.to_string())?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_parent_chunk_id ON knowledge_chunks (parent_chunk_id)",
            [],
        )
        .map_err(|err| err.to_string())?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_asset_id ON knowledge_chunks (asset_id)",
            [],
        )
        .map_err(|err| err.to_string())?;

    crate::knowledge_pipeline::ensure_pipeline_schema(connection)?;
    ensure_knowledge_defaults(connection)?;

    Ok(())
}
