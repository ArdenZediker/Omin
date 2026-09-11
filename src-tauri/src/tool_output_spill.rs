//! 工具结果超长输出的「截断 + 完整落盘（spill）」通用管道。
//!
//! 设计对齐 deepseek-harness 的 spillPath：截断只是「不塞进模型上下文」，不等于丢弃——
//! 超长的纯文本工具结果会被整段写到数据根的 `tool-output/` 目录，截断提示里附绝对路径，
//! 模型可按路径回读被砍掉的内容。预览采用 head/tail（保留开头 + 结尾），避免只留开头时
//! 丢失尾部的关键报错 / diff 收尾（对齐 deepseek 的 `TextRetainer` headTail 形态）。
//!
//! 调用点：shell 命令、git 工具、MCP 工具结果组装。read_file / workspace_files 走结构化
//! 分页（`truncated` 字段），不进本管道，以免 read → spill → read 死循环。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// 单次工具结果默认上限（字符）。与 deepseek `maxInlineBytes` / atomcode
/// `max_tool_result_bytes` 同一语义；shell 的 `MAX_OUTPUT_CHARS` 也指向它。
pub(crate) const DEFAULT_TOOL_RESULT_CHARS: usize = 32_000;

/// 超长输出落盘目录（应用启动时由 lib.rs 注入；未注入则只截断不落盘）。
static SPILL_DIR: OnceLock<PathBuf> = OnceLock::new();
/// 单次进程内的落盘序号，避免同毫秒并发写入互相覆盖。
static SPILL_SEQ: AtomicU64 = AtomicU64::new(0);
/// 落盘目录内保留的最大文件数，超出按修改时间删最旧（best-effort）。
pub(crate) const SPILL_KEEP_FILES: usize = 200;

/// 注入落盘目录（幂等，首次调用生效）。
pub(crate) fn configure_spill_dir(dir: PathBuf) {
    let _ = SPILL_DIR.set(dir);
}

/// 落盘文件名里允许出现的工具名片段安全化（去路径分隔符等，仅留安全字符）。
fn safe_tool_tag(tool: &str) -> String {
    tool
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .take(40)
        .collect()
}

/// 把完整输出写到 spill 目录并返回绝对路径；任何失败都静默返回 None（截断提示照旧）。
/// 文件名带工具名前缀，便于事后定位来源。
fn spill_full_output(text: &str, tool_name: &str) -> Option<String> {
    let dir = SPILL_DIR.get()?;
    std::fs::create_dir_all(dir).ok()?;
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis();
    let seq = SPILL_SEQ.fetch_add(1, Ordering::Relaxed);
    let tag = safe_tool_tag(tool_name);
    let path = dir.join(format!("output-{tag}-{millis}-{seq}.log"));
    std::fs::write(&path, text).ok()?;
    prune_spill_dir(dir, SPILL_KEEP_FILES);
    Some(path.to_string_lossy().into_owned())
}

/// 只保留最近 keep 个文件，避免长跑后无限累积（清理失败不影响主流程）。
fn prune_spill_dir(dir: &std::path::Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(SystemTime, PathBuf)> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().map(|kind| kind.is_file()).unwrap_or(false))
        .filter_map(|entry| Some((entry.metadata().ok()?.modified().ok()?, entry.path())))
        .collect();
    if files.len() <= keep {
        return;
    }
    files.sort_by_key(|(modified, _)| *modified);
    let drop_count = files.len() - keep;
    for (_, path) in files.into_iter().take(drop_count) {
        let _ = std::fs::remove_file(path);
    }
}

/// head/tail 预览：保留开头约 60% 与结尾约 40%，中间标注省略字符数。
/// 返回 (预览文本, 被省略字符数)。`total <= max` 时原样返回、省略 0。
fn head_tail_preview(text: &str, max: usize) -> (String, usize) {
    let total = text.chars().count();
    if total <= max {
        return (text.to_string(), 0);
    }
    let head_chars = ((max as f64) * 0.6) as usize;
    let tail_chars = max.saturating_sub(head_chars);
    let head: String = text.chars().take(head_chars).collect();
    let tail: String = text
        .chars()
        .rev()
        .take(tail_chars)
        .collect::<Vec<char>>()
        .into_iter()
        .rev()
        .collect();
    let omitted = total.saturating_sub(head_chars + tail_chars);
    let preview = format!("{head}\n…[中间省略 {omitted} 字符…]\n{tail}");
    (preview, omitted)
}

