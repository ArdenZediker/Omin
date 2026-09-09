use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::HashMap;
use std::fs;
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use crate::current_timestamp_ms;

pub(crate) const KNOWLEDGE_EMBEDDING_CONFIG_KEY: &str = "omni_knowledge_embedding_profile";
pub(crate) const KNOWLEDGE_MULTIMODAL_CONFIG_KEY: &str = "omni_knowledge_multimodal_profile";

/// 整包快照在 app_kv 表中的固定 key（快照 = 前端序列化后的整包 JSON）。
/// 统一 omni_snapshot_ 前缀，与前端 localStorage key（omni_*）及结构化 key 区分。
const SNAPSHOT_PROJECT_PRESETS_KEY: &str = "omni_snapshot_project_presets";
const SNAPSHOT_TOOL_MANIFESTS_KEY: &str = "omni_snapshot_tool_manifests";
const SNAPSHOT_SKILL_MANIFESTS_KEY: &str = "omni_snapshot_skill_manifests";
const SNAPSHOT_PROJECT_MEMORIES_KEY: &str = "omni_snapshot_project_memories";
const SNAPSHOT_USER_PREFERENCES_KEY: &str = "omni_snapshot_user_preferences";
const SNAPSHOT_SESSION_SUMMARIES_KEY: &str = "omni_snapshot_session_summaries";
const SNAPSHOT_SCHEDULED_TASKS_KEY: &str = "omni_snapshot_scheduled_tasks";

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DbProviderConfigRecord {
    api_key: String,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    custom_models: Option<JsonValue>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatStoragePayload {
    pub(crate) projects_json: Option<String>,
    pub(crate) sessions_json: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManifestStoragePayload {
    pub(crate) project_presets_json: Option<String>,
    pub(crate) tool_manifests_json: Option<String>,
    pub(crate) skill_manifests_json: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryStoragePayload {
    pub(crate) project_memories_json: Option<String>,
    pub(crate) user_preferences_json: Option<String>,
    pub(crate) session_summaries_json: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationStoragePayload {
    pub(crate) scheduled_tasks_json: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DbProject {
    id: String,
    kind: String,
    #[serde(default)]
    source_preset_id: Option<String>,
    title: String,
    description: String,
    #[serde(default)]
    workspace_path: String,
    #[serde(default)]
    system_prompt: Option<String>,
    #[serde(default)]
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
    project_id: String,
    title: String,
    messages: serde_json::Value,
    pinned: Option<bool>,
    favorite: Option<bool>,
    created_at: i64,
    updated_at: i64,
    usage: DbChatUsageStats,
}

/// 会话消息权威源：<sessions_root>/<sessionId>/session.jsonl（JSONL 事件日志，每行一个 message）。
/// SQLite chat_sessions 表的 messages_json 列仅作一次性迁移占位（"[]"），不再承载消息实体。
///
/// 写路径先落临时文件再原子 rename，避免崩溃时留下半截文件（撕裂）；
/// 全局锁串行化所有会话文件读写，规避多窗口并发写竞争。
static SESSION_FILE_LOCK: Mutex<()> = Mutex::new(());

/// 会话 JSONL 文件格式版本。升级消息 schema 时递增，并在 read 侧做版本校验/迁移。
const SESSION_FORMAT_VERSION: u32 = 1;
/// 会话文件头魔数键：首行 JSON 含此键即视为格式头（而非消息）。
const SESSION_HEADER_MAGIC: &str = "_omni_session_format";
/// 跨进程写锁文件路径（在 sessions_root 下），通过 create_new 原子创建实现咨询锁。
/// 与进程内 Mutex 配合，确保多实例并发写不会撕裂文件。
const SESSION_LEASE_FILE: &str = ".omni_sessions.lock";
/// 获取跨进程写锁的最长等待时间。
const SESSION_LEASE_TIMEOUT: Duration = Duration::from_secs(10);

fn session_file_path(root: &Path, id: &str) -> PathBuf {
    root.join(id).join("session.jsonl")
}

/// 构造会话文件头行（JSONL 首行），记录格式版本与压缩方式，供后续迁移识别。
fn build_session_header() -> String {
    let mut header = serde_json::Map::new();
    header.insert(SESSION_HEADER_MAGIC.to_string(), JsonValue::from(SESSION_FORMAT_VERSION));
    header.insert("compression".to_string(), JsonValue::from("none"));
    JsonValue::Object(header).to_string()
}

/// 跨进程写锁：在 sessions_root 下原子创建 .omni_sessions.lock。
/// 创建成功即持有锁；超时或异常返回错误。调用方须在临界区结束后删除该文件释放锁。
fn acquire_cross_process_lease(root: &Path) -> Result<fs::File, String> {
    let lock_path = root.join(SESSION_LEASE_FILE);
    let deadline = Instant::now() + SESSION_LEASE_TIMEOUT;
    loop {
        match OpenOptions::new().write(true).create_new(true).open(&lock_path) {
            Ok(file) => return Ok(file),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                if Instant::now() >= deadline {
                    return Err(format!("获取会话写锁超时: {}", lock_path.display()));
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(err) => {
                return Err(format!("创建会话写锁失败 {}: {}", lock_path.display(), err));
            }
        }
    }
}

fn write_session_messages(root: &Path, id: &str, messages: &JsonValue) -> Result<(), String> {
    let _guard = SESSION_FILE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // 进程间互斥：多实例并发写时串行化，避免文件撕裂。
    let _lease = acquire_cross_process_lease(root)?;
    let dir = root.join(id);
    fs::create_dir_all(&dir).map_err(|err| format!("创建会话目录失败 {}: {}", dir.display(), err))?;
    let target = dir.join("session.jsonl");
    let tmp = dir.join("session.jsonl.tmp");

    let array: Vec<&JsonValue> = match messages {
        JsonValue::Array(items) => items.iter().collect(),
        other => vec![other],
    };
    let mut content = String::new();
    // 首行为格式头，便于后续版本迁移识别；其余每行一个消息。
    content.push_str(&build_session_header());
    content.push('\n');
    for item in array {
        let line = serde_json::to_string(item).map_err(|err| err.to_string())?;
        content.push_str(&line);
        content.push('\n');
    }
    fs::write(&tmp, content.as_bytes())
        .map_err(|err| format!("写入会话临时文件失败 {}: {}", tmp.display(), err))?;
    fs::rename(&tmp, &target)
        .map_err(|err| format!("重命名会话文件失败 {}: {}", target.display(), err))?;
    // 释放跨进程写锁（仅本进程持有，Mutex 已保证唯一进入者）。
    let _ = fs::remove_file(root.join(SESSION_LEASE_FILE));
    Ok(())
}

fn read_session_messages(root: &Path, id: &str) -> Result<Option<Vec<JsonValue>>, String> {
    let _guard = SESSION_FILE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let file = session_file_path(root, id);
    if !file.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&file)
        .map_err(|err| format!("读取会话文件失败 {}: {}", file.display(), err))?;
    let mut out: Vec<JsonValue> = Vec::new();
    let mut first_line = true;
    for (index, line) in raw.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if first_line {
            first_line = false;
            // 首行可能是格式头：含魔数键则校验版本后跳过；否则视为无头旧文件，按消息解析。
            if let Ok(JsonValue::Object(map)) = serde_json::from_str::<JsonValue>(line) {
                if let Some(JsonValue::Number(version)) = map.get(SESSION_HEADER_MAGIC) {
                    let v = version.as_u64().unwrap_or(0) as u32;
                    if v > SESSION_FORMAT_VERSION {
                        return Err(format!(
                            "会话 {} 的文件格式版本 {} 高于当前支持的 {}，需迁移",
                            id, v, SESSION_FORMAT_VERSION
                        ));
                    }
                    continue; // 跳过头行，不计入消息
                }
            }
            // 无头旧文件：首行即消息，落到下方解析
        }
        match serde_json::from_str::<JsonValue>(line) {
            Ok(value) => out.push(value),
            Err(err) => {
                eprintln!("跳过会话 {} 中损坏的消息行 {}: {}", id, index + 1, err);
            }
        }
    }
    Ok(Some(out))
}

fn delete_session_dir(root: &Path, id: &str) {
    let _guard = SESSION_FILE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let dir = root.join(id);
    if dir.exists() {
        let _ = fs::remove_dir_all(&dir);
    }
}

pub(crate) fn read_kv(connection: &Connection, key: &str) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT value FROM app_kv WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| err.to_string())
}

pub(crate) fn write_kv(connection: &Connection, key: &str, value: &str) -> Result<(), String> {
    connection
        .execute(
            r#"
            INSERT INTO app_kv (key, value, updated_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(key) DO UPDATE SET
              value = excluded.value,
              updated_at = excluded.updated_at
            "#,
            params![key, value, current_timestamp_ms()],
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn remove_kv(connection: &Connection, key: &str) -> Result<(), String> {
    connection
        .execute("DELETE FROM app_kv WHERE key = ?1", params![key])
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn is_window_state_key(key: &str) -> bool {
    matches!(
        key,
        "omni_main_view" | "omni_compact_position" | "omni_main_position"
    )
}

fn is_provider_config_key(key: &str) -> bool {
    key == "omni_provider_configs"
}

fn is_model_connection_status_key(key: &str) -> bool {
    key == "omni_model_connection_status"
}

fn is_knowledge_embedding_config_key(key: &str) -> bool {
    key == KNOWLEDGE_EMBEDDING_CONFIG_KEY
}

fn is_knowledge_multimodal_config_key(key: &str) -> bool {
    key == KNOWLEDGE_MULTIMODAL_CONFIG_KEY
}

pub(crate) fn read_simple_table_value(
    connection: &Connection,
    table: &str,
    key: &str,
) -> Result<Option<String>, String> {
    let sql = format!("SELECT value FROM {table} WHERE key = ?1");
    connection
        .query_row(&sql, params![key], |row| row.get(0))
        .optional()
        .map_err(|err| err.to_string())
}

pub(crate) fn write_simple_table_value(
    connection: &Connection,
    table: &str,
    key: &str,
    value: &str,
) -> Result<(), String> {
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

fn remove_simple_table_value(
    connection: &Connection,
    table: &str,
    key: &str,
) -> Result<(), String> {
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
            let parsed = serde_json::from_str::<JsonValue>(&custom_models_json)
                .unwrap_or(JsonValue::Array(Vec::new()));
            item.insert("customModels".into(), parsed);
        }
        result.insert(provider, JsonValue::Object(item));
    }

    Ok(Some(
        serde_json::to_string(&JsonValue::Object(result)).map_err(|err| err.to_string())?,
    ))
}

fn write_provider_configs_value(connection: &Connection, value: &str) -> Result<(), String> {
    let parsed: JsonMap<String, JsonValue> =
        serde_json::from_str(value).map_err(|err| err.to_string())?;
    let tx = connection
        .unchecked_transaction()
        .map_err(|err| err.to_string())?;
    tx.execute("DELETE FROM provider_configs", [])
        .map_err(|err| err.to_string())?;

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
            let record: DbProviderConfigRecord =
                serde_json::from_value(item).map_err(|err| err.to_string())?;
            stmt.execute(params![
                provider,
                record.api_key,
                record.base_url,
                record.name,
                record
                    .custom_models
                    .map(|value| serde_json::to_string(&value))
                    .transpose()
                    .map_err(|err| err.to_string())?,
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
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0))
        })
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

    Ok(Some(
        serde_json::to_string(&JsonValue::Object(result)).map_err(|err| err.to_string())?,
    ))
}

fn write_model_connection_status_value(connection: &Connection, value: &str) -> Result<(), String> {
    let parsed: HashMap<String, bool> =
        serde_json::from_str(value).map_err(|err| err.to_string())?;
    let tx = connection
        .unchecked_transaction()
        .map_err(|err| err.to_string())?;
    tx.execute("DELETE FROM model_connection_status", [])
        .map_err(|err| err.to_string())?;

    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO model_connection_status (model_id, connected, updated_at) VALUES (?1, ?2, ?3)",
            )
            .map_err(|err| err.to_string())?;

        for (model_id, connected) in parsed {
            stmt.execute(params![
                model_id,
                if connected { 1_i64 } else { 0_i64 },
                current_timestamp_ms()
            ])
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

pub(crate) fn read_structured_app_value(
    connection: &Connection,
    key: &str,
) -> Result<Option<String>, String> {
    if is_provider_config_key(key) {
        return read_provider_configs_value(connection);
    }
    if is_model_connection_status_key(key) {
        return read_model_connection_status_value(connection);
    }
    if is_knowledge_embedding_config_key(key) {
        return read_kv(connection, key);
    }
    if is_knowledge_multimodal_config_key(key) {
        return read_kv(connection, key);
    }
    if is_window_state_key(key) {
        return read_simple_table_value(connection, "window_state", key);
    }
    read_simple_table_value(connection, "app_settings", key)
}

pub(crate) fn write_structured_app_value(
    connection: &Connection,
    key: &str,
    value: &str,
) -> Result<(), String> {
    if is_provider_config_key(key) {
        return write_provider_configs_value(connection, value);
    }
    if is_model_connection_status_key(key) {
        return write_model_connection_status_value(connection, value);
    }
    if is_knowledge_embedding_config_key(key) {
        return write_kv(connection, key, value);
    }
    if is_knowledge_multimodal_config_key(key) {
        return write_kv(connection, key, value);
    }
    if is_window_state_key(key) {
        return write_simple_table_value(connection, "window_state", key, value);
    }
    write_simple_table_value(connection, "app_settings", key, value)
}

pub(crate) fn remove_structured_app_value(
    connection: &Connection,
    key: &str,
) -> Result<(), String> {
    if is_provider_config_key(key) {
        return remove_provider_configs_value(connection);
    }
    if is_model_connection_status_key(key) {
        return remove_model_connection_status_value(connection);
    }
    if is_knowledge_embedding_config_key(key) {
        return remove_kv(connection, key);
    }
    if is_knowledge_multimodal_config_key(key) {
        return remove_kv(connection, key);
    }
    if is_window_state_key(key) {
        return remove_simple_table_value(connection, "window_state", key);
    }
    remove_simple_table_value(connection, "app_settings", key)
}

pub(crate) fn has_structured_chat_storage(connection: &Connection) -> Result<bool, String> {
    let project_count: i64 = connection
        .query_row("SELECT COUNT(1) FROM projects", [], |row| row.get(0))
        .map_err(|err| err.to_string())?;
    let session_count: i64 = connection
        .query_row("SELECT COUNT(1) FROM chat_sessions", [], |row| row.get(0))
        .map_err(|err| err.to_string())?;
    Ok(project_count > 0 || session_count > 0)
}

pub(crate) fn load_structured_chat_storage(
    connection: &Connection,
    sessions_root: &Path,
) -> Result<ChatStoragePayload, String> {
    let mut project_stmt = connection
        .prepare(
            r#"
            SELECT id, kind, source_preset_id, title, description, system_prompt, default_model_id, allowed_tool_ids_json, allowed_skill_ids_json, created_at, updated_at, workspace_path
            FROM projects
            ORDER BY created_at ASC, id ASC
            "#,
        )
        .map_err(|err| err.to_string())?;

    let projects = project_stmt
        .query_map([], |row| {
            let allowed_tool_ids_json: String = row.get(7)?;
            let allowed_skill_ids_json: String = row.get(8)?;

            Ok(DbProject {
                id: row.get(0)?,
                kind: row.get(1)?,
                source_preset_id: row.get(2)?,
                title: row.get(3)?,
                description: row.get(4)?,
                workspace_path: row.get(11).unwrap_or_default(),
                system_prompt: row.get(5)?,
                default_model_id: row.get(6)?,
                allowed_tool_ids: serde_json::from_str(&allowed_tool_ids_json).unwrap_or_default(),
                allowed_skill_ids: serde_json::from_str(&allowed_skill_ids_json)
                    .unwrap_or_default(),
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
            SELECT id, project_id, title, messages_json, pinned, favorite, created_at, updated_at, usage_json
            FROM chat_sessions
            ORDER BY updated_at DESC, created_at DESC, id DESC
            "#,
        )
        .map_err(|err| err.to_string())?;

    let raw_sessions: Vec<(
        String,
        String,
        String,
        String,
        Option<bool>,
        Option<bool>,
        i64,
        i64,
        String,
    )> = session_stmt
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get::<_, i64>(4).ok().map(|value| value != 0),
                row.get::<_, i64>(5).ok().map(|value| value != 0),
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
            ))
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    let sessions: Vec<DbChatSession> = raw_sessions
        .into_iter()
        .map(
            |(id, project_id, title, messages_json, pinned, favorite, created_at, updated_at, usage_json)| {
                // 消息优先从 JSONL 文件读取；文件缺失时回退旧 messages_json 列
                // （首次从旧版本升级时的迁移路径），并写回文件，之后文件成为权威源。
                let messages = match read_session_messages(sessions_root, &id)? {
                    Some(items) => JsonValue::Array(items),
                    None => {
                        let parsed: JsonValue = serde_json::from_str(&messages_json)
                            .unwrap_or(JsonValue::Array(Vec::new()));
                        let _ = write_session_messages(sessions_root, &id, &parsed);
                        parsed
                    }
                };
                let usage = serde_json::from_str(&usage_json).unwrap_or(DbChatUsageStats {
                    request_count: 0,
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0,
                    total_cost_usd: 0.0,
                    last_model: None,
                    last_used_at: None,
                    has_estimated_usage: false,
                });
                Ok(DbChatSession {
                    id,
                    project_id,
                    title,
                    messages,
                    pinned,
                    favorite,
                    created_at,
                    updated_at,
                    usage,
                })
            },
        )
        .collect::<Result<Vec<_>, String>>()?;

    Ok(ChatStoragePayload {
        projects_json: Some(serde_json::to_string(&projects).map_err(|err| err.to_string())?),
        sessions_json: Some(serde_json::to_string(&sessions).map_err(|err| err.to_string())?),
    })
}

pub(crate) fn save_structured_chat_storage(
    connection: &Connection,
    projects_json: &str,
    sessions_json: &str,
    sessions_root: &Path,
) -> Result<(), String> {
    let projects: Vec<DbProject> =
        serde_json::from_str(projects_json).map_err(|err| err.to_string())?;
    let sessions: Vec<DbChatSession> =
        serde_json::from_str(sessions_json).map_err(|err| err.to_string())?;

    let tx = connection
        .unchecked_transaction()
        .map_err(|err| err.to_string())?;

    // 前端以整个快照为真相源，保存前清理不在快照中的旧记录，
    // 避免 delete_project/delete_chat_session 异步失败或窗口提前关闭导致"幽灵"记录复活。
    tx.execute("DELETE FROM projects WHERE kind != 'basic'", [])
        .map_err(|err| err.to_string())?;

    {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT OR REPLACE INTO projects (
                  id, kind, source_preset_id, title, description, workspace_path, system_prompt, default_model_id,
                  allowed_tool_ids_json, allowed_skill_ids_json, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                "#,
            )
            .map_err(|err| err.to_string())?;

        for project in projects {
            stmt.execute(params![
                project.id,
                project.kind,
                project.source_preset_id,
                project.title,
                project.description,
                project.workspace_path,
                project.system_prompt,
                project.default_model_id,
                serde_json::to_string(&project.allowed_tool_ids).map_err(|err| err.to_string())?,
                serde_json::to_string(&project.allowed_skill_ids)
                    .map_err(|err| err.to_string())?,
                project.created_at,
                project.updated_at,
            ])
            .map_err(|err| err.to_string())?;
        }
    }

    {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT OR REPLACE INTO chat_sessions (
                  id, project_id, title, messages_json, pinned, favorite, created_at, updated_at, usage_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                "#,
            )
            .map_err(|err| err.to_string())?;

        for session in &sessions {
            stmt.execute(params![
                session.id,
                session.project_id,
                session.title,
                // 消息实体已迁出到 JSONL 文件，这里仅留占位，避免破坏 NOT NULL 约束。
                "[]",
                if session.pinned.unwrap_or(false) {
                    1_i64
                } else {
                    0_i64
                },
                if session.favorite.unwrap_or(false) {
                    1_i64
                } else {
                    0_i64
                },
                session.created_at,
                session.updated_at,
                serde_json::to_string(&session.usage).map_err(|err| err.to_string())?,
            ])
            .map_err(|err| err.to_string())?;
        }
    }

    tx.commit().map_err(|err| err.to_string())?;

    // 元数据入库后落会话消息文件（JSONL 事件日志，原子 rename 写入）。
    // helper 内部已持全局锁，这里无需额外加锁。
    let mut incoming: std::collections::HashSet<String> = std::collections::HashSet::new();
    for session in &sessions {
        write_session_messages(sessions_root, &session.id, &session.messages)?;
        incoming.insert(session.id.clone());
    }

    // 清理快照之外的"幽灵"会话：删 SQL 行 + 删其目录。
    let existing: Vec<String> = {
        let mut stmt = connection
            .prepare("SELECT id FROM chat_sessions")
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?;
        rows
    };
    for id in existing {
        if !incoming.contains(&id) {
            connection
                .execute("DELETE FROM chat_sessions WHERE id = ?1", params![id])
                .map_err(|err| err.to_string())?;
            delete_session_dir(sessions_root, &id);
        }
    }

    Ok(())
}

pub(crate) fn delete_chat_session_by_id(
    connection: &Connection,
    id: &str,
    sessions_root: &Path,
) -> Result<(), String> {
    connection
        .execute("DELETE FROM chat_sessions WHERE id = ?1", params![id])
        .map_err(|err| err.to_string())?;
    delete_session_dir(sessions_root, id);
    Ok(())
}

pub(crate) fn delete_project_by_id(
    connection: &Connection,
    id: &str,
    sessions_root: &Path,
) -> Result<(), String> {
    // 默认助手不允许删除；同时清理其所属会话，避免孤儿记录。
    connection
        .execute("DELETE FROM projects WHERE id = ?1 AND kind != 'basic'", params![id])
        .map_err(|err| err.to_string())?;
    let orphan_ids: Vec<String> = {
        let mut stmt = connection
            .prepare("SELECT id FROM chat_sessions WHERE project_id = ?1")
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![id], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?;
        rows
    };
    for orphan_id in orphan_ids {
        connection
            .execute("DELETE FROM chat_sessions WHERE id = ?1", params![orphan_id])
            .map_err(|err| err.to_string())?;
        delete_session_dir(sessions_root, &orphan_id);
    }
    Ok(())
}

pub(crate) fn load_manifest_storage(
    connection: &Connection,
) -> Result<ManifestStoragePayload, String> {
    let project_presets_json = read_kv(connection, SNAPSHOT_PROJECT_PRESETS_KEY)?;
    let tool_manifests_json = read_kv(connection, SNAPSHOT_TOOL_MANIFESTS_KEY)?;
    let skill_manifests_json = read_kv(connection, SNAPSHOT_SKILL_MANIFESTS_KEY)?;

    Ok(ManifestStoragePayload {
        project_presets_json,
        tool_manifests_json,
        skill_manifests_json,
    })
}

pub(crate) fn save_manifest_storage(
    connection: &Connection,
    project_presets_json: Option<&str>,
    tool_manifests_json: Option<&str>,
    skill_manifests_json: Option<&str>,
) -> Result<(), String> {
    if let Some(value) = project_presets_json {
        write_kv(connection, SNAPSHOT_PROJECT_PRESETS_KEY, value)?;
    }
    if let Some(value) = tool_manifests_json {
        write_kv(connection, SNAPSHOT_TOOL_MANIFESTS_KEY, value)?;
    }
    if let Some(value) = skill_manifests_json {
        write_kv(connection, SNAPSHOT_SKILL_MANIFESTS_KEY, value)?;
    }
    Ok(())
}

pub(crate) fn load_memory_storage(connection: &Connection) -> Result<MemoryStoragePayload, String> {
    let project_memories_json = read_kv(connection, SNAPSHOT_PROJECT_MEMORIES_KEY)?;
    let user_preferences_json = read_kv(connection, SNAPSHOT_USER_PREFERENCES_KEY)?;
    let session_summaries_json = read_kv(connection, SNAPSHOT_SESSION_SUMMARIES_KEY)?;

    Ok(MemoryStoragePayload {
        project_memories_json,
        user_preferences_json,
        session_summaries_json,
    })
}

pub(crate) fn save_memory_storage(
    connection: &Connection,
    project_memories_json: Option<&str>,
    user_preferences_json: Option<&str>,
    session_summaries_json: Option<&str>,
) -> Result<(), String> {
    if let Some(value) = project_memories_json {
        write_kv(connection, SNAPSHOT_PROJECT_MEMORIES_KEY, value)?;
    }
    if let Some(value) = user_preferences_json {
        write_kv(connection, SNAPSHOT_USER_PREFERENCES_KEY, value)?;
    }
    if let Some(value) = session_summaries_json {
        write_kv(connection, SNAPSHOT_SESSION_SUMMARIES_KEY, value)?;
    }
    Ok(())
}

pub(crate) fn load_automation_storage(
    connection: &Connection,
) -> Result<AutomationStoragePayload, String> {
    let scheduled_tasks_json = read_kv(connection, SNAPSHOT_SCHEDULED_TASKS_KEY)?;
    Ok(AutomationStoragePayload {
        scheduled_tasks_json,
    })
}

pub(crate) fn save_automation_storage(
    connection: &Connection,
    scheduled_tasks_json: Option<&str>,
) -> Result<(), String> {
    if let Some(value) = scheduled_tasks_json {
        write_kv(connection, SNAPSHOT_SCHEDULED_TASKS_KEY, value)?;
    }
    Ok(())
}

#[cfg(test)]
mod session_file_tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "omni_session_test_{}_{}",
            std::process::id(),
            n
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    fn sample_messages() -> JsonValue {
        JsonValue::Array(vec![
            serde_json::json!({"role":"user","content":"你好"}),
            serde_json::json!({"role":"assistant","content":"你好，有什么可以帮你？","reasoning":"我先看看用户想问什么"}),
        ])
    }

    #[test]
    fn write_then_read_roundtrip_preserves_order_and_content() {
        let root = temp_root();
        let msgs = sample_messages();
        write_session_messages(&root, "s1", &msgs).expect("写入应成功");
        let loaded = read_session_messages(&root, "s1")
            .expect("读取应成功")
            .expect("应读到消息");
        assert_eq!(&loaded, msgs.as_array().unwrap());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_missing_session_returns_none() {
        let root = temp_root();
        assert_eq!(read_session_messages(&root, "nope").unwrap(), None);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_tolerates_corrupt_lines_and_keeps_valid_ones() {
        let root = temp_root();
        write_session_messages(&root, "s2", &sample_messages()).expect("写入应成功");
        // 模拟崩溃撕裂：追加一行半截/损坏数据 + 一行有效数据
        let path = root.join("s2").join("session.jsonl");
        let mut f = fs::OpenOptions::new().append(true).open(&path).expect("打开文件");
        writeln!(f, "{{this is not valid json").expect("追加损坏行");
        writeln!(f, "{{\"role\":\"user\",\"content\":\"追加的有效行\"}}").expect("追加有效行");
        drop(f);

        let loaded = read_session_messages(&root, "s2")
            .expect("读取应成功")
            .expect("应读到");
        // 原始 2 行 + 1 行有效追加 = 3；损坏行被跳过
        assert_eq!(loaded.len(), 3);
        assert_eq!(loaded[2]["content"], "追加的有效行");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn overwrite_replaces_content_not_append() {
        let root = temp_root();
        write_session_messages(&root, "s3", &sample_messages()).expect("写入应成功");
        let replacement = JsonValue::Array(vec![serde_json::json!({"role":"system","content":"只有一条"})]);
        write_session_messages(&root, "s3", &replacement).expect("重写应成功");
        let loaded = read_session_messages(&root, "s3")
            .expect("读取应成功")
            .expect("应读到");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0]["role"], "system");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn write_includes_format_header_and_read_skips_it() {
        let root = temp_root();
        let msgs = sample_messages();
        write_session_messages(&root, "s5", &msgs).expect("写入应成功");

        // 首行应为格式头，含魔数键与版本号
        let raw = fs::read_to_string(root.join("s5").join("session.jsonl")).expect("读原文件");
        let first_line = raw.lines().next().expect("应有首行");
        let header: serde_json::Map<String, JsonValue> =
            serde_json::from_str(first_line).expect("头行应为合法 JSON");
        assert_eq!(header.get("_omni_session_format").and_then(|v| v.as_u64()), Some(1));

        // 读取结果只含消息、不含头行
        let loaded = read_session_messages(&root, "s5")
            .expect("读取应成功")
            .expect("应读到消息");
        assert_eq!(&loaded, msgs.as_array().unwrap());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_rejects_header_with_future_format_version() {
        let root = temp_root();
        let dir = root.join("s6");
        fs::create_dir_all(&dir).expect("创建目录");
        let mut f = fs::File::create(dir.join("session.jsonl")).expect("创建文件");
        writeln!(f, "{{\"_omni_session_format\":999,\"compression\":\"none\"}}").expect("写头行");
        writeln!(f, "{{\"role\":\"user\",\"content\":\"x\"}}").expect("写消息行");
        drop(f);

        let result = read_session_messages(&root, "s6");
        assert!(result.is_err(), "未来版本号应被拒绝");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_removes_session_dir() {
        let root = temp_root();
        write_session_messages(&root, "s4", &sample_messages()).expect("写入应成功");
        assert!(read_session_messages(&root, "s4").unwrap().is_some());
        delete_session_dir(&root, "s4");
        assert_eq!(read_session_messages(&root, "s4").unwrap(), None);
        let _ = fs::remove_dir_all(&root);
    }
}
