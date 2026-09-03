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

/// 单次读文件返回值——结构化告知前端/模型「共多少字符、本次返回多少字符、是否被截断」，
/// 避免过去拼一段「 [truncated]」字符串让模型误以为读到全文。
#[derive(Serialize)]
pub(crate) struct ReadFileResult {
    /// 本次读到的文本（已按 offset/limit 切片）。
    content: String,
    /// 源文件总字符数。
    total_chars: usize,
    /// 本次返回的字符数。
    returned_chars: usize,
    /// 本次起始字符偏移（0-based）。
    offset_chars: usize,
    /// 是否还有未读部分（true = 还有后续字符可读；false = 本次即读完）。
    truncated: bool,
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
    offset_chars: Option<usize>,
    limit_chars: Option<usize>,
) -> Result<ReadFileResult, String> {
    // 读取不限制范围：绝对路径直接读（用户的本机文件，无需授权/确认）；
    // 相对/越界路径落在工作区（无项目时全局 workspace_root）内解析。
    // 写入才需要围栏与确认门，读取只是查看用户自己的文件。
    let full_path = if Path::new(&path).is_absolute() {
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
    let total_chars = content.chars().count();

    // 软上限：单次返回字符数上限；超过则本次窗口截断（truncated=true），
    // 模型可调 max_chars 一次性读完，或用 offset_chars 续读。
    // 下限 1（任意 max_chars 都按用户原值使用，保证「想读 30 字符就只读 30」也成立）；
    // 上限 80000（防止模型一次拉爆 token）。
    let max_chars = max_chars.unwrap_or(16000).clamp(1, 80000);
    let offset_chars = offset_chars.unwrap_or(0).min(total_chars);
    let remaining = total_chars.saturating_sub(offset_chars);

    // 本次能取的字符数 = min(limit_chars?, max_chars, 剩余字符数)
    let window = max_chars.min(remaining);
    let limit_chars = match limit_chars {
        Some(value) => value.clamp(1, max_chars),
        None => window,
    };
    let take = limit_chars.min(remaining);

    let slice: String = content
        .chars()
        .skip(offset_chars)
        .take(take)
        .collect();

    Ok(ReadFileResult {
        truncated: offset_chars + take < total_chars,
        offset_chars,
        returned_chars: take,
        total_chars,
        content: slice,
    })
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

    /// 写一个 utf-8 测试文件，返回绝对路径；测试结束自动清理。
    fn write_temp_file(name: &str, content: &str) -> String {
        let dir = std::env::temp_dir().join("omni-read-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(name);
        std::fs::write(&file, content).unwrap();
        file.to_string_lossy().into_owned()
    }

    #[test]
    fn read_absolute_is_allowed_without_confirmation() {
        let abs = write_temp_file("secret.txt", "hello");

        // 读取不限制范围：绝对路径直接读，无需 allow_absolute 授权标志。
        let result = read_file(None, abs, None, None, None).unwrap();
        assert_eq!(result.content, "hello");
        assert_eq!(result.total_chars, 5);
        assert_eq!(result.returned_chars, 5);
        assert!(!result.truncated);
        assert_eq!(result.offset_chars, 0);
    }

    #[test]
    fn read_truncated_when_above_max_chars() {
        // 100 字符数字串，超过默认 16000 不会截断；显式把 max_chars 设小一点触发截断。
        let body = "a".repeat(100);
        let abs = write_temp_file("truncate.txt", &body);

        let result = read_file(None, abs, Some(40), None, None).unwrap();
        assert_eq!(result.total_chars, 100);
        assert_eq!(result.returned_chars, 40);
        assert!(result.truncated);
        assert_eq!(result.content.chars().count(), 40);
        assert!(result.content.chars().all(|c| c == 'a'));
    }

    #[test]
    fn read_offset_chars_skips_leading_content() {
        let body: String = (1..=50).map(|n| format!("{n:02}")).collect::<Vec<_>>().join("-");
        // 总字符数 50*3 - 1 = 149；offset=60 应跳过前 60 字符
        let abs = write_temp_file("offset.txt", &body);

        let result = read_file(None, abs, Some(16000), Some(60), None).unwrap();
        assert_eq!(result.total_chars, 149);
        assert_eq!(result.offset_chars, 60);
        // 跳过 60 字符后还剩 89；limit 默认 = min(max_chars, remaining) = 89
        assert_eq!(result.returned_chars, 89);
        assert!(!result.truncated);
        // 内容正确：取原始 body 的 [60..] 子串
        let expected: String = body.chars().skip(60).collect();
        assert_eq!(result.content, expected);
    }

    #[test]
    fn read_limit_chars_caps_returned_window() {
        let body = (0..200).map(|n| n as u8 as char).collect::<String>();
        let abs = write_temp_file("limit.txt", &body);

        // 让 max_chars 足够大（80000），但显式把 limit_chars 压小到 50
        let result = read_file(None, abs, Some(80000), None, Some(50)).unwrap();
        assert_eq!(result.total_chars, 200);
        assert_eq!(result.returned_chars, 50);
        assert!(result.truncated);
        assert_eq!(result.offset_chars, 0);

        let expected: String = body.chars().take(50).collect();
        assert_eq!(result.content, expected);
    }

    #[test]
    fn read_unicode_chars_not_split_mid_codepoint() {
        // 100 个汉字，每个 1 个 char，但 3 字节。验证按 char 切不会切坏码点。
        let body: String = "春".repeat(100);
        let abs = write_temp_file("unicode.txt", &body);

        // max_chars=33 应该精确取前 33 个汉字，不会切坏中间字符
        let result = read_file(None, abs, Some(33), None, None).unwrap();
        assert_eq!(result.total_chars, 100);
        assert_eq!(result.returned_chars, 33);
        assert!(result.truncated);
        assert_eq!(result.content.chars().count(), 33);
        assert!(result.content.chars().all(|c| c == '春'));
    }

    #[test]
    fn read_offset_beyond_total_is_clamped() {
        let body = "hi";
        let abs = write_temp_file("clamp.txt", body);

        // offset 远超 total，应被 clamp 到 total_chars
        let result = read_file(None, abs, Some(16000), Some(1000), None).unwrap();
        assert_eq!(result.total_chars, 2);
        assert_eq!(result.offset_chars, 2);
        assert_eq!(result.returned_chars, 0);
        assert!(!result.truncated); // 已经读完（含 0 字符也视为读完）
        assert!(result.content.is_empty());
    }

    #[test]
    fn read_unicode_filename_and_content() {
        let body = "# 中文标题\n这是一段中文内容。";
        let abs = write_temp_file("Spring生态调研报告.md", body);

        let result = read_file(None, abs, None, None, None).unwrap();
        assert_eq!(result.total_chars, body.chars().count());
        assert_eq!(result.returned_chars, body.chars().count());
        assert!(!result.truncated);
        assert_eq!(result.content, body);
    }
}
