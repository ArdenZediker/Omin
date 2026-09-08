//! 沙箱：统一策略模型 + Windows 受限 token 后端。
//!
//! 分层对齐 codex（codex-rs/sandboxing）：上层（execute_command）只面对
//! [`SandboxPolicy`] 与 [`get_platform_sandbox`] 后端选择器，平台后端把策略
//! 编译成原语。v1 实现 Windows 受限 token（CreateRestrictedToken）：
//! - 剥离全部特权（DISABLE_MAX_PRIVILEGE）→ 无法提权（SeDebug/SeBackup 等全部消失）；
//! - 子进程继承用户身份但不可执行管理操作；
//! - 环境变量沿用 shellcmd 的 allowlist 白名单（密钥不进子进程）；
//! - 输出经临时批处理文件重定向采集（chcp 65001 强制 UTF-8），退出码回传。
//!
//! 已知边界（v1）：不做写根 ACL 强制（受限 token 仍可写用户目录内任意文件）——
//! 写根的强制由前端 bash 写语义扫描 + no_go_zone_check 确认门承担，OS 层只兜底
//! 「禁止提权」。完整 ACL deny-write / 提权服务后端是后续升级路径。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 统一沙箱策略（对齐 codex SandboxPolicy 思路）：
/// 上层一份模型，平台后端各自编译为原语（受限 token / 未来 Seatbelt、Landlock）。
/// v1 仅由测试与未来 ACL 后端消费——allow(dead_code) 为刻意保留的抽象层。
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SandboxPolicy {
    /// 允许写入的根目录（项目工作区、应用数据目录）
    pub write_roots: Vec<String>,
    /// 额外禁止读取的路径（密钥类：.ssh 等）
    pub deny_read: Vec<String>,
    /// 是否放行网络访问
    pub network_access: bool,
}

#[allow(dead_code)]
impl SandboxPolicy {
    /// 工作区写模式：项目工作区可写；.ssh 列入禁止读取；网络默认放行。
    pub fn workspace_write(workspace: Option<&Path>) -> Self {
        let write_roots = workspace
            .map(|w| vec![w.to_string_lossy().into_owned()])
            .unwrap_or_default();
        let mut deny_read = Vec::new();
        if let Some(up) = std::env::var_os("USERPROFILE") {
            let ssh = PathBuf::from(up).join(".ssh");
            deny_read.push(ssh.to_string_lossy().into_owned());
        }
        if let Some(home) = std::env::var_os("HOME") {
            let ssh = PathBuf::from(home).join(".ssh");
            let s = ssh.to_string_lossy().into_owned();
            if !deny_read.contains(&s) {
                deny_read.push(s);
            }
        }
        Self {
            write_roots,
            deny_read,
            network_access: true,
        }
    }
}

/// 平台后端类型（对齐 codex SandboxType）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxType {
    /// 不启用沙箱
    None,
    /// Windows 受限 token（本 v1 唯一实装后端）
    WindowsRestrictedToken,
}

/// 按平台与开关选择后端；非 Windows 平台 v1 回落 None（策略模型已就位，后端后续补）。
pub fn get_platform_sandbox(enabled: bool) -> SandboxType {
    if !enabled {
        return SandboxType::None;
    }
    #[cfg(target_os = "windows")]
    {
        SandboxType::WindowsRestrictedToken
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = enabled;
        SandboxType::None
    }
}

#[cfg(target_os = "windows")]
mod win {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
    use windows_sys::Win32::Security::CreateRestrictedToken;
    use windows_sys::Win32::System::Threading::{
        CreateProcessAsUserW, GetExitCodeProcess, GetCurrentProcess, OpenProcessToken,
        TerminateProcess, WaitForSingleObject, PROCESS_INFORMATION, STARTUPINFOW,
    };

    use crate::shellcmd::{cap_output, is_env_allowed, MAX_OUTPUT_CHARS};

