//! 受控文件修改工具（Codex 风格代码工作台核心）。
//!
//! 设计定位：
//! - `write_file` / `edit_file` 是模型的原子粒度文件修改入口，替代「全量覆盖靠 export_*」
//!   和「绕过变更面板靠 /bash 写文件」两条旧路。
//! - **围栏**：No-Go Zone（.ssh/AppData/Windows/Program Files）无条件拒绝；项目工作区外
//!   的写入必须由前端 HITL 确认（`confirmed_outside=true`）才放行——安全模型与 export_* 一致。
//! - **快照回滚**：每个路径在进程生命周期内的首次修改前，把磁盘基线存入内存快照表
//!   （None = 该文件是 agent 新建的，撤销即删除）。`undo_file_edit` 恢复基线，不依赖 git。
//! - **diff**：复用 office_export::compute_file_diff（similar crate，内存 unified-diff），
//!   结果经前端 fileDiff 透传进变更面板。

use crate::office_export::{no_go_zone, DiffResult};
use crate::storage_paths::fallback_workspace_root;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 单文件 diff 超限跳过阈值（与 write_text_file 保持一致）。
const MAX_DIFF_CHARS: usize = 2_000_000;

/// 修改快照表：绝对路径 → 修改前磁盘内容（None = agent 新建，撤销时删除文件）。
/// 只在**首次**修改某路径时记录基线，连续多次修改共享同一个撤销点（回到任务起点语义）。
static SNAPSHOTS: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);

fn with_snapshots<T>(f: impl FnOnce(&mut HashMap<String, Option<String>>) -> T) -> T {
    let mut guard = SNAPSHOTS.lock().unwrap();
    f(guard.get_or_insert_with(HashMap::new))
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileEditOutcome {
    pub path: String,
    pub size: u64,
    /// 是否为新建文件（此前不存在）。
    pub created: bool,
    /// 实际替换次数（write_file 新建/覆盖为 0，edit_file 为命中次数）。
    pub replacements: usize,
    /// 内存 unified-diff（超大文件为 None，前端不显示行级对比）。
    pub diff: Option<DiffResult>,
    /// 该路径是否存在撤销快照（供前端提示「可撤销」）。
    pub snapshot_available: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UndoOutcome {
    pub path: String,
    /// true = 恢复了修改前内容；false = 删除了 agent 新建的文件。
    pub restored: bool,
    pub message: String,
}

/// 解析并校验目标路径：绝对化（相对路径 + 工作区拼接）、No-Go Zone 硬拒、
/// 工作区外需前端确认放行。不校验扩展名（代码文件任意类型）。
fn resolve_target(
    path: &str,
    workspace_path: Option<&str>,
    confirmed_outside: bool,
) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("文件路径不能为空".to_string());
    }
    let ws = workspace_path.map(str::trim).filter(|s| !s.is_empty());
    let p = Path::new(trimmed);
    let target: PathBuf = if p.is_absolute() {
        p.to_path_buf()
    } else {
        // 相对路径：有工作区则拼接到工作区下，否则拒绝（避免写到进程 cwd 的不可预期位置）。
        match ws {
            Some(ws) => Path::new(ws).join(p),
            None => {
                return Err(format!(
                    "相对路径「{trimmed}」需要项目工作区才能解析，请提供绝对路径或先绑定项目工作目录"
                ))
            }
        }
    };
    // No-Go Zone 无条件拒绝（与 export_* 同一闸门）。
    if let Some(zone) = no_go_zone(&target) {
        return Err(format!("路径位于禁止写入的{zone}，已拒绝。"));
    }
    // 工作区围栏：项目会话下越界写入需要前端 HITL 确认放行（confirmed_outside=true）。
    if let Some(ws) = ws {
        let outside = !is_within(&target, Path::new(ws));
        if outside && !confirmed_outside {
            return Err(format!(
                "路径「{trimmed}」位于项目工作区（{ws}）之外，需要用户确认后才能写入（由前端确认门处理，不应直接到达此处）"
            ));
        }
    }
    Ok(target)
}

/// child 是否落在 parent 之内（与 office_export::is_within 同规则）。
fn is_within(child: &Path, parent: &Path) -> bool {
    let c = child.to_string_lossy().replace('\\', "/").to_lowercase();
    let p = parent
        .to_string_lossy()
        .replace('\\', "/")
        .to_lowercase()
        .trim_end_matches('/')
        .to_string();
    c == p || c.starts_with(&format!("{p}/"))
}

/// 首次修改前记录磁盘基线快照（同一进程内同一路径只记一次）。
fn snapshot_baseline(target: &Path) {
    let key = target.to_string_lossy().into_owned();
    with_snapshots(|store| {
        if store.contains_key(&key) {
            return;
        }
        let baseline = if target.is_file() {
            std::fs::read_to_string(target).ok()
        } else {
            None
        };
        store.insert(key, baseline);
    });
}

