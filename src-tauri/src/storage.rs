use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::HashMap;

use crate::current_timestamp_ms;

pub(crate) const KNOWLEDGE_EMBEDDING_CONFIG_KEY: &str = "omni_knowledge_embedding_profile";
pub(crate) const KNOWLEDGE_MULTIMODAL_CONFIG_KEY: &str = "omni_knowledge_multimodal_profile";

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

    let sessions = session_stmt
        .query_map([], |row| {
            let messages_json: String = row.get(3)?;
            let usage_json: String = row.get(8)?;

            Ok(DbChatSession {
                id: row.get(0)?,
                project_id: row.get(1)?,
                title: row.get(2)?,
                messages: serde_json::from_str(&messages_json)
                    .unwrap_or_else(|_| serde_json::Value::Array(Vec::new())),
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
        projects_json: Some(serde_json::to_string(&projects).map_err(|err| err.to_string())?),
        sessions_json: Some(serde_json::to_string(&sessions).map_err(|err| err.to_string())?),
    })
}

pub(crate) fn save_structured_chat_storage(
    connection: &Connection,
    projects_json: &str,
    sessions_json: &str,
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
    tx.execute("DELETE FROM chat_sessions", [])
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

        for session in sessions {
            stmt.execute(params![
                session.id,
                session.project_id,
                session.title,
                serde_json::to_string(&session.messages).map_err(|err| err.to_string())?,
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
    Ok(())
}

pub(crate) fn delete_chat_session_by_id(connection: &Connection, id: &str) -> Result<(), String> {
    connection
        .execute("DELETE FROM chat_sessions WHERE id = ?1", params![id])
        .map_err(|err| err.to_string())?;
    Ok(())
}

pub(crate) fn delete_project_by_id(connection: &Connection, id: &str) -> Result<(), String> {
    // 默认助手不允许删除；同时清理其所属会话，避免孤儿记录。
    connection
        .execute("DELETE FROM projects WHERE id = ?1 AND kind != 'basic'", params![id])
        .map_err(|err| err.to_string())?;
    connection
        .execute("DELETE FROM chat_sessions WHERE project_id = ?1", params![id])
        .map_err(|err| err.to_string())?;
    Ok(())
}

pub(crate) fn load_manifest_storage(
    connection: &Connection,
) -> Result<ManifestStoragePayload, String> {
    let project_presets_json =
        read_simple_table_value(connection, "project_presets", "builtin")?;
    let tool_manifests_json = read_simple_table_value(connection, "tool_manifests", "builtin")?;
    let skill_manifests_json = read_simple_table_value(connection, "skill_manifests", "builtin")?;

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
        write_simple_table_value(connection, "project_presets", "builtin", value)?;
    }
    if let Some(value) = tool_manifests_json {
        write_simple_table_value(connection, "tool_manifests", "builtin", value)?;
    }
    if let Some(value) = skill_manifests_json {
        write_simple_table_value(connection, "skill_manifests", "builtin", value)?;
    }
    Ok(())
}

pub(crate) fn load_memory_storage(connection: &Connection) -> Result<MemoryStoragePayload, String> {
    let project_memories_json =
        read_simple_table_value(connection, "project_memories", "builtin")?;
    let user_preferences_json = read_simple_table_value(connection, "user_preferences", "builtin")?;
    let session_summaries_json =
        read_simple_table_value(connection, "session_summaries", "builtin")?;

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
        write_simple_table_value(connection, "project_memories", "builtin", value)?;
    }
    if let Some(value) = user_preferences_json {
        write_simple_table_value(connection, "user_preferences", "builtin", value)?;
    }
    if let Some(value) = session_summaries_json {
        write_simple_table_value(connection, "session_summaries", "builtin", value)?;
    }
    Ok(())
}

pub(crate) fn load_automation_storage(
    connection: &Connection,
) -> Result<AutomationStoragePayload, String> {
    let scheduled_tasks_json = read_simple_table_value(connection, "scheduled_tasks", "builtin")?;
    Ok(AutomationStoragePayload {
        scheduled_tasks_json,
    })
}

pub(crate) fn save_automation_storage(
    connection: &Connection,
    scheduled_tasks_json: Option<&str>,
) -> Result<(), String> {
    if let Some(value) = scheduled_tasks_json {
        write_simple_table_value(connection, "scheduled_tasks", "builtin", value)?;
    }
    Ok(())
}
