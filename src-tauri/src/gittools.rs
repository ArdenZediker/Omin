//! Git 工作流工具：git_info（只读 status/log/diff/branch）、git_commit（暂存+提交）、
//! git_pr（推送当前分支并用 GitHub CLI 创建 PR）。
//!
//! 全部走系统 `git` / `gh` 可执行文件；工作目录优先用项目工作区路径，
//! 未提供时回落到当前目录。写操作由前端权限体系（项目 allowedToolIds）管控。

use std::process::{Command, Stdio};

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
