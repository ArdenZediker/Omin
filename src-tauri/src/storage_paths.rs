//! 统一的数据根目录解析。
//!
//! 优先级：用户在设置里指定的自定义路径 > 便携模式（exe 同级 data 目录）> 默认 AppData。
//! 配置本身存在 `app_config_dir()`（固定位置），**不跟着数据目录一起搬**，
//! 否则切换路径后配置会一起被复制走，出现自举问题。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

const DATA_ROOT_CONFIG_FILE: &str = "data-root.json";
const PORTABLE_DIR_NAME: &str = "data";
const DB_FILE_NAME: &str = "omni.sqlite3";
const KNOWLEDGE_DIR_NAME: &str = "knowledge_files";
/// 会话目录根名。单一事实来源：chat_sessions_root() 与 DataRootInfo.chat_sessions_path 共用，
/// 前端据此把产出/附件写进会话目录（勿在别处再写字面量）。
const CHAT_SESSIONS_DIR_NAME: &str = "chat-sessions";
/// 工具超长输出的完整副本落盘目录（对齐 deepseek-harness 的 spillPath）。
const TOOL_OUTPUT_DIR_NAME: &str = "tool-output";
const PASTED_ATTACHMENTS_DIR_NAME: &str = "pasted-attachments";

/// 已知云同步目录标记（小写比对）。SQLite 的 WAL 模式在这些目录下会静默损坏。
const SYNC_DIR_MARKERS: &[&str] = &[
    "onedrive",
    "dropbox",
    "icloud",
    "nutstore",
    "jianguoyun",
    "baidunetdisk",
    "googledrive",
    "megasync",
    "pcloud",
    "syncthing",
    "坚果云",
    "百度网盘",
    "天翼云",
    "腾讯微云",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DataRootConfig {
    #[serde(default)]
    path: String,
    #[serde(default)]
    updated_at: Option<i64>,
    /// Explicitly return to the platform default without deleting config non-atomically.
    #[serde(default)]
    reset_to_default: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DataRootSource {
    /// 用户在设置里指定的目录
    Custom,
    /// exe 同级 data 目录（绿色版 / 便携模式）
    Portable,
    /// 系统应用数据目录
    Default,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DataRootInfo {
    pub(crate) path: String,
    pub(crate) source: DataRootSource,
    pub(crate) writable: bool,
    pub(crate) database_path: String,
    pub(crate) knowledge_path: String,
    /// 会话目录根（<data_root>/chat-sessions）。前端把该会话的产出与附件快照写进
    /// `<chat_sessions_path>/<sessionId>/`，实现「一个会话一个自包含目录」——
    /// 备份天然覆盖、删除会话即一次 remove_dir_all，不会有跨根孤儿。
    pub(crate) chat_sessions_path: String,
    pub(crate) pending_restart: bool,
    /// 期望用自定义/便携路径、但实际回退到了默认位置时的原因
    #[serde(default)]
    pub(crate) fallback_reason: Option<String>,
}

fn config_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir.join(DATA_ROOT_CONFIG_FILE))
}

/// 危险路径检测：网络盘 / 云同步目录。返回 Some(原因) 表示不该往这里放 SQLite。
pub(crate) fn path_risk(path: &Path) -> Option<String> {
    let raw = path.to_string_lossy().to_string();
    let local_verbatim = raw.strip_prefix(r"\\?\").is_some_and(|rest| {
        rest.as_bytes().get(1) == Some(&b':')
            && rest
                .as_bytes()
                .get(2)
                .is_some_and(|separator| *separator == b'\\' || *separator == b'/')
            && rest.as_bytes()[0].is_ascii_alphabetic()
    });
    if !local_verbatim && (raw.starts_with(r"\\") || raw.starts_with("//")) {
        return Some("不支持网络路径（UNC），数据库可能损坏".to_string());
    }
    let lower = raw.to_lowercase();
    for marker in SYNC_DIR_MARKERS {
        if lower.contains(marker) {
            return Some(format!("疑似云同步目录（{}），数据库可能损坏", marker));
        }
    }
    None
}

