//! 持久 shell 会话（对齐 harness tool-bash-persistent / codex unified_exec 的本地化实现）。
//!
//! 一个会话 = 一个常驻 bash 进程跑在**真 PTY** 里（`portable-pty`：Windows ConPTY /
//! Unix openpty），`bash -l -i` 登录态保证 PATH 里有 POSIX 工具、交互态维持逐行读循环。
//! **cwd、环境变量、导出的函数/别名跨调用保留**。
//!
//! 采集协议（harness 同款）：每条命令用「本次唯一的标记符」包裹——
//! `printf START; eval -- <命令>; printf END:$status`——从环形 scrollback 缓冲里
//! 切出「本次输出 + 退出码」。PTY 的命令回显发生在 START 之前、提示符发生在 END
//! 之后，都落在提取窗口之外，天然被过滤。
//!
//! 行为约定：
//! - 会话死亡（进程退出/stdin 断）：自动丢弃旧会话并新建重试一次，结果带 shellReset 标记；
//! - 单条命令超时：**不杀会话**，返回已产生的部分输出（timedOut=true），长任务可 `&` 转后台；
//! - 输出环形缓冲超上限：丢最旧整行并标记 lostPrefix；
//! - PTY 行缓冲上限（~4KB/行）：超长单行命令可能无法送达，属已知边界。
//!
//! 安全边界与一次性 execute_command 完全一致：环境变量脱敏、Windows 无窗口、
//! 危险命令黑名单与确认门都在前端工具层（localTools.ts bash 工具），本模块不判风险。

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::shellcmd::{cap_output, is_env_allowed, MAX_OUTPUT_CHARS};

