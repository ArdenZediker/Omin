//! Git 工作流工具：git_info（只读 status/log/diff/branch）、git_commit（暂存+提交）、
//! git_pr（推送当前分支并用 GitHub CLI 创建 PR）。
//!
//! 全部走系统 `git` / `gh` 可执行文件；工作目录优先用项目工作区路径，
//! 未提供时回落到当前目录。写操作由前端权限体系（项目 allowedToolIds）管控。

use serde::{Deserialize, Serialize};
use std::process::{Command, Stdio};

/// git 状态/单文件 diff 的结构化结果,方便前端直接渲染(无需解析文本)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitFileChange {
    /// 相对工作区根的 POSIX 路径（用 `/` 分隔,方便前端直接显示）。
    pub path: String,
    /// `git status --porcelain` 两位 XY 码(左 X=索引区,右 Y=工作区)。
    /// 常见: ` M` = 工作区修改, `M ` = 暂存修改, `??` = 未跟踪, `A ` = 新增已暂存, `D ` = 删除已暂存。
    pub status: String,
    /// `git diff --numstat` 增加行数;二进制文件为 -1。
    pub additions: i64,
    /// 删除行数;二进制为 -1。
    pub deletions: i64,
    /// 是否有已暂存(staged)部分的修改。
    pub staged: bool,
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn run_command(dir: Option<&str>, program: &str, args: &[&str]) -> Result<(bool, String), String> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    if let Some(d) = dir {
        let path = std::path::Path::new(d);
        if !path.is_dir() {
            return Err(format!("工作目录不存在：{d}"));
        }
        cmd.current_dir(path);
    }
    let output = cmd.output().map_err(|e| {
        if program == "git" {
            format!("无法执行 git（请确认已安装并加入 PATH）: {e}")
        } else {
            format!("无法执行 {program}: {e}")
        }
    })?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let combined = if stderr.trim().is_empty() {
        stdout
    } else if stdout.trim().is_empty() {
        stderr
    } else {
        format!("{stdout}\n{stderr}")
    };
    Ok((output.status.success(), combined.trim().to_string()))
}

fn run_git(dir: Option<&str>, args: &[&str]) -> Result<String, String> {
    let (ok, output) = run_command(dir, "git", args)?;
    if !ok {
        return Err(friendly_git_error(&output));
    }
    Ok(output)
}

fn friendly_git_error(output: &str) -> String {
    let lower = output.to_lowercase();
    if lower.contains("not a git repository") {
        "目标目录不是 Git 仓库（可先在终端执行 git init 或传入正确的工作区路径）".to_string()
    } else if lower.contains("does not have a commit checked out") {
        "该目录是嵌套的 Git 工作区，请传入仓库根目录".to_string()
    } else if lower.contains("user.name") || lower.contains("user.email") {
        format!("Git 身份未配置，请先执行：git config --global user.name / user.email\n{output}")
    } else if lower.contains("nothing to commit") {
        "没有可提交的变更（工作区是干净的）".to_string()
    } else {
        format!("git 执行失败：{output}")
    }
}

fn cap_output(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        let cut: String = text.chars().take(max).collect();
        format!("{cut}\n…[输出已截断]")
    }
}

// ---------- git_info（只读） ----------

#[tauri::command]
pub(crate) async fn git_info(
    project_path: Option<String>,
    operation: String,
    limit: Option<usize>,
) -> Result<String, String> {
    let dir = project_path.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let args: Vec<String> = match operation.as_str() {
            "status" => vec![
                "status".into(),
                "--short".into(),
                "--branch".into(),
            ],
            "log" => {
                let n = limit.unwrap_or(20).clamp(1, 50).to_string();
                vec!["log".into(), "--oneline".into(), "--decorate".into(), "-n".into(), n]
            }
            "diff" => vec!["diff".into()],
            "diff-staged" => vec!["diff".into(), "--cached".into()],
            "branch" => vec!["branch".into(), "-vv".into()],
            other => return Err(format!("不支持的 git_info 操作：{other}（可选 status / log / diff / diff-staged / branch）")),
        };
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let output = run_git(dir.as_deref(), &arg_refs)?;
        let empty_hint = if output.trim().is_empty() {
            match args[0].as_str() {
                "diff" => "（工作区相对 HEAD 无未暂存改动）".to_string(),
                "diff-staged" => "（暂存区为空）".to_string(),
                _ => String::new(),
            }
        } else {
            String::new()
        };
        Ok(cap_output(&format!("{output}{empty_hint}"), 20_000))
    })
    .await
    .map_err(|e| format!("git_info 任务失败: {e}"))?
}

