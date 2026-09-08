//! 受控本地命令执行（Bash / shell 工具）。
//!
//! 设计定位（对齐本地工作台安全模型）：
//! - 仅执行 shell 命令，不做任何"解释"`;命令字符串原样交给系统 shell。
//! - Windows 默认走 `cmd /C`，其他平台走 `sh -c`；统一用 shell 包装，方便 `bun`、`npm`、
//!   管道、重定向等 CLI 技能包使用。
//! - 工作目录（cwd）由前端传入（锁定在项目工作区），为空时回落到应用当前目录。
//! - 内置超时（默认 120s），超时杀掉整个子进程树，避免长命令/卡死耗尽线程。
//! - **危险命令拦截在前端工具层做**（见 `src/chat/localTools.ts` 的 `bash` 工具），
//!   本模块只负责"执行 + 回传输出 + 超时"，不替业务判断风险。

use serde::{Deserialize, Serialize};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 默认命令超时（毫秒）。CLI 技能包（如腾讯新闻 install-cli）可能要下载，给足时间。
const DEFAULT_TIMEOUT_MS: u64 = 120_000;
/// 单次输出上限，超出截断，避免超大输出撑爆上下文。
const MAX_OUTPUT_CHARS: usize = 32_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteCommandInput {
    /// 要执行的 shell 命令字符串（原样交给系统 shell）。
    pub command: String,
    /// 工作目录（绝对路径）。建议锁定在项目工作区。
    #[serde(default)]
    pub cwd: Option<String>,
    /// 自定义超时（毫秒），可选；超出用默认。
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteCommandResult {
    /// 退出码（0 = 成功）。
    pub exit_code: i32,
    /// 合并后的标准输出 + 标准错误（已截断）。
    pub output: String,
    /// 是否因超时被强杀。
    pub timed_out: bool,
}

fn cap_output(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        let cut: String = text.chars().take(max).collect();
        format!("{cut}\n…[输出超过 {max} 字符已截断]")
    }
}

/// 用系统 shell 执行命令，带超时与跨平台无窗口处理。
fn run_shell(input: ExecuteCommandInput) -> Result<ExecuteCommandResult, String> {
    let timeout = Duration::from_millis(input.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
    let cwd = input.cwd.clone();

    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", &input.command]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", &input.command]);
        c
    };
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    if let Some(d) = &cwd {
        let path = std::path::Path::new(d);
        if !path.is_dir() {
            return Err(format!("工作目录不存在：{d}"));
        }
        cmd.current_dir(path);
    }

    let child = cmd.spawn().map_err(|e| format!("无法启动命令（请确认相关可执行文件已在 PATH 中）：{e}"))?;

    // 把 child 放进 Arc<Mutex> 以便超时线程能跨线程 kill。
    let child_arc = Arc::new(Mutex::new(child));
    let wait_child = Arc::clone(&child_arc);
    let (tx, rx) = std::sync::mpsc::channel::<std::process::ExitStatus>();
    let wait_thread = thread::spawn(move || {
        let status = wait_child.lock().unwrap().wait();
        if let Ok(status) = status {
            let _ = tx.send(status);
        }
    });

    match rx.recv_timeout(timeout) {
        Ok(status) => {
            let mut guard = child_arc.lock().unwrap();
            let (stdout, stderr) = collect_outputs(&mut guard);
            let combined = combine(stdout, stderr);
            Ok(ExecuteCommandResult {
                exit_code: status.code().unwrap_or(-1),
                output: cap_output(&combined, MAX_OUTPUT_CHARS),
                timed_out: false,
            })
        }
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            // 超时：强杀子进程并回收。
            let _ = child_arc.lock().unwrap().kill();
            let _ = wait_thread.join();
            let mut guard = child_arc.lock().unwrap();
            let (stdout, stderr) = collect_outputs(&mut guard);
            let mut combined = combine(stdout, stderr);
            combined.push_str("\n[命令超时已被终止]");
            Ok(ExecuteCommandResult {
                exit_code: -1,
                output: cap_output(&combined, MAX_OUTPUT_CHARS),
                timed_out: true,
            })
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            Err("命令执行过程中通道断开".to_string())
        }
    }
}

fn collect_outputs(child: &mut std::process::Child) -> (String, String) {
    use std::io::Read;
    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(mut out) = child.stdout.take() {
        let _ = out.read_to_string(&mut stdout);
    }
    if let Some(mut err) = child.stderr.take() {
        let _ = err.read_to_string(&mut stderr);
    }
    (stdout, stderr)
}

fn combine(stdout: String, stderr: String) -> String {
    let stdout = stdout.trim_end().to_string();
    let stderr = stderr.trim_end().to_string();
    if stderr.is_empty() {
        stdout
    } else if stdout.is_empty() {
        stderr
    } else {
        format!("{stdout}\n{stderr}")
    }
}

#[tauri::command]
pub(crate) async fn execute_command(input: ExecuteCommandInput) -> Result<ExecuteCommandResult, String> {
    if input.command.trim().is_empty() {
        return Err("命令不能为空".to_string());
    }
    let input = input;
    tauri::async_runtime::spawn_blocking(move || run_shell(input))
        .await
        .map_err(|e| format!("execute_command 任务失败: {e}"))?
}