    // 原生常量（避免 windows-sys 版本间类型别名差异，直接取值）
    const TOKEN_ASSIGN_PRIMARY: u32 = 0x0001;
    const TOKEN_DUPLICATE: u32 = 0x0002;
    const TOKEN_QUERY: u32 = 0x0008;
    const DISABLE_MAX_PRIVILEGE: u32 = 0x0000_0001;
    const CREATE_UNICODE_ENVIRONMENT: u32 = 0x0000_0400;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const WAIT_OBJECT_0: u32 = 0x0000_0000;
    const INFINITE: u32 = 0xFFFF_FFFF;

    pub struct RestrictedExec {
        pub exit_code: i32,
        pub output: String,
        pub timed_out: bool,
    }

    fn to_wide_null(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    fn last_err(context: &str) -> String {
        format!("{context}失败（Win32 错误码 {}）", unsafe { GetLastError() })
    }

    /// 创建受限 token：剥离全部特权（无法提权），保留用户身份（正常访问用户文件）。
    pub fn create_restricted_token() -> Result<HANDLE, String> {
        unsafe {
            let mut process_token: HANDLE = 0;
            if OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY,
                &mut process_token,
            ) == 0
            {
                return Err(last_err("OpenProcessToken"));
            }
            let mut new_token: HANDLE = 0;
            let ok = CreateRestrictedToken(
                process_token,
                DISABLE_MAX_PRIVILEGE,
                0,
                std::ptr::null(),
                0,
                std::ptr::null(),
                0,
                std::ptr::null(),
                &mut new_token,
            );
            CloseHandle(process_token);
            if ok == 0 {
                return Err(last_err("CreateRestrictedToken"));
            }
            Ok(new_token)
        }
    }

    /// 用 allowlist 环境构造 UTF-16 环境块（密钥类变量不进沙箱子进程）。
    fn build_env_block() -> Vec<u16> {
        let mut block: Vec<u16> = Vec::new();
        for (key, value) in std::env::vars_os() {
            let key = key.to_string_lossy();
            if !is_env_allowed(&key) {
                continue;
            }
            for unit in format!("{key}={}\0", value.to_string_lossy()).encode_utf16() {
                block.push(unit);
            }
        }
        block.push(0);
        block
    }

    /// 受限执行入口：临时批处理承载命令（chcp 65001 强制 UTF-8 输出），
    /// stdout/stderr 重定向到临时文件，执行完读取并按 cap_output 截断。
    pub fn execute_restricted(command: &str, cwd: Option<&str>, timeout: Duration) -> Result<RestrictedExec, String> {
        let temp_dir = std::env::temp_dir();
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let batch_path: PathBuf = temp_dir.join(format!("omni_sbx_{stamp}.cmd"));
        let out_path: PathBuf = temp_dir.join(format!("omni_sbx_{stamp}.out"));
        let out_file = out_path.to_string_lossy().into_owned();

        // 批处理内容：命令 + 全量重定向。chcp 65001 让输出以 UTF-8 落盘（与父进程解码一致）。
        let batch = format!(
            "@echo off\r\nchcp 65001 > nul\r\n{} > \"{}\" 2>&1\r\n",
            command.replace('\r', " ").replace('\n', " & "),
            out_file
        );
        std::fs::write(&batch_path, batch).map_err(|e| format!("写入临时批处理失败：{e}"))?;

        let token = create_restricted_token()?;
        let result = run_token_process(&token, &batch_path, cwd, &out_path, timeout);
        unsafe {
            CloseHandle(token);
        }
        let _ = std::fs::remove_file(&batch_path);
        result
    }

