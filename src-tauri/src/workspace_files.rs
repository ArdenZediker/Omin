use globset::{Glob, GlobMatcher};
use ignore::WalkBuilder;
use regex::RegexBuilder;
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
    /// 匹配所在文件的相对路径（相对工作区根）。
    path: String,
    /// 匹配行号（1-based）。
    line_number: usize,
    /// 匹配行内容。
    line: String,
    /// 匹配行之前的上下文行（最多 `context` 行，按原顺序）。
    before: Vec<String>,
    /// 匹配行之后的上下文行（最多 `context` 行，按原顺序）。
    after: Vec<String>,
}

/// 单次读文件返回值——结构化告知前端/模型「共多少字符、本次返回多少字符、是否被截断」，
/// 避免过去拼一段「 [truncated]」字符串让模型误以为读到全文。
#[derive(Serialize)]
pub(crate) struct ReadFileResult {
    /// 本次读到的文本（已按 offset/limit 切片，原始内容，未加行号前缀）。
    content: String,
    /// 源文件总字符数。
    total_chars: usize,
    /// 本次返回的字符数。
    returned_chars: usize,
    /// 本次起始字符偏移（0-based）。
    offset_chars: usize,
    /// 是否还有未读部分（true = 还有后续字符可读；false = 本次即读完）。
    truncated: bool,
    /// 窗口首字符所在行（1-based）。offset 落在行中间时也指向该行，
    /// 与 /search_files 返回的 line_number 保持同一坐标系。
    start_line: usize,
    /// 窗口末字符所在行（1-based）。
    end_line: usize,
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

/// 轻量 read 黑名单：默认护栏而非围栏（不破坏「读取放开」的整体语义）。
/// 只拦凭据类文件——SSH 私钥 / GPG 钥匙串 / 云与集群凭证、Windows 注册表
/// hive（SAM/SYSTEM/SECURITY）、NTDS 目录库、Unix 口令文件。命中返回简短
/// 原因供错误信息展示；普通文件一律放行。`home` 由调用方注入以便测试。
fn sensitive_read_reason(path: &Path, home: Option<&str>) -> Option<String> {
    let text = path.to_string_lossy().replace('\\', "/").to_lowercase();

    if let Some(home) = home {
        let home = home
            .replace('\\', "/")
            .to_lowercase()
            .trim_end_matches('/')
            .to_string();
        for dir in [".ssh", ".gnupg", ".aws", ".kube"] {
            let prefix = format!("{home}/{dir}");
            if text == prefix || text.starts_with(&format!("{prefix}/")) {
                return Some(format!("~/{dir}（凭据目录）"));
            }
        }
    }

    for sys in ["/etc/shadow", "/etc/sudoers"] {
        if text == sys || text.starts_with(&format!("{sys}/")) {
            return Some(sys.to_string());
        }
    }
    if text.starts_with("/etc/sudoers.d/") {
        return Some("/etc/sudoers.d".to_string());
    }

    // Windows 注册表 hive（凭据转储的常见目标）。只匹配文件名，
    // 不拦 System32/config 下的普通子目录内容。
    if let Some(idx) = text.find("/windows/system32/config/") {
        let rest = &text[idx + "/windows/system32/config/".len()..];
        let base = rest.split('/').next().unwrap_or("");
        if matches!(base, "sam" | "system" | "security") {
            return Some("Windows 注册表 hive".to_string());
        }
    }
    if text.ends_with("/ntds.dit") || text == "ntds.dit" {
        return Some("NTDS 目录库".to_string());
    }

    None
}

/// 读取路径护栏：结合当前用户家目录判断是否命中黑名单。
fn read_blocked(path: &Path) -> Option<String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok();
    sensitive_read_reason(path, home.as_deref())
}

