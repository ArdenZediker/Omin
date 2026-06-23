use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::HashMap;

use crate::current_timestamp_ms;

pub(crate) const KNOWLEDGE_EMBEDDING_CONFIG_KEY: &str = "omni_knowledge_embedding_profile";
pub(crate) const KNOWLEDGE_MULTIMODAL_CONFIG_KEY: &str = "omni_knowledge_multimodal_profile";

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DbProviderConfigRecord {
    api_key: String,
    base_url: Option<String>,
    name: Option<String>,
    custom_models: Option<JsonValue>,
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
