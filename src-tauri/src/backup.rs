//! Consistent snapshots and staged restore. Activation is deferred to next startup.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use zip::write::FileOptions;
#[cfg(test)]
#[path = "backup_tests.rs"]
mod tests;

pub(crate) const BACKUP_FORMAT_VERSION: u32 = 2;
pub(crate) const MANIFEST_NAME: &str = "omni-backup-manifest.json";
const DB_FILE_NAME: &str = "omni.sqlite3";
const DATA_DIRS: &[&str] = &[
    "knowledge_files",
    "chat-sessions",
    "pasted-attachments",
    "persona",
    "fallback-workspace",
    "tool-output",
    "clipboard_cache",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct FileStamp {
    size: u64,
    sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupManifest {
    pub app: String,
    pub format_version: u32,
    pub app_version: String,
    #[serde(default)]
    pub created_at: i64,
    pub encrypted: bool,
    #[serde(default)]
    pub source_root: Option<String>,
    #[serde(default)]
    pub files: BTreeMap<String, FileStamp>,
}

/// Drop only removes the unique directory created by this operation.
pub(crate) struct Staging {
    pub(crate) path: PathBuf,
}
impl Staging {
    pub(crate) fn beside(target: &Path) -> Result<Self, String> {
        let parent = target.parent().ok_or("目标缺少父目录")?;
        let path = parent.join(format!(".omni-staging-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).map_err(|e| format!("无法创建临时目录：{e}"))?;
        Ok(Self { path })
    }
}
impl Drop for Staging {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn is_link(meta: &fs::Metadata) -> bool {
    let link = meta.file_type().is_symlink();
    #[cfg(windows)]
    let link = {
        use std::os::windows::fs::MetadataExt;
        link || meta.file_attributes() & 0x400 != 0
    };
    link
}

fn reject_link(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if is_link(&meta) {
        return Err(format!("不允许符号链接或目录联接：{}", path.display()));
    }
    Ok(())
}

/// macOS exposes its temporary directory as `/var/...`, while `/var` itself
/// is a system-owned symlink to `/private/var`. Those root aliases are safe to
/// traverse; user-selected paths elsewhere retain the strict no-link policy.
#[cfg(target_os = "macos")]
fn is_system_root_alias(path: &Path) -> bool {
    matches!(path.to_str(), Some("/var" | "/tmp"))
}

#[cfg(not(target_os = "macos"))]
fn is_system_root_alias(_path: &Path) -> bool {
    false
}

pub(crate) fn checked_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("必须使用绝对路径".into());
    }
    let mut current = PathBuf::new();
    for component in path.components() {
        if matches!(component, Component::ParentDir | Component::CurDir) {
            return Err("路径不能包含 . 或 ..".into());
        }
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(meta) if is_link(&meta) && !is_system_root_alias(&current) => {
                return Err(format!("不允许符号链接或目录联接：{}", current.display()));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    if path.exists() {
        return fs::canonicalize(path).map_err(|e| e.to_string());
    }
    let parent = path.parent().ok_or("目标缺少父目录")?;
    let parent = fs::canonicalize(parent).map_err(|e| format!("目标父目录必须存在：{e}"))?;
    Ok(parent.join(path.file_name().ok_or("目标不能是磁盘根目录")?))
}

fn path_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    let value = value
        .strip_prefix("//?/")
        .unwrap_or(&value)
        .trim_end_matches('/');
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value.to_string()
    }
}
pub(crate) fn validate_new_target(current: &Path, target: &Path) -> Result<PathBuf, String> {
    let current = checked_path(current).map_err(|e| format!("当前数据目录路径无效：{e}"))?;
    let target = checked_path(target).map_err(|e| format!("目标路径无效：{e}"))?;
    let a = path_key(&current);
    let b = path_key(&target);
    if a == b || a.starts_with(&(b.clone() + "/")) || b.starts_with(&(a + "/")) {
        return Err("恢复目标不能是当前数据目录或其父子目录".into());
    }
    require_empty(&target)?;
    Ok(target)
}
fn require_empty(path: &Path) -> Result<(), String> {
    if path.exists() {
        reject_link(path)?;
        if !path.is_dir()
            || fs::read_dir(path)
                .map_err(|e| e.to_string())?
                .next()
                .is_some()
        {
            return Err("恢复仅允许空的新目录，现有文件不会被覆盖".into());
        }
    }
    Ok(())
}
fn base_options(secret: Option<&str>) -> FileOptions<'_, ()> {
    let options = FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    match secret.filter(|s| !s.is_empty()) {
        Some(password) => options.with_aes_encryption(zip::AesMode::Aes256, password),
        None => options,
    }
}

/// Portable ZIP names, rejecting NTFS ADS, reserved devices and case aliases too.
fn sanitize_entry(name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.starts_with('/') || name.contains(['\\', ':', '\0']) {
        return Err(format!("备份条目包含非法路径：{name}"));
    }
    let trimmed = name.strip_suffix('/').unwrap_or(name);
    for part in trimmed.split('/') {
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        let device = matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        ) || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && matches!(stem.as_bytes()[3], b'1'..=b'9'));
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with(['.', ' '])
            || device
            || part
                .chars()
                .any(|c| c.is_control() || "<>\"|?*".contains(c))
        {
            return Err(format!("备份条目包含非法路径：{name}"));
        }
    }
    Ok(PathBuf::from(trimmed))
}
fn collect_files(root: &Path, dir: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    reject_link(dir)?;
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        reject_link(&path)?;
        let name = path
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        sanitize_entry(&name)?;
        if path.is_dir() {
            collect_files(root, &path, files)?;
        } else if path.is_file() {
            files.push(path);
        } else {
            return Err(format!("不支持的文件类型：{}", path.display()));
        }
    }
    Ok(())
}
fn digest(path: &Path) -> Result<FileStamp, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut size = 0;
    let mut buffer = [0u8; 65536];
    loop {
        let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
        size += read as u64;
    }
    Ok(FileStamp {
        size,
        sha256: format!("{:x}", hash.finalize()),
    })
}

