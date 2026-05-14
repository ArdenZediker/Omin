use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::{
    cmp::Ordering,
    fs,
    path::{Component, Path, PathBuf},
    collections::HashMap,
    time::{SystemTime, UNIX_EPOCH},
};
use reqwest::blocking::Client as BlockingHttpClient;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter,
    Manager,
};

mod knowledge_chunker;

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

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DbProviderConfigRecord {
    api_key: String,
    base_url: Option<String>,
    name: Option<String>,
    custom_models: Option<JsonValue>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeCollectionRecord {
    id: String,
    name: String,
    description: String,
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
    chunk_count: i64,
    tags: Vec<String>,
    favorite: bool,
    access_count: i64,
    last_accessed_at: Option<i64>,
    title_hierarchy: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeChunkRecord {
    id: String,
    document_id: String,
    collection_id: String,
    chunk_index: i64,
    title: Option<String>,
    content: String,
    embedding_json: Option<String>,
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
struct SearchKnowledgeChunksInput {
    query: String,
    limit: Option<usize>,
    collection_id: Option<String>,
    query_embedding: Option<Vec<f64>>,
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

fn workspace_root() -> Result<PathBuf, String> {
    std::env::current_dir().map_err(|err| err.to_string())
}

fn current_timestamp_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn knowledge_files_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    let root = app_data_dir.join("knowledge_files");
    fs::create_dir_all(&root).map_err(|err| err.to_string())?;
    Ok(root)
}

fn sanitize_storage_file_name(value: &str) -> String {
    let mut cleaned = value
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ if ch.is_control() => '_',
            _ => ch,
        })
        .collect::<String>();
    cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.is_empty() {
        "document".to_string()
    } else {
        cleaned
    }
}

fn file_extension_from_name(value: &str) -> Option<String> {
    Path::new(value)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.trim().to_lowercase())
        .filter(|ext| !ext.is_empty())
}

fn normalize_file_extension(extension: Option<String>, source_name: &str) -> Option<String> {
    extension
        .and_then(|value| {
            let trimmed = value.trim().trim_start_matches('.').to_lowercase();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        })
        .or_else(|| file_extension_from_name(source_name))
}

fn infer_preview_type(extension: Option<&str>, mime_type: Option<&str>) -> String {
    let extension = extension.unwrap_or_default().to_lowercase();
    let mime_type = mime_type.unwrap_or_default().to_lowercase();

    if matches!(
        extension.as_str(),
        "md" | "markdown" | "txt" | "log" | "json" | "csv" | "tsv" | "html" | "htm" | "xml" | "yml" | "yaml" | "js" | "jsx" | "ts" | "tsx" | "py" | "rs" | "css" | "toml" | "ini" | "sql" | "sh" | "bat" | "cmd"
    ) || mime_type.starts_with("text/")
        || mime_type == "application/json"
    {
        return if extension == "md" || extension == "markdown" {
            "markdown".to_string()
        } else {
            "text".to_string()
        };
    }

    if matches!(extension.as_str(), "pdf") || mime_type == "application/pdf" {
        return "pdf".to_string();
    }

    if matches!(extension.as_str(), "docx") || mime_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document" {
        return "docx".to_string();
    }

    if matches!(
        extension.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "avif" | "ico"
    ) || mime_type.starts_with("image/")
    {
        return "image".to_string();
    }

    if matches!(extension.as_str(), "doc" | "rtf") {
        return "unsupported".to_string();
    }

    "unsupported".to_string()
}

fn document_file_name(source_name: &str, document_id: &str) -> String {
    let base = sanitize_storage_file_name(source_name);
    if base == "document" {
        format!("{document_id}.bin")
    } else {
        base
    }
}

fn store_knowledge_document_bytes(
    app: &tauri::AppHandle,
    collection_id: &str,
    document_id: &str,
    source_name: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    let collection_dir = sanitize_storage_file_name(collection_id);
    let document_dir = sanitize_storage_file_name(document_id);
    let file_name = document_file_name(source_name, document_id);
    let stored_path = knowledge_files_root(app)?
        .join(collection_dir)
        .join(document_dir)
        .join(file_name);
    if let Some(parent) = stored_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(&stored_path, bytes).map_err(|err| err.to_string())?;
    Ok(stored_path)
}