/// 截断逻辑本体（spill 回调由调用方注入，便于测试）。head/tail 预览。
fn cap_output_with_spill(
    text: &str,
    max: usize,
    spill: impl FnOnce(&str) -> Option<String>,
) -> String {
    let total = text.chars().count();
    if total <= max {
        return text.to_string();
    }
    let (preview, _omitted) = head_tail_preview(text, max);
    match spill(text) {
        Some(path) => format!(
            "{preview}\n…[输出超过 {max} 字符已截断]\n[完整输出共 {total} 字符，已保存到 {path}]"
        ),
        None => format!("{preview}\n…[输出超过 {max} 字符已截断]"),
    }
}

/// 通用截断 + 落盘。超过 `max` 字符时保留 head/tail 预览，并把完整原文落盘，
/// 提示里附绝对路径。保留 `字符已截断]` 子串——前端 `withClipNote` 靠它识别截断并补引导。
pub(crate) fn cap_and_spill(text: &str, max: usize, tool_name: &str) -> String {
    cap_output_with_spill(text, max, |t| spill_full_output(t, tool_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cap_output_leaves_short_text_untouched() {
        let spill = |_: &str| -> Option<String> { panic!("短文本不应触发落盘") };
        assert_eq!(cap_output_with_spill("hello", 10, spill), "hello");
    }

    #[test]
    fn cap_output_keeps_legacy_hint_when_spill_unavailable() {
        let long = "a".repeat(20);
        let out = cap_output_with_spill(&long, 5, |_| None);
        // 前端 withClipNote 靠「字符已截断]」识别截断并补引导，这个子串不能丢。
        assert!(out.contains("字符已截断]"), "缺少前端依赖的截断标记：{out}");
        // head/tail 预览：开头保留 60% ≈ 3 个字符。
        assert!(out.starts_with("aaa"), "head 预览不符：{out}");
        assert!(!out.contains("已保存到"));
    }

    #[test]
    fn cap_output_appends_spill_path_when_available() {
        let long = "b".repeat(20);
        let out = cap_output_with_spill(&long, 5, |text| {
            assert_eq!(text.chars().count(), 20, "落盘的必须是完整输出而非截断片段");
            Some("C:/tmp/output-1.log".to_string())
        });
        assert!(out.contains("字符已截断]"));
        assert!(out.contains("完整输出共 20 字符"));
        assert!(out.contains("C:/tmp/output-1.log"));
    }

    #[test]
    fn cap_output_uses_head_tail_preview() {
        // 头部与尾部都应出现在预览里，中间有省略标记。
        let head = "HEAD_LINE_";
        let tail = "_TAIL_LINE";
        let middle = "M".repeat(5000);
        let long = format!("{head}{middle}{tail}");
        let out = cap_output_with_spill(&long, 200, |_| None);
        assert!(out.contains(head), "head 丢失：{out}");
        assert!(out.contains(tail), "tail 丢失：{out}");
        assert!(out.contains("中间省略"), "缺少中间省略标记：{out}");
    }

    #[test]
    fn prune_spill_dir_keeps_newest_files() {
        let dir = std::env::temp_dir().join("omni-spill-prune-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..6u64 {
            std::fs::write(dir.join(format!("output-{i}.log")), "x").unwrap();
            // 让 modified 有可分辨的先后（部分文件系统时间戳精度有限）。
            std::thread::sleep(std::time::Duration::from_millis(12));
        }
        prune_spill_dir(&dir, 2);
        for i in 0..4u64 {
            assert!(!dir.join(format!("output-{i}.log")).exists(), "旧文件 output-{i} 未被清理");
        }
        for i in 4..6u64 {
            assert!(dir.join(format!("output-{i}.log")).exists(), "新文件 output-{i} 被误删");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cap_output_writes_full_text_when_spill_dir_configured() {
        let dir = std::env::temp_dir().join("omni-spill-io-test");
        let _ = std::fs::remove_dir_all(&dir);
        configure_spill_dir(dir.clone());

        let long = "z".repeat(50);
        let out = cap_and_spill(&long, 10, "bash");

        // 前端依赖的截断标记仍在，且提示里带上了落盘路径。
        assert!(out.contains("字符已截断]"), "缺少截断标记：{out}");
        assert!(out.contains(dir.to_string_lossy().as_ref()), "提示里应带上落盘路径：{out}");

        // 落盘的必须是完整原文，而不是被截断的片段。
        let written = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
            .find(|content| content == &long);
        assert_eq!(written.as_deref(), Some(long.as_str()), "落盘内容不是完整原文");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cap_output_preserves_tail_on_overflow() {
        // 关键信息常在尾部（报错 / diff 收尾）：必须出现在预览里。
        let body = "x".repeat(4000);
        let tail_marker = "FATAL_ERROR_AT_END";
        let long = format!("{body}{tail_marker}");
        let out = cap_and_spill(&long, 100, "bash");
        assert!(out.contains(tail_marker), "尾部关键信息丢失：{out}");
    }
}
