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
    /// 自定义 Shell 可执行文件路径（设置 → 命令执行）。非空时覆盖自动探测；
    /// 按可执行名匹配参数：bash/zsh → -lc，cmd → /C，pwsh → -Command，其余 → -c。
    #[serde(default)]
    pub shell_path: Option<String>,
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

/// 探测 Git for Windows 自带的 bash.exe（结果缓存，进程生命周期内只查一次盘）。
/// 覆盖：Program Files / Program Files (x86) / 用户级安装（%LOCALAPPDATA%\Programs\Git）
/// 与 scoop 安装。**刻意不探测 `C:\Windows\System32\bash.exe`** —— 那是 WSL，
/// 路径体系（/mnt/c）和行为完全不同，误用会造成语义错乱。
#[cfg(windows)]
fn detect_git_bash() -> Option<String> {
    use std::sync::OnceLock;
    static GIT_BASH: OnceLock<Option<String>> = OnceLock::new();
    GIT_BASH
        .get_or_init(|| {
            let mut candidates: Vec<String> = Vec::new();
            if let Ok(pf) = std::env::var("ProgramFiles") {
                candidates.push(format!("{pf}\\Git\\bin\\bash.exe"));
            }
            if let Ok(pf) = std::env::var("ProgramFiles(x86)") {
                candidates.push(format!("{pf}\\Git\\bin\\bash.exe"));
            }
            if let Ok(lad) = std::env::var("LOCALAPPDATA") {
                candidates.push(format!("{lad}\\Programs\\Git\\bin\\bash.exe"));
            }
            if let Ok(home) = std::env::var("USERPROFILE") {
                candidates.push(format!("{home}\\scoop\\apps\\git\\current\\bin\\bash.exe"));
            }
            candidates
                .into_iter()
                .find(|p| std::path::Path::new(p).is_file())
        })
        .clone()
}

/// 按可执行文件名选择传参方式（自定义 Shell 与自动探测共用）。
/// bash/zsh 用登录 shell（-l 加载标准 PATH，ls/grep 等 POSIX 工具可用）；
/// sh/dash/fish 及未知可执行用最通用的 -c；PowerShell 用 -NoLogo -Command；cmd 用 /C。
/// 特例：wsl.exe 用 `-- <命令>`（交默认 Linux shell 执行，路径体系 /mnt/c）；
/// busybox.exe 用 `sh -c <命令>`（busybox 本体不是 shell，需指定 applet）。
fn apply_shell_args(cmd: &mut Command, exe_stem: &str, command: &str) {
    let name = exe_stem.to_ascii_lowercase();
    let is_powershell = name == "pwsh" || name.contains("powershell");
    let is_bash_like = name.contains("bash") || name.contains("zsh");
    let is_cmd = name == "cmd" || name == "cmd.exe";
    let is_wsl = name == "wsl" || name == "wsl.exe";
    let is_busybox = name == "busybox";

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if is_cmd {
            // raw_arg 原样传命令，避开 Rust 自动加引号触发 cmd 外层引号剥离规则。
            cmd.raw_arg("/C").raw_arg(command);
            return;
        }
        if is_wsl {
            // wsl.exe 对参数有自己的解析（会拼回 Linux 命令行），同样用 raw_arg 原样传递，
            // 避免 Rust 的自动引号被 wsl 再剥一层。
            cmd.raw_arg("--").raw_arg(command);
            return;
        }
    }
    #[cfg(not(windows))]
    let _ = (is_cmd, is_wsl);

    if is_busybox {
        cmd.arg("sh").arg("-c").arg(command);
    } else if is_powershell {
        cmd.arg("-NoLogo").arg("-Command").arg(command);
    } else if is_bash_like {
        cmd.arg("-lc").arg(command);
    } else {
        cmd.arg("-c").arg(command);
    }
}

/// 解析自定义 Shell 路径：非空时校验文件存在并返回（路径, 可执行名）。
fn resolve_custom_shell(shell_path: Option<&str>) -> Result<Option<(String, String)>, String> {
    let Some(p) = shell_path.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let path = std::path::Path::new(p);
    if !path.is_file() {
        return Err(format!("自定义 Shell 路径不存在：{p}"));
    }
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    Ok(Some((p.to_string(), stem)))
}

/// 构造系统 shell 包装命令。
/// 优先级：设置里的自定义 Shell 路径 > Windows 自动探测 Git-Bash > 系统默认。
/// Windows 自动探测未命中时回落 `cmd /C`，用 `raw_arg` **原样**传命令字符串
/// （不做 Rust 的自动引号转义）——若用 `.args(["/C", cmd])`，Rust 会在命令含
/// 空格时整体加引号变成 `cmd /C "整个命令"`，触发 cmd 特殊的外层引号剥离规则，
/// 导致含空格路径、嵌套双引号的命令解析错乱（手动 cmd 能跑、程序调用就失败的
/// 典型根因）。原样传递等价于手敲 `cmd /C <命令>`。
/// 其他平台：`sh -c <命令>`。
#[cfg(windows)]
fn build_shell_command(command: &str, shell_path: Option<&str>) -> Result<Command, String> {
    if let Some((path, stem)) = resolve_custom_shell(shell_path)? {
        let mut c = Command::new(path);
        apply_shell_args(&mut c, &stem, command);
        return Ok(c);
    }
    if let Some(bash) = detect_git_bash() {
        let mut c = Command::new(bash);
        c.arg("-lc").arg(command);
        return Ok(c);
    }
    use std::os::windows::process::CommandExt;
    let mut c = Command::new("cmd");
    c.raw_arg("/C").raw_arg(command);
    Ok(c)
}