fn delete_stored_document_file(path: Option<&str>) {
    let Some(path) = path else {
        return;
    };

    let stored_path = PathBuf::from(path);
    if stored_path.is_file() {
        let _ = fs::remove_file(&stored_path);
    }

    fn remove_if_empty(path: &Path) {
        if !path.is_dir() {
            return;
        }

        let is_empty = fs::read_dir(path)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);
        if is_empty {
            let _ = fs::remove_dir(path);
        }
    }

    if let Some(document_dir) = stored_path.parent() {
        remove_if_empty(document_dir);
        if let Some(collection_dir) = document_dir.parent() {
            remove_if_empty(collection_dir);
        }
    }
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

        CREATE TABLE IF NOT EXISTS knowledge_collections (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
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
          created_at INTEGER NOT NULL,
          UNIQUE(document_id, chunk_index)
        );
        "#,
    ).map_err(|err| err.to_string())?;
    run_database_migrations(&connection)?;
    ensure_storage_migrations(&connection)?;
    ensure_knowledge_schema(&connection)?;
    ensure_knowledge_defaults(&connection)?;
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

fn ensure_knowledge_defaults(connection: &Connection) -> Result<(), String> {
    let now = current_timestamp_ms();
    connection
        .execute(
            r#"
            INSERT OR IGNORE INTO knowledge_collections (
              id, name, description, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5)
            "#,
            params![
                "default",
                "默认知识库",
                "用于存放上传文件和导入内容",
                now,
                now
            ],
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn normalize_knowledge_collection_id(value: Option<String>) -> String {
    value
        .unwrap_or_default()
        .trim()
        .to_string()
        .if_empty_then("default")
}

const OPENAI_COMPATIBLE_EMBEDDING_PROVIDERS: [&str; 6] = [
    "openai",
    "openrouter",
    "moonshot",
    "siliconflow",
    "dashscope",
    "zhipu",
];

const EMBEDDING_PROVIDER_PRIORITY: [&str; 6] = [
    "openai",
    "openrouter",
    "moonshot",
    "siliconflow",
    "dashscope",
    "zhipu",
];

const DEFAULT_EMBEDDING_MODEL: &str = "text-embedding-3-small";

fn provider_supports_embeddings(provider: &str) -> bool {
    OPENAI_COMPATIBLE_EMBEDDING_PROVIDERS.contains(&provider)
}

fn load_provider_config_map(connection: &Connection) -> Result<HashMap<String, DbProviderConfigRecord>, String> {
    let raw = read_structured_app_value(connection, "omni_provider_configs")?;
    match raw {
        Some(value) => serde_json::from_str(&value).map_err(|err| err.to_string()),
        None => Ok(HashMap::new()),
    }
}

fn provider_for_model_id(model_id: &str, configs: &HashMap<String, DbProviderConfigRecord>) -> Option<String> {
    let trimmed = model_id.trim();
    if trimmed.is_empty() {
        return None;
    }

    for (provider, config) in configs {
        if let Some(custom_models) = config.custom_models.as_ref().and_then(|value| value.as_array()) {
            for model in custom_models {
                let matches_id = model.get("id").and_then(|value| value.as_str()) == Some(trimmed);
                let matches_request_model =
                    model.get("requestModelId").and_then(|value| value.as_str()) == Some(trimmed);
                if matches_id || matches_request_model {
                    return Some(provider.clone());
                }
            }
        }
    }

    if trimmed.starts_with("openai/") || trimmed.starts_with("anthropic/") || trimmed.starts_with("google/") {
        return Some("openrouter".to_string());
    }
    if trimmed.starts_with("moonshot-v1-") {
        return Some("moonshot".to_string());
    }
    if trimmed.starts_with("deepseek-ai/") || trimmed.starts_with("Qwen/") {
        return Some("siliconflow".to_string());
    }
    if trimmed.starts_with("qwen-") {
        return Some("dashscope".to_string());
    }
    if trimmed.starts_with("glm-") {
        return Some("zhipu".to_string());
    }

    match trimmed {
        "gpt-4o" | "gpt-4o-mini" | "o1" | "o3-mini" => Some("openai".to_string()),
        value if value.starts_with("claude-") => Some("claude".to_string()),
        value if value.starts_with("gemini-") => Some("gemini".to_string()),
        "llama3" | "llava" => Some("ollama".to_string()),
        value if value.starts_with("deepseek-") => Some("deepseek".to_string()),
        _ => None,
    }
}

fn resolve_embedding_provider(
    connection: &Connection,
) -> Result<Option<(String, DbProviderConfigRecord)>, String> {
    let current_model = read_structured_app_value(connection, "omni_current_model")?.unwrap_or_default();
    let configs = load_provider_config_map(connection)?;
    let mut ordered_candidates: Vec<String> = Vec::new();

    if let Some(provider) = provider_for_model_id(&current_model, &configs) {
        ordered_candidates.push(provider);
    }

    for provider in EMBEDDING_PROVIDER_PRIORITY {
        if !ordered_candidates.iter().any(|item| item == provider) {
            ordered_candidates.push(provider.to_string());
        }
    }

    for provider in configs.keys() {
        if !ordered_candidates.iter().any(|item| item == provider) {
            ordered_candidates.push(provider.clone());
        }
    }

    for provider in ordered_candidates {
        if !provider_supports_embeddings(&provider) {
            continue;
        }

        let Some(config) = configs.get(&provider) else {
            continue;
        };

        if config.api_key.trim().is_empty() {
            continue;
        }

        return Ok(Some((provider, config.clone())));
    }

    Ok(None)
}

fn generate_chunk_embeddings(
    connection: &Connection,
    chunks: &[knowledge_chunker::ChunkSlice],
) -> Vec<Option<String>> {
    if chunks.is_empty() {
        return Vec::new();
    }

    let Some((provider, config)) = resolve_embedding_provider(connection).ok().flatten() else {
        return vec![None; chunks.len()];
    };

    let base_url = config.base_url.as_deref().unwrap_or("https://api.openai.com/v1").trim();
    let api_key = config.api_key.trim();
    if base_url.is_empty() || api_key.is_empty() {
        return vec![None; chunks.len()];
    }

    let client = match BlockingHttpClient::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
    {
        Ok(client) => client,
        Err(err) => {
            eprintln!("知识库 embedding 客户端创建失败 ({provider}): {err}");
            return vec![None; chunks.len()];
        }
    };

    let input: Vec<&str> = chunks.iter().map(|chunk| chunk.content.as_str()).collect();
    let request_body = serde_json::json!({
        "model": DEFAULT_EMBEDDING_MODEL,
        "input": input,
    });

    let response = match client
        .post(format!("{}/embeddings", base_url.trim_end_matches('/')))
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&request_body)
        .send()
    {
        Ok(response) => response,
        Err(err) => {
            eprintln!("知识库 embedding 请求失败 ({provider}): {err}");
            return vec![None; chunks.len()];
        }
    };

    if !response.status().is_success() {
        let err_text = response.text().unwrap_or_default();
        eprintln!("知识库 embedding API 返回错误 ({provider}): {err_text}");
        return vec![None; chunks.len()];
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

    let payload: EmbeddingApiResponse = match response.json() {
        Ok(payload) => payload,
        Err(err) => {
            eprintln!("知识库 embedding 响应解析失败 ({provider}): {err}");
            return vec![None; chunks.len()];
        }
    };

    let mut ordered = payload.data;
    ordered.sort_by_key(|item| item.index);

    let mut embeddings = vec![None; chunks.len()];
    for (index, item) in ordered.into_iter().enumerate() {
        if index >= embeddings.len() {
            break;
        }
        embeddings[index] = serde_json::to_string(&item.embedding).ok();
    }

    embeddings
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
            SELECT id, name, description, created_at, updated_at
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
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
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
                   access_count, last_accessed_at, title_hierarchy, created_at, updated_at
            FROM knowledge_documents
            ORDER BY updated_at DESC, created_at DESC, id DESC
            "#,
        )
        .map_err(|err| err.to_string())?;
    let documents = documents_stmt
        .query_map([], |row| {
            let tags_json: String = row.get(12)?;
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
                chunk_count: row.get(10)?,
                thumbnail_data_url: row.get(11)?,
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

    Ok(KnowledgeLibraryPayload { collections, documents })
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
                   access_count, last_accessed_at, title_hierarchy, created_at, updated_at
            FROM knowledge_documents
            WHERE id = ?1
            "#,
            params![document_id],
            |row| {
                let tags_json: String = row.get(12)?;
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
                    chunk_count: row.get(10)?,
                    thumbnail_data_url: row.get(11)?,
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

    let mut chunk_stmt = connection
        .prepare(
            r#"
            SELECT id, document_id, collection_id, chunk_index, title, content, embedding_json, created_at
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
                embedding_json: row.get(6)?,
                created_at: row.get(7)?,
            })
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    Ok(KnowledgeDocumentDetailPayload { document, chunks })
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

fn create_knowledge_collection(connection: &Connection, name: &str, description: &str) -> Result<KnowledgeCollectionRecord, String> {
    let now = current_timestamp_ms();
    let id = uuid::Uuid::new_v4().to_string();
    let name = name.trim();
    let description = description.trim();

    if name.is_empty() {
        return Err("知识库名称不能为空".into());
    }

    connection
        .execute(
            r#"
            INSERT INTO knowledge_collections (id, name, description, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            "#,
            params![id, name, description, now, now],
        )
        .map_err(|err| err.to_string())?;

    Ok(KnowledgeCollectionRecord {
        id,
        name: name.to_string(),
        description: description.to_string(),
        created_at: now,
        updated_at: now,
    })
}

fn delete_knowledge_collection(connection: &Connection, collection_id: &str) -> Result<(), String> {
    let collection_id = collection_id.trim();
    if collection_id.is_empty() {
        return Err("知识库 ID 不能为空".into());
    }
    if collection_id == "default" {
        return Err("默认知识库不能删除".into());
    }

    let stored_paths = {
        let mut stmt = connection
            .prepare(
                r#"
                SELECT stored_file_path
                FROM knowledge_documents
                WHERE collection_id = ?1
                "#,
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt.query_map(params![collection_id], |row| row.get::<_, Option<String>>(0))
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?;
        rows
    };

    let tx = connection.unchecked_transaction().map_err(|err| err.to_string())?;
    tx.execute("DELETE FROM knowledge_chunks WHERE collection_id = ?1", params![collection_id])
        .map_err(|err| err.to_string())?;
    tx.execute("DELETE FROM knowledge_documents WHERE collection_id = ?1", params![collection_id])
        .map_err(|err| err.to_string())?;
    tx.execute("DELETE FROM knowledge_collections WHERE id = ?1", params![collection_id])
        .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;

    for path in stored_paths {
        delete_stored_document_file(path.as_deref());
    }

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

    let tx = connection.unchecked_transaction().map_err(|err| err.to_string())?;
    tx.execute("DELETE FROM knowledge_chunks WHERE document_id = ?1", params![document_id])
        .map_err(|err| err.to_string())?;
    tx.execute("DELETE FROM knowledge_documents WHERE id = ?1", params![document_id])
        .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;

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
    let title_hierarchy = input.title_hierarchy.map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
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
    let chunk_embeddings = generate_chunk_embeddings(connection, &chunks);
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
        .map(|bytes| store_knowledge_document_bytes(app, &collection_id, &document_id, source_name, bytes))
        .transpose()?
        .map(|path| path.to_string_lossy().to_string());

    let tx = connection.unchecked_transaction().map_err(|err| err.to_string())?;
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
                  id, document_id, collection_id, chunk_index, title, content, embedding_json, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
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
        content: if content.trim().is_empty() { None } else { Some(content) },
        content_preview,
        thumbnail_data_url,
        chunk_count,
        tags,
        favorite,
        access_count: 0,
        last_accessed_at: None,
        title_hierarchy,
        created_at: now,
        updated_at: now,
    })
}

fn score_search_candidate(
    query: &str,
    query_terms: &[String],
    query_embedding: Option<&[f64]>,
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

    if haystack.contains(&normalize_text_for_search(&candidate.source_name)) {
        score += 1.0;
    }
    if candidate
        .title
        .as_deref()
        .map(normalize_text_for_search)
        .as_deref()
        .map(|title| haystack.contains(title))
        .unwrap_or(false)
    {
        score += 0.8;
    }

    if let Some(query_embedding) = query_embedding {
        if let Some(candidate_embedding) = candidate.embedding_json.as_deref().and_then(parse_embedding_json) {
            score += cosine_similarity(query_embedding, &candidate_embedding) * 2.0;
        }
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
    embedding_json: Option<String>,
    created_at: i64,
    source_name: String,
    source_path: Option<String>,
    collection_name: String,
    tags: Vec<String>,
    favorite: bool,
    access_count: i64,
    last_accessed_at: Option<i64>,
    title_hierarchy: Option<String>,
}

fn search_knowledge_chunks(
    connection: &Connection,
    input: SearchKnowledgeChunksInput,
) -> Result<Vec<SearchKnowledgeChunkResult>, String> {
    let query = input.query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    ensure_knowledge_defaults(connection)?;
    let query_terms: Vec<String> = query
        .split_whitespace()
        .filter(|term| !term.is_empty())
        .map(|term| term.to_string())
        .collect();
    let limit = input.limit.unwrap_or(10).clamp(1, 50);
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
              c.embedding_json,
              c.created_at,
              d.source_name,
              d.source_path,
              d.tags_json,
              d.favorite,
              d.access_count,
              d.last_accessed_at,
              d.title_hierarchy,
              k.name
            FROM knowledge_chunks c
            JOIN knowledge_documents d ON d.id = c.document_id
            JOIN knowledge_collections k ON k.id = c.collection_id
            "#,
        )
        .map_err(|err| err.to_string())?;

    let candidates = stmt
        .query_map([], |row| {
            let tags_json: String = row.get(10)?;
            Ok(KnowledgeSearchCandidate {
                chunk_id: row.get(0)?,
                document_id: row.get(1)?,
                collection_id: row.get(2)?,
                chunk_index: row.get(3)?,
                title: row.get(4)?,
                content: row.get(5)?,
                embedding_json: row.get(6)?,
                created_at: row.get(7)?,
                source_name: row.get(8)?,
                source_path: row.get(9)?,
                tags: parse_tags_json(&tags_json),
                favorite: row.get::<_, i64>(11)? != 0,
                access_count: row.get(12)?,
                last_accessed_at: row.get(13)?,
                title_hierarchy: row.get(14)?,
                collection_name: row.get(15)?,
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
        let score = score_search_candidate(&query, &query_terms, query_embedding.as_deref(), &candidate);
        if score <= 0.0 && !candidate.content.to_lowercase().contains(&query) {
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

    Ok(scored
        .into_iter()
        .take(limit)
        .map(|(score, candidate)| SearchKnowledgeChunkResult {
            chunk: KnowledgeChunkRecord {
                id: candidate.chunk_id,
                document_id: candidate.document_id,
                collection_id: candidate.collection_id,
                chunk_index: candidate.chunk_index,
                title: candidate.title,
                content: candidate.content,
                embedding_json: candidate.embedding_json,
                created_at: candidate.created_at,
            },
            score,
            source_name: candidate.source_name,
            source_path: candidate.source_path,
            collection_name: candidate.collection_name,
            tags: candidate.tags,
            favorite: candidate.favorite,
            access_count: candidate.access_count,
            last_accessed_at: candidate.last_accessed_at,
            title_hierarchy: candidate.title_hierarchy,
        })
        .collect())
}

#[tauri::command]
fn load_knowledge_library_command(app: tauri::AppHandle) -> Result<KnowledgeLibraryPayload, String> {
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
) -> Result<KnowledgeCollectionRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    create_knowledge_collection(&connection, &name, &description)
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
fn search_knowledge_chunks_command(
    app: tauri::AppHandle,
    input: SearchKnowledgeChunksInput,
) -> Result<Vec<SearchKnowledgeChunkResult>, String> {
    let connection = open_sqlite_connection(&app)?;
    search_knowledge_chunks(&connection, input)
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

fn table_has_column(connection: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let sql = format!("PRAGMA table_info({table})");
    let mut stmt = connection.prepare(&sql).map_err(|err| err.to_string())?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    Ok(columns.iter().any(|item| item == column))
}

fn ensure_knowledge_schema(connection: &Connection) -> Result<(), String> {
    ensure_knowledge_defaults(connection)?;

    if !table_has_column(connection, "knowledge_chunks", "embedding_json")? {
        connection
            .execute(
                "ALTER TABLE knowledge_chunks ADD COLUMN embedding_json TEXT",
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

    Ok(())
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
            list_workspace_files,
            read_workspace_file,
            search_workspace_files,
            load_knowledge_library_command,
            load_knowledge_document_command,
            load_knowledge_document_file_command,
            create_knowledge_collection_command,
            delete_knowledge_collection_command,
            delete_knowledge_document_command,
            import_knowledge_document_command,
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
            remove_app_kv
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

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("运行 Omni 时发生错误");
}
