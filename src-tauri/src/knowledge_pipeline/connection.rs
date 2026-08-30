//! SQLite 连接获取：一次性连接与 worker tick 复用连接。
//!
//! 由 knowledge_pipeline 单文件拆分而来，保持逻辑不变。

use crate::{
    find_exact_usable_knowledge_multimodal_model, infer_preview_type,
    load_knowledge_collection_multimodal_config, load_knowledge_multimodal_config,
    validate_knowledge_multimodal_upload, KnowledgeCollectionMultimodalConfigRecord,
    KnowledgeMultimodalModelConfigRecord,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use regex::Regex;
use reqwest::blocking::{multipart, Client as BlockingHttpClient};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
    time::{SystemTime, UNIX_EPOCH},
};

use super::*;

pub(crate) fn open_pipeline_connection(app: &tauri::AppHandle) -> Result<Connection, String> {
    crate::open_sqlite_connection(app)
}

/// worker tick 复用的长连接。
///
/// tick 每 750ms 触发一次，若每次都新建 SQLite 连接会带来可观的打开/PRAGMA 开销，
/// 因此在进程内缓存一条连接。锁中毒（持锁线程 panic）时直接恢复内部值，
/// 避免一次偶发 panic 导致后续所有 tick 永久失败。
pub(crate) fn pipeline_tick_connection(
    app: &tauri::AppHandle,
) -> Result<std::sync::MutexGuard<'static, Connection>, String> {
    static PIPELINE_TICK_CONNECTION: OnceLock<std::sync::Mutex<Connection>> = OnceLock::new();

    if let Some(cell) = PIPELINE_TICK_CONNECTION.get() {
        return Ok(cell.lock().unwrap_or_else(|poisoned| poisoned.into_inner()));
    }

    let connection = crate::open_sqlite_connection(app)?;
    let cell = PIPELINE_TICK_CONNECTION.get_or_init(|| std::sync::Mutex::new(connection));
    Ok(cell.lock().unwrap_or_else(|poisoned| poisoned.into_inner()))
}