/// Caller holds maintenance across SQLite and the associated file stores.
pub(crate) fn copy_snapshot(source: &Path, staging: &Path) -> Result<(), String> {
    reject_link(&source.join(DB_FILE_NAME))?;
    crate::database::snapshot_database(&source.join(DB_FILE_NAME), &staging.join(DB_FILE_NAME))?;
    let mut files = Vec::new();
    for name in DATA_DIRS {
        let dir = source.join(name);
        if dir.exists() {
            collect_files(source, &dir, &mut files)?;
        }
    }
    for file in files {
        let target = staging.join(file.strip_prefix(source).map_err(|e| e.to_string())?);
        fs::create_dir_all(target.parent().ok_or("缺少父目录")?).map_err(|e| e.to_string())?;
        fs::copy(&file, &target).map_err(|e| e.to_string())?;
        fs::OpenOptions::new()
            .write(true)
            .open(&target)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
    }
    validate_data(staging, Some(source), None)
}

/// Copy a live data root to a new empty directory without publishing partial data.
/// The caller holds the exclusive maintenance gate until the root config is committed.
pub(crate) fn migrate_snapshot(source_root: &Path, target_root: &Path) -> Result<PathBuf, String> {
    let target =
        validate_new_target(source_root, target_root).map_err(|e| format!("迁移目标无效：{e}"))?;
    let source = checked_path(source_root).map_err(|e| format!("迁移源路径无效：{e}"))?;
    let staging = Staging::beside(&target).map_err(|e| format!("无法创建迁移暂存区：{e}"))?;
    copy_snapshot(&source, &staging.path).map_err(|e| format!("创建迁移快照失败：{e}"))?;
    validate_data(&staging.path, Some(&source), Some(&target))
        .map_err(|e| format!("迁移数据校验失败：{e}"))?;
    sync_files(&staging.path)?;
    publish_restore(&staging.path, &target).map_err(|e| format!("迁移目录发布失败：{e}"))?;
    Ok(target)
}

