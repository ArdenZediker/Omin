use serde::Serialize;
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

#[derive(Serialize)]
pub(crate) struct WorkspaceFileEntry {
    path: String,
    is_dir: bool,
}

#[derive(Serialize)]
pub(crate) struct WorkspaceSearchMatch {
    path: String,
    line_number: usize,
    line_preview: String,
}

/// 解析文件操作的根目录：优先使用项目工作目录，否则回退到全局 workspace_root。
fn resolve_root(project_path: &Option<String>) -> Result<PathBuf, String> {
    if let Some(raw) = project_path {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    crate::workspace_root()
}

pub(crate) fn list_files(
    project_path: Option<String>,
    query: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<WorkspaceFileEntry>, String> {
    let root = resolve_root(&project_path)?;
    let normalized_query = query.unwrap_or_default().trim().to_lowercase();
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let mut results = Vec::new();
    collect_workspace_files(&root, &root, &normalized_query, limit, &mut results)?;
    Ok(results)
}

pub(crate) fn read_file(
    project_path: Option<String>,
    path: String,
    max_chars: Option<usize>,
    allow_absolute: Option<bool>,
) -> Result<String, String> {
    // 提权读取：仅当用户在前端确认后传入 allow_absolute=true 才放开绝对路径，
    // 否则一律走工作区围栏（normalize_relative_path 拒绝绝对路径/越界）。
    let full_path = if allow_absolute.unwrap_or(false) && Path::new(&path).is_absolute() {
        PathBuf::from(&path)
    } else {
        let root = resolve_root(&project_path)?;
        let relative = normalize_relative_path(&path)?;
        root.join(relative)
    };

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

pub(crate) fn search_files(
    project_path: Option<String>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<WorkspaceSearchMatch>, String> {
    let normalized_query = query.trim().to_lowercase();
    if normalized_query.is_empty() {
        return Err("Query cannot be empty".into());
    }

    let root = resolve_root(&project_path)?;
    let limit = limit.unwrap_or(50).clamp(1, 200);
    let mut results = Vec::new();
    collect_workspace_matches(&root, &root, &normalized_query, limit, &mut results)?;
    Ok(results)
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

fn should_skip_entry(file_name: &str) -> bool {
    file_name.starts_with(".git") || file_name == "node_modules" || file_name == "dist"
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
        if should_skip_entry(&file_name) {
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
        if should_skip_entry(&file_name) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_absolute_requires_allow_flag() {
        let dir = std::env::temp_dir().join("omni-read-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("secret.txt");
        std::fs::write(&file, b"hello").unwrap();
        let abs = file.to_string_lossy().into_owned();

        // 未授权：绝对路径被工作区围栏拒绝
        let err = read_file(None, abs.clone(), None, None).unwrap_err();
        assert!(
            err.contains("Only relative workspace paths are allowed"),
            "actual: {err}"
        );

        // 授权（前端确认后 allow_absolute=true）：可读到内容
        let content = read_file(None, abs.clone(), None, Some(true)).unwrap();
        assert_eq!(content, "hello");
    }
}
