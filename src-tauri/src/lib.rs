use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::{
    fs,
    path::{Component, Path, PathBuf},
    collections::HashMap,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

#[derive(Serialize)]
struct WorkspaceFileEntry {
    path: String,
    is_dir: bool,
}

#[derive(Serialize)]
struct WorkspaceSearchMatch {
    path: String,
    line_number: usize,
    line_preview: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatStoragePayload {
    assistants_json: Option<String>,
    sessions_json: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestStoragePayload {
    assistant_presets_json: Option<String>,
    tool_manifests_json: Option<String>,
    skill_manifests_json: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryStoragePayload {
    assistant_memories_json: Option<String>,
    user_preferences_json: Option<String>,
    session_summaries_json: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AutomationStoragePayload {
    scheduled_tasks_json: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppStoragePayload {
    entries: HashMap<String, String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DbAssistantProfile {
    id: String,
    kind: String,
    source_preset_id: Option<String>,
    title: String,
    description: String,
    system_prompt: Option<String>,
    default_model_id: Option<String>,
    allowed_tool_ids: Vec<String>,
    allowed_skill_ids: Vec<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DbChatUsageStats {
    request_count: i64,
    prompt_tokens: i64,
    completion_tokens: i64,
    total_tokens: i64,
    total_cost_usd: f64,
    last_model: Option<String>,
    last_used_at: Option<i64>,
    has_estimated_usage: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DbChatSession {
    id: String,
    assistant_id: String,
    title: String,
    messages: serde_json::Value,
    pinned: Option<bool>,
    favorite: Option<bool>,
    created_at: i64,
    updated_at: i64,
    usage: DbChatUsageStats,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DbAssistantPresetRecord {
    id: String,
    title: String,
    description: String,
    avatar_code: Option<String>,
    system_prompt: Option<String>,
    default_model_id: Option<String>,
    allowed_tool_ids: Vec<String>,
    allowed_skill_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DbProviderConfigRecord {
    api_key: String,
    base_url: Option<String>,
    name: Option<String>,
    custom_models: Option<JsonValue>,
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("你好，{}！欢迎使用 Omni AI 助手！", name)
}

fn workspace_root() -> Result<PathBuf, String> {
    std::env::current_dir().map_err(|err| err.to_string())
}

fn current_timestamp_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
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

    Ok(())
}

fn sqlite_db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|err| err.to_string())?;
    Ok(app_data_dir.join("omni.sqlite3"))
}

fn open_sqlite_connection(app: &tauri::AppHandle) -> Result<Connection, String> {
    let connection = Connection::open(sqlite_db_path(app)?).map_err(|err| err.to_string())?;
    connection.execute_batch(
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

        CREATE TABLE IF NOT EXISTS assistants (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          source_preset_id TEXT,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          system_prompt TEXT,
          default_model_id TEXT,
          allowed_tool_ids_json TEXT NOT NULL,
          allowed_skill_ids_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS assistant_presets (
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

        CREATE TABLE IF NOT EXISTS assistant_memories (
          id TEXT PRIMARY KEY,
          assistant_id TEXT NOT NULL,
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
          assistant_id TEXT NOT NULL,
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
          assistant_id TEXT NOT NULL,
          title TEXT NOT NULL,
          messages_json TEXT NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0,
          favorite INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          usage_json TEXT NOT NULL
        );
        "#,
    ).map_err(|err| err.to_string())?;
    run_database_migrations(&connection)?;
    ensure_storage_migrations(&connection)?;
    Ok(connection)
}

fn read_kv(connection: &Connection, key: &str) -> Result<Option<String>, String> {
    connection
        .query_row("SELECT value FROM app_kv WHERE key = ?1", params![key], |row| row.get(0))
        .optional()
        .map_err(|err| err.to_string())
}

fn is_window_state_key(key: &str) -> bool {
    matches!(key, "omni_main_view" | "omni_compact_position" | "omni_main_position")
}

fn is_provider_config_key(key: &str) -> bool {
    key == "omni_provider_configs"
}

fn is_model_connection_status_key(key: &str) -> bool {
    key == "omni_model_connection_status"
}

fn read_simple_table_value(connection: &Connection, table: &str, key: &str) -> Result<Option<String>, String> {
    let sql = format!("SELECT value FROM {table} WHERE key = ?1");
    connection
        .query_row(&sql, params![key], |row| row.get(0))
        .optional()
        .map_err(|err| err.to_string())
}

fn write_simple_table_value(connection: &Connection, table: &str, key: &str, value: &str) -> Result<(), String> {
    let sql = format!(
        r#"
        INSERT INTO {table} (key, value, updated_at)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
        "#
    );

    connection
        .execute(&sql, params![key, value, current_timestamp_ms()])
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn remove_simple_table_value(connection: &Connection, table: &str, key: &str) -> Result<(), String> {
    let sql = format!("DELETE FROM {table} WHERE key = ?1");
    connection
        .execute(&sql, params![key])
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn read_provider_configs_value(connection: &Connection) -> Result<Option<String>, String> {
    let mut stmt = connection
        .prepare(
            r#"
            SELECT provider, api_key, base_url, name, custom_models_json
            FROM provider_configs
            ORDER BY provider ASC
            "#,
        )
        .map_err(|err| err.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    if rows.is_empty() {
        return Ok(None);
    }

    let mut result = JsonMap::new();
    for (provider, api_key, base_url, name, custom_models_json) in rows {
        let mut item = JsonMap::new();
        item.insert("apiKey".into(), JsonValue::String(api_key));
        if let Some(base_url) = base_url {
            item.insert("baseUrl".into(), JsonValue::String(base_url));
        }
        if let Some(name) = name {
            item.insert("name".into(), JsonValue::String(name));
        }
        if let Some(custom_models_json) = custom_models_json {
            let parsed = serde_json::from_str::<JsonValue>(&custom_models_json).unwrap_or(JsonValue::Array(Vec::new()));
            item.insert("customModels".into(), parsed);
        }
        result.insert(provider, JsonValue::Object(item));
    }

    Ok(Some(serde_json::to_string(&JsonValue::Object(result)).map_err(|err| err.to_string())?))
}

fn write_provider_configs_value(connection: &Connection, value: &str) -> Result<(), String> {
    let parsed: JsonMap<String, JsonValue> = serde_json::from_str(value).map_err(|err| err.to_string())?;
    let tx = connection.unchecked_transaction().map_err(|err| err.to_string())?;
    tx.execute("DELETE FROM provider_configs", []).map_err(|err| err.to_string())?;

    {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO provider_configs (provider, api_key, base_url, name, custom_models_json, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                "#,
            )
            .map_err(|err| err.to_string())?;

        for (provider, item) in parsed {
            let record: DbProviderConfigRecord = serde_json::from_value(item).map_err(|err| err.to_string())?;
            stmt.execute(params![
                provider,
                record.api_key,
                record.base_url,
                record.name,
                record.custom_models.map(|value| serde_json::to_string(&value)).transpose().map_err(|err| err.to_string())?,
                current_timestamp_ms(),
            ])
            .map_err(|err| err.to_string())?;
        }
    }

    tx.commit().map_err(|err| err.to_string())?;
    Ok(())
}

fn remove_provider_configs_value(connection: &Connection) -> Result<(), String> {
    connection
        .execute("DELETE FROM provider_configs", [])
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn read_model_connection_status_value(connection: &Connection) -> Result<Option<String>, String> {
    let mut stmt = connection
        .prepare("SELECT model_id, connected FROM model_connection_status ORDER BY model_id ASC")
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0)))
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    if rows.is_empty() {
        return Ok(None);
    }

    let mut result = JsonMap::new();
    for (model_id, connected) in rows {
        result.insert(model_id, JsonValue::Bool(connected));
    }

    Ok(Some(serde_json::to_string(&JsonValue::Object(result)).map_err(|err| err.to_string())?))
}

fn write_model_connection_status_value(connection: &Connection, value: &str) -> Result<(), String> {
    let parsed: HashMap<String, bool> = serde_json::from_str(value).map_err(|err| err.to_string())?;
    let tx = connection.unchecked_transaction().map_err(|err| err.to_string())?;
    tx.execute("DELETE FROM model_connection_status", []).map_err(|err| err.to_string())?;

    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO model_connection_status (model_id, connected, updated_at) VALUES (?1, ?2, ?3)",
            )
            .map_err(|err| err.to_string())?;

        for (model_id, connected) in parsed {
            stmt.execute(params![model_id, if connected { 1_i64 } else { 0_i64 }, current_timestamp_ms()])
                .map_err(|err| err.to_string())?;
        }
    }

    tx.commit().map_err(|err| err.to_string())?;
    Ok(())
}

fn remove_model_connection_status_value(connection: &Connection) -> Result<(), String> {
    connection
        .execute("DELETE FROM model_connection_status", [])
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn read_structured_app_value(connection: &Connection, key: &str) -> Result<Option<String>, String> {
    if is_provider_config_key(key) {
        return read_provider_configs_value(connection);
    }
    if is_model_connection_status_key(key) {
        return read_model_connection_status_value(connection);
    }
    if is_window_state_key(key) {
        return read_simple_table_value(connection, "window_state", key);
    }
    read_simple_table_value(connection, "app_settings", key)
}

fn write_structured_app_value(connection: &Connection, key: &str, value: &str) -> Result<(), String> {
    if is_provider_config_key(key) {
        return write_provider_configs_value(connection, value);
    }
    if is_model_connection_status_key(key) {
        return write_model_connection_status_value(connection, value);
    }
    if is_window_state_key(key) {
        return write_simple_table_value(connection, "window_state", key, value);
    }
    write_simple_table_value(connection, "app_settings", key, value)
}

fn remove_structured_app_value(connection: &Connection, key: &str) -> Result<(), String> {
    if is_provider_config_key(key) {
        return remove_provider_configs_value(connection);
    }
    if is_model_connection_status_key(key) {
        return remove_model_connection_status_value(connection);
    }
    if is_window_state_key(key) {
        return remove_simple_table_value(connection, "window_state", key);
    }
    remove_simple_table_value(connection, "app_settings", key)
}

fn has_structured_chat_storage(connection: &Connection) -> Result<bool, String> {
    let assistant_count: i64 = connection
        .query_row("SELECT COUNT(1) FROM assistants", [], |row| row.get(0))
        .map_err(|err| err.to_string())?;
    let session_count: i64 = connection
        .query_row("SELECT COUNT(1) FROM chat_sessions", [], |row| row.get(0))
        .map_err(|err| err.to_string())?;
    Ok(assistant_count > 0 || session_count > 0)
}

fn load_structured_chat_storage(connection: &Connection) -> Result<ChatStoragePayload, String> {
    let mut assistant_stmt = connection
        .prepare(
            r#"
            SELECT id, kind, title, description, system_prompt, default_model_id, allowed_tool_ids_json, allowed_skill_ids_json, created_at, updated_at
            SELECT id, kind, source_preset_id, title, description, system_prompt, default_model_id, allowed_tool_ids_json, allowed_skill_ids_json, created_at, updated_at
            FROM assistants
            ORDER BY created_at ASC, id ASC
            "#,
        )
        .map_err(|err| err.to_string())?;

    let assistants = assistant_stmt
        .query_map([], |row| {
            let allowed_tool_ids_json: String = row.get(7)?;
            let allowed_skill_ids_json: String = row.get(8)?;

            Ok(DbAssistantProfile {
                id: row.get(0)?,
                kind: row.get(1)?,
                source_preset_id: row.get(2)?,
                title: row.get(3)?,
                description: row.get(4)?,
                system_prompt: row.get(5)?,
                default_model_id: row.get(6)?,
                allowed_tool_ids: serde_json::from_str(&allowed_tool_ids_json).unwrap_or_default(),
                allowed_skill_ids: serde_json::from_str(&allowed_skill_ids_json).unwrap_or_default(),
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
            })
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    let mut session_stmt = connection
        .prepare(
            r#"
            SELECT id, assistant_id, title, messages_json, pinned, favorite, created_at, updated_at, usage_json
            FROM chat_sessions
            ORDER BY updated_at DESC, created_at DESC, id DESC
            "#,
        )
        .map_err(|err| err.to_string())?;

    let sessions = session_stmt
        .query_map([], |row| {
            let messages_json: String = row.get(3)?;
            let usage_json: String = row.get(8)?;

            Ok(DbChatSession {
                id: row.get(0)?,
                assistant_id: row.get(1)?,
                title: row.get(2)?,
                messages: serde_json::from_str(&messages_json).unwrap_or_else(|_| serde_json::Value::Array(Vec::new())),
                pinned: Some(row.get::<_, i64>(4)? != 0),
                favorite: Some(row.get::<_, i64>(5)? != 0),
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
                usage: serde_json::from_str(&usage_json).unwrap_or(DbChatUsageStats {
                    request_count: 0,
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0,
                    total_cost_usd: 0.0,
                    last_model: None,
                    last_used_at: None,
                    has_estimated_usage: false,
                }),
            })
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    Ok(ChatStoragePayload {
        assistants_json: Some(serde_json::to_string(&assistants).map_err(|err| err.to_string())?),
        sessions_json: Some(serde_json::to_string(&sessions).map_err(|err| err.to_string())?),
    })
}

fn save_structured_chat_storage(
    connection: &Connection,
    assistants_json: &str,
    sessions_json: &str,
) -> Result<(), String> {
    let assistants: Vec<DbAssistantProfile> = serde_json::from_str(assistants_json).map_err(|err| err.to_string())?;
    let sessions: Vec<DbChatSession> = serde_json::from_str(sessions_json).map_err(|err| err.to_string())?;

    let tx = connection.unchecked_transaction().map_err(|err| err.to_string())?;
    tx.execute("DELETE FROM assistants", []).map_err(|err| err.to_string())?;
    tx.execute("DELETE FROM chat_sessions", []).map_err(|err| err.to_string())?;

    {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO assistants (
                  id, kind, source_preset_id, title, description, system_prompt, default_model_id,
                  allowed_tool_ids_json, allowed_skill_ids_json, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                "#,
            )
            .map_err(|err| err.to_string())?;

        for assistant in assistants {
            stmt.execute(params![
                assistant.id,
                assistant.kind,
                assistant.source_preset_id,
                assistant.title,
                assistant.description,
                assistant.system_prompt,
                assistant.default_model_id,
                serde_json::to_string(&assistant.allowed_tool_ids).map_err(|err| err.to_string())?,
                serde_json::to_string(&assistant.allowed_skill_ids).map_err(|err| err.to_string())?,
                assistant.created_at,
                assistant.updated_at,
            ])
            .map_err(|err| err.to_string())?;
        }
    }

    {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO chat_sessions (
                  id, assistant_id, title, messages_json, pinned, favorite, created_at, updated_at, usage_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                "#,
            )
            .map_err(|err| err.to_string())?;

        for session in sessions {
            stmt.execute(params![
                session.id,
                session.assistant_id,
                session.title,
                serde_json::to_string(&session.messages).map_err(|err| err.to_string())?,
                if session.pinned.unwrap_or(false) { 1_i64 } else { 0_i64 },
                if session.favorite.unwrap_or(false) { 1_i64 } else { 0_i64 },
                session.created_at,
                session.updated_at,
                serde_json::to_string(&session.usage).map_err(|err| err.to_string())?,
            ])
            .map_err(|err| err.to_string())?;
        }
    }

    tx.commit().map_err(|err| err.to_string())?;
    Ok(())
}

fn load_manifest_storage(connection: &Connection) -> Result<ManifestStoragePayload, String> {
    let assistant_presets_json = read_simple_table_value(connection, "assistant_presets", "builtin")?;
    let tool_manifests_json = read_simple_table_value(connection, "tool_manifests", "builtin")?;
    let skill_manifests_json = read_simple_table_value(connection, "skill_manifests", "builtin")?;

    Ok(ManifestStoragePayload {
        assistant_presets_json,
        tool_manifests_json,
        skill_manifests_json,
    })
}

fn save_manifest_storage(
    connection: &Connection,
    assistant_presets_json: Option<&str>,
    tool_manifests_json: Option<&str>,
    skill_manifests_json: Option<&str>,
) -> Result<(), String> {
    if let Some(value) = assistant_presets_json {
        write_simple_table_value(connection, "assistant_presets", "builtin", value)?;
    }
    if let Some(value) = tool_manifests_json {
        write_simple_table_value(connection, "tool_manifests", "builtin", value)?;
    }
    if let Some(value) = skill_manifests_json {
        write_simple_table_value(connection, "skill_manifests", "builtin", value)?;
    }
    Ok(())
}

fn load_memory_storage(connection: &Connection) -> Result<MemoryStoragePayload, String> {
    let assistant_memories_json = read_simple_table_value(connection, "assistant_memories", "builtin")?;
    let user_preferences_json = read_simple_table_value(connection, "user_preferences", "builtin")?;
    let session_summaries_json = read_simple_table_value(connection, "session_summaries", "builtin")?;

    Ok(MemoryStoragePayload {
        assistant_memories_json,
        user_preferences_json,
        session_summaries_json,
    })
}

fn save_memory_storage(
    connection: &Connection,
    assistant_memories_json: Option<&str>,
    user_preferences_json: Option<&str>,
    session_summaries_json: Option<&str>,
) -> Result<(), String> {
    if let Some(value) = assistant_memories_json {
        write_simple_table_value(connection, "assistant_memories", "builtin", value)?;
    }
    if let Some(value) = user_preferences_json {
        write_simple_table_value(connection, "user_preferences", "builtin", value)?;
    }
    if let Some(value) = session_summaries_json {
        write_simple_table_value(connection, "session_summaries", "builtin", value)?;
    }
    Ok(())
}

fn load_automation_storage(connection: &Connection) -> Result<AutomationStoragePayload, String> {
    let scheduled_tasks_json = read_simple_table_value(connection, "scheduled_tasks", "builtin")?;
    Ok(AutomationStoragePayload { scheduled_tasks_json })
}

fn save_automation_storage(connection: &Connection, scheduled_tasks_json: Option<&str>) -> Result<(), String> {
    if let Some(value) = scheduled_tasks_json {
        write_simple_table_value(connection, "scheduled_tasks", "builtin", value)?;
    }
    Ok(())
}

fn migrate_legacy_chat_kv_to_structured(connection: &Connection) -> Result<(), String> {
    if has_structured_chat_storage(connection)? {
        return Ok(());
    }

    let assistants_json = read_kv(connection, "chat_assistants")?;
    let sessions_json = read_kv(connection, "chat_sessions")?;

    if assistants_json.is_none() && sessions_json.is_none() {
        return Ok(());
    }

    save_structured_chat_storage(
        connection,
        assistants_json.as_deref().unwrap_or("[]"),
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

fn normalize_relative_path(input: &str) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(input);
    if candidate.is_absolute() {
        return Err("Only relative workspace paths are allowed".into());
    }

    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => normalized.push(part),
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err("Path escapes workspace root".into());
                }
            }
            _ => return Err("Unsupported path component".into()),
        }
    }

    Ok(normalized)
}

fn collect_workspace_files(
    root: &Path,
    current: &Path,
    query: &str,
    limit: usize,
    acc: &mut Vec<WorkspaceFileEntry>,
) -> Result<(), String> {
    if acc.len() >= limit {
        return Ok(());
    }

    let entries = fs::read_dir(current).map_err(|err| err.to_string())?;
    for entry in entries {
        if acc.len() >= limit {
            break;
        }

        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.starts_with(".git") || file_name == "node_modules" || file_name == "dist" {
            continue;
        }

        let metadata = entry.metadata().map_err(|err| err.to_string())?;
        let relative = path
            .strip_prefix(root)
            .map_err(|err| err.to_string())?
            .to_string_lossy()
            .replace('\\', "/");

        if query.is_empty() || relative.to_lowercase().contains(query) {
            acc.push(WorkspaceFileEntry {
                path: relative.clone(),
                is_dir: metadata.is_dir(),
            });
        }

        if metadata.is_dir() {
            collect_workspace_files(root, &path, query, limit, acc)?;
        }
    }

    Ok(())
}

fn collect_workspace_matches(
    root: &Path,
    current: &Path,
    query: &str,
    limit: usize,
    acc: &mut Vec<WorkspaceSearchMatch>,
) -> Result<(), String> {
    if acc.len() >= limit {
        return Ok(());
    }

    let entries = fs::read_dir(current).map_err(|err| err.to_string())?;
    for entry in entries {
        if acc.len() >= limit {
            break;
        }

        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.starts_with(".git") || file_name == "node_modules" || file_name == "dist" {
            continue;
        }

        let metadata = entry.metadata().map_err(|err| err.to_string())?;
        if metadata.is_dir() {
            collect_workspace_matches(root, &path, query, limit, acc)?;
            continue;
        }

        let relative = path
            .strip_prefix(root)
            .map_err(|err| err.to_string())?
            .to_string_lossy()
            .replace('\\', "/");

        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        let content = String::from_utf8_lossy(&bytes);

        for (index, line) in content.lines().enumerate() {
            if acc.len() >= limit {
                break;
            }

            if line.to_lowercase().contains(query) {
                let preview = if line.chars().count() > 160 {
                    let clipped: String = line.chars().take(157).collect();
                    format!("{clipped}...")
                } else {
                    line.to_string()
                };

                acc.push(WorkspaceSearchMatch {
                    path: relative.clone(),
                    line_number: index + 1,
                    line_preview: preview,
                });
            }
        }
    }

    Ok(())
}

#[tauri::command]
fn list_workspace_files(query: Option<String>, limit: Option<usize>) -> Result<Vec<WorkspaceFileEntry>, String> {
    let root = workspace_root()?;
    let normalized_query = query.unwrap_or_default().trim().to_lowercase();
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let mut results = Vec::new();
    collect_workspace_files(&root, &root, &normalized_query, limit, &mut results)?;
    Ok(results)
}

#[tauri::command]
fn read_workspace_file(path: String, max_chars: Option<usize>) -> Result<String, String> {
    let root = workspace_root()?;
    let relative = normalize_relative_path(&path)?;
    let full_path = root.join(relative);

    if !full_path.exists() {
        return Err(format!("File not found: {path}"));
    }
    if full_path.is_dir() {
        return Err(format!("Path is a directory: {path}"));
    }

    let bytes = fs::read(&full_path).map_err(|err| err.to_string())?;
    let content = String::from_utf8_lossy(&bytes).into_owned();
    let max_chars = max_chars.unwrap_or(8000).clamp(200, 20000);

    if content.chars().count() > max_chars {
        let preview: String = content.chars().take(max_chars).collect();
        return Ok(format!("{preview}\n\n[truncated]"));
    }

    Ok(content)
}

#[tauri::command]
fn search_workspace_files(query: String, limit: Option<usize>) -> Result<Vec<WorkspaceSearchMatch>, String> {
    let normalized_query = query.trim().to_lowercase();
    if normalized_query.is_empty() {
        return Err("Query cannot be empty".into());
    }

    let root = workspace_root()?;
    let limit = limit.unwrap_or(50).clamp(1, 200);
    let mut results = Vec::new();
    collect_workspace_matches(&root, &root, &normalized_query, limit, &mut results)?;
    Ok(results)
}

#[tauri::command]
fn load_chat_storage(
    app: tauri::AppHandle,
    legacy_assistants_json: Option<String>,
    legacy_sessions_json: Option<String>,
) -> Result<ChatStoragePayload, String> {
    let connection = open_sqlite_connection(&app)?;

    if has_structured_chat_storage(&connection)? {
        return load_structured_chat_storage(&connection);
    }

    let payload = ChatStoragePayload {
        assistants_json: legacy_assistants_json.filter(|value| !value.trim().is_empty()),
        sessions_json: legacy_sessions_json.filter(|value| !value.trim().is_empty()),
    };

    if payload.assistants_json.is_some() || payload.sessions_json.is_some() {
        save_structured_chat_storage(
            &connection,
            payload.assistants_json.as_deref().unwrap_or("[]"),
            payload.sessions_json.as_deref().unwrap_or("[]"),
        )?;
        return load_structured_chat_storage(&connection);
    }

    Ok(payload)
}

#[tauri::command]
fn save_chat_storage(
    app: tauri::AppHandle,
    assistants_json: String,
    sessions_json: String,
) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    save_structured_chat_storage(&connection, &assistants_json, &sessions_json)?;
    Ok(())
}

#[tauri::command]
fn load_manifest_storage_command(app: tauri::AppHandle) -> Result<ManifestStoragePayload, String> {
    let connection = open_sqlite_connection(&app)?;
    load_manifest_storage(&connection)
}

#[tauri::command]
fn save_manifest_storage_command(
    app: tauri::AppHandle,
    assistant_presets_json: Option<String>,
    tool_manifests_json: Option<String>,
    skill_manifests_json: Option<String>,
) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    save_manifest_storage(
        &connection,
        assistant_presets_json.as_deref(),
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
    assistant_memories_json: Option<String>,
    user_preferences_json: Option<String>,
    session_summaries_json: Option<String>,
) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    save_memory_storage(
        &connection,
        assistant_memories_json.as_deref(),
        user_preferences_json.as_deref(),
        session_summaries_json.as_deref(),
    )
}

#[tauri::command]
fn load_automation_storage_command(app: tauri::AppHandle) -> Result<AutomationStoragePayload, String> {
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
            if let Some(legacy_value) = legacy_entries.get(&key).filter(|value| !value.trim().is_empty()) {
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

fn toggle_main_window_visibility(app: &tauri::AppHandle) {
    let compact_window = app.get_webview_window("compact");
    let main_window = app.get_webview_window("main");

    if let Some(window) = compact_window.as_ref() {
        if window.is_visible().unwrap_or(false) {
            let _ = window.set_focus();
            return;
        }

        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    if let Some(window) = main_window.as_ref() {
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
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed
                        && (shortcut.to_string() == "Alt+Space" || shortcut.to_string() == "Ctrl+Space")
                    {
                        toggle_main_window_visibility(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            greet,
            list_workspace_files,
            read_workspace_file,
            search_workspace_files,
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
            remove_app_kv
        ])
        .setup(|app| {
            use tauri_plugin_global_shortcut::GlobalShortcutExt;

            let show_hide = MenuItemBuilder::with_id("toggle", "显示 / 隐藏").build(app)?;
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
                            toggle_main_window_visibility(&tray.app_handle());
                        }
                    })
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "toggle" => toggle_main_window_visibility(app),
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .build(app)?;
            } else {
                eprintln!("[Omni] 托盘图标不可用，已跳过托盘初始化");
            }

            let alt_shortcut = tauri_plugin_global_shortcut::Shortcut::new(
                Some(tauri_plugin_global_shortcut::Modifiers::ALT),
                tauri_plugin_global_shortcut::Code::Space,
            );
            let ctrl_shortcut = tauri_plugin_global_shortcut::Shortcut::new(
                Some(tauri_plugin_global_shortcut::Modifiers::CONTROL),
                tauri_plugin_global_shortcut::Code::Space,
            );

            if app.global_shortcut().register(alt_shortcut).is_ok() {
                eprintln!("[Omni] 已注册全局快捷键 Alt+Space");
            } else if app.global_shortcut().register(ctrl_shortcut).is_ok() {
                eprintln!("[Omni] Alt+Space 不可用，已回退到 Ctrl+Space");
            } else {
                eprintln!("[Omni] Alt+Space 和 Ctrl+Space 都注册失败");
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("运行 Omni 时发生错误");
}
