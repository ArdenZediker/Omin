use rusqlite::Connection;
use std::path::PathBuf;

use crate::knowledge_schema::{ensure_knowledge_defaults, ensure_knowledge_schema};
use crate::storage::{
    has_structured_chat_storage, read_kv, read_structured_app_value, save_structured_chat_storage,
    write_structured_app_value, KNOWLEDGE_MULTIMODAL_CONFIG_KEY,
};

/// 把旧版以“助手”命名的表与列迁移到“项目”命名，避免已有数据丢失。
/// 所有语句都做了容错：表/列不存在或已存在时静默跳过。
pub(crate) fn migrate_legacy_project_data(connection: &Connection) -> Result<(), String> {
    let guarded = |sql: &str| {
        if let Err(err) = connection.execute_batch(sql) {
            let msg = err.to_string();
            let ignorable = msg.contains("no such table")
                || msg.contains("no such column")
                || msg.contains("already exists")
                || msg.contains("duplicate column");
            if !ignorable {
                eprintln!("[omni] project migration warning: {msg}");
            }
        }
    };

    guarded("ALTER TABLE assistants RENAME TO projects");
    guarded("ALTER TABLE assistant_presets RENAME TO project_presets");
    guarded("ALTER TABLE assistant_memories RENAME TO project_memories");
    guarded("ALTER TABLE project_memories RENAME COLUMN assistant_id TO project_id");
    guarded("ALTER TABLE session_summaries RENAME COLUMN assistant_id TO project_id");
    guarded("ALTER TABLE chat_sessions RENAME COLUMN assistant_id TO project_id");
    guarded("ALTER TABLE projects ADD COLUMN workspace_path TEXT NOT NULL DEFAULT ''");

    Ok(())
}

pub(crate) fn open_sqlite_connection(app: &tauri::AppHandle) -> Result<Connection, String> {
    let connection = Connection::open(sqlite_db_path(app)?).map_err(|err| err.to_string())?;
    connection
        .execute_batch(
            r#"
        PRAGMA busy_timeout = 2000;
        PRAGMA journal_mode = WAL;
        "#,
        )
        .map_err(|err| err.to_string())?;
    migrate_legacy_project_data(&connection)?;
    connection
        .execute_batch(
            r#"
        CREATE TABLE IF NOT EXISTS app_kv (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS window_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS provider_configs (
          provider TEXT PRIMARY KEY,
          api_key TEXT NOT NULL,
          base_url TEXT,
          name TEXT,
          custom_models_json TEXT,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS model_connection_status (
          model_id TEXT PRIMARY KEY,
          connected INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          source_preset_id TEXT,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          workspace_path TEXT NOT NULL DEFAULT '',
          system_prompt TEXT,
          default_model_id TEXT,
          allowed_tool_ids_json TEXT NOT NULL,
          allowed_skill_ids_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS project_presets (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          avatar_code TEXT,
          system_prompt TEXT,
          default_model_id TEXT,
          allowed_tool_ids_json TEXT NOT NULL,
          allowed_skill_ids_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tool_manifests (
          id TEXT PRIMARY KEY,
          payload_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS skill_manifests (
          id TEXT PRIMARY KEY,
          payload_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS project_memories (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          content TEXT NOT NULL,
          source_session_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS user_preferences (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS session_summaries (
          session_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS scheduled_tasks (
          id TEXT PRIMARY KEY,
          payload_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chat_sessions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          title TEXT NOT NULL,
          messages_json TEXT NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0,
          favorite INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          usage_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS knowledge_collections (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          retrieval_mode TEXT NOT NULL DEFAULT 'hybrid',
          embedding_profile_id TEXT,
          multimodal_config_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS knowledge_documents (
          id TEXT PRIMARY KEY,
          collection_id TEXT NOT NULL,
          source_name TEXT NOT NULL,
          source_path TEXT,
          stored_file_path TEXT,
          mime_type TEXT,
          file_extension TEXT,
          preview_type TEXT,
          content TEXT,
          content_preview TEXT NOT NULL,
          chunk_count INTEGER NOT NULL,
          tags_json TEXT NOT NULL,
          favorite INTEGER NOT NULL DEFAULT 0,
          access_count INTEGER NOT NULL DEFAULT 0,
          last_accessed_at INTEGER,
          title_hierarchy TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS knowledge_chunks (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL,
          collection_id TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          title TEXT,
          content TEXT NOT NULL,
          embedding_json TEXT,
          embedding_model_key TEXT,
          created_at INTEGER NOT NULL,
          UNIQUE(document_id, chunk_index)
        );
        "#,
        )
        .map_err(|err| err.to_string())?;
    run_database_migrations(&connection)?;
    ensure_storage_migrations(&connection)?;
    ensure_knowledge_schema(&connection)?;
    ensure_knowledge_defaults(&connection)?;
    Ok(connection)
}

fn sqlite_db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // 统一走 storage_paths：自定义目录 > 便携模式（exe 同级 data）> 默认 AppData。
    crate::storage_paths::database_path(app)
}

fn run_database_migrations(connection: &Connection) -> Result<(), String> {
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|err| err.to_string())?;

    if version < 1 {
        connection
            .execute_batch("PRAGMA user_version = 1;")
            .map_err(|err| err.to_string())?;
    }

    if version < 2 {
        connection
            .execute_batch("PRAGMA user_version = 2;")
            .map_err(|err| err.to_string())?;
    }

    if version < 3 {
        connection
            .execute_batch("PRAGMA user_version = 3;")
            .map_err(|err| err.to_string())?;
    }

    if version < 4 {
        connection
            .execute_batch("PRAGMA user_version = 4;")
            .map_err(|err| err.to_string())?;
    }

    Ok(())
}

fn migrate_legacy_chat_kv_to_structured(connection: &Connection) -> Result<(), String> {
    if has_structured_chat_storage(connection)? {
        return Ok(());
    }

    let projects_json = read_kv(connection, "chat_assistants")?;
    let sessions_json = read_kv(connection, "chat_sessions")?;

    if projects_json.is_none() && sessions_json.is_none() {
        return Ok(());
    }

    save_structured_chat_storage(
        connection,
        projects_json.as_deref().unwrap_or("[]"),
        sessions_json.as_deref().unwrap_or("[]"),
    )
}

fn migrate_legacy_app_kv_to_structured(connection: &Connection) -> Result<(), String> {
    let known_keys = [
        "omni_theme_mode",
        "omni_basic_settings",
        "omni_main_view",
        "omni_compact_position",
        "omni_main_position",
        "omni_provider_configs",
        "omni_current_model",
        "omni_model_connection_status",
        "omni_compact_appearance",
        "omni_character_scale",
        "omni_character_model",
        KNOWLEDGE_MULTIMODAL_CONFIG_KEY,
    ];

    for key in known_keys {
        if read_structured_app_value(connection, key)?.is_some() {
            continue;
        }
        if let Some(value) = read_kv(connection, key)? {
            write_structured_app_value(connection, key, &value)?;
        }
    }

    Ok(())
}

fn ensure_storage_migrations(connection: &Connection) -> Result<(), String> {
    migrate_legacy_chat_kv_to_structured(connection)?;
    migrate_legacy_app_kv_to_structured(connection)?;
    Ok(())
}