fn file_size(target: &Path) -> u64 {
    std::fs::metadata(target).map(|m| m.len()).unwrap_or(0)
}

fn diff_if_reasonable(old_content: &str, new_content: &str, target: &Path) -> Option<DiffResult> {
    if old_content.len() > MAX_DIFF_CHARS || new_content.len() > MAX_DIFF_CHARS {
        return None;
    }
    let filename = target
        .file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_else(|| target.to_string_lossy().into_owned());
    Some(crate::office_export::compute_file_diff(old_content, new_content, &filename))
}

/// 读文件文本内容（非 UTF-8 视为二进制并拒绝，避免把二进制改坏）。
fn read_text(target: &Path) -> Result<String, String> {
    std::fs::read_to_string(target).map_err(|_| {
        format!(
            "无法以 UTF-8 文本读取「{}」（可能是二进制文件或编码不符），已拒绝修改",
            target.to_string_lossy()
        )
    })
}

/// 写入/新建文件（任意文本类型）：工作区内静默执行，工作区外需前端确认。
/// 已存在且未传 overwrite=true 时拒绝，引导模型改用 edit_file 做定点修改。
#[tauri::command]
pub(crate) async fn write_file_tool(
    app: tauri::AppHandle,
    path: String,
    content: String,
    overwrite: Option<bool>,
    workspace_path: Option<String>,
    confirmed_outside: Option<bool>,
) -> Result<FileEditOutcome, String> {
    if content.is_empty() {
        return Err("写入内容为空：如需清空文件请明确说明，普通写入请提供完整内容".to_string());
    }
    let overwrite = overwrite.unwrap_or(false);
    // 未绑定工作空间时回退到兜底目录（仿 codex 永远有 cwd）。
    let ws = workspace_path
        .filter(|s| !s.trim().is_empty())
        .or_else(|| fallback_workspace_root(&app).ok().map(|p| p.to_string_lossy().into_owned()));
    tauri::async_runtime::spawn_blocking(move || {
        let target = resolve_target(&path, ws.as_deref(), confirmed_outside.unwrap_or(false))?;
        let created = !target.is_file();
        if !created && !overwrite {
            return Err(format!(
                "文件已存在：{}。传 overwrite=true 覆盖整个文件，或改用 edit_file 做定点搜索替换（更安全）",
                target.to_string_lossy()
            ));
        }
        // 覆盖已有文件时先确认它确实是文本（避免把二进制当文本写坏）。
        let old_content = if created {
            String::new()
        } else {
            read_text(&target)?
        };
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
        snapshot_baseline(&target);
        std::fs::write(&target, content.as_bytes()).map_err(|e| format!("写入文件失败: {e}"))?;
        let diff = diff_if_reasonable(&old_content, &content, &target);
        Ok(FileEditOutcome {
            path: target.to_string_lossy().into_owned(),
            size: file_size(&target),
            created,
            replacements: 0,
            diff,
            snapshot_available: true,
        })
    })
    .await
    .map_err(|e| format!("write_file 任务失败: {e}"))?
}

/// 定点搜索替换（Codex edit_file 同款语义）：find 必须精确匹配，
/// 多处命中且未传 replace_all 时拒绝（要求补充上下文或显式 replace_all）。
#[tauri::command]
pub(crate) async fn edit_file_tool(
    app: tauri::AppHandle,
    path: String,
    find: String,
    replace: String,
    replace_all: Option<bool>,
    workspace_path: Option<String>,
    confirmed_outside: Option<bool>,
) -> Result<FileEditOutcome, String> {
    if find.is_empty() {
        return Err("find 不能为空：请提供要替换的精确原文（可包含多行）".to_string());
    }
    let replace_all = replace_all.unwrap_or(false);
    // 未绑定工作空间时回退到兜底目录（仿 codex 永远有 cwd）。
    let ws = workspace_path
        .filter(|s| !s.trim().is_empty())
        .or_else(|| fallback_workspace_root(&app).ok().map(|p| p.to_string_lossy().into_owned()));
    tauri::async_runtime::spawn_blocking(move || {
        let target = resolve_target(&path, ws.as_deref(), confirmed_outside.unwrap_or(false))?;
        if !target.is_file() {
            return Err(format!(
                "文件不存在：{}。请先用 list_files/search_files 定位，或用 write_file 新建",
                target.to_string_lossy()
            ));
        }
        let old_content = read_text(&target)?;
        let count = old_content.matches(&find).count();
        if count == 0 {
            return Err(format!(
                "find 原文在文件中出现 0 次（可能存在缩进/换行差异）。请从文件中精确复制原文后重试"
            ));
        }
        if count > 1 && !replace_all {
            return Err(format!(
                "find 原文在文件中出现 {count} 次。请提供更多上下文使匹配唯一，或传 replace_all=true 替换全部（当前请求已拒绝，未做任何修改）"
            ));
        }
        let new_content = if replace_all {
            old_content.replace(&find, &replace)
        } else {
            old_content.replacen(&find, &replace, 1)
        };
        snapshot_baseline(&target);
        std::fs::write(&target, new_content.as_bytes()).map_err(|e| format!("写入文件失败: {e}"))?;
        let diff = diff_if_reasonable(&old_content, &new_content, &target);
        Ok(FileEditOutcome {
            path: target.to_string_lossy().into_owned(),
            size: file_size(&target),
            created: false,
            replacements: if replace_all { count } else { 1 },
            diff,
            snapshot_available: true,
        })
    })
    .await
    .map_err(|e| format!("edit_file 任务失败: {e}"))?
}