// ---------- git_status_files (结构化 status + numstat) ----------

/// `git status --porcelain` 两位码映射。
/// `XY`: 左 X=索引区、右 Y=工作区;`?`=未跟踪;` `=未变更。
#[allow(dead_code)]
pub fn parse_porcelain_to_xy(record: &str) -> (String, String) {
    // v2 格式:"<header_byte> <index_state> <worktree_state> ..." 中单个字符分隔
    // 但我们最终使用 v1 (`git status --porcelain=1`) 的两字符 XY,见下面对调用端约束。
    // 函数仅用于测试+v1 解析复用
    let bytes = record.as_bytes();
    if bytes.len() < 2 {
        return (" ".to_string(), " ".to_string());
    }
    (bytes[0..1].iter().copied().map(|b| b as char).collect(), bytes[1..2].iter().copied().map(|b| b as char).collect())
}

#[tauri::command]
pub(crate) async fn git_status_files(
    project_path: Option<String>,
) -> Result<Vec<GitFileChange>, String> {
    let dir = project_path.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<GitFileChange>, String> {
        // 用 v1 porcelain:两位 XY 码 + (空格)path,简单清晰。
        let (porcelain_ok, porcelain_out) = run_command(
            dir.as_deref(),
            "git",
            &["status", "--porcelain=1", "--untracked-files=normal"],
        )?;
        if !porcelain_ok {
            return Err(format!("git status 解析失败:{porcelain_out}"));
        }
        // 同时取工作区 vs HEAD、暂存区 vs HEAD 的 numstat,合计每文件加/删行
        let (_, ws_numstat) = run_command(dir.as_deref(), "git", &["diff", "--numstat", "--no-renames"])?;
        let (_, staged_numstat) = run_command(dir.as_deref(), "git", &["diff", "--cached", "--numstat", "--no-renames"])?;
        let mut ws_nums: std::collections::HashMap<String, (i64, i64)> = std::collections::HashMap::new();
        let mut staged_nums: std::collections::HashMap<String, (i64, i64)> = std::collections::HashMap::new();
        let parse_numstat = |out: &str, target: &mut std::collections::HashMap<String, (i64, i64)>| {
            for line in out.lines() {
                let mut parts = line.split('\t');
                let adds = parts.next().unwrap_or("0");
                let dels = parts.next().unwrap_or("0");
                let path = parts.next().unwrap_or("");
                if path.is_empty() { continue; }
                let a = if adds == "-" { -1 } else { adds.parse::<i64>().unwrap_or(0) };
                let d = if dels == "-" { -1 } else { dels.parse::<i64>().unwrap_or(0) };
                target.insert(path.to_string(), (a, d));
            }
        };
        parse_numstat(&ws_numstat, &mut ws_nums);
        parse_numstat(&staged_numstat, &mut staged_nums);

        let mut out: Vec<GitFileChange> = Vec::new();
        for line in porcelain_out.lines() {
            if line.len() < 3 { continue; }
            // porcelain v1:"XY path" (XY 占两位,第三位是空格)
            let xy = &line[..2];
            let raw_path = line[3..].to_string();
            // 去掉重命名前导 "old -> new";简单处理:从最后一段 `->` 取后端
            let path_str = match raw_path.find(" -> ") {
                Some(idx) => raw_path[idx + 4..].to_string(),
                None => raw_path.clone(),
            };
            let path = path_str.replace('\\', "/");
            let staged = xy.chars().next().map(|c| c != ' ' && c != '?').unwrap_or(false);
            // 加/删合并:暂存 + 工作区,worktree 优先
            let (mut additions, mut deletions) = (0i64, 0i64);
            // 二进制 (- -) 在 numstat 中表现为 ( -1, -1)
            if let Some((a, d)) = ws_nums.get(&path_str) {
                additions += *a;
                deletions += *d;
            }
            // 已暂存部分单加(避免重复统计)
            if let Some((a, d)) = staged_nums.get(&path_str) {
                if xy.chars().next().map(|c| c != ' ' && c != '?').unwrap_or(false) {
                    // 当文件已暂存时,numstat(unstaged)未含这部分,需要加上暂存侧
                    // 但 grep 实际上只在 diff 命令参数包含 staged 时不同,所以这里直接加
                    additions += *a;
                    deletions += *d;
                }
            }
            out.push(GitFileChange {
                path,
                status: xy.to_string(),
                additions,
                deletions,
                staged,
            });
        }

        // 排序:未跟踪 → 工作区 → 暂存;同组按路径升序
        out.sort_by(|a, b| {
            fn rank(s: &str) -> u8 {
                match s {
                    "??" => 0,
                    " M" | "MM" | " D" | "MD" | "AM" | "?M" => 1,
                    "M " | "A " | "R " | "C " => 2,
                    "D " => 3,
                    _ => 1,
                }
            }
            rank(&a.status).cmp(&rank(&b.status)).then(a.path.cmp(&b.path))
        });
        Ok(out)
    })
    .await
    .map_err(|e| format!("git_status_files 任务失败:{e}"))?
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitFileDiff {
    /// 相对工作区根的 POSIX 路径
    pub path: String,
    /// 状态码(与 GitFileChange.status 一致)
    pub status: String,
    /// unified diff 文本(可能为空:当文件无修改,或全部已恢复)
    pub unified_diff: String,
    /// 该文件总加/删行数(二进制为 -1)
    pub additions: i64,
    pub deletions: i64,
}