/// 列出工作区文件/目录：基于 ripgrep 的 `ignore` walker（自动尊重 .gitignore / .ignore /
/// 全局 gitignore，并跳过隐藏文件），用 glob 表达式在相对路径上做文件名过滤。
///
/// 与旧实现（std::fs 递归 + 子串 contains）的区别：
/// - 支持 glob 通配符（`**/*.ts`、`src/**/test_*.rs`），不再只是大小写不敏感子串；
/// - 自动排除 gitignore 忽略项（含 node_modules / dist / build 产物等），无需硬编码目录名；
/// - 走 ripgrep 的 walker，大仓库更快、且并行遍历。
pub(crate) fn list_files(
    project_path: Option<String>,
    glob: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<WorkspaceFileEntry>, String> {
    let root = resolve_root(&project_path)?;
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let matcher = build_glob_matcher(glob.as_deref())?;

    let mut results: Vec<WorkspaceFileEntry> = Vec::new();
    let walker = WalkBuilder::new(&root).build();
    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        // 跳过根目录自身（relative 为空）。
        let relative = match relative_posix(entry.path(), &root) {
            Some(r) if !r.is_empty() => r,
            _ => continue,
        };
        if let Some(m) = &matcher {
            if !m.is_match(&relative) {
                continue;
            }
        }
        let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        results.push(WorkspaceFileEntry { path: relative, is_dir });
        if results.len() >= limit {
            break;
        }
    }
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
    if let Some(reason) = read_blocked(&full_path) {
        return Err(format!(
            "已拒绝读取敏感路径（{reason}）：此为模型侧默认护栏；如确需查看该文件，请自行打开后粘贴或调整位置。"
        ));
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

    // 行号坐标系：窗口首字符所在行 = 前 offset_chars 字符里的换行数 + 1。
    // 即便 offset 落在行中间，start_line 也指向该（部分）行——模型续读时
    // 行号与 /search_files 的 line_number 连续对齐。
    let start_line = content.chars().take(offset_chars).filter(|&c| c == '\n').count() + 1;
    let end_line = start_line + slice.matches('\n').count();

    Ok(ReadFileResult {
        truncated: offset_chars + take < total_chars,
        offset_chars,
        returned_chars: take,
        total_chars,
        content: slice,
        start_line,
        end_line,
    })
}

/// 读取文件原始字节，供前端预览器（file-viewer）直接消费。
/// 路径解析规则与 `read_file` 一致：绝对路径直接读（用户本机文件，无需授权）；
/// 相对路径落工作区根内解析。读取放开，仅查看用户自己的文件。
pub(crate) fn read_file_bytes(
    project_path: Option<String>,
    path: String,
) -> Result<Vec<u8>, String> {
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
    if let Some(reason) = read_blocked(&full_path) {
        return Err(format!(
            "已拒绝读取敏感路径（{reason}）：此为模型侧默认护栏；如确需查看该文件，请自行打开后粘贴或调整位置。"
        ));
    }

    fs::read(&full_path).map_err(|err| err.to_string())
}

/// 附件快照复制结果——前端据此把 Message.attachments 的路径改写成快照路径。
#[derive(Serialize)]
pub(crate) struct CopyFileResult {
    /// 快照落盘后的绝对路径（可能与请求的 dst 不同：同名冲突时自动追加 -1、-2）。
    path: String,
    /// 快照文件字节数。
    size: u64,
}

/// 把用户选定的本地文件复制一份到 Omni 的产出目录（会话附件快照）。
///
/// 背景：对话框附件此前只存原始绝对路径，用户移动/重命名/删除原文件后，模型再调
/// /read_file 就读不到了。发送时落一份快照，让非图片附件也像图片（base64 内联）
/// 一样自包含——语义对齐 DeepSeek / WorkBuddy 的「摄取副本」，而非「记指针」。
///
/// 安全：读取放开（用户自己的文件）；写入侧仅做绝对路径 + No-Go Zone 兜底，
/// 具体目录由前端按「产出根 / 项目 / 会话」算出。
pub(crate) fn copy_file_to_store(src: &str, dst: &str) -> Result<CopyFileResult, String> {
    let src_trimmed = src.trim();
    let src_path = Path::new(src_trimmed);
    if !src_path.is_absolute() {
        return Err(format!("附件源路径必须是绝对路径（收到「{src_trimmed}」）"));
    }
    if !src_path.exists() {
        return Err(format!("File not found: {src_trimmed}"));
    }
    if src_path.is_dir() {
        return Err(format!("Path is a directory: {src_trimmed}"));
    }

    let dst_trimmed = dst.trim();
    if dst_trimmed.is_empty() {
        return Err("附件快照路径不能为空".to_string());
    }
    let dst_path = Path::new(dst_trimmed);
    if !dst_path.is_absolute() {
        return Err(format!(
            "附件快照路径必须是绝对路径（收到「{dst_trimmed}」）"
        ));
    }
    if let Some(zone) = crate::office_export::no_go_zone(dst_path) {
        return Err(format!("附件快照路径位于禁止写入的{zone}，已拒绝。"));
    }

    // 冲突避免：同名文件已存在时自动追加 -1、-2……保证同一会话多次上传同名文件不互相覆盖。
    let mut candidate = dst_path.to_path_buf();
    if candidate.exists() {
        let stem = dst_path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let ext = dst_path
            .extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default();
        let parent = dst_path.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        let mut n = 1;
        loop {
            let name = if ext.is_empty() {
                format!("{stem}-{n}")
            } else {
                format!("{stem}-{n}.{ext}")
            };
            let next = if parent.as_os_str().is_empty() {
                PathBuf::from(&name)
            } else {
                parent.join(&name)
            };
            if !next.exists() {
                candidate = next;
                break;
            }
            n += 1;
            if n > 999 {
                return Err("附件快照同名冲突过多，无法生成唯一文件名".to_string());
            }
        }
    }

    if let Some(parent) = candidate.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| format!("创建附件快照目录失败: {e}"))?;
        }
    }

    fs::copy(src_path, &candidate).map_err(|e| format!("复制附件快照失败: {e}"))?;
    let size = fs::metadata(&candidate)
        .map_err(|e| format!("读取附件快照元数据失败: {e}"))?
        .len();

    Ok(CopyFileResult {
        path: candidate.to_string_lossy().to_string(),
        size,
    })
}