/// 可写性探针：建目录 → 写文件 → 读回 → 删除。
pub(crate) fn ensure_writable(dir: &Path) -> Result<(), String> {
    match fs::metadata(dir) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => return Err("目标路径不是目录".to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(dir).map_err(|err| format!("无法创建目录：{}", err))?;
        }
        Err(err) => return Err(format!("无法读取目录：{}", err)),
    }
    let probe = dir.join(format!(".omni-write-probe-{}", uuid::Uuid::new_v4()));
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|err| format!("目录不可写：{}", err))?;
    file.write_all(b"omni")
        .map_err(|err| format!("目录不可写：{}", err))?;
    drop(file);
    let read_back = fs::read(&probe).map_err(|err| format!("目录读取失败：{}", err))?;
    fs::remove_file(&probe).map_err(|err| format!("无法清理测试文件：{}", err))?;
    if read_back != b"omni" {
        return Err("目录写入校验失败".to_string());
    }
    Ok(())
}

fn read_custom_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    let file = config_file_path(app).ok()?;
    read_custom_root_file(&file)
}

fn read_custom_root_file(file: &Path) -> Option<PathBuf> {
    let raw = fs::read_to_string(&file).ok()?;
    let config: DataRootConfig = serde_json::from_str(&raw).ok()?;
    if config.reset_to_default || config.path.trim().is_empty() {
        return None;
    }
    Some(PathBuf::from(config.path.trim()))
}

fn write_custom_root(app: &tauri::AppHandle, path: &Path) -> Result<(), String> {
    let file = config_file_path(app)?;
    write_root_config_file(&file, Some(path), replace_config_file)
}

fn write_default_root(app: &tauri::AppHandle) -> Result<(), String> {
    let file = config_file_path(app)?;
    write_root_config_file(&file, None, replace_config_file)
}

fn write_root_config_file(
    file: &Path,
    path: Option<&Path>,
    replace: impl FnOnce(&Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    let config = DataRootConfig {
        path: path.map_or_else(String::new, |value| value.to_string_lossy().to_string()),
        updated_at: Some(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_millis() as i64)
                .unwrap_or(0),
        ),
        reset_to_default: path.is_none(),
    };
    let raw = serde_json::to_vec_pretty(&config).map_err(|err| err.to_string())?;
    atomic_write_config(file, &raw, replace)
}