#[tauri::command]
pub(crate) async fn git_diff_file(
    project_path: Option<String>,
    file_path: String,
    staged: Option<bool>,
) -> Result<GitFileDiff, String> {
    let dir = project_path.clone();
    let file_path_clone = file_path.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<GitFileDiff, String> {
        let file_path = file_path_clone;
        if file_path.is_empty() {
            return Err("file_path 不能为空".to_string());
        }
        if file_path.contains("..") || file_path.starts_with('/') || file_path.starts_with('\\') {
            return Err(format!("非法的文件路径:{file_path}"));
        }
        let use_staged = staged.unwrap_or(false);
        let mut args: Vec<String> = vec!["diff".into(), "--no-color".into(), "--no-ext-diff".into()];
        if use_staged { args.push("--cached".into()); }
        args.push("--".into());
        args.push(file_path.clone());
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();

        let (ok, out) = run_command(dir.as_deref(), "git", &arg_refs)?;
        if !ok {
            return Err(format!("git diff {file_path} 失败:{out}"));
        }
        let mut unified = out;

        // 未跟踪文件用 diff --no-index /dev/null <path> 制造完整新增块
        if unified.trim().is_empty() {
            let (_, porcelain) = run_command(
                dir.as_deref(),
                "git",
                &["status", "--porcelain=1", "--untracked-files=normal", "--", &file_path],
            )?;
            if porcelain.lines().any(|l| l.starts_with("??")) {
                match run_command(
                    dir.as_deref(),
                    "git",
                    &["diff", "--no-color", "--no-ext-diff", "/dev/null", &file_path],
                ) {
                    Ok((_, synth)) => unified = synth,
                    Err(_) => {}
                }
            }
        }

        // 计算加/删行
        let (mut additions, mut deletions) = (0i64, 0i64);
        for line in unified.lines() {
            if line.starts_with("+++") || line.starts_with("---") { continue; }
            if let Some(s) = line.strip_prefix('+') {
                if !s.starts_with("++") { additions += 1; }
            } else if let Some(s) = line.strip_prefix('-') {
                if !s.starts_with("--") { deletions += 1; }
            }
        }

        let status = if unified.contains("new file mode") {
            "??".to_string()
        } else if unified.contains("deleted file mode") {
            " D".to_string()
        } else {
            " M".to_string()
        };

        Ok(GitFileDiff {
            path: file_path.replace('\\', "/"),
            status,
            unified_diff: unified,
            additions,
            deletions,
        })
    })
    .await
    .map_err(|e| format!("git_diff_file 任务失败:{e}"))?
}

