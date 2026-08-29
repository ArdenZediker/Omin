//! 统一的数据根目录解析。
//!
//! 优先级：用户在设置里指定的自定义路径 > 便携模式（exe 同级 data 目录）> 默认 AppData。
//! 配置本身存在 `app_config_dir()`（固定位置），**不跟着数据目录一起搬**，
//! 否则切换路径后配置会一起被复制走，出现自举问题。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

const DATA_ROOT_CONFIG_FILE: &str = "data-root.json";
const PORTABLE_DIR_NAME: &str = "data";
const DB_FILE_NAME: &str = "omni.sqlite3";
const KNOWLEDGE_DIR_NAME: &str = "knowledge_files";
const WRITE_PROBE_NAME: &str = ".omni-write-probe";

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
    path: String,
    #[serde(default)]
    updated_at: Option<i64>,
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
    if raw.starts_with(r"\\") || raw.starts_with("//") {
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
    fs::create_dir_all(dir).map_err(|err| format!("无法创建目录：{}", err))?;
    let probe = dir.join(WRITE_PROBE_NAME);
    fs::write(&probe, b"omni").map_err(|err| format!("目录不可写：{}", err))?;
    let read_back = fs::read(&probe).map_err(|err| format!("目录读取失败：{}", err))?;
    fs::remove_file(&probe).map_err(|err| format!("无法清理测试文件：{}", err))?;
    if read_back != b"omni" {
        return Err("目录写入校验失败".to_string());
    }
    Ok(())
}

fn read_custom_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    let file = config_file_path(app).ok()?;
    let raw = fs::read_to_string(&file).ok()?;
    let config: DataRootConfig = serde_json::from_str(&raw).ok()?;
    if config.path.trim().is_empty() {
        return None;
    }
    Some(PathBuf::from(config.path.trim()))
}

fn write_custom_root(app: &tauri::AppHandle, path: &Path) -> Result<(), String> {
    let file = config_file_path(app)?;
    let config = DataRootConfig {
        path: path.to_string_lossy().to_string(),
        updated_at: Some(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_millis() as i64)
                .unwrap_or(0),
        ),
    };
    let raw = serde_json::to_string_pretty(&config).map_err(|err| err.to_string())?;
    fs::write(&file, raw).map_err(|err| err.to_string())
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
fn resolve_with_source(app: &tauri::AppHandle) -> Result<(PathBuf, DataRootSource, Option<String>), String> {
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

pub(crate) fn data_root_info(app: &tauri::AppHandle) -> Result<DataRootInfo, String> {
    let (root, source, fallback_reason) = resolve_with_source(app)?;
    Ok(DataRootInfo {
        database_path: root.join(DB_FILE_NAME).to_string_lossy().to_string(),
        knowledge_path: root.join(KNOWLEDGE_DIR_NAME).to_string_lossy().to_string(),
        writable: ensure_writable(&root).is_ok(),
        path: root.to_string_lossy().to_string(),
        source,
        fallback_reason,
    })
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|err| err.to_string())?;
    let entries = fs::read_dir(src).map_err(|err| err.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|err| err.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

fn dir_stats(dir: &Path) -> Result<(u64, u64), String> {
    let mut count = 0u64;
    let mut bytes = 0u64;
    if !dir.exists() {
        return Ok((0, 0));
    }
    let entries = fs::read_dir(dir).map_err(|err| err.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            let (inner_count, inner_bytes) = dir_stats(&path)?;
            count += inner_count;
            bytes += inner_bytes;
        } else {
            count += 1;
            bytes += entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        }
    }
    Ok((count, bytes))
}

fn sqlite_integrity_ok(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let connection = rusqlite::Connection::open(path).map_err(|err| format!("无法打开数据库副本：{}", err))?;
    let result: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|err| format!("完整性检查失败：{}", err))?;
    if result.trim().to_lowercase() != "ok" {
        return Err(format!("完整性检查未通过：{}", result));
    }
    Ok(())
}

/// 切换到新的数据目录：校验 → 复制 → 校验副本 → 写配置。
/// 任一步失败都会返回 Err，旧数据保持原样不动。
pub(crate) fn set_custom_root(app: &tauri::AppHandle, raw_path: &str) -> Result<DataRootInfo, String> {
    let target = PathBuf::from(raw_path.trim());
    if target.as_os_str().is_empty() {
        return Err("路径不能为空".to_string());
    }
    if let Some(reason) = path_risk(&target) {
        return Err(reason);
    }
    ensure_writable(&target)?;

    let current = resolve_data_root(app)?;
    let canonical_current = fs::canonicalize(&current).unwrap_or_else(|_| current.clone());
    let canonical_target = fs::canonicalize(&target).unwrap_or_else(|_| target.clone());
    if canonical_current == canonical_target {
        return Err("新目录与当前数据目录相同".to_string());
    }

    // ① 复制数据库（含 WAL / SHM 旁路文件）
    let source_db = current.join(DB_FILE_NAME);
    let target_db = target.join(DB_FILE_NAME);
    if source_db.exists() {
        fs::copy(&source_db, &target_db).map_err(|err| format!("复制数据库失败：{}", err))?;
        for suffix in ["-wal", "-shm"] {
            let with_suffix = PathBuf::from(format!("{}{}", source_db.to_string_lossy(), suffix));
            if with_suffix.exists() {
                let destination =
                    PathBuf::from(format!("{}{}", target_db.to_string_lossy(), suffix));
                fs::copy(&with_suffix, &destination).map_err(|err| {
                    format!("复制数据库旁路文件失败：{}", err)
                })?;
            }
        }
    }

    // ② 复制知识库文件
    let source_knowledge = current.join(KNOWLEDGE_DIR_NAME);
    let target_knowledge = target.join(KNOWLEDGE_DIR_NAME);
    if source_knowledge.exists() {
        copy_dir_recursive(&source_knowledge, &target_knowledge)
            .map_err(|err| format!("复制知识库文件失败：{}", err))?;
    }

    // ③ 校验副本：文件数 + 字节数 + SQLite 完整性
    let (source_count, source_bytes) = dir_stats(&current)?;
    let (target_count, target_bytes) = dir_stats(&target)?;
    if target_count < source_count || target_bytes < source_bytes {
        let _ = fs::remove_dir_all(&target);
        return Err(format!(
            "副本不完整（源文件 {} 个 / {} 字节，副本 {} 个 / {} 字节），已回退",
            source_count, source_bytes, target_count, target_bytes
        ));
    }
    if let Err(err) = sqlite_integrity_ok(&target_db) {
        let _ = fs::remove_dir_all(&target);
        return Err(format!("{}，已回退", err));
    }

    // ④ 写入配置（旧目录保留，等用户确认后再手动清理）
    commit_custom_root(app, &target)
}

/// 直接把某个目录登记为数据根（写入配置 + 返回信息）。不复制任何数据，
/// 由调用方保证目标目录已经准备好（迁移 / 备份恢复场景）。
pub(crate) fn commit_custom_root(app: &tauri::AppHandle, target: &Path) -> Result<DataRootInfo, String> {
    if let Some(reason) = path_risk(target) {
        return Err(reason);
    }
    ensure_writable(target)?;
    write_custom_root(app, target)?;
    data_root_info(app)
}

/// 回到「跟随软件安装位置 / 系统默认目录」，不再使用自定义路径。
pub(crate) fn clear_custom_root(app: &tauri::AppHandle) -> Result<DataRootInfo, String> {
    let file = config_file_path(app)?;
    if file.exists() {
        fs::remove_file(&file).map_err(|err| err.to_string())?;
    }
    data_root_info(app)
}
