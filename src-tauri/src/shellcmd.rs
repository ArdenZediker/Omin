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
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::storage_paths::fallback_workspace_root;

#[cfg(windows)]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 默认命令超时（毫秒）。CLI 技能包（如腾讯新闻 install-cli）可能要下载，给足时间。
const DEFAULT_TIMEOUT_MS: u64 = 120_000;
/// 单次输出上限，超出截断，避免超大输出撑爆上下文。
pub(crate) const MAX_OUTPUT_CHARS: usize = 32_000;

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
    /// 是否在受限 token 沙箱中执行（设置 → 命令执行）。默认关闭；非 Windows 平台自动回落普通执行。
    #[serde(default)]
    pub sandbox: Option<bool>,
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

/// 超长输出落盘目录（应用启动时由 lib.rs 注入；未注入则只截断不落盘）。
/// 对齐 deepseek-harness 的 spillPath：截断只是「不塞进上下文」，不等于丢弃。
static SPILL_DIR: OnceLock<PathBuf> = OnceLock::new();
/// 单次进程内的落盘序号，避免同毫秒并发写入互相覆盖。
static SPILL_SEQ: AtomicU64 = AtomicU64::new(0);
/// 落盘目录内保留的最大文件数，超出按修改时间删最旧（best-effort）。
const SPILL_KEEP_FILES: usize = 200;

/// 注入落盘目录（幂等，首次调用生效）。
pub(crate) fn configure_spill_dir(dir: PathBuf) {
    let _ = SPILL_DIR.set(dir);
}

/// 把完整输出写到 spill 目录并返回绝对路径；任何失败都静默返回 None（截断提示照旧）。
fn spill_full_output(text: &str) -> Option<String> {
    let dir = SPILL_DIR.get()?;
    std::fs::create_dir_all(dir).ok()?;
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis();
    let seq = SPILL_SEQ.fetch_add(1, Ordering::Relaxed);
    let path = dir.join(format!("output-{millis}-{seq}.log"));
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

/// 截断逻辑本体（spill 回调由调用方注入，便于测试）。
fn cap_output_with_spill(
    text: &str,
    max: usize,
    spill: impl FnOnce(&str) -> Option<String>,
) -> String {
    let total = text.chars().count();
    if total <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max).collect();
    match spill(text) {
        Some(path) => format!(
            "{cut}\n…[输出超过 {max} 字符已截断]\n[完整输出共 {total} 字符，已保存到 {path}]"
        ),
        None => format!("{cut}\n…[输出超过 {max} 字符已截断]"),
    }
}

/// 截断超长输出。截断时把**完整**输出落盘并在提示里附路径，
/// 让模型按路径回读被砍掉的片段（截断 ≠ 丢弃，对齐 deepseek-harness 的 spillPath）。
///
/// 注意：提示里必须保留 `字符已截断]` 这个子串——前端 `localTools.ts::withClipNote`
/// 靠它识别截断并补 `[clipped-note]` 引导，改文案时别把它拆开。
pub(crate) fn cap_output(text: &str, max: usize) -> String {
    cap_output_with_spill(text, max, spill_full_output)
}

/// 探测 Git for Windows 自带的 bash.exe（结果缓存，进程生命周期内只查一次盘）。
/// 覆盖（按序）：
/// 1. 标准安装位置：Program Files / Program Files (x86) / 用户级安装（%LOCALAPPDATA%\Programs\Git）
///    与 scoop 安装；
/// 2. PATH 上 `git.exe` 的兄弟目录——Git for Windows 装在自定义位置（如 D:\Dev_tools\Git）时，
///    通常只有 `\cmd` 加入 PATH，bash.exe 在其 `..\bin` / `..\usr\bin` 下；
/// 3. PATH 上的 `bash.exe`（便携版 Git 等），**排除 `C:\Windows\System32\bash.exe`** ——
///    那是 WSL，路径体系（/mnt/c）和行为完全不同，误用会造成语义错乱。
#[cfg(windows)]
pub(crate) fn detect_git_bash() -> Option<String> {
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
            // PATH 上 git.exe 的祖先目录里找 bash.exe（自定义安装位置兜底）。
            for git_dir in where_on_path("git.exe") {
                let git_path = std::path::Path::new(&git_dir);
                for ancestor in git_path.ancestors().skip(1).take(3) {
                    candidates.push(format!("{}\\bin\\bash.exe", ancestor.display()));
                    candidates.push(format!("{}\\usr\\bin\\bash.exe", ancestor.display()));
                }
            }
            // PATH 上的 bash.exe（便携版 Git 等），排除 System32 的 WSL bash。
            for bash in where_on_path("bash.exe") {
                if bash.to_ascii_lowercase().contains("\\system32\\") {
                    continue;
                }
                candidates.push(bash);
            }
            candidates
                .into_iter()
                .find(|p| std::path::Path::new(p).is_file())
        })
        .clone()
}