// ---------- git_commit ----------

#[tauri::command]
pub(crate) async fn git_commit(
    project_path: Option<String>,
    message: String,
    add_all: Option<bool>,
    paths: Option<Vec<String>>,
) -> Result<String, String> {
    let dir = project_path.clone();
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err("提交信息（message）不能为空".to_string());
    }
    let add_all = add_all.unwrap_or(false);
    let paths = paths.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        if add_all {
            run_git(dir.as_deref(), &["add", "-A"])?;
        } else if !paths.is_empty() {
            let mut args = vec!["add"];
            args.extend(paths.iter().map(String::as_str));
            run_git(dir.as_deref(), &args)?;
        } else {
            // 未指定暂存范围时，确认暂存区已有内容，否则给出明确指引。
            let (ok, _) = run_command(dir.as_deref(), "git", &["diff", "--cached", "--quiet"])?;
            if ok {
                return Err(
                    "没有已暂存的变更：请传 addAll=true 全量暂存、paths 指定文件，或先自行 git add"
                        .to_string(),
                );
            }
        }
        run_git(dir.as_deref(), &["commit", "-m", &message])?;
        let hash = run_git(dir.as_deref(), &["rev-parse", "--short", "HEAD"])?;
        let summary = run_git(dir.as_deref(), &["show", "--stat", "--oneline", "-s", "HEAD"])
            .unwrap_or_default();
        Ok(format!("提交成功（{hash}）\n{summary}"))
    })
    .await
    .map_err(|e| format!("git_commit 任务失败: {e}"))?
}

// ---------- git_pr ----------

#[tauri::command]
pub(crate) async fn git_pr(
    project_path: Option<String>,
    title: String,
    body: Option<String>,
    base: Option<String>,
) -> Result<String, String> {
    let dir = project_path.clone();
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("PR 标题（title）不能为空".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let (gh_ok, _) = run_command(dir.as_deref(), "gh", &["--version"])?;
        if !gh_ok {
            return Err("未检测到 GitHub CLI（gh）：请先安装 https://cli.github.com/ 并执行 gh auth login".to_string());
        }
        let branch = run_git(dir.as_deref(), &["rev-parse", "--abbrev-ref", "HEAD"])?;
        if branch.is_empty() || branch == "HEAD" {
            return Err("当前处于 detached HEAD，无法创建 PR".to_string());
        }
        // 推送当前分支（已有 upstream 时 -u 幂等）。
        let (push_ok, push_out) = run_command(dir.as_deref(), "git", &["push", "-u", "origin", &branch])?;
        if !push_ok {
            return Err(format!("推送分支 {branch} 失败：{push_out}"));
        }
        let mut args = vec!["pr", "create", "--title", &title];
        let body_str = body.unwrap_or_default();
        if body_str.trim().is_empty() {
            args.push("--fill-first");
        } else {
            args.push("--body");
            args.push(&body_str);
        }
        let base_str;
        if let Some(b) = base.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            base_str = b.to_string();
            args.push("--base");
            args.push(&base_str);
        }
        let (ok, out) = run_command(dir.as_deref(), "gh", &args)?;
        if !ok {
            return Err(format!("gh pr create 失败：{out}"));
        }
        Ok(format!("分支 {branch} 已推送，PR 创建成功：\n{out}"))
    })
    .await
    .map_err(|e| format!("git_pr 任务失败: {e}"))?
}

// ---------- 单元测试 ----------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cap_output_truncates() {
        let long = "a".repeat(300);
        assert!(cap_output(&long, 100).contains("已截断"));
        assert_eq!(cap_output("short", 100), "short");
    }

    #[test]
    fn friendly_error_maps_missing_repo() {
        let msg = friendly_git_error("fatal: not a git repository (or any of the parent directories)");
        assert!(msg.contains("不是 Git 仓库"));
    }

    #[test]
    fn git_info_rejects_unknown_operation() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let err = rt
            .block_on(git_info(None, "rebase".into(), None))
            .unwrap_err();
        assert!(err.contains("不支持"));
    }
}