#[cfg(not(windows))]
fn build_shell_command(command: &str, shell_path: Option<&str>) -> Result<Command, String> {
    if let Some((path, stem)) = resolve_custom_shell(shell_path)? {
        let mut c = Command::new(path);
        apply_shell_args(&mut c, &stem, command);
        return Ok(c);
    }
    let mut c = Command::new("sh");
    c.arg("-c").arg(command);
    Ok(c)
}

/// 环境变量脱敏（对齐 Codex spawn_child 的 allowlist 语义）：
/// 子进程不再继承父进程全部环境变量——密钥类变量（apiKey/token 等）不会随 /bash 泄漏到
/// 命令输出或第三方 CLI。白名单只保留系统/基础设施必需项，保证 shell、PATH 解析、
/// 用户目录、临时目录等正常工作。Git-Bash 需 MSYSTEM/EXEPATH 才能正确初始化。
fn scrub_environment(cmd: &mut Command) {
    const ALLOWED: &[&str] = &[
        // Windows 系统必需
        "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "OS",
        "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
        "ALLUSERSPROFILE", "PROGRAMDATA", "PUBLIC",
        "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
        "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432",
        // 用户与目录
        "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "HOME", "APPDATA", "LOCALAPPDATA",
        "TEMP", "TMP", "TMPDIR",
        // 身份
        "USERNAME", "COMPUTERNAME", "USERDOMAIN", "USERDOMAIN_ROAMINGPROFILE",
        // Shell / 工具链
        "PATH", "SHELL", "LANG", "LC_ALL", "TERM",
        "MSYSTEM", "EXEPATH", "HOME_DRIVE",
        "JAVA_HOME", "CARGO_HOME", "RUSTUP_HOME", "GOPATH", "GOROOT", "PYTHONDONTWRITEBYTECODE",
    ];
    cmd.env_clear();
    for (key, value) in std::env::vars_os() {
        let key_str = key.to_string_lossy();
        if ALLOWED.iter().any(|allowed| allowed.eq_ignore_ascii_case(&key_str)) {
            cmd.env(key, value);
        }
    }
}

/// 用系统 shell 执行命令，带超时与跨平台无窗口处理。
fn run_shell(input: ExecuteCommandInput) -> Result<ExecuteCommandResult, String> {
    let timeout = Duration::from_millis(input.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
    let cwd = input.cwd.clone();

    let mut cmd = build_shell_command(&input.command, input.shell_path.as_deref())?;
    scrub_environment(&mut cmd);
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectShellResult {
    /// 是否检测通过（文件存在且 `--version` 正常返回）。
    pub ok: bool,
    /// Shell 自报的版本信息（或失败原因），供设置页展示。
    pub output: String,
}

/// 检测自定义 Shell 可用性：执行 `{path} --version`（8s 超时），供设置页「检测可用性」按钮。
/// 注意：仅做可用性探测，不改变任何安全策略——黑名单/确认门/工作目录锁定不受 Shell 类型影响。
#[tauri::command]
pub(crate) async fn detect_shell(path: String) -> Result<DetectShellResult, String> {
    let p = path.trim().to_string();
    if p.is_empty() {
        return Err("路径不能为空".to_string());
    }
    if !std::path::Path::new(&p).is_file() {
        return Ok(DetectShellResult {
            ok: false,
            output: format!("文件不存在：{p}"),
        });
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&p);
        cmd.arg("--version")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let child = cmd
            .spawn()
            .map_err(|e| format!("无法启动（不是有效的可执行文件？）：{e}"))?;
        let child_arc = Arc::new(Mutex::new(child));
        let wait_child = Arc::clone(&child_arc);
        let (tx, rx) = std::sync::mpsc::channel::<std::process::ExitStatus>();
        thread::spawn(move || {
            if let Ok(status) = wait_child.lock().unwrap().wait() {
                let _ = tx.send(status);
            }
        });
        let status = match rx.recv_timeout(Duration::from_secs(8)) {
            Ok(status) => Some(status),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                let _ = child_arc.lock().unwrap().kill();
                None
            }
            Err(_) => None,
        };
        let mut guard = child_arc.lock().unwrap();
        let mut output = String::new();
        if let Some(mut out) = guard.stdout.take() {
            use std::io::Read;
            let _ = out.read_to_string(&mut output);
        }
        if let Some(mut err) = guard.stderr.take() {
            use std::io::Read;
            let mut e = String::new();
            let _ = err.read_to_string(&mut e);
            if !e.is_empty() {
                if !output.is_empty() {
                    output.push('\n');
                }
                output.push_str(&e);
            }
        }
        drop(guard);
        let ok = matches!(status, Some(s) if s.success());
        if status.is_none() {
            output.push_str("\n[检测超时（8s），已终止]");
        }
        Ok(DetectShellResult {
            ok,
            output: cap_output(output.trim_end(), 2_000),
        })
    })
    .await
    .map_err(|e| format!("detect_shell 任务失败: {e}"))?
}
