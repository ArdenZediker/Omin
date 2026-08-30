//! SQLite 连接获取：一次性连接与 worker tick 复用连接。
//!
//! 由 knowledge_pipeline 单文件拆分而来，保持逻辑不变。

use rusqlite::Connection;
use std::sync::OnceLock;


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