fn atomic_write_config(
    file: &Path,
    contents: &[u8],
    replace: impl FnOnce(&Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    let temporary = file.with_file_name(format!(".data-root-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|err| err.to_string())?;
        use std::io::Write;
        output.write_all(contents).map_err(|err| err.to_string())?;
        output.sync_all().map_err(|err| err.to_string())?;
        drop(output);
        replace(&temporary, file)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(windows)]
fn replace_config_file(temporary: &Path, file: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = file.as_os_str().encode_wide().chain(Some(0)).collect();
    let replaced = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        return Err(format!(
            "提交数据根配置失败，旧配置未改变：{}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_config_file(temporary: &Path, file: &Path) -> Result<(), String> {
    fs::rename(temporary, file).map_err(|err| format!("提交数据根配置失败，旧配置未改变：{err}"))
}

fn restore_process_root() -> &'static Mutex<Option<PathBuf>> {
    static ROOT: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    ROOT.get_or_init(|| Mutex::new(None))
}

/// 恢复只改变下次启动的根。当前进程中的旧窗口、队列和打开的连接继续指向旧根。
pub(crate) fn pin_current_root_for_restore(root: PathBuf) {
    *restore_process_root()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(root);
}

pub(crate) fn require_no_pending_root_change() -> Result<(), String> {
    if restore_process_root()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .is_some()
    {
        return Err("数据目录已变更，请先重启应用，再次修改存储位置".to_string());
    }
    Ok(())
}

/// 便携模式仅在 release 构建下启用，避免开发时把数据搬到 target/debug/data。
/// 开发调试可用环境变量 OMNI_PORTABLE=1 强制开启。
fn portable_enabled() -> bool {
    !cfg!(debug_assertions) || std::env::var("OMNI_PORTABLE").is_ok()
}

fn portable_root(_app: &tauri::AppHandle) -> Option<PathBuf> {
    if !portable_enabled() {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    Some(dir.join(PORTABLE_DIR_NAME))
}

/// 实际生效的数据根目录 + 来源 + 回退原因。
fn resolve_with_source(
    app: &tauri::AppHandle,
) -> Result<(PathBuf, DataRootSource, Option<String>), String> {
    if let Some(custom) = read_custom_root(app) {
        match ensure_writable(&custom) {
            Ok(()) => return Ok((custom, DataRootSource::Custom, None)),
            Err(err) => {
                let reason = format!("自定义数据目录不可用（{}），已临时使用默认位置", err);
                let fallback = default_root(app)?;
                return Ok((fallback, DataRootSource::Default, Some(reason)));
            }
        }
    }

    if let Some(portable) = portable_root(app) {
        if path_risk(&portable).is_none() && ensure_writable(&portable).is_ok() {
            return Ok((portable, DataRootSource::Portable, None));
        }
    }

    let fallback = default_root(app)?;
    Ok((fallback, DataRootSource::Default, None))
}

fn default_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

/// 统一入口：所有需要落盘的地方都走这里。
pub(crate) fn resolve_data_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(root) = restore_process_root()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
    {
        return Ok(root.clone());
    }
    let (root, _source, _reason) = resolve_with_source(app)?;
    Ok(root)
}

pub(crate) fn database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = resolve_data_root(app)?;
    fs::create_dir_all(&root).map_err(|err| err.to_string())?;
    Ok(root.join(DB_FILE_NAME))
}

pub(crate) fn knowledge_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = resolve_data_root(app)?;
    let dir = root.join(KNOWLEDGE_DIR_NAME);
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

/// 粘贴附件的临时根目录：用户从剪贴板直接粘贴文件时，前端拿不到本地绝对路径，
/// 只能得到二进制内容；Rust 侧把它写到应用数据目录下，返回绝对路径供 /read_file 使用。
pub(crate) fn pasted_attachments_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = resolve_data_root(app)?;
    let dir = root.join(PASTED_ATTACHMENTS_DIR_NAME);
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

/// 对话消息的权威存储目录：每个会话一个独立子目录，内部为 session.jsonl 事件日志。
/// SQLite 的 chat_sessions 表只存会话元数据，消息实体落盘到这里，
/// 规避「整 blob 重写」的脆弱形态，并实现崩溃隔离与按会话级读写。
pub(crate) fn chat_sessions_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = resolve_data_root(app)?;
    let dir = root.join(CHAT_SESSIONS_DIR_NAME);
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

/// 兜底工作目录（fallback workspace）。
///
/// 仿 codex 的 `~/.codex`：任何未显式绑定工作空间的会话/项目，其文件操作都落到这里，
/// 保证「不指定空间也能对话、也能执行 /bash、/write_file 等文件工具」——永远有一个 cwd。
/// 该目录位于数据根下，属应用自有目录，天然避开 No-Go Zone 与云同步目录风险。
pub(crate) fn fallback_workspace_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = resolve_data_root(app)?;
    let dir = root.join("fallback-workspace");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

/// 工具超长输出的完整副本落盘目录：shell 输出超出上下文预算被截断时，
/// 完整内容写到这里，截断提示里附上绝对路径供按需回读（截断 ≠ 丢弃）。
pub(crate) fn tool_output_spill_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = resolve_data_root(app)?;
    let dir = root.join(TOOL_OUTPUT_DIR_NAME);
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

pub(crate) fn data_root_info(app: &tauri::AppHandle) -> Result<DataRootInfo, String> {
    let (configured_root, source, fallback_reason) = resolve_with_source(app)?;
    let active_root = restore_process_root()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let pending_restore = active_root
        .as_ref()
        .is_some_and(|root| root != &configured_root);
    let root = active_root.unwrap_or(configured_root.clone());
    let fallback_reason = if pending_restore {
        Some(format!(
            "数据目录已准备切换到 {}；重启后生效，当前进程仍使用原目录。",
            configured_root.display()
        ))
    } else {
        fallback_reason
    };
    Ok(DataRootInfo {
        database_path: root.join(DB_FILE_NAME).to_string_lossy().to_string(),
        knowledge_path: root.join(KNOWLEDGE_DIR_NAME).to_string_lossy().to_string(),
        chat_sessions_path: root
            .join(CHAT_SESSIONS_DIR_NAME)
            .to_string_lossy()
            .to_string(),
        pending_restart: pending_restore,
        writable: ensure_writable(&root).is_ok(),
        path: root.to_string_lossy().to_string(),
        source,
        fallback_reason,
    })
}

/// 切换到新的数据目录：校验 → 复制 → 校验副本 → 写配置。
/// 目标必须为空；旧数据保持不变，进程重启后才切换到新目录。
pub(crate) fn set_custom_root(
    app: &tauri::AppHandle,
    raw_path: &str,
) -> Result<DataRootInfo, String> {
    let target = PathBuf::from(raw_path.trim());
    if target.as_os_str().is_empty() {
        return Err("路径不能为空".to_string());
    }
    if let Some(reason) = path_risk(&target) {
        return Err(reason);
    }
    let current = resolve_data_root(app)?;
    migrate_then_commit(&current, &target, |target| {
        commit_custom_root_config(app, target)
    })?;
    pin_current_root_for_restore(current);
    data_root_info(app)
}

/// A failed config update leaves the live root untouched and the published copy
/// available for manual retry. The caller pins the live root only after success.
fn migrate_then_commit(
    current: &Path,
    target: &Path,
    commit: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<PathBuf, String> {
    let target = crate::backup::migrate_snapshot(current, target)?;
    commit(&target)?;
    Ok(target)
}

/// 直接把某个目录登记为数据根（写入配置 + 返回信息）。不复制任何数据，
/// 由调用方保证目标目录已经准备好（迁移 / 备份恢复场景）。
pub(crate) fn commit_custom_root_config(
    app: &tauri::AppHandle,
    target: &Path,
) -> Result<(), String> {
    if let Some(reason) = path_risk(target) {
        return Err(reason);
    }
    ensure_writable(target)?;
    write_custom_root(app, target)
}

/// 回到「跟随软件安装位置 / 系统默认目录」，不再使用自定义路径。
pub(crate) fn clear_custom_root(app: &tauri::AppHandle) -> Result<DataRootInfo, String> {
    let current = resolve_data_root(app)?;
    let target = if let Some(portable) = portable_root(app).filter(|path| path_risk(path).is_none())
    {
        if ensure_writable(&portable).is_ok() {
            portable
        } else {
            default_root(app)?
        }
    } else {
        default_root(app)?
    };
    let canonical_current = fs::canonicalize(&current).unwrap_or_else(|_| current.clone());
    let canonical_target = fs::canonicalize(&target).unwrap_or_else(|_| target.clone());
    if canonical_current != canonical_target {
        migrate_then_commit(&current, &target, |_| write_default_root(app))?;
    } else {
        write_default_root(app)?;
    }
    if canonical_current != canonical_target {
        pin_current_root_for_restore(current);
    }
    data_root_info(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbatim_local_drive_is_not_mistaken_for_unc() {
        assert!(path_risk(Path::new(r"\\?\C:\OmniData")).is_none());
        assert!(path_risk(Path::new(r"\\?\UNC\server\share")).is_some());
        assert!(path_risk(Path::new(r"\\server\share")).is_some());
    }

    #[test]
    fn ensure_writable_accepts_existing_directory_without_recreating_it() {
        let dir = std::env::temp_dir().join(format!("omni-writable-dir-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        ensure_writable(&dir).unwrap();
        assert!(dir.is_dir());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn ensure_writable_rejects_existing_file_without_changing_it() {
        let dir = std::env::temp_dir().join(format!("omni-writable-file-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let file = dir.join("not-a-directory");
        fs::write(&file, b"keep").unwrap();
        assert_eq!(ensure_writable(&file).unwrap_err(), "目标路径不是目录");
        assert_eq!(fs::read(&file).unwrap(), b"keep");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_atomic_config_replacement_preserves_old_bytes_and_cleans_temp() {
        let dir =
            std::env::temp_dir().join(format!("omni-config-write-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let file = dir.join("data-root.json");
        fs::write(&file, b"old config bytes").unwrap();
        let result = atomic_write_config(&file, b"new config bytes", |_, _| {
            Err("injected replace failure".into())
        });
        assert_eq!(result.unwrap_err(), "injected replace failure");
        assert_eq!(fs::read(&file).unwrap(), b"old config bytes");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn default_root_marker_replaces_custom_root_without_deleting_config() {
        let dir =
            std::env::temp_dir().join(format!("omni-root-reset-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let file = dir.join(DATA_ROOT_CONFIG_FILE);
        let previous_root = dir.join("old-root");
        write_root_config_file(&file, Some(&previous_root), replace_config_file).unwrap();
        assert_eq!(read_custom_root_file(&file), Some(previous_root));
        write_root_config_file(&file, None, replace_config_file).unwrap();
        assert!(file.is_file());
        assert_eq!(read_custom_root_file(&file), None);
        let config: DataRootConfig = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert!(config.reset_to_default);
        assert!(config.path.is_empty());
        // Legacy custom-root files that omit the new flag remain custom-root configs.
        let legacy: DataRootConfig = serde_json::from_str(r#"{"path":"D:\\OmniData"}"#).unwrap();
        assert!(!legacy.reset_to_default);
        assert_eq!(legacy.path, r"D:\OmniData");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_default_root_commit_keeps_prior_custom_root_and_config_bytes() {
        let dir =
            std::env::temp_dir().join(format!("omni-root-reset-failure-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let file = dir.join(DATA_ROOT_CONFIG_FILE);
        let previous_root = dir.join("old-root");
        write_root_config_file(&file, Some(&previous_root), replace_config_file).unwrap();
        let previous_bytes = fs::read(&file).unwrap();
        let failure = write_root_config_file(&file, None, |_, _| Err("reset commit failed".into()));
        assert_eq!(failure.unwrap_err(), "reset commit failed");
        assert_eq!(read_custom_root_file(&file), Some(previous_root));
        assert_eq!(fs::read(&file).unwrap(), previous_bytes);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_config_commit_leaves_original_data_and_published_copy() {
        let fixture =
            std::env::temp_dir().join(format!("omni-root-commit-test-{}", uuid::Uuid::new_v4()));
        let source = fixture.join("source");
        let target = fixture.join("target");
        fs::create_dir_all(&source).unwrap();
        let connection = rusqlite::Connection::open(source.join(DB_FILE_NAME)).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE value (content TEXT); INSERT INTO value VALUES ('original');",
            )
            .unwrap();
        drop(connection);

        let failure =
            migrate_then_commit(&source, &target, |_| Err("配置写入失败".into())).unwrap_err();
        assert_eq!(failure, "配置写入失败");
        for root in [&source, &target] {
            let connection = rusqlite::Connection::open(root.join(DB_FILE_NAME)).unwrap();
            let content: String = connection
                .query_row("SELECT content FROM value", [], |row| row.get(0))
                .unwrap();
            assert_eq!(content, "original");
        }
        fs::remove_dir_all(fixture).unwrap();
    }
}