/// scrollback 环形缓冲上限（字符）。超过丢最旧整行。
const SCROLLBACK_MAX_CHARS: usize = 200_000;
/// 轮询 scrollback 等待 END 标记的间隔（harness 同款 25ms）。
const POLL_INTERVAL_MS: u64 = 25;
/// 单条命令默认等待超时。
const DEFAULT_EXEC_TIMEOUT_MS: u64 = 120_000;
/// PTY 初始尺寸（行/列）。模型输出不依赖宽度，默认 80 列即可。
const PTY_ROWS: u16 = 24;
const PTY_COLS: u16 = 80;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellSessionExecInput {
    /// 会话标识（前端按聊天会话隔离；同 id 复用同一常驻 shell）。
    pub session_id: String,
    /// 要执行的命令（在持久 shell 内 eval）。
    pub command: String,
    /// 仅在**新建**会话时作为初始工作目录；已存在的会话忽略（用 cd 自行切换）。
    #[serde(default)]
    pub cwd: Option<String>,
    /// 自定义 bash 路径（仅接受 bash/zsh 族，其余回落自动探测）。
    #[serde(default)]
    pub shell_path: Option<String>,
    /// 单条命令等待超时（毫秒）。
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellSessionExecResult {
    /// 退出码（timedOut 时为 -1）。
    pub exit_code: i32,
    /// 本次命令的输出（已截断、已归一化换行）。
    pub output: String,
    /// 等待超时（会话仍存活，可继续用；输出为已产生的部分）。
    pub timed_out: bool,
    /// 本次执行前自动重置了会话（旧会话已死）——输出状态与上次不连续。
    pub shell_reset: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellSessionResetInput {
    pub session_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellSessionResetResult {
    /// true = 杀掉并移除了已存在的会话；false = 本来就不存在。
    pub reset: bool,
}

// ---------- 标记协议 ----------

struct CommandMarkers {
    start: String,
    end: String,
}

fn next_nonce() -> u64 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    (nanos << 8) | (COUNTER.fetch_add(1, Ordering::Relaxed) & 0xff)
}

fn markers() -> CommandMarkers {
    let nonce = next_nonce();
    CommandMarkers {
        start: format!("__OMNI_SH_START_{nonce}__"),
        end: format!("__OMNI_SH_END_{nonce}:"),
    }
}

/// bash `$'...'` 安全引用（harness 同款转义：反斜杠/单引号/CR/LF）。
fn quote_for_bash(value: &str) -> String {
    format!(
        "$'{}'",
        value
            .replace('\\', "\\\\")
            .replace('\'', "\\'")
            .replace('\r', "\\r")
            .replace('\n', "\\n")
    )
}

/// 把命令包成**单物理行**标记协议（PTY 行提交 + harness 经验：单行避免 PS2 泄漏）。
fn wrap_command(command: &str, m: &CommandMarkers) -> String {
    format!(
        "printf '%s\\n' {}; eval -- {}; __omni_st=$?; printf '%s%s\\n' {} \"$__omni_st\"",
        m.start,
        quote_for_bash(command),
        m.end
    )
}

/// PTY 输出归一化：\r\n → \n；行内孤立 \r 取最后一段（进度条回车重写的最终帧）。
fn normalize_pty_text(text: &str) -> String {
    text.replace("\r\n", "\n")
        .split('\n')
        .map(|line| match line.rfind('\r') {
            Some(p) => &line[p + 1..],
            None => line,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 从 scrollback 全文里解析出「本次命令的已完成输出 + 退出码」。
/// 未出现 END 标记（或退出码尚未写完）返回 None。
/// 注意：PTY 回显里也含标记字面量，但回显先于真实输出出现，rfind 永远取到真实标记；
/// 回显处的 END 后跟 ` "$__omni_st"`（非数字），不会误判完成。
fn extract_completed(text: &str, m: &CommandMarkers) -> Option<(String, i32)> {
    let end = text.rfind(&m.end)?;
    let status_tail = &text[end + m.end.len()..];
    let status: String = status_tail.chars().take_while(|c| c.is_ascii_digit()).collect();
    if status.is_empty() {
        return None; // END 标记已出但退出码还没刷出来，下一轮轮询再取
    }
    let code: i32 = status.parse().unwrap_or(-1);
    let start = text[..end].rfind(&m.start).map(|p| p + m.start.len());
    let body = match start {
        Some(p) => &text[p..end],
        None => "", // START 被环形缓冲挤掉：视作部分输出
    };
    Some((
        body.trim_start_matches('\n').trim_end_matches(['\r', '\n']).to_string(),
        code,
    ))
}

/// 等待超时时取「已产生的部分输出」（从最后一个 START 标记起）。
fn extract_partial(text: &str, m: &CommandMarkers) -> String {
    match text.rfind(&m.start) {
        Some(p) => {
            let body = &text[p + m.start.len()..];
            let trimmed = body.trim_start_matches('\n');
            if trimmed.trim_end().is_empty() {
                "（尚未产生输出）".to_string()
            } else {
                trimmed.to_string()
            }
        }
        None => "（尚未产生输出）".to_string(),
    }
}

// ---------- 会话存储 ----------

#[derive(Default)]
struct Scrollback {
    text: String,
    lost_prefix: bool,
}

impl Scrollback {
    fn push(&mut self, chunk: &str) {
        self.text.push_str(chunk);
        let total = self.text.chars().count();
        if total <= SCROLLBACK_MAX_CHARS {
            return;
        }
        self.lost_prefix = true;
        // 从头丢弃整行，直到回到上限内（保证不把行切一半）。
        let overflow = total - SCROLLBACK_MAX_CHARS;
        let mut seen = 0usize;
        let mut cut: Option<usize> = None;
        for (idx, ch) in self.text.char_indices() {
            if seen >= overflow && ch == '\n' {
                cut = Some(idx + 1);
                break;
            }
            seen += 1;
        }
        match cut {
            Some(cut) => {
                self.text.drain(..cut);
            }
            None => self.text.clear(),
        }
    }
}

struct ShellSession {
    /// master 句柄保活：drop 它会关闭 PTY（保留字段即为有意持有）。
    _master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    writer: Option<Box<dyn Write + Send>>,
    scrollback: Arc<Mutex<Scrollback>>,
}

impl Drop for ShellSession {
    fn drop(&mut self) {
        // 显式 kill + wait，避免留下孤儿 bash 进程。
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// PTY 读线程：字节流 → 增量 UTF-8 解码（跨 chunk 的多字节字符不会碎）→ scrollback。
fn spawn_reader<R: std::io::Read + Send + 'static>(mut stream: R, scrollback: Arc<Mutex<Scrollback>>) {
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match std::io::Read::read(&mut stream, &mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    loop {
                        match std::str::from_utf8(&pending) {
                            Ok(s) => {
                                if let Ok(mut guard) = scrollback.lock() {
                                    guard.push(s);
                                } else {
                                    return;
                                }
                                pending.clear();
                                break;
                            }
                            Err(e) => {
                                let valid = e.valid_up_to();
                                if valid > 0 {
                                    if let Ok(mut guard) = scrollback.lock() {
                                        guard.push(&String::from_utf8_lossy(&pending[..valid]));
                                    } else {
                                        return;
                                    }
                                }
                                pending.drain(..valid);
                                if e.error_len().is_none() && pending.len() < 4 {
                                    break; // 序列可能被 chunk 截断，等下一批字节
                                }
                                // 真非法字节：占位后继续
                                if let Ok(mut guard) = scrollback.lock() {
                                    guard.push("\u{FFFD}");
                                } else {
                                    return;
                                }
                                if pending.is_empty() {
                                    break;
                                }
                            }
                        }
                    }
                }
                Err(_) => break,
            }
        }
    });
}

impl ShellSession {
    fn spawn(cwd: Option<&str>, shell_path: Option<&str>) -> Result<Self, String> {
        let (program, args) = resolve_persistent_shell(shell_path)?;
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows: PTY_ROWS, cols: PTY_COLS, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("无法创建 PTY：{e}"))?;

        let mut cmd = CommandBuilder::new(&program);
        cmd.args(args.iter().copied());
        scrub_pty_env(&mut cmd);
        if let Some(d) = cwd {
            let path = std::path::Path::new(d);
            if !path.is_dir() {
                return Err(format!("工作目录不存在：{d}"));
            }
            cmd.cwd(path);
        }
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("无法启动持久 shell（{program}）：{e}"))?;
        // slave 必须在父进程侧 drop，子进程退出后 reader 才能收到 EOF。
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("无法读取 PTY 输出：{e}"))?;
        let writer = pair.master.take_writer().map_err(|e| format!("无法写入 PTY：{e}"))?;
        let scrollback: Arc<Mutex<Scrollback>> = Arc::new(Mutex::new(Scrollback::default()));
        spawn_reader(reader, Arc::clone(&scrollback));

        Ok(ShellSession { _master: pair.master, child, writer: Some(writer), scrollback })
    }
}

