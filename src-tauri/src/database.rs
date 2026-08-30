use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Once;

use crate::knowledge_schema::{ensure_knowledge_defaults, ensure_knowledge_schema, table_has_column};
use crate::storage::{
    has_structured_chat_storage, read_kv, read_structured_app_value, save_structured_chat_storage,
    write_structured_app_value, KNOWLEDGE_MULTIMODAL_CONFIG_KEY,
};

/// 判断表/视图是否存在（表名来自代码常量，非用户输入，直接拼接安全）。
fn table_exists(connection: &Connection, name: &str) -> bool {
    let sql = format!(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = '{name}'"
    );
    connection.query_row(&sql, [], |_| Ok(())).is_ok()
}

/// 把旧版以“助手”命名的表与列迁移到“项目”命名，避免已有数据丢失。
/// 所有语句都做了容错：表/列不存在或已存在时静默跳过。
/// 关键点：改名前先确认「源表存在且目标表不存在」，否则 `assistants RENAME TO projects`
/// 会因 projects 已存在而反复打印 harmless 警告（每次打开连接都跑一次，刷屏）。
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

    if table_exists(connection, "assistants") && !table_exists(connection, "projects") {
        guarded("ALTER TABLE assistants RENAME TO projects");
    }
    if table_exists(connection, "assistant_presets") && !table_exists(connection, "project_presets") {
        guarded("ALTER TABLE assistant_presets RENAME TO project_presets");
    }
    if table_exists(connection, "assistant_memories") && !table_exists(connection, "project_memories") {
        guarded("ALTER TABLE assistant_memories RENAME TO project_memories");
    }
    guarded("ALTER TABLE project_memories RENAME COLUMN assistant_id TO project_id");
    guarded("ALTER TABLE session_summaries RENAME COLUMN assistant_id TO project_id");
    guarded("ALTER TABLE chat_sessions RENAME COLUMN assistant_id TO project_id");
    if table_exists(connection, "projects") && !table_has_column(connection, "projects", "workspace_path").unwrap_or(false) {
        guarded("ALTER TABLE projects ADD COLUMN workspace_path TEXT NOT NULL DEFAULT ''");
    }

    Ok(())
}

/// 首次打开连接时执行一次：建表 + 旧数据迁移 + 列补齐。幂等，可安全重复调用，
/// 但用 `Once` 包一层避免 worker 线程每 750ms 重开连接时反复空跑。
fn init_schema_once(connection: &Connection) -> Result<(), String> {
    migrate_legacy_project_data(connection)?;
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
    run_database_migrations(connection)?;
    ensure_storage_migrations(connection)?;
    ensure_knowledge_schema(connection)?;
    ensure_knowledge_defaults(connection)?;
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

    // 进程内只执行一次建表与迁移：worker 线程每 750ms 重开连接，
    // 若每次都重跑会持续刷屏 harmless 警告并做无用功。
    static SCHEMA_INIT: Once = Once::new();
    let mut init_error: Option<String> = None;
    SCHEMA_INIT.call_once(|| {
        if let Err(err) = init_schema_once(&connection) {
            init_error = Some(err);
        }
    });
    if let Some(err) = init_error {
        return Err(err);
    }

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