    fn run_token_process(
        token: &HANDLE,
        batch_path: &Path,
        cwd: Option<&str>,
        out_path: &Path,
        timeout: Duration,
    ) -> Result<RestrictedExec, String> {
        unsafe {
            let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
            // cmd /S /C ""batch""：双引号包裹路径含空格也安全的经典形态
            let batch_str = batch_path.to_string_lossy().into_owned();
            let command_line = format!("{} /S /C \"\"{}\"\"", comspec, batch_str);
            let mut cmd_line_w = to_wide_null(&command_line);

            let cwd_w = cwd.map(to_wide_null);
            let cwd_ptr = cwd_w
                .as_ref()
                .map(|v| v.as_ptr())
                .unwrap_or(std::ptr::null());

            let env_block = build_env_block();

            let mut startup: STARTUPINFOW = std::mem::zeroed();
            startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
            let mut proc_info: PROCESS_INFORMATION = std::mem::zeroed();

            let ok = CreateProcessAsUserW(
                *token,
                std::ptr::null(),
                cmd_line_w.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                env_block.as_ptr().cast(),
                cwd_ptr,
                &startup,
                &mut proc_info,
            );
            if ok == 0 {
                return Err(last_err("CreateProcessAsUserW"));
            }

            let timeout_ms = timeout
                .as_millis()
                .try_into()
                .unwrap_or(INFINITE);
            let wait = WaitForSingleObject(proc_info.hProcess, timeout_ms);
            let mut timed_out = false;
            if wait != WAIT_OBJECT_0 {
                timed_out = true;
                TerminateProcess(proc_info.hProcess, 1);
                WaitForSingleObject(proc_info.hProcess, 5_000);
            }

            let mut exit_code: u32 = 0;
            GetExitCodeProcess(proc_info.hProcess, &mut exit_code);
            CloseHandle(proc_info.hThread);
            CloseHandle(proc_info.hProcess);

            // 给文件句柄释放留一点时间，然后读取输出
            let output = std::fs::read(out_path)
                .map(|bytes| cap_output(&String::from_utf8_lossy(&bytes), MAX_OUTPUT_CHARS))
                .unwrap_or_default();
            let _ = std::fs::remove_file(out_path);

            Ok(RestrictedExec {
                exit_code: exit_code as i32,
                output,
                timed_out,
            })
        }
    }
}

/// 受限执行的跨平台入口：非 Windows（或未启用）回落 Err，由调用方走普通路径。
#[cfg(target_os = "windows")]
pub fn execute_restricted(
    command: &str,
    cwd: Option<&str>,
    timeout: Duration,
) -> Result<win::RestrictedExec, String> {
    win::execute_restricted(command, cwd, timeout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_workspace_write_collects_roots_and_deny_read() {
        let policy = SandboxPolicy::workspace_write(Some(Path::new("D:/repo")));
        assert_eq!(policy.write_roots, vec!["D:/repo".to_string()]);
        assert!(policy.deny_read.iter().any(|p| p.replace('\\', "/").ends_with("/.ssh")));
        assert!(policy.network_access);

        let none = SandboxPolicy::workspace_write(None);
        assert!(none.write_roots.is_empty());
    }

    #[test]
    fn platform_selector_respects_switch() {
        assert_eq!(get_platform_sandbox(false), SandboxType::None);
        // Windows 上启用 → 受限 token；其他平台 v1 回落 None
        #[cfg(target_os = "windows")]
        assert_eq!(get_platform_sandbox(true), SandboxType::WindowsRestrictedToken);
        #[cfg(not(target_os = "windows"))]
        assert_eq!(get_platform_sandbox(true), SandboxType::None);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn restricted_token_creates_valid_handle() {
        use windows_sys::Win32::Foundation::CloseHandle;
        let token = win::create_restricted_token().expect("创建受限 token 失败");
        assert!(token != 0);
        unsafe {
            CloseHandle(token);
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn restricted_exec_runs_and_captures_output() {
        let result = win::execute_restricted("echo omni_sandbox_ok", None, Duration::from_secs(30))
            .expect("受限执行失败");
        assert_eq!(result.exit_code, 0);
        assert!(result.output.contains("omni_sandbox_ok"), "output={}", result.output);
        assert!(!result.timed_out);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn restricted_exec_reports_exit_code_and_cwd() {
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let result = win::execute_restricted("cmd /c exit 7", Some(&cwd), Duration::from_secs(30))
            .expect("受限执行失败");
        assert_eq!(result.exit_code, 7);
    }
}