/// 内容搜索：基于 ripgrep 的 `ignore` walker 遍历（自动尊重 .gitignore）+ `regex` 匹配器
/// （ripgrep 底层使用的正是 regex crate），支持字面模式、大小写忽略、上下文行、文件类型
/// 过滤（glob）与搜索目录限定（path）。
///
/// 与旧实现（from_utf8_lossy 逐行 contains）的区别：
/// - 支持正则（pattern），而非大小写不敏感子串；`literal=true` 时按字面量匹配；
/// - 自动排除 gitignore 忽略项与二进制文件；
/// - 返回匹配行前后的上下文行（`context`），避免模型为看上下文而整文件拖进上下文。
pub(crate) fn search_files(
    project_path: Option<String>,
    pattern: String,
    path: Option<String>,
    glob: Option<String>,
    literal: Option<bool>,
    ignore_case: Option<bool>,
    context: Option<usize>,
    limit: Option<usize>,
) -> Result<Vec<WorkspaceSearchMatch>, String> {
    let raw_pattern = pattern.trim();
    if raw_pattern.is_empty() {
        return Err("Pattern cannot be empty".into());
    }
    // literal 模式：对 pattern 做正则转义，使其按字面量匹配（不解析正则元字符）。
    let effective = if literal.unwrap_or(false) {
        regex::escape(raw_pattern)
    } else {
        raw_pattern.to_string()
    };
    let re = RegexBuilder::new(&effective)
        .case_insensitive(ignore_case.unwrap_or(false))
        .build()
        .map_err(|e| format!("Invalid regex pattern 「{raw_pattern}」: {e}"))?;

    let root = resolve_root(&project_path)?;
    // `path` 可选：限定在根目录下的某个子目录内搜索（相对路径，禁止跳出根）。
    let search_root = if let Some(sub) = path.as_deref().filter(|s| !s.trim().is_empty()) {
        let normalized = normalize_relative_path(sub)?;
        let joined = root.join(normalized);
        if !joined.exists() {
            return Err(format!("Search path not found: {sub}"));
        }
        joined
    } else {
        root.clone()
    };

    let limit = limit.unwrap_or(50).clamp(1, 200);
    let context = context.unwrap_or(0).min(20);
    let glob_matcher = build_glob_matcher(glob.as_deref())?;

    let mut results: Vec<WorkspaceSearchMatch> = Vec::new();
    let walker = WalkBuilder::new(&search_root).build();
    'walk: for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let file_type = match entry.file_type() {
            Some(ft) => ft,
            None => continue,
        };
        if file_type.is_dir() {
            continue;
        }
        let absolute = entry.path();
        let relative = match relative_posix(absolute, &root) {
            Some(r) => r,
            None => continue,
        };
        if let Some(m) = &glob_matcher {
            if !m.is_match(&relative) {
                continue;
            }
        }

        let bytes = match fs::read(absolute) {
            Ok(b) => b,
            Err(_) => continue,
        };
        // 跳过含 NUL 的二进制文件，避免把非文本字节当字符串匹配（对齐 ripgrep 的二进制检测）。
        if bytes.contains(&0) {
            continue;
        }
        let content = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = content.lines().collect();
        for (idx, line) in lines.iter().enumerate() {
            if re.find(line).is_some() {
                let start = idx.saturating_sub(context);
                let before: Vec<String> = lines[start..idx].iter().map(|s| s.to_string()).collect();
                let end = (idx + 1 + context).min(lines.len());
                let after: Vec<String> = lines[idx + 1..end].iter().map(|s| s.to_string()).collect();
                results.push(WorkspaceSearchMatch {
                    path: relative.clone(),
                    line_number: idx + 1,
                    line: line.to_string(),
                    before,
                    after,
                });
                if results.len() >= limit {
                    break 'walk;
                }
            }
        }
    }
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