/// CommandBuilder 的环境脱敏：与一次性 execute_command 的 scrub_environment 共用白名单。
fn scrub_pty_env(cmd: &mut CommandBuilder) {
    cmd.env_clear();
    for (key, value) in std::env::vars_os() {
        if is_env_allowed(&key.to_string_lossy()) {
            cmd.env(key, value);
        }
    }
}

/// 持久会话仅支持 bash 族（标记协议与 `eval --` 依赖 POSIX 语义）。
/// 优先自定义路径（须为 bash/zsh），否则 Windows 自动探测 Git Bash、其他平台用系统 bash。
fn resolve_persistent_shell(shell_path: Option<&str>) -> Result<(String, Vec<&'static str>), String> {
    if let Some(p) = shell_path.map(str::trim).filter(|s| !s.is_empty()) {
        let path = std::path::Path::new(p);
        if !path.is_file() {
            return Err(format!("自定义 Shell 路径不存在：{p}"));
        }
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
        if stem.contains("bash") {
            return Ok((p.to_string(), vec!["-l", "-i"]));
        }
        if stem.contains("zsh") {
            return Ok((p.to_string(), vec!["-f", "-i"]));
        }
        // 非 bash 族：忽略自定义路径，回落自动探测（一次性 execute_command 仍会用它）。
    }
    #[cfg(windows)]
    {
        if let Some(bash) = crate::shellcmd::detect_git_bash() {
            return Ok((bash, vec!["-l", "-i"]));
        }
        Err("未找到 bash（持久会话需要 Git Bash / MSYS2）；可改用设置里的自定义 Shell 或直接用一次性命令执行".to_string())
    }
    #[cfg(not(windows))]
    {
        Ok(("bash".to_string(), vec!["-l", "-i"]))
    }
}

