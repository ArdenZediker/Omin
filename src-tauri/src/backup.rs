//! 数据备份 / 恢复：把整个数据目录（数据库 + 知识库文件）打包成带清单的 zip，
//! 可选 AES-256 加密（secret）。导入时做清单版本校验与 SQLite 完整性校验。
//!
//! 数据流：
//! - 导出：当前数据根 → 校验风险 → 复制数据库（含 WAL/SHM）+ 知识库目录 → 写入 zip（含 manifest）。
//! - 导入：读取 zip → 解析 manifest（校验 app / 版本 / 是否加密）→ 解压到目标目录 → SQLite 完整性校验。

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use zip::write::FileOptions;

pub(crate) const BACKUP_FORMAT_VERSION: u32 = 1;
pub(crate) const MANIFEST_NAME: &str = "omni-backup-manifest.json";
const DB_FILE_NAME: &str = "omni.sqlite3";
const KNOWLEDGE_DIR_NAME: &str = "knowledge_files";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupManifest {
    pub app: String,
    pub format_version: u32,
    pub app_version: String,
    #[serde(default)]
    pub created_at: i64,
    pub encrypted: bool,
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

/// WAL 模式下把写缓冲落盘到主库文件，保证快照一致性。
fn checkpoint_wal(db_path: &Path) {
    if !db_path.exists() {
        return;
    }
    if let Ok(connection) = rusqlite::Connection::open(db_path) {
        let _ = connection.execute("PRAGMA wal_checkpoint(TRUNCATE)", []);
    }
}

fn base_options(secret: Option<&str>) -> FileOptions<'_, ()> {
    let mut options =
        FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    if let Some(password) = secret {
        if !password.is_empty() {
            options = options.with_aes_encryption(zip::AesMode::Aes256, password);
        }
    }
    options
}

/// 把单个文件按相对 root 的路径写进 zip。
fn add_single_file<W: Write + std::io::Seek>(
    zip: &mut zip::ZipWriter<W>,
    root: &Path,
    file: &Path,
    secret: Option<&str>,
) -> Result<(), String> {
    let relative = file
        .strip_prefix(root)
        .map_err(|err| format!("路径越界：{}", err))?;
    let name = relative.to_string_lossy().replace('\\', "/");
    zip.start_file(name, base_options(secret))
        .map_err(|err| err.to_string())?;
    let data = fs::read(file).map_err(|err| format!("读取文件失败：{}", err))?;
    zip.write_all(&data).map_err(|err| err.to_string())?;
    Ok(())
}

/// 递归把 dir 下的内容（相对 root）写进 zip。
fn add_dir_to_zip<W: Write + std::io::Seek>(
    zip: &mut zip::ZipWriter<W>,
    root: &Path,
    dir: &Path,
    secret: Option<&str>,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            let relative = path
                .strip_prefix(root)
                .map_err(|err| err.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            zip.add_directory(format!("{}/", relative), base_options(secret))
                .map_err(|err| err.to_string())?;
            add_dir_to_zip(zip, root, &path, secret)?;
        } else {
            add_single_file(zip, root, &path, secret)?;
        }
    }
    Ok(())
}

/// 整库导出为 zip（含 manifest）。secret 为空则不加密。
pub(crate) fn build_backup(
    source_root: &Path,
    target_zip: &Path,
    secret: Option<&str>,
) -> Result<BackupManifest, String> {
    fs::create_dir_all(source_root).map_err(|err| err.to_string())?;
    checkpoint_wal(&source_root.join(DB_FILE_NAME));

    let file = fs::File::create(target_zip).map_err(|err| format!("无法创建备份文件：{}", err))?;
    let mut zip = zip::ZipWriter::new(file);

    let encrypted = secret.map(|value| !value.is_empty()).unwrap_or(false);
    let manifest = BackupManifest {
        app: "omni".to_string(),
        format_version: BACKUP_FORMAT_VERSION,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        created_at: now_millis(),
        encrypted,
    };

    // 先写清单
    let manifest_json = serde_json::to_string_pretty(&manifest).map_err(|err| err.to_string())?;
    zip.start_file(MANIFEST_NAME, base_options(secret))
        .map_err(|err| err.to_string())?;
    zip.write_all(manifest_json.as_bytes())
        .map_err(|err| err.to_string())?;

    // 数据库（含 WAL / SHM 旁路文件）
    let db = source_root.join(DB_FILE_NAME);
    if db.exists() {
        add_single_file(&mut zip, source_root, &db, secret)?;
        for suffix in ["-wal", "-shm"] {
            let side = PathBuf::from(format!("{}{}", db.to_string_lossy(), suffix));
            if side.exists() {
                add_single_file(&mut zip, source_root, &side, secret)?;
            }
        }
    }

    // 知识库文件
    let knowledge = source_root.join(KNOWLEDGE_DIR_NAME);
    if knowledge.exists() {
        add_dir_to_zip(&mut zip, source_root, &knowledge, secret)?;
    }

    zip.finish().map_err(|err| format!("写入备份失败：{}", err))?;
    Ok(manifest)
}