pub(crate) fn build_backup(
    source_root: &Path,
    target_zip: &Path,
    secret: Option<&str>,
) -> Result<BackupManifest, String> {
    let source = checked_path(source_root)?;
    let target = checked_path(target_zip)?;
    if path_key(&target).starts_with(&(path_key(&source) + "/")) || source == target {
        return Err("备份文件必须保存在数据目录之外".into());
    }
    let staging = Staging::beside(&target)?;
    let snapshot = staging.path.join("snapshot");
    fs::create_dir(&snapshot).map_err(|e| e.to_string())?;
    copy_snapshot(&source, &snapshot).map_err(|e| format!("创建数据快照失败：{e}"))?;
    let mut files = Vec::new();
    collect_files(&snapshot, &snapshot, &mut files)
        .map_err(|e| format!("枚举快照文件失败：{e}"))?;
    let mut manifest = BackupManifest {
        app: "omni".into(),
        format_version: BACKUP_FORMAT_VERSION,
        app_version: env!("CARGO_PKG_VERSION").into(),
        created_at: crate::current_timestamp_ms(),
        encrypted: secret.is_some_and(|s| !s.is_empty()),
        source_root: Some(source.to_string_lossy().into_owned()),
        files: BTreeMap::new(),
    };
    let partial = staging.path.join("archive.zip");
    let mut zip = zip::ZipWriter::new(fs::File::create(&partial).map_err(|e| e.to_string())?);
    for file in files {
        let name = file
            .strip_prefix(&snapshot)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        manifest.files.insert(name.clone(), digest(&file)?);
        zip.start_file(name, base_options(secret))
            .map_err(|e| e.to_string())?;
        std::io::copy(
            &mut fs::File::open(&file).map_err(|e| e.to_string())?,
            &mut zip,
        )
        .map_err(|e| e.to_string())?;
    }
    zip.start_file(MANIFEST_NAME, base_options(secret))
        .map_err(|e| e.to_string())?;
    zip.write_all(&serde_json::to_vec(&manifest).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    zip.finish()
        .map_err(|e| e.to_string())?
        .sync_all()
        .map_err(|e| e.to_string())?;
    fs::rename(&partial, &target).map_err(|e| format!("无法提交备份（旧备份保留）：{e}"))?;
    Ok(manifest)
}

fn has_table(connection: &rusqlite::Connection, name: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
            [name],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n != 0)
        .map_err(|e| e.to_string())
}
fn internal_relative(value: &str, source: Option<&Path>) -> Result<Option<PathBuf>, String> {
    let value = value.replace('\\', "/");
    let value = value.strip_prefix("//?/").unwrap_or(&value);
    if let Some(source) = source {
        // Stored paths may use an alias that canonicalization later rewrites
        // (notably macOS `/var` -> `/private/var`). Compare canonical paths
        // when both sides still exist, then fall back to lexical matching for
        // backups restored from a machine that no longer has the old root.
        if let (Ok(canonical_value), Ok(canonical_source)) =
            (fs::canonicalize(value), fs::canonicalize(source))
        {
            if let Ok(relative) = canonical_value.strip_prefix(&canonical_source) {
                return sanitize_entry(&relative.to_string_lossy().replace('\\', "/")).map(Some);
            }
        }
        let root = source.to_string_lossy().replace('\\', "/");
        let root = root
            .strip_prefix("//?/")
            .unwrap_or(&root)
            .trim_end_matches('/');
        let windows = root.as_bytes().get(1) == Some(&b':');
        let prefix = format!("{root}/");
        let matches = if windows {
            value.to_lowercase().starts_with(&prefix.to_lowercase())
        } else {
            value.starts_with(&prefix)
        };
        if matches {
            return sanitize_entry(&value[prefix.len()..]).map(Some);
        }
    }
    if DATA_DIRS
        .iter()
        .any(|d| value.starts_with(&format!("{d}/")))
    {
        return sanitize_entry(value).map(Some);
    }
    Ok(None)
}
fn rewrite_json_paths(
    value: &mut serde_json::Value,
    staging: &Path,
    source: Option<&Path>,
    target: Option<&Path>,
) -> Result<bool, String> {
    let mut changed = false;
    match value {
        serde_json::Value::Object(map) => {
            for (key, item) in map {
                if matches!(
                    key.as_str(),
                    "path"
                        | "filePath"
                        | "localPath"
                        | "storedPath"
                        | "storedFilePath"
                        | "outputPath"
                        | "snapshotPath"
                ) {
                    if let Some(raw) = item.as_str() {
                        if let Some(relative) = internal_relative(raw, source)? {
                            if !DATA_DIRS.iter().any(|dir| relative.starts_with(dir)) {
                                return Err(format!("会话引用了备份范围外的内部文件：{raw}"));
                            }
                            if !staging.join(&relative).exists() {
                                return Err(format!(
                                    "会话引用的内部文件缺失：{}",
                                    relative.display()
                                ));
                            }
                            if let Some(target) = target {
                                *item = serde_json::Value::String(
                                    target.join(relative).to_string_lossy().into_owned(),
                                );
                                changed = true;
                            }
                        }
                    }
                } else {
                    changed |= rewrite_json_paths(item, staging, source, target)?;
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                changed |= rewrite_json_paths(item, staging, source, target)?;
            }
        }
        _ => {}
    }
    Ok(changed)
}

/// Check originals and JSONL before publication. Rebase structured path fields,
/// never arbitrary user message strings.
fn validate_data(
    staging: &Path,
    source: Option<&Path>,
    target: Option<&Path>,
) -> Result<(), String> {
    let connection = rusqlite::Connection::open_with_flags(
        staging.join(DB_FILE_NAME),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE,
    )
    .map_err(|e| format!("无法打开快照数据库：{e}"))?;
    let mut check = connection
        .prepare("PRAGMA integrity_check")
        .map_err(|e| e.to_string())?;
    let checks = check
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if checks != ["ok"] {
        return Err(format!("数据库完整性校验失败：{}", checks.join("; ")));
    }
    drop(check);
    for table in ["knowledge_documents", "knowledge_document_assets"] {
        if !has_table(&connection, table)? {
            continue;
        }
        let mut stmt = connection.prepare(&format!("SELECT id, stored_file_path FROM {table} WHERE stored_file_path IS NOT NULL AND stored_file_path != ''")).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        for (id, stored) in rows {
            let relative = internal_relative(&stored, source)?
                .or_else(|| {
                    if source.is_some() {
                        return None;
                    }
                    let normalized = stored.replace('\\', "/");
                    normalized
                        .find("/knowledge_files/")
                        .and_then(|n| sanitize_entry(&normalized[n + 1..]).ok())
                })
                .ok_or_else(|| format!("知识原件路径不属于备份：{stored}"))?;
            if !relative.starts_with("knowledge_files") || !staging.join(&relative).is_file() {
                return Err(format!("知识原件缺失：{stored}"));
            }
            if let Some(target) = target {
                connection
                    .execute(
                        &format!("UPDATE {table} SET stored_file_path=?1 WHERE id=?2"),
                        rusqlite::params![target.join(relative).to_string_lossy(), id],
                    )
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    let mut session_ids = HashSet::new();
    let sessions = staging.join("chat-sessions");
    if sessions.exists() {
        let mut files = Vec::new();
        collect_files(staging, &sessions, &mut files)?;
        for file in files
            .into_iter()
            .filter(|p| p.file_name().is_some_and(|s| s == "session.jsonl"))
        {
            let id = file
                .parent()
                .and_then(Path::file_name)
                .ok_or("无效会话路径")?
                .to_string_lossy()
                .into_owned();
            if !session_ids.insert(id.clone()) {
                return Err(format!("会话目录重复：{id}"));
            }
            let input = fs::read_to_string(&file).map_err(|e| e.to_string())?;
            let mut output = String::new();
            let mut changed = false;
            for line in input.lines().filter(|s| !s.trim().is_empty()) {
                let mut value: serde_json::Value = serde_json::from_str(line)
                    .map_err(|e| format!("会话 {id} 的 JSONL 损坏：{e}"))?;
                changed |= rewrite_json_paths(&mut value, staging, source, target)?;
                output.push_str(&serde_json::to_string(&value).map_err(|e| e.to_string())?);
                output.push('\n');
            }
            if changed {
                fs::write(&file, output).map_err(|e| e.to_string())?;
            }
        }
    }
    if has_table(&connection, "chat_sessions")? {
        let mut stmt = connection
            .prepare("SELECT id, messages_json, workspace_path FROM chat_sessions")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        for (id, messages, workspace) in rows {
            let legacy: serde_json::Value =
                serde_json::from_str(&messages).map_err(|e| e.to_string())?;
            if !session_ids.contains(&id) && legacy.as_array().is_none_or(|a| a.is_empty()) {
                return Err(format!("数据库会话缺少 JSONL：{id}"));
            }
            if let (Some(target), Some(relative)) = (target, internal_relative(&workspace, source)?)
            {
                connection
                    .execute(
                        "UPDATE chat_sessions SET workspace_path=?1 WHERE id=?2",
                        rusqlite::params![target.join(relative).to_string_lossy(), id],
                    )
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    connection
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;")
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn publish_restore(staging: &Path, target: &Path) -> Result<(), String> {
    require_empty(target).map_err(|e| format!("恢复目标不可用：{e}"))?;
    let existed = target.exists();
    if existed {
        fs::remove_dir(target).map_err(|e| e.to_string())?;
    }
    if let Err(error) = fs::rename(staging, target) {
        if existed {
            let _ = fs::create_dir(target);
        }
        return Err(format!(
            "无法将 {} 发布到 {}：{error}",
            staging.display(),
            target.display()
        ));
    }
    Ok(())
}

fn sync_files(root: &Path) -> Result<(), String> {
    let mut files = Vec::new();
    collect_files(root, root, &mut files)?;
    for file in files {
        fs::OpenOptions::new()
            .write(true)
            .open(&file)
            .and_then(|f| f.sync_all())
            .map_err(|e| format!("文件同步失败 {}：{e}", file.display()))?;
    }
    Ok(())
}

/// Caller also rejects the live data root and its ancestors/descendants.
pub(crate) fn restore_backup(
    source_zip: &Path,
    target_root: &Path,
    secret: Option<&str>,
) -> Result<BackupManifest, String> {
    let target = checked_path(target_root)?;
    require_empty(&target)?;
    let file = fs::File::open(source_zip).map_err(|e| format!("无法打开备份：{e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("备份损坏：{e}"))?;
    let password = secret.filter(|s| !s.is_empty());
    let manifest: BackupManifest = {
        let mut reader = match password {
            Some(p) => archive.by_name_decrypt(MANIFEST_NAME, p.as_bytes()),
            None => archive.by_name(MANIFEST_NAME),
        }
        .map_err(|e| format!("无法读取清单，请检查备份与密码：{e}"))?;
        let mut bytes = Vec::new();
        reader
            .read_to_end(&mut bytes)
            .map_err(|e| format!("清单解密失败：{e}"))?;
        serde_json::from_slice(&bytes).map_err(|e| format!("清单损坏：{e}"))?
    };
    if manifest.app != "omni"
        || manifest.format_version == 0
        || manifest.format_version > BACKUP_FORMAT_VERSION
    {
        return Err("不支持的备份格式或版本".into());
    }
    if manifest.encrypted && password.is_none() {
        return Err("该备份需要密码".into());
    }
    let mut seen = HashSet::new();
    for i in 0..archive.len() {
        let entry = archive.by_index_raw(i).map_err(|e| e.to_string())?;
        let name = entry.name();
        let relative = sanitize_entry(name)?;
        if !seen.insert(name.trim_end_matches('/').to_lowercase()) {
            return Err(format!("备份含重复条目：{name}"));
        }
        if entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) {
            return Err("备份不允许符号链接".into());
        }
        if name != MANIFEST_NAME
            && name != DB_FILE_NAME
            && !DATA_DIRS.iter().any(|d| relative.starts_with(d))
            && !(manifest.format_version == 1
                && matches!(name, "omni.sqlite3-wal" | "omni.sqlite3-shm"))
        {
            return Err(format!("备份含未知根条目：{name}"));
        }
    }
    if !seen.contains(DB_FILE_NAME) {
        return Err("备份文件缺少数据库".into());
    }
    if manifest.files.contains_key(MANIFEST_NAME) {
        return Err("清单不能引用自身".into());
    }
    let staging = Staging::beside(&target)?;
    let mut stamps = BTreeMap::new();
    for i in 0..archive.len() {
        let mut reader = match password {
            Some(p) => archive.by_index_decrypt(i, p.as_bytes()),
            None => archive.by_index(i),
        }
        .map_err(|e| format!("备份解密失败：{e}"))?;
        let name = reader.name().to_string();
        if name == MANIFEST_NAME {
            continue;
        }
        let output = staging.path.join(sanitize_entry(&name)?);
        if reader.is_dir() {
            fs::create_dir_all(&output).map_err(|e| e.to_string())?;
            continue;
        }
        fs::create_dir_all(output.parent().ok_or("条目缺少父目录")?).map_err(|e| e.to_string())?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)
            .map_err(|e| e.to_string())?;
        std::io::copy(&mut reader, &mut file).map_err(|e| format!("备份条目损坏：{e}"))?;
        file.sync_all().map_err(|e| e.to_string())?;
        stamps.insert(name, digest(&output)?);
    }
    if manifest.format_version >= 2 && stamps != manifest.files {
        return Err("备份文件清单或校验和不匹配".into());
    }
    validate_data(
        &staging.path,
        manifest.source_root.as_deref().map(Path::new),
        Some(&target),
    )
    .map_err(|e| format!("恢复数据校验失败：{e}"))?;
    sync_files(&staging.path)?;
    publish_restore(&staging.path, &target).map_err(|e| format!("恢复目录发布失败：{e}"))?;
    Ok(manifest)
}