fn sessions() -> &'static Mutex<HashMap<String, Arc<Mutex<ShellSession>>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<Mutex<ShellSession>>>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

// ---------- Tauri 命令 ----------

/// 在持久 shell 会话中执行一条命令。会话不存在或已死亡时自动新建（重试一次）。
#[tauri::command]
pub(crate) async fn shell_session_exec(input: ShellSessionExecInput) -> Result<ShellSessionExecResult, String> {
    if input.command.trim().is_empty() {
        return Err("命令不能为空".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || run_session_exec(input))
        .await
        .map_err(|e| format!("shell_session_exec 任务失败: {e}"))?
}

fn run_session_exec(input: ShellSessionExecInput) -> Result<ShellSessionExecResult, String> {
    let timeout = Duration::from_millis(input.timeout_ms.unwrap_or(DEFAULT_EXEC_TIMEOUT_MS));
    let mut shell_reset = false;

    // 最多两轮：会话不存在/已死 → 自动重建并重试一次（harness 同款 reset 语义）。
    for attempt in 0..2 {
        let entry = {
            let mut map = sessions().lock().unwrap();
            match map.get(&input.session_id) {
                Some(entry) => Arc::clone(entry),
                None => {
                    let session = ShellSession::spawn(input.cwd.as_deref(), input.shell_path.as_deref())?;
                    let entry = Arc::new(Mutex::new(session));
                    map.insert(input.session_id.clone(), Arc::clone(&entry));
                    if attempt > 0 {
                        shell_reset = true;
                    }
                    entry
                }
            }
        };

        let mut guard = entry.lock().unwrap();
        // 会话进程已退出 → 丢弃并重建重试。
        let probe = guard.child.try_wait().map_err(|e| format!("探测持久 shell 状态失败：{e}"));
        match probe {
            Ok(Some(status)) => {
                let mut map = sessions().lock().unwrap();
                map.remove(&input.session_id);
                drop(guard);
                if attempt == 0 {
                    shell_reset = true;
                    continue;
                }
                return Err(format!("持久 shell 已退出（code={}）且重建失败", status.exit_code() as i32));
            }
            Err(e) => return Err(e),
            Ok(None) => {}
        }

        let m = markers();
        let wrapped = wrap_command(&input.command, &m);
        {
            let writer = guard
                .writer
                .as_mut()
                .ok_or_else(|| "持久 shell 的 stdin 已关闭".to_string())?;
            let written = writer
                .write_all(wrapped.as_bytes())
                .and_then(|_| writer.write_all(b"\n"))
                .and_then(|_| writer.flush());
            if let Err(e) = written {
                let mut map = sessions().lock().unwrap();
                map.remove(&input.session_id);
                drop(guard);
                if attempt == 0 {
                    shell_reset = true;
                    continue;
                }
                return Err(format!("写入持久 shell 失败（会话已退出）且重建失败：{e}"));
            }
        }

        // 轮询 scrollback 等待 END 标记；超时返回部分输出（不杀会话）。
        let deadline = Instant::now() + timeout;
        loop {
            thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
            let snap = guard.scrollback.lock().unwrap();
            if let Some((body, code)) = extract_completed(&snap.text, &m) {
                let output = cap_output(&normalize_pty_text(&body), MAX_OUTPUT_CHARS);
                return Ok(ShellSessionExecResult { exit_code: code, output, timed_out: false, shell_reset });
            }
            if Instant::now() >= deadline {
                let mut partial = normalize_pty_text(&extract_partial(&snap.text, &m));
                if snap.lost_prefix {
                    partial = format!("[提示] 输出开头部分已被滚动缓冲丢弃，以下是最早保留的内容。\n{partial}");
                }
                let output = cap_output(&partial, MAX_OUTPUT_CHARS);
                return Ok(ShellSessionExecResult { exit_code: -1, output, timed_out: true, shell_reset });
            }
        }
    }
    unreachable!("重试循环必然在两轮内返回")
}

/// 重置（杀掉）一个持久 shell 会话。下次执行会自动新建全新会话。
#[tauri::command]
pub(crate) async fn shell_session_reset(input: ShellSessionResetInput) -> Result<ShellSessionResetResult, String> {
    let removed = sessions()
        .lock()
        .unwrap()
        .remove(&input.session_id)
        .is_some();
    Ok(ShellSessionResetResult { reset: removed })
}

// ---------- 纯函数单测 ----------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrap_command_is_single_physical_line() {
        let m = markers();
        let wrapped = wrap_command("echo hi\necho two", &m);
        assert!(!wrapped.contains('\n'), "包装命令必须保持单行：{wrapped}");
        assert!(wrapped.starts_with(&format!("printf '%s\\n' {}", m.start)));
        assert!(wrapped.contains(&quote_for_bash("echo hi\necho two")));
        assert!(wrapped.ends_with(&format!("printf '%s%s\\n' {} \"$__omni_st\"", m.end)));
    }

    #[test]
    fn quote_for_bash_escapes_specials() {
        assert_eq!(quote_for_bash("a'b\\c\nd"), "$'a\\'b\\\\c\\nd'");
    }

    #[test]
    fn extract_completed_parses_body_and_exit_code() {
        let m = markers();
        let text = format!("{}\nhello\nworld\n{}0\n", m.start, m.end);
        let (body, code) = extract_completed(&text, &m).unwrap();
        assert_eq!(code, 0);
        assert_eq!(body, "hello\nworld");
    }

    #[test]
    fn extract_completed_ignores_pty_echo_of_markers() {
        // 模拟 PTY 回显：整条包装命令（含标记字面量）先出现，随后才是真实输出。
        let m = markers();
        let wrapped = wrap_command("echo hi", &m);
        let text = format!(
            "{wrapped}\r\n{}\r\nhi\r\n{}0\r\n",
            m.start, m.end
        );
        let (body, code) = extract_completed(&normalize_pty_text(&text), &m).unwrap();
        assert_eq!(code, 0);
        assert_eq!(body, "hi");
    }

    #[test]
    fn extract_completed_rejects_incomplete_and_missing_status() {
        let m = markers();
        let text = format!("{}\npartial", m.start);
        assert!(extract_completed(&text, &m).is_none());
        let text = format!("{}\nx\n{}", m.start, m.end);
        assert!(extract_completed(&text, &m).is_none());
    }

    #[test]
    fn extract_completed_ignores_previous_round_markers() {
        let old = markers();
        let m = markers();
        let text = format!(
            "{}\nold output\n{}0\n{}\nnew output\n{}3\n",
            old.start, old.end, m.start, m.end
        );
        let (body, code) = extract_completed(&text, &m).unwrap();
        assert_eq!(code, 3);
        assert_eq!(body, "new output");
    }

    #[test]
    fn extract_partial_returns_body_since_start() {
        let m = markers();
        let text = format!("{}\nline1\nline2\n", m.start);
        assert_eq!(extract_partial(&text, &m), "line1\nline2\n");
        assert_eq!(extract_partial("no marker", &m), "（尚未产生输出）");
    }

    #[test]
    fn normalize_pty_text_strips_carriage_returns() {
        assert_eq!(normalize_pty_text("a\r\nb\rc\r\n"), "a\nc\n");
        assert_eq!(normalize_pty_text("plain\nlines"), "plain\nlines");
    }

    #[test]
    fn scrollback_push_drops_oldest_lines_and_marks_lost_prefix() {
        let mut sb = Scrollback::default();
        let line = "x".repeat(1000) + "\n";
        for _ in 0..250 {
            sb.push(&line);
        }
        assert!(sb.lost_prefix);
        assert!(sb.text.chars().count() <= SCROLLBACK_MAX_CHARS);
        assert!(!sb.text.starts_with("xxx\n"));
        assert!(sb.text.ends_with('\n'));
    }
}