/// 防止 zip slip：拒绝绝对路径与 `..` 段，返回相对目标路径。
fn sanitize_entry(name: &str) -> Result<PathBuf, String> {
    let trimmed = name.trim_start_matches('/');
    if trimmed.is_empty() || trimmed.starts_with('/') {
        return Err(format!("备份条目包含非法路径：{}", name));
    }
    let path = PathBuf::from(trimmed);
    for component in path.components() {
        match component {
            Component::ParentDir => return Err(format!("备份条目包含非法路径：{}", name)),
            Component::RootDir => return Err(format!("备份条目包含绝对路径：{}", name)),
            _ => {}
        }
    }
    Ok(path)
}

/// 解压备份到 target_root，并做清单校验 + SQLite 完整性校验。
pub(crate) fn restore_backup(
    source_zip: &Path,
    target_root: &Path,
    secret: Option<&str>,
) -> Result<BackupManifest, String> {
    if !source_zip.exists() {
        return Err("备份文件不存在".to_string());
    }
    let file = fs::File::open(source_zip).map_err(|err| format!("无法打开备份文件：{}", err))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|err| format!("备份文件损坏：{}", err))?;

    // 1) 读取清单（加密的需要密码；未加密的用普通读取，失败提示需要密码）
    let manifest = {
        let mut reader = match secret.as_deref() {
            Some(password) if !password.is_empty() => archive
                .by_name_decrypt(MANIFEST_NAME, password.as_bytes())
                .map_err(|_| "备份已加密，密码可能不正确".to_string())?,
            _ => archive
                .by_name(MANIFEST_NAME)
                .map_err(|_| "无法读取备份清单（可能已加密，需要密码）".to_string())?,
        };
        let mut buffer = String::new();
        reader
            .read_to_string(&mut buffer)
            .map_err(|err| err.to_string())?;
        serde_json::from_str::<BackupManifest>(&buffer)
            .map_err(|err| format!("清单解析失败：{}", err))?
    };

    if manifest.app != "omni" {
        return Err("不是 Omni 的备份文件".to_string());
    }
    if manifest.format_version > BACKUP_FORMAT_VERSION {
        return Err(format!(
            "备份版本（{}）高于当前程序支持（{}），请升级后再导入",
            manifest.format_version, BACKUP_FORMAT_VERSION
        ));
    }
    if manifest.encrypted && secret.as_deref().map(|value| value.is_empty()).unwrap_or(true) {
        return Err("该备份已加密，请输入密码".to_string());
    }

    // 2) 先遍历一次做路径校验，并确认数据库存在
    let mut has_db = false;
    for index in 0..archive.len() {
        let name = archive
            .by_index(index)
            .map_err(|err| err.to_string())?
            .name()
            .to_string();
        if name == MANIFEST_NAME {
            continue;
        }
        let _ = sanitize_entry(&name)?;
        if name == DB_FILE_NAME {
            has_db = true;
        }
    }
    if !has_db {
        return Err("备份文件缺少数据库".to_string());
    }

    // 3) 解压到目标根目录
    fs::create_dir_all(target_root).map_err(|err| err.to_string())?;
    for index in 0..archive.len() {
        let name = archive
            .by_index(index)
            .map_err(|err| err.to_string())?
            .name()
            .to_string();
        if name == MANIFEST_NAME {
            continue;
        }
        let relative = sanitize_entry(&name)?;
        let out_path = target_root.join(&relative);
        if name.ends_with('/') {
            fs::create_dir_all(&out_path).map_err(|err| err.to_string())?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        let mut reader = if manifest.encrypted {
            archive
                .by_index_decrypt(index, secret.as_deref().unwrap_or("").as_bytes())
                .map_err(|_| "解密失败，密码可能不正确".to_string())?
        } else {
            archive.by_index(index).map_err(|err| err.to_string())?
        };
        let mut buffer = Vec::new();
        reader
            .read_to_end(&mut buffer)
            .map_err(|err| err.to_string())?;
        fs::write(&out_path, &buffer).map_err(|err| err.to_string())?;
    }

    // 4) SQLite 完整性校验
    let db_path = target_root.join(DB_FILE_NAME);
    if db_path.exists() {
        let connection = rusqlite::Connection::open(&db_path)
            .map_err(|err| format!("无法打开恢复后的数据库：{}", err))?;
        let result: String = connection
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(|err| err.to_string())?;
        if result.trim().to_lowercase() != "ok" {
            return Err(format!("恢复后的数据库完整性未通过：{}", result));
        }
    }

    Ok(manifest)
}