/// `where <name>` 的解析结果（PATH 上匹配的绝对路径列表）；where 不可用或无匹配时返回空。
#[cfg(windows)]
fn where_on_path(name: &str) -> Vec<String> {
    Command::new("where.exe")
        .arg(name)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()
        .map(|out| {
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
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

/// 环境变量白名单判断（scrub_environment 与持久会话 scrub_pty_env 共用）。
pub(crate) fn is_env_allowed(key: &str) -> bool {
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
    ALLOWED.iter().any(|allowed| allowed.eq_ignore_ascii_case(key))
}

/// 环境变量脱敏（对齐 Codex spawn_child 的 allowlist 语义）：
/// 子进程不再继承父进程全部环境变量——密钥类变量（apiKey/token 等）不会随 /bash 泄漏到
/// 命令输出或第三方 CLI。白名单只保留系统/基础设施必需项，保证 shell、PATH 解析、
/// 用户目录、临时目录等正常工作。Git-Bash 需 MSYSTEM/EXEPATH 才能正确初始化。
fn scrub_environment(cmd: &mut Command) {
    cmd.env_clear();
    for (key, value) in std::env::vars_os() {
        if is_env_allowed(&key.to_string_lossy()) {
            cmd.env(key, value);
        }
    }
}

/// 用系统 shell 执行命令，带超时与跨平台无窗口处理。
fn run_shell(input: ExecuteCommandInput) -> Result<ExecuteCommandResult, String> {
    let timeout = Duration::from_millis(input.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
    let cwd = input.cwd.clone();

    // 沙箱模式（设置开关，默认关）：Windows 受限 token 执行，剥离全部特权防提权。
    // 非 Windows 或未启用时回落普通路径（策略模型已就位，后端按平台补齐）。
    if input.sandbox.unwrap_or(false)
        && crate::sandbox::get_platform_sandbox(true) == crate::sandbox::SandboxType::WindowsRestrictedToken
    {
        let exec = crate::sandbox::execute_restricted(&input.command, cwd.as_deref(), timeout)?;
        return Ok(ExecuteCommandResult {
            exit_code: exec.exit_code,
            output: exec.output,
            timed_out: exec.timed_out,
        });
    }

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
pub(crate) async fn execute_command(app: tauri::AppHandle, input: ExecuteCommandInput) -> Result<ExecuteCommandResult, String> {
    if input.command.trim().is_empty() {
        return Err("命令不能为空".to_string());
    }
    let mut input = input;
    // 未传工作目录时回退到兜底目录（仿 codex 永远有 cwd），避免回落到不可控的应用当前目录。
    if input.cwd.as_deref().map(|s| s.trim().is_empty()).unwrap_or(true) {
        if let Ok(fb) = fallback_workspace_root(&app) {
            input.cwd = Some(fb.to_string_lossy().into_owned());
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn where_on_path_finds_where_itself_and_rejects_unknown() {
        // where.exe 必然在 System32（PATH 上）——能找到自己说明解析逻辑可用。
        assert!(where_on_path("where.exe").iter().any(|p| p.to_ascii_lowercase().contains("where.exe")));
        // 无匹配时返回空而非报错。
        assert!(where_on_path("definitely-not-a-real-exe-xyz").is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn detect_git_bash_finds_a_posix_bash() {
        // 本机存在任一 Git Bash（标准位置/自定义 Git 安装/PATH 便携版）时应能命中，
        // 且命中的绝不是 System32 的 WSL bash。
        if let Some(bash) = detect_git_bash() {
            assert!(!bash.to_ascii_lowercase().contains("\\system32\\"), "误探测到 WSL bash: {bash}");
            assert!(std::path::Path::new(&bash).is_file());
        }
    }

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
        assert!(out.starts_with("aaaaa"));
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
    fn prune_spill_dir_keeps_newest_files() {
        let dir = std::env::temp_dir().join("omni-spill-prune-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..6u64 {
            std::fs::write(dir.join(format!("output-{i}.log")), "x").unwrap();
            // 让 modified 有可分辨的先后（部分文件系统时间戳精度有限）。
            std::thread::sleep(Duration::from_millis(12));
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
        let out = cap_output(&long, 10);

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
}