/// 计算相对工作区根的路径（POSIX 分隔符），用于结果展示与 glob 匹配。
/// 路径等于根时返回空串（调用方应跳过）。
fn relative_posix(path: &Path, root: &Path) -> Option<String> {
    let stripped = path.strip_prefix(root).ok()?;
    let s = stripped.to_string_lossy().replace('\\', "/");
    Some(s)
}

/// 把 glob 表达式编译成 globset 匹配器；空/None 表示不过滤（匹配所有）。
/// 支持 `**` 跨目录通配，对齐 ripgrep 的 glob 语义。
fn build_glob_matcher(glob: Option<&str>) -> Result<Option<GlobMatcher>, String> {
    match glob {
        Some(g) if !g.trim().is_empty() => {
            let matcher = Glob::new(g.trim())
                .map_err(|e| format!("Invalid glob pattern 「{g}」: {e}"))?
                .compile_matcher();
            Ok(Some(matcher))
        }
        _ => Ok(None),
    }
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

    #[test]
    fn read_start_line_tracks_offset_windows() {
        let body = "l1\nl2\nl3\nl4\nl5";
        let abs = write_temp_file("lines.txt", body);

        // 全量读：行号 1..=5
        let result = read_file(None, abs.clone(), Some(16000), None, None).unwrap();
        assert_eq!(result.start_line, 1);
        assert_eq!(result.end_line, 5);

        // offset=6 跳过 "l1\nl2\n"（恰好在行边界）：窗口从第 3 行开始
        let result = read_file(None, abs, Some(16000), Some(6), None).unwrap();
        assert_eq!(result.offset_chars, 6);
        assert_eq!(result.start_line, 3);
        assert_eq!(result.end_line, 5);
        assert_eq!(result.content, "l3\nl4\nl5");
    }

    // ---------- 敏感路径黑名单（P2 默认护栏） ----------

    #[test]
    fn sensitive_classifier_blocks_credentials_and_allows_normal_files() {
        let home = Some("C:\\Users\\tester");

        // 家目录下的凭据目录：整目录拦截
        assert!(sensitive_read_reason(Path::new("C:\\Users\\tester\\.ssh\\id_rsa"), home).is_some());
        assert!(sensitive_read_reason(Path::new("C:/Users/tester/.ssh"), home).is_some());
        assert!(sensitive_read_reason(Path::new("C:\\Users\\tester\\.gnupg\\pubring.kbx"), home).is_some());
        assert!(sensitive_read_reason(Path::new("C:\\Users\\tester\\.aws\\credentials"), home).is_some());

        // 前缀必须完整匹配：.ssh-utils 这类同名前缀目录不能误伤
        assert!(sensitive_read_reason(Path::new("C:\\Users\\tester\\.ssh-utils\\a.txt"), home).is_none());
        // 家目录普通文件放行
        assert!(sensitive_read_reason(Path::new("C:\\Users\\tester\\notes.md"), home).is_none());

        // Windows 注册表 hive：只拦 SAM/SYSTEM/SECURITY 本体
        assert!(sensitive_read_reason(Path::new("C:\\Windows\\System32\\config\\SAM"), None).is_some());
        assert!(sensitive_read_reason(Path::new("C:\\WINDOWS\\system32\\config\\SYSTEM"), None).is_some());
        assert!(sensitive_read_reason(Path::new("C:\\Windows\\System32\\config\\drivers\\ok.txt"), None).is_none());

        // NTDS 目录库 + Unix 口令文件（sudoers.d 整目录拦；shadow.d 并非真实敏感路径，放行）
        assert!(sensitive_read_reason(Path::new("D:\\data\\ntds.dit"), None).is_some());
        assert!(sensitive_read_reason(Path::new("/etc/shadow"), None).is_some());
        assert!(sensitive_read_reason(Path::new("/etc/sudoers.d/extra"), None).is_some());
        assert!(sensitive_read_reason(Path::new("/etc/shadow.d/extra"), None).is_none());
        assert!(sensitive_read_reason(Path::new("/etc/passwd"), None).is_none());
    }

    // ---------- copy_file_to_store（会话附件快照） ----------

    /// 附件快照的落盘目录：放在系统临时目录下，No-Go Zone 对该目录放行。
    /// 每次先清空——测试会重复运行，残留文件会触发「同名冲突自动改名」逻辑，
    /// 让断言变得不稳定。
    fn temp_store_dir(name: &str) -> String {
        let dir = std::env::temp_dir().join("omni-attachment-test").join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().into_owned()
    }

    /// 取路径末段文件名。断言用它而非整串路径——Rust 会把请求里的 `/` 规范化成
    /// Windows 的 `\`，直接比字符串会假失败。
    fn file_name_of(p: &str) -> String {
        Path::new(p)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default()
    }

    #[test]
    fn copy_to_store_writes_snapshot_and_reports_size() {
        let body = "hello 附件";
        let src = write_temp_file("src-note.txt", body);
        let dir = temp_store_dir("basic");

        let dst = format!("{}/note.txt", dir);
        let result = copy_file_to_store(&src, &dst).unwrap();
        // 无冲突时快照文件名与请求的 dst 一致（整串路径分隔符可能被规范化，故只比文件名）。
        assert_eq!(file_name_of(&result.path), "note.txt");
        assert_eq!(result.size, body.as_bytes().len() as u64);
        assert_eq!(std::fs::read_to_string(&result.path).unwrap(), body);
        // 原文件仍在：快照是复制而非移动。
        assert!(std::path::Path::new(&src).exists());
    }

    #[test]
    fn copy_to_store_avoids_overwriting_existing_snapshot() {
        let src = write_temp_file("dup.txt", "v1");
        let dir = temp_store_dir("collision");

        let first = copy_file_to_store(&src, &format!("{}/dup.txt", dir)).unwrap();
        let second = copy_file_to_store(&src, &format!("{}/dup.txt", dir)).unwrap();
        let third = copy_file_to_store(&src, &format!("{}/dup.txt", dir)).unwrap();

        assert!(first.path.ends_with("dup.txt"));
        assert!(second.path.ends_with("dup-1.txt"));
        assert!(third.path.ends_with("dup-2.txt"));
        assert_ne!(first.path, second.path);
    }

    #[test]
    fn copy_to_store_rejects_non_absolute_paths() {
        let src = write_temp_file("rel.txt", "x");
        let dir = temp_store_dir("reject");

        // 相对源路径
        assert!(copy_file_to_store("rel.txt", &format!("{}/out.txt", dir)).is_err());
        // 相对目标路径
        assert!(copy_file_to_store(&src, "out.txt").is_err());
        // 空目标路径
        assert!(copy_file_to_store(&src, "   ").is_err());
    }

    #[test]
    fn copy_to_store_rejects_missing_source_and_directory() {
        let dir = temp_store_dir("reject2");
        let missing = format!("{}/definitely-missing-file.txt", dir);

        assert!(copy_file_to_store(&missing, &format!("{}/out.txt", dir)).is_err());
        // 源是目录：不应被当成文件复制
        assert!(copy_file_to_store(&dir, &format!("{}/out.txt", dir)).is_err());
    }

    // ---------- list_files / search_files（glob + ripgrep） ----------

    /// 在一个临时仓库里铺一批文件（含 .gitignore 与 node_modules），用于验证
    /// glob / gitignore 行为。每次先 remove_dir_all，避免残留断言不稳定。
    fn temp_repo(name: &str) -> String {
        let dir = std::env::temp_dir().join("omni-search-test").join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        fs::write(dir.join("src_a.ts"), "export const a = 1;").unwrap();
        fs::write(dir.join("src_b.ts"), "export const b = 2;").unwrap();
        fs::write(dir.join("readme.md"), "see src_a.ts").unwrap();
        fs::write(dir.join("secret.log"), "debug log").unwrap();
        fs::create_dir_all(dir.join("nested")).unwrap();
        fs::write(dir.join("nested").join("deep.ts"), "export const deep = 3;").unwrap();
        fs::create_dir_all(dir.join("node_modules").join("pkg")).unwrap();
        fs::write(
            dir.join("node_modules").join("pkg").join("index.js"),
            "ignored by gitignore",
        )
        .unwrap();
        fs::write(dir.join(".gitignore"), "secret.log\nnode_modules/\n").unwrap();
        dir.to_string_lossy().into_owned()
    }

    #[test]
    fn list_files_respects_gitignore_and_glob() {
        let repo = temp_repo("list1");

        // glob `**/*.ts` 应只命中 .ts 文件，且排除 node_modules（gitignore）。
        let ts = list_files(Some(repo.clone()), Some("**/*.ts".to_string()), None).unwrap();
        let names: Vec<String> = ts.iter().map(|e| e.path.clone()).collect();
        assert!(names.iter().any(|p| p == "src_a.ts"));
        assert!(names.iter().any(|p| p == "nested/deep.ts"));
        assert!(names.iter().all(|p| !p.starts_with("node_modules")));
        // secret.log 被 gitignore 忽略，不出现。
        assert!(!names.iter().any(|p| p == "secret.log"));
    }

    #[test]
    fn list_files_returns_dirs_and_files() {
        let repo = temp_repo("list2");
        let all = list_files(Some(repo), None, None).unwrap();
        // 至少包含嵌套目录（nested 是目录）。
        assert!(all.iter().any(|e| e.is_dir && e.path == "nested"));
        assert!(all.iter().any(|e| !e.is_dir && e.path == "src_a.ts"));
    }

    #[test]
    fn search_files_uses_regex_and_context() {
        let repo = temp_repo("search1");
        // 正则 `export const \w+ =` 命中 src_a.ts / src_b.ts / nested/deep.ts；
        // 同时验证 context=1 返回前后各 1 行。
        let matches = search_files(
            Some(repo),
            "export const \\w+ =".to_string(),
            None,
            None,
            Some(false),
            Some(false),
            Some(1),
            None,
        )
        .unwrap();
        assert_eq!(matches.len(), 3);
        for m in &matches {
            assert!(m.path.ends_with(".ts"));
            assert!(m.line.contains("export const"));
            // 每个匹配文件只有一行，context 行应为空。
            assert!(m.before.is_empty());
            assert!(m.after.is_empty());
        }
    }

    #[test]
    fn search_files_glob_filters_file_types() {
        let repo = temp_repo("search2");
        // 仅搜 .md 文件，正则 `src_a` 只应命中 readme.md。
        let matches = search_files(
            Some(repo),
            "src_a".to_string(),
            None,
            Some("**/*.md".to_string()),
            Some(false),
            Some(false),
            Some(0),
            None,
        )
        .unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].path, "readme.md");
    }

    #[test]
    fn search_files_literal_mode_escapes_regex() {
        let repo = temp_repo("search3");
        // 字面量搜索含正则元字符的内容；literal=true 时应把 `\w` 当字面量。
        fs::write(
            std::path::Path::new(&repo).join("lit.txt"),
            "price \\w widget",
        )
        .unwrap();
        let literal_hit = search_files(
            Some(repo.clone()),
            "\\w".to_string(),
            None,
            Some("**/*.txt".to_string()),
            Some(true),
            Some(false),
            Some(0),
            None,
        )
        .unwrap();
        assert_eq!(literal_hit.len(), 1);
        assert_eq!(literal_hit[0].line, "price \\w widget");

        // 非 literal 模式下，`\w` 是元字符，应匹配 readme.md 里的 `src_a`（\w 匹配字母）。
        let regex_hit = search_files(
            Some(repo),
            "\\w".to_string(),
            None,
            Some("**/*.md".to_string()),
            Some(false),
            Some(false),
            Some(0),
            None,
        )
        .unwrap();
        assert_eq!(regex_hit.len(), 1);
        assert_eq!(regex_hit[0].path, "readme.md");
    }
}