/// 撤销对某文件的 agent 修改：恢复到本进程内首次修改前的磁盘基线；
/// 若文件是 agent 新建的则直接删除。无快照时报错（不可恢复的改动不走此命令）。
#[tauri::command]
pub(crate) async fn undo_file_edit(path: String) -> Result<UndoOutcome, String> {
    let trimmed = path.trim().to_string();
    if trimmed.is_empty() {
        return Err("文件路径不能为空".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        // 三态：None = 无快照（拒绝，防止误删未登记文件）；Some(None) = agent 新建（撤销即删除）；
        // Some(Some(content)) = 恢复修改前内容。
        let baseline = with_snapshots(|store| store.remove(&trimmed));
        let target = Path::new(&trimmed);
        match baseline {
            None => Err(format!(
                "「{trimmed}」没有可撤销的修改快照（可能由 /bash 等其他途径改动，或应用重启后快照已清空）"
            )),
            Some(None) => {
                // agent 新建的文件：撤销即删除（限 filemod 自己登记过的路径，天然围栏内）。
                match std::fs::remove_file(target) {
                    Ok(()) => Ok(UndoOutcome {
                        path: trimmed,
                        restored: false,
                        message: "已删除本次任务新建的文件".to_string(),
                    }),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(UndoOutcome {
                        path: trimmed,
                        restored: false,
                        message: "文件已不存在，无需撤销".to_string(),
                    }),
                    Err(e) => Err(format!("删除文件失败: {e}")),
                }
            }
            Some(Some(content)) => {
                std::fs::write(target, content.as_bytes()).map_err(|e| format!("恢复文件失败: {e}"))?;
                Ok(UndoOutcome {
                    path: trimmed,
                    restored: true,
                    message: "已恢复到本次任务修改前的内容".to_string(),
                })
            }
        }
    })
    .await
    .map_err(|e| format!("undo_file_edit 任务失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("omni_filemod_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn write_then_undo_restores_baseline() {
        let dir = temp_dir("undo");
        let file = dir.join("a.txt");
        std::fs::write(&file, "hello").unwrap();
        snapshot_baseline(&file);
        std::fs::write(&file, "hello world").unwrap();
        let baseline = with_snapshots(|store| store.remove(&file.to_string_lossy().into_owned()));
        assert_eq!(baseline, Some(Some("hello".to_string())));
        std::fs::write(&file, baseline.unwrap().unwrap()).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "hello");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn undo_without_snapshot_is_none() {
        let dir = temp_dir("nosnap");
        let file = dir.join("never_touched.txt");
        std::fs::write(&file, "keep me").unwrap();
        let baseline = with_snapshots(|store| store.remove(&file.to_string_lossy().into_owned()));
        assert!(baseline.is_none(), "未登记路径不得有快照（否则 undo 会误删）");
        assert!(std::fs::read_to_string(&file).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn edit_counts_occurrences() {
        let content = "x = 1\ny = x + 1\n";
        assert_eq!(content.matches("x").count(), 2);
        assert_eq!(content.matches("x = 1").count(), 1);
    }

    #[test]
    fn resolve_target_rejects_relative_without_workspace() {
        let err = resolve_target("src/a.rs", None, false).unwrap_err();
        assert!(err.contains("绝对路径"));
    }

    #[test]
    fn resolve_target_rejects_outside_workspace_without_confirm() {
        let err = resolve_target("D:/somewhere/else/a.rs", Some("D:/Code/ws"), false).unwrap_err();
        assert!(err.contains("确认"));
    }

    #[test]
    fn resolve_target_allows_relative_with_workspace() {
        let target = resolve_target("src/a.rs", Some("D:/Code/ws"), false).unwrap();
        assert!(is_within(&target, Path::new("D:/Code/ws")));
    }
}
