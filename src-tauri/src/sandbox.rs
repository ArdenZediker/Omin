//! Unified command sandbox policy and platform backends.
//!
//! The public model follows the WorkDSH permission contract:
//! - `read-only`: file writes are denied;
//! - `workspace-write`: only the session workspace and a private temp directory are writable;
//! - `danger-full-access`: no file sandbox is applied.
//!
//! Windows uses the same security composition as WorkDSH's ACL backend:
//! a WRITE_RESTRICTED token, capability SIDs on writable roots, a Low integrity
//! token, and a Low no-write-up label. macOS uses Seatbelt through
//! `/usr/bin/sandbox-exec` with the same writable-root allow-list. Any setup
//! failure is fail-closed.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxMode {
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

impl SandboxMode {
    #[cfg(test)]
    pub(crate) const fn rank(self) -> u8 {
        match self {
            Self::ReadOnly => 0,
            Self::WorkspaceWrite => 1,
            Self::DangerFullAccess => 2,
        }
    }

    pub(crate) const fn is_confined(self) -> bool {
        !matches!(self, Self::DangerFullAccess)
    }

    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::WorkspaceWrite => "workspace-write",
            Self::DangerFullAccess => "danger-full-access",
        }
    }
}

impl Default for SandboxMode {
    fn default() -> Self {
        if is_platform_sandbox_supported() {
            Self::WorkspaceWrite
        } else {
            Self::DangerFullAccess
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct SandboxPolicy {
    pub mode: SandboxMode,
    pub workspace_root: PathBuf,
}

impl SandboxPolicy {
    pub(crate) fn new(
        mode: SandboxMode,
        workspace_root: impl Into<PathBuf>,
    ) -> Result<Self, String> {
        let workspace_root = workspace_root.into();
        let canonical = std::fs::canonicalize(&workspace_root).map_err(|error| {
            format!(
                "沙箱工作区不存在或不可访问：{}（{error}）",
                workspace_root.display()
            )
        })?;
        if !canonical.is_dir() {
            return Err(format!("沙箱工作区不是目录：{}", canonical.display()));
        }
        Ok(Self {
            mode,
            workspace_root: canonical,
        })
    }
}

pub(crate) struct SandboxExec {
    pub exit_code: i32,
    pub output: String,
    pub timed_out: bool,
    pub denied: bool,
    pub enforcement: &'static str,
}

pub(crate) const fn is_platform_sandbox_supported() -> bool {
    cfg!(any(target_os = "windows", target_os = "macos"))
}

pub(crate) fn denied_output(mode: SandboxMode, output: &str) -> bool {
    if !mode.is_confined() {
        return false;
    }
    let lower = output.to_ascii_lowercase();
    [
        "access is denied",
        "permission denied",
        "operation not permitted",
        "拒绝访问",
        "access denied",
        // `cmd.exe` may emit the localized message in the OEM code page even
        // when the pipe decoder is UTF-8; the stable symptom is this prefix
        // after lossy decoding.
        "�ܾ�",
    ]
    .iter()
    .any(|signature| lower.contains(signature))
}

fn canonicalize_for_containment(path: &Path) -> Result<PathBuf, String> {
    let mut current = path;
    let mut missing = Vec::new();
    loop {
        if current.exists() {
            let mut canonical = std::fs::canonicalize(current)
                .map_err(|error| format!("无法规范化写入路径「{}」：{error}", current.display()))?;
            for component in missing.iter().rev() {
                canonical.push(component);
            }
            return Ok(canonical);
        }
        let name = current
            .file_name()
            .ok_or_else(|| format!("无法解析写入路径「{}」的现有父目录", path.display()))?;
        missing.push(name.to_os_string());
        current = current
            .parent()
            .ok_or_else(|| format!("无法解析写入路径「{}」的现有父目录", path.display()))?;
    }
}

fn is_system_temp_path(path: &Path) -> bool {
    let is_under = |root: &Path| {
        std::fs::canonicalize(root)
            .ok()
            .is_some_and(|canonical| crate::office_export::is_within(path, &canonical))
    };
    if is_under(&std::env::temp_dir()) {
        return true;
    }
    #[cfg(unix)]
    {
        is_under(Path::new("/tmp"))
    }
    #[cfg(not(unix))]
    {
        false
    }
}

/// Apply the standing file policy to in-process file tools that do not spawn a
/// restricted token (`write_file`, `edit_file`, Office export, etc.).
///
/// The effective `mode` is authoritative. A one-call escalation must therefore
/// be resolved by the caller before this check and passed as the effective
/// mode; the legacy `user_escalated` flag never widens a workspace boundary.
pub(crate) fn ensure_explicit_write_allowed(
    mode: SandboxMode,
    target: &Path,
    workspace_root: Option<&Path>,
    _user_escalated: bool,
) -> Result<(), String> {
    match mode {
        SandboxMode::DangerFullAccess => Ok(()),
        SandboxMode::ReadOnly => Err(
            "当前文件权限为 read-only，已拒绝创建、修改或导出文件。请先在设置中切换为 workspace-write 或 danger-full-access。"
                .to_string(),
        ),
        SandboxMode::WorkspaceWrite => {
            let root = workspace_root.ok_or_else(|| {
                "当前文件权限为 workspace-write，但本次操作没有可用工作区；已拒绝写入。请先绑定项目工作区。"
                    .to_string()
            })?;
            let canonical_target = canonicalize_for_containment(target)?;
            let canonical_root = std::fs::canonicalize(root)
                .map_err(|error| format!("无法规范化工作区「{}」：{error}", root.display()))?;
            if crate::office_export::is_within(&canonical_target, &canonical_root)
                || is_system_temp_path(&canonical_target)
            {
                Ok(())
            } else {
                Err(format!(
                    "当前文件权限为 workspace-write，目标「{}」不在工作区「{}」或系统临时目录内；已拒绝写入。",
                    target.display(),
                    root.display()
                ))
            }
        }
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn execute(
    policy: &SandboxPolicy,
    command: &str,
    cwd: Option<&str>,
    timeout: Duration,
    shell_path: Option<&str>,
) -> Result<SandboxExec, String> {
    let _ = shell_path;
    win::execute(policy, command, cwd, timeout)
}

#[cfg(target_os = "macos")]
pub(crate) fn execute(
    policy: &SandboxPolicy,
    command: &str,
    cwd: Option<&str>,
    timeout: Duration,
    shell_path: Option<&str>,
) -> Result<SandboxExec, String> {
    mac::execute(policy, command, cwd, timeout, shell_path)
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub(crate) fn execute(
    policy: &SandboxPolicy,
    _command: &str,
    _cwd: Option<&str>,
    _timeout: Duration,
    _shell_path: Option<&str>,
) -> Result<SandboxExec, String> {
    Err(format!(
        "当前平台尚未实现 {} 沙箱后端；命令未执行。",
        policy.mode.as_str()
    ))
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::OsStr;
    use std::io::Read;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    use super::{denied_output, SandboxExec, SandboxMode, SandboxPolicy};
    use crate::shellcmd::{cap_output, is_env_allowed, MAX_OUTPUT_CHARS};

    const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

    fn canonical_or_spelled(path: &Path) -> PathBuf {
        std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
    }

    fn writable_roots(policy: &SandboxPolicy) -> Vec<PathBuf> {
        if policy.mode != SandboxMode::WorkspaceWrite {
            return Vec::new();
        }
        let mut roots = vec![
            canonical_or_spelled(&policy.workspace_root),
            canonical_or_spelled(Path::new("/tmp")),
            canonical_or_spelled(&std::env::temp_dir()),
        ];
        roots.sort();
        roots.dedup();
        roots
    }

    fn sbpl_string(path: &Path) -> Result<String, String> {
        let value = path
            .to_str()
            .ok_or_else(|| format!("Sandbox 路径不是有效 UTF-8：{}", path.display()))?;
        if value.chars().any(|character| character.is_control()) {
            return Err(format!(
                "Sandbox 路径包含控制字符，已拒绝生成 Seatbelt 配置：{}",
                path.display()
            ));
        }
        Ok(format!(
            "\"{}\"",
            value.replace('\\', "\\\\").replace('"', "\\\"")
        ))
    }

    pub(super) fn profile(policy: &SandboxPolicy) -> Result<String, String> {
        let mut forms = vec![
            "(version 1)".to_string(),
            "(allow default)".to_string(),
            "(deny file-write*)".to_string(),
            format!(
                "(allow file-write* (literal {}))",
                sbpl_string(Path::new("/dev/null"))?
            ),
        ];
        let roots = writable_roots(policy);
        if !roots.is_empty() {
            let grants = roots
                .iter()
                .map(|root| sbpl_string(root).map(|value| format!("(subpath {value})")))
                .collect::<Result<Vec<_>, _>>()?
                .join(" ");
            forms.push(format!("(allow file-write* {grants})"));
        }
        Ok(forms.join(" "))
    }

    fn resolve_shell(shell_path: Option<&str>) -> Result<(String, Vec<&'static str>), String> {
        let configured = shell_path.map(str::trim).filter(|value| !value.is_empty());
        if let Some(path) = configured {
            if !Path::new(path).is_file() {
                return Err(format!("自定义 Shell 路径不存在：{path}"));
            }
            let stem = Path::new(path)
                .file_stem()
                .and_then(OsStr::to_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            let args = if stem.contains("pwsh") || stem.contains("powershell") {
                vec!["-NoLogo", "-Command"]
            } else if stem.contains("bash") || stem.contains("zsh") {
                vec!["-lc"]
            } else if stem.contains("busybox") {
                vec!["sh", "-c"]
            } else {
                vec!["-c"]
            };
            return Ok((path.to_string(), args));
        }

        let shell = std::env::var("SHELL")
            .ok()
            .filter(|value| Path::new(value).is_file())
            .unwrap_or_else(|| "/bin/zsh".to_string());
        let stem = Path::new(&shell)
            .file_stem()
            .and_then(OsStr::to_str)
            .unwrap_or("zsh")
            .to_ascii_lowercase();
        let args = if stem.contains("bash") || stem.contains("zsh") {
            vec!["-lc"]
        } else if stem.contains("busybox") {
            vec!["sh", "-c"]
        } else {
            vec!["-c"]
        };
        Ok((shell, args))
    }

    fn drain(
        mut pipe: impl Read + Send + 'static,
    ) -> (Arc<Mutex<Vec<u8>>>, std::sync::mpsc::Receiver<()>) {
        let buffer = Arc::new(Mutex::new(Vec::new()));
        let output = Arc::clone(&buffer);
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            while let Ok(size) = pipe.read(&mut chunk) {
                if size == 0 {
                    break;
                }
                output
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .extend_from_slice(&chunk[..size]);
            }
            let _ = done_tx.send(());
        });
        (buffer, done_rx)
    }

    fn combine(stdout: String, stderr: String) -> String {
        let stdout = stdout.trim_end();
        let stderr = stderr.trim_end();
        match (stdout.is_empty(), stderr.is_empty()) {
            (true, true) => String::new(),
            (true, false) => stderr.to_string(),
            (false, true) => stdout.to_string(),
            (false, false) => format!("{stdout}\n{stderr}"),
        }
    }

    fn runner_failure(stderr: &str) -> Option<String> {
        stderr.lines().find_map(|line| {
            let line = line.trim();
            line.starts_with("sandbox-exec:").then(|| line.to_string())
        })
    }

    pub(super) fn execute(
        policy: &SandboxPolicy,
        command: &str,
        cwd: Option<&str>,
        timeout: Duration,
        shell_path: Option<&str>,
    ) -> Result<SandboxExec, String> {
        if !policy.mode.is_confined() {
            return Err("danger-full-access 不应进入沙箱后端".to_string());
        }
        if !Path::new(SANDBOX_EXEC).is_file() {
            return Err(
                "macOS Seatbelt 后端不可用：/usr/bin/sandbox-exec 不存在；命令未执行。".to_string(),
            );
        }

        let profile = profile(policy)?;
        let (shell, shell_args) = resolve_shell(shell_path)?;
        let mut cmd = Command::new(SANDBOX_EXEC);
        cmd.arg("-p")
            .arg(profile)
            .arg("--")
            .arg(shell)
            .args(shell_args)
            .arg(command)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd.env_clear();
        for (key, value) in std::env::vars_os() {
            if is_env_allowed(&key.to_string_lossy()) {
                cmd.env(key, value);
            }
        }
        if let Some(directory) = cwd {
            let path = Path::new(directory);
            if !path.is_dir() {
                return Err(format!("工作目录不存在：{directory}"));
            }
            cmd.current_dir(path);
        }

        let mut child = cmd
            .spawn()
            .map_err(|error| format!("无法启动 macOS Seatbelt 沙箱：{error}"))?;
        let (stdout, stdout_done) = drain(child.stdout.take().ok_or("子进程标准输出未打开")?);
        let (stderr, stderr_done) = drain(child.stderr.take().ok_or("子进程标准错误未打开")?);
        let deadline = Instant::now() + timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) if Instant::now() >= deadline => {
                    child
                        .kill()
                        .map_err(|error| format!("终止超时命令失败：{error}"))?;
                    child
                        .wait()
                        .map_err(|error| format!("回收超时命令失败：{error}"))?;
                    break None;
                }
                Ok(None) => thread::sleep(Duration::from_millis(20)),
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("等待命令失败：{error}"));
                }
            }
        };

        let drain_deadline = Instant::now() + Duration::from_millis(500);
        let _ = stdout_done.recv_timeout(drain_deadline.saturating_duration_since(Instant::now()));
        let _ = stderr_done.recv_timeout(drain_deadline.saturating_duration_since(Instant::now()));
        let stdout =
            String::from_utf8_lossy(&stdout.lock().unwrap_or_else(|poison| poison.into_inner()))
                .into_owned();
        let stderr =
            String::from_utf8_lossy(&stderr.lock().unwrap_or_else(|poison| poison.into_inner()))
                .into_owned();

        if status.and_then(|value| value.code()).unwrap_or(0) != 0 {
            if let Some(detail) = runner_failure(&stderr) {
                return Err(format!(
                    "macOS Seatbelt 后端启动失败：{detail}；命令未在无沙箱状态下执行。"
                ));
            }
        }

        let timed_out = status.is_none();
        let mut output = combine(stdout, stderr);
        if timed_out {
            output.push_str("\n[命令超时已被终止]");
        }
        let denied = denied_output(policy.mode, &output);
        Ok(SandboxExec {
            exit_code: status.and_then(|value| value.code()).unwrap_or(-1),
            output: cap_output(&output, MAX_OUTPUT_CHARS),
            timed_out,
            denied,
            enforcement: "full",
        })
    }
}

#[cfg(target_os = "windows")]
mod win {
    use std::ffi::{OsStr, OsString};
    use std::fs::File;
    use std::io::Read;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{FromRawHandle, RawHandle};
    use std::path::Path;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    use sha2::{Digest, Sha256};
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT,
        PSID,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSidToSidW, GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW,
        DENY_ACCESS, EXPLICIT_ACCESS_W, GRANT_ACCESS, NO_MULTIPLE_TRUSTEE, SE_FILE_OBJECT,
        TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::{
        AddMandatoryAce, CreateRestrictedToken, CreateWellKnownSid, GetLengthSid,
        GetTokenInformation, InitializeAcl, SetTokenInformation, TokenDefaultDacl, TokenGroups,
        TokenIntegrityLevel, WinLowLabelSid, WinWorldSid, ACL, ACL_REVISION, CONTAINER_INHERIT_ACE,
        DACL_SECURITY_INFORMATION, LABEL_SECURITY_INFORMATION, OBJECT_INHERIT_ACE,
        SID_AND_ATTRIBUTES, TOKEN_ADJUST_DEFAULT, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE,
        TOKEN_MANDATORY_LABEL, TOKEN_QUERY, WRITE_RESTRICTED,
    };
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE};
    use windows_sys::Win32::System::Memory::{LocalAlloc, LPTR};
    use windows_sys::Win32::System::Pipes::CreatePipe;
    use windows_sys::Win32::System::Threading::{
        CreateProcessAsUserW, GetCurrentProcess, GetExitCodeProcess, OpenProcessToken,
        TerminateProcess, WaitForSingleObject, CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION,
        STARTF_USESTDHANDLES, STARTUPINFOW,
    };

    use super::{denied_output, SandboxExec, SandboxMode, SandboxPolicy};
    use crate::shellcmd::{cap_output, is_env_allowed, MAX_OUTPUT_CHARS};

    const TOKEN_QUERY_EXTENDED: u32 = TOKEN_QUERY;
    const TOKEN_ADJUST_DEFAULT_EXTENDED: u32 = TOKEN_ADJUST_DEFAULT;
    const CREATE_NO_WINDOW_EXTENDED: u32 = 0x0800_0000;
    const WAIT_TIMEOUT_EXTENDED: u32 = 0x0000_0102;
    const INFINITE_EXTENDED: u32 = 0xFFFF_FFFF;
    const SECURITY_MAX_SID_SIZE: usize = 68;
    const GRANT_MASK: u32 = 0x0011_0156;
    const FILE_ALL_ACCESS: u32 = 0x001F_01FF;
    const FILE_DELETE_CHILD: u32 = 0x0000_0040;
    const RESTRICTED_TOKEN_FLAGS: u32 = WRITE_RESTRICTED | 0x0000_0004 | 0x0000_0001;
    const GENERIC_READ_EXTENDED: u32 = 0x8000_0000;
    const OPEN_EXISTING_FILES: u32 = 3;
    const SECURITY_INFO_DACL_AND_LABEL: u32 =
        DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION;
    const TOKEN_GROUPS_HEADER_SIZE: usize = std::mem::size_of::<u32>() * 2;
    const SE_GROUP_LOGON_ID_VALUE: u32 = 0xC000_0000;
    static ACL_WRITE_LOCK: Mutex<()> = Mutex::new(());

    struct OwnedSid(PSID);

    struct AclRestore {
        path: std::path::PathBuf,
        descriptor: *mut std::ffi::c_void,
        old_dacl: *mut ACL,
        old_sacl: *mut ACL,
    }

    impl Drop for AclRestore {
        fn drop(&mut self) {
            let path_wide = to_wide_null(&self.path.to_string_lossy());
            let result = unsafe {
                SetNamedSecurityInfoW(
                    path_wide.as_ptr(),
                    SE_FILE_OBJECT,
                    SECURITY_INFO_DACL_AND_LABEL,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    self.old_dacl,
                    self.old_sacl,
                )
            };
            if result != 0 {
                eprintln!(
                    "恢复沙箱目录 ACL 失败：{}（Win32 错误码 {result}）",
                    self.path.display()
                );
            }
            if !self.descriptor.is_null() {
                unsafe {
                    LocalFree(self.descriptor);
                }
            }
        }
    }

    impl OwnedSid {
        fn from_string(value: &str) -> Result<Self, String> {
            let wide = to_wide_null(value);
            let mut sid: PSID = std::ptr::null_mut();
            if unsafe { ConvertStringSidToSidW(wide.as_ptr(), &mut sid) } == 0 {
                return Err(last_err("ConvertStringSidToSidW"));
            }
            Ok(Self(sid))
        }

        fn ptr(&self) -> PSID {
            self.0
        }
    }

    impl Drop for OwnedSid {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    LocalFree(self.0.cast());
                }
            }
        }
    }

    fn to_wide_null(value: &str) -> Vec<u16> {
        OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn last_err(context: &str) -> String {
        format!("{context}失败（Win32 错误码 {}）", unsafe {
            GetLastError()
        })
    }

    fn well_known_sid(kind: i32) -> Result<Vec<u8>, String> {
        let mut buffer = vec![0u8; SECURITY_MAX_SID_SIZE];
        let mut length = buffer.len() as u32;
        if unsafe {
            CreateWellKnownSid(
                kind,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut length,
            )
        } == 0
        {
            return Err(last_err("CreateWellKnownSid"));
        }
        buffer.truncate(length as usize);
        Ok(buffer)
    }

    fn derive_sid(workspace_root: &Path) -> String {
        let mut path = workspace_root.to_string_lossy().replace('/', "\\");
        path.make_ascii_lowercase();
        let digest = Sha256::digest(path.as_bytes());
        let first = u32::from_le_bytes(digest[0..4].try_into().unwrap()) % ((1u32 << 30) - 1) + 1;
        let second = u32::from_le_bytes(digest[4..8].try_into().unwrap()) % ((1u32 << 30) - 1) + 1;
        format!("S-1-4-{first}-{second}")
    }

    fn derive_temp_sid(temp_dir: &Path) -> String {
        let mut digest_input = b"temp\0".to_vec();
        digest_input.extend_from_slice(temp_dir.to_string_lossy().as_bytes());
        let digest = Sha256::digest(&digest_input);
        let first = u32::from_le_bytes(digest[0..4].try_into().unwrap()) % ((1u32 << 30) - 1) + 1;
        let second = u32::from_le_bytes(digest[4..8].try_into().unwrap()) % ((1u32 << 30) - 1) + 1;
        format!("S-1-4-{first}-{second}-1")
    }

    fn trustee(sid: PSID) -> TRUSTEE_W {
        TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: sid.cast(),
        }
    }

    fn explicit_access(
        sid: PSID,
        mode: i32,
        permissions: u32,
        inheritance: u32,
    ) -> EXPLICIT_ACCESS_W {
        EXPLICIT_ACCESS_W {
            grfAccessPermissions: permissions,
            grfAccessMode: mode,
            grfInheritance: inheritance,
            Trustee: trustee(sid),
        }
    }

    fn build_low_label_acl(low_label_sid: PSID) -> Result<*mut ACL, String> {
        let sid_length = unsafe { GetLengthSid(low_label_sid) } as usize;
        if sid_length == 0 {
            return Err(last_err("GetLengthSid"));
        }
        let acl_length = 16 + sid_length;
        let acl = unsafe { LocalAlloc(LPTR, acl_length) } as *mut ACL;
        if acl.is_null() {
            return Err(last_err("LocalAlloc"));
        }
        if unsafe { InitializeAcl(acl, acl_length as u32, ACL_REVISION) } == 0 {
            let error = last_err("InitializeAcl");
            unsafe {
                LocalFree(acl.cast());
            }
            return Err(error);
        }
        if unsafe {
            AddMandatoryAce(
                acl,
                ACL_REVISION,
                OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
                1,
                low_label_sid,
            )
        } == 0
        {
            let error = last_err("AddMandatoryAce");
            unsafe {
                LocalFree(acl.cast());
            }
            return Err(error);
        }
        Ok(acl)
    }

    fn grant_write(
        path: &Path,
        capability_sid: PSID,
        low_label_sid: PSID,
        world_sid: PSID,
    ) -> Result<AclRestore, String> {
        let path_wide = to_wide_null(&path.to_string_lossy());
        let mut old_dacl: *mut ACL = std::ptr::null_mut();
        let mut old_sacl: *mut ACL = std::ptr::null_mut();
        let mut descriptor = std::ptr::null_mut();
        let result = unsafe {
            GetNamedSecurityInfoW(
                path_wide.as_ptr(),
                SE_FILE_OBJECT,
                SECURITY_INFO_DACL_AND_LABEL,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut old_dacl,
                &mut old_sacl,
                &mut descriptor,
            )
        };
        if result != 0 {
            return Err(format!(
                "读取目录 ACL 失败：{}（Win32 错误码 {result}）",
                path.display()
            ));
        }

        let label_acl = match build_low_label_acl(low_label_sid) {
            Ok(acl) => acl,
            Err(error) => {
                unsafe {
                    LocalFree(descriptor.cast());
                }
                return Err(error);
            }
        };

        let entries = [
            explicit_access(
                world_sid,
                DENY_ACCESS,
                FILE_DELETE_CHILD,
                CONTAINER_INHERIT_ACE,
            ),
            explicit_access(
                capability_sid,
                GRANT_ACCESS,
                GRANT_MASK,
                OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
            ),
        ];
        let mut merged_dacl: *mut ACL = std::ptr::null_mut();
        let merge_result = unsafe {
            SetEntriesInAclW(
                entries.len() as u32,
                entries.as_ptr(),
                old_dacl,
                &mut merged_dacl,
            )
        };
        if merge_result != 0 || merged_dacl.is_null() {
            unsafe {
                LocalFree(descriptor.cast());
                LocalFree(label_acl.cast());
            }
            return Err(format!(
                "合并目录 ACL 失败：{}（Win32 错误码 {merge_result}）",
                path.display()
            ));
        }

        let apply_result = unsafe {
            SetNamedSecurityInfoW(
                path_wide.as_ptr(),
                SE_FILE_OBJECT,
                SECURITY_INFO_DACL_AND_LABEL,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                merged_dacl,
                label_acl,
            )
        };
        unsafe {
            LocalFree(merged_dacl.cast());
            LocalFree(label_acl.cast());
        }
        if apply_result != 0 {
            unsafe {
                LocalFree(descriptor.cast());
            }
            return Err(format!(
                "应用目录 ACL 失败：{}（Win32 错误码 {apply_result}）",
                path.display()
            ));
        }
        Ok(AclRestore {
            path: path.to_path_buf(),
            descriptor,
            old_dacl,
            old_sacl,
        })
    }

    fn logon_sid(token: HANDLE) -> Result<(PSID, Vec<usize>), String> {
        let mut needed = 0u32;
        unsafe {
            GetTokenInformation(token, TokenGroups, std::ptr::null_mut(), 0, &mut needed);
        }
        if needed == 0 {
            return Err(last_err("GetTokenInformation(TokenGroups)"));
        }
        let words =
            (needed as usize + std::mem::size_of::<usize>() - 1) / std::mem::size_of::<usize>();
        let mut buffer = vec![0usize; words.max(1)];
        if unsafe {
            GetTokenInformation(
                token,
                TokenGroups,
                buffer.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        } == 0
        {
            return Err(last_err("GetTokenInformation(TokenGroups)"));
        }
        let count = unsafe { *(buffer.as_ptr() as *const u32) } as usize;
        let groups = unsafe {
            std::slice::from_raw_parts(
                (buffer.as_ptr() as *const u8).add(TOKEN_GROUPS_HEADER_SIZE)
                    as *const SID_AND_ATTRIBUTES,
                count,
            )
        };
        let sid = groups
            .iter()
            .find(|group| group.Attributes & SE_GROUP_LOGON_ID_VALUE == SE_GROUP_LOGON_ID_VALUE)
            .map(|group| group.Sid)
            .ok_or_else(|| "当前进程 token 不包含 logon SID，无法创建写限制 token".to_string())?;
        Ok((sid, buffer))
    }

    fn set_token_integrity(token: HANDLE, low_label_sid: PSID) -> Result<(), String> {
        let label = TOKEN_MANDATORY_LABEL {
            Label: SID_AND_ATTRIBUTES {
                Sid: low_label_sid,
                Attributes: 0,
            },
        };
        if unsafe {
            SetTokenInformation(
                token,
                TokenIntegrityLevel,
                (&label as *const TOKEN_MANDATORY_LABEL).cast(),
                std::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32,
            )
        } == 0
        {
            return Err(last_err("SetTokenInformation(TokenIntegrityLevel)"));
        }
        Ok(())
    }

    fn set_token_default_dacl(token: HANDLE, sid: PSID) -> Result<(), String> {
        let mut needed = 0u32;
        unsafe {
            GetTokenInformation(
                token,
                TokenDefaultDacl,
                std::ptr::null_mut(),
                0,
                &mut needed,
            );
        }
        if needed == 0 {
            return Err(last_err("GetTokenInformation(TokenDefaultDacl)"));
        }
        let words =
            (needed as usize + std::mem::size_of::<usize>() - 1) / std::mem::size_of::<usize>();
        let mut buffer = vec![0usize; words.max(1)];
        if unsafe {
            GetTokenInformation(
                token,
                TokenDefaultDacl,
                buffer.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        } == 0
        {
            return Err(last_err("GetTokenInformation(TokenDefaultDacl)"));
        }
        let current_dacl = unsafe { *(buffer.as_ptr() as *const *mut ACL) };
        if current_dacl.is_null() {
            return Err("受限 token 没有可扩展的默认 DACL".to_string());
        }
        let entries = [explicit_access(sid, GRANT_ACCESS, FILE_ALL_ACCESS, 3)];
        let mut merged_dacl: *mut ACL = std::ptr::null_mut();
        let merge_result = unsafe {
            SetEntriesInAclW(
                entries.len() as u32,
                entries.as_ptr(),
                current_dacl,
                &mut merged_dacl,
            )
        };
        if merge_result != 0 || merged_dacl.is_null() {
            return Err(format!(
                "扩展受限 token 默认 DACL 失败（Win32 错误码 {merge_result}）"
            ));
        }
        let result = unsafe {
            SetTokenInformation(
                token,
                TokenDefaultDacl,
                (&merged_dacl as *const *mut ACL).cast(),
                std::mem::size_of::<*mut ACL>() as u32,
            )
        };
        unsafe {
            LocalFree(merged_dacl.cast());
        }
        if result == 0 {
            return Err(last_err("SetTokenInformation(TokenDefaultDacl)"));
        }
        Ok(())
    }

    fn create_restricted_token(
        mode: SandboxMode,
        workspace_sid: PSID,
        temp_sid: PSID,
    ) -> Result<HANDLE, String> {
        let mut process_token: HANDLE = 0;
        if unsafe {
            OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_ASSIGN_PRIMARY
                    | TOKEN_DUPLICATE
                    | TOKEN_QUERY_EXTENDED
                    | TOKEN_ADJUST_DEFAULT_EXTENDED,
                &mut process_token,
            )
        } == 0
        {
            return Err(last_err("OpenProcessToken"));
        }

        let (logon_sid, _groups_buffer) = match logon_sid(process_token) {
            Ok(value) => value,
            Err(error) => {
                unsafe {
                    CloseHandle(process_token);
                }
                return Err(error);
            }
        };
        let world_buffer = match well_known_sid(WinWorldSid) {
            Ok(value) => value,
            Err(error) => {
                unsafe {
                    CloseHandle(process_token);
                }
                return Err(error);
            }
        };
        let low_buffer = match well_known_sid(WinLowLabelSid) {
            Ok(value) => value,
            Err(error) => {
                unsafe {
                    CloseHandle(process_token);
                }
                return Err(error);
            }
        };
        let world_sid = world_buffer.as_ptr() as PSID;
        let low_sid = low_buffer.as_ptr() as PSID;

        let mut restricting = vec![
            SID_AND_ATTRIBUTES {
                Sid: logon_sid,
                Attributes: 0,
            },
            SID_AND_ATTRIBUTES {
                Sid: world_sid,
                Attributes: 0,
            },
        ];
        if mode == SandboxMode::WorkspaceWrite {
            restricting.push(SID_AND_ATTRIBUTES {
                Sid: workspace_sid,
                Attributes: 0,
            });
            restricting.push(SID_AND_ATTRIBUTES {
                Sid: temp_sid,
                Attributes: 0,
            });
        }

        let mut token: HANDLE = 0;
        let ok = unsafe {
            CreateRestrictedToken(
                process_token,
                RESTRICTED_TOKEN_FLAGS,
                0,
                std::ptr::null(),
                0,
                std::ptr::null(),
                restricting.len() as u32,
                restricting.as_ptr(),
                &mut token,
            )
        };
        unsafe {
            CloseHandle(process_token);
        }
        if ok == 0 {
            return Err(last_err("CreateRestrictedToken"));
        }

        let setup = (|| {
            set_token_integrity(token, low_sid)?;
            let default_sid = if mode == SandboxMode::WorkspaceWrite {
                temp_sid
            } else {
                world_sid
            };
            set_token_default_dacl(token, default_sid)
        })();
        if let Err(error) = setup {
            unsafe {
                CloseHandle(token);
            }
            return Err(error);
        }
        Ok(token)
    }

    fn build_env_block(temp_dir: &Path) -> Vec<u16> {
        let mut vars: Vec<(String, OsString)> = std::env::vars_os()
            .filter_map(|(key, value)| {
                let key = key.to_string_lossy().into_owned();
                is_env_allowed(&key).then_some((key, value))
            })
            .collect();
        vars.retain(|(key, _)| {
            !key.eq_ignore_ascii_case("TEMP")
                && !key.eq_ignore_ascii_case("TMP")
                && !key.eq_ignore_ascii_case("TMPDIR")
        });
        let temp = temp_dir.as_os_str().to_os_string();
        vars.push(("TEMP".to_string(), temp.clone()));
        vars.push(("TMP".to_string(), temp.clone()));
        vars.push(("TMPDIR".to_string(), temp));
        vars.sort_by(|left, right| {
            left.0
                .to_ascii_uppercase()
                .cmp(&right.0.to_ascii_uppercase())
        });
        let mut block = Vec::new();
        for (key, value) in vars {
            block.extend(OsStr::new(&format!("{key}={}", value.to_string_lossy())).encode_wide());
            block.push(0);
        }
        block.push(0);
        block
    }

    fn drain(mut pipe: File) -> (Arc<Mutex<Vec<u8>>>, std::sync::mpsc::Receiver<()>) {
        let buffer = Arc::new(Mutex::new(Vec::new()));
        let output = Arc::clone(&buffer);
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            while let Ok(size) = pipe.read(&mut chunk) {
                if size == 0 {
                    break;
                }
                output
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .extend_from_slice(&chunk[..size]);
            }
            let _ = done_tx.send(());
        });
        (buffer, done_rx)
    }

    fn combine(stdout: String, stderr: String) -> String {
        let stdout = stdout.trim_end();
        let stderr = stderr.trim_end();
        match (stdout.is_empty(), stderr.is_empty()) {
            (true, true) => String::new(),
            (true, false) => stderr.to_string(),
            (false, true) => stdout.to_string(),
            (false, false) => format!("{stdout}\n{stderr}"),
        }
    }

    fn run_token_process(
        token: HANDLE,
        command: &str,
        cwd: Option<&str>,
        temp_dir: &Path,
        timeout: Duration,
    ) -> Result<SandboxExec, String> {
        let inherit_attributes = windows_sys::Win32::Security::SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<windows_sys::Win32::Security::SECURITY_ATTRIBUTES>()
                as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: 1,
        };
        let mut stdout_read: HANDLE = 0;
        let mut stdout_write: HANDLE = 0;
        let mut stderr_read: HANDLE = 0;
        let mut stderr_write: HANDLE = 0;
        if unsafe { CreatePipe(&mut stdout_read, &mut stdout_write, &inherit_attributes, 0) } == 0
            || unsafe { CreatePipe(&mut stderr_read, &mut stderr_write, &inherit_attributes, 0) }
                == 0
        {
            return Err(last_err("CreatePipe"));
        }
        unsafe {
            SetHandleInformation(stdout_read, HANDLE_FLAG_INHERIT, 0);
            SetHandleInformation(stderr_read, HANDLE_FLAG_INHERIT, 0);
        }

        let nul_wide = to_wide_null("NUL");
        let nul_handle = unsafe {
            CreateFileW(
                nul_wide.as_ptr(),
                GENERIC_READ_EXTENDED,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                &inherit_attributes,
                OPEN_EXISTING_FILES,
                0,
                0,
            )
        };
        if nul_handle == -1isize {
            unsafe {
                CloseHandle(stdout_read);
                CloseHandle(stdout_write);
                CloseHandle(stderr_read);
                CloseHandle(stderr_write);
            }
            return Err(last_err("CreateFileW(NUL)"));
        }

        let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
        let command_line = format!("{comspec} /D /S /C \"chcp 65001>nul & {command}\"");
        let mut command_line = to_wide_null(&command_line);
        let cwd_wide = cwd.map(to_wide_null);
        let cwd_ptr = cwd_wide
            .as_ref()
            .map(|value| value.as_ptr())
            .unwrap_or(std::ptr::null());
        let env_block = build_env_block(temp_dir);
        let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
        startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = nul_handle;
        startup.hStdOutput = stdout_write;
        startup.hStdError = stderr_write;
        let mut process_info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };

        let created = unsafe {
            CreateProcessAsUserW(
                token,
                std::ptr::null(),
                command_line.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
                CREATE_NO_WINDOW_EXTENDED | CREATE_UNICODE_ENVIRONMENT,
                env_block.as_ptr().cast(),
                cwd_ptr,
                &startup,
                &mut process_info,
            )
        };
        unsafe {
            CloseHandle(stdout_write);
            CloseHandle(stderr_write);
            CloseHandle(nul_handle);
        }
        if created == 0 {
            unsafe {
                CloseHandle(stdout_read);
                CloseHandle(stderr_read);
            }
            return Err(last_err("CreateProcessAsUserW"));
        }

        let stdout_file = unsafe { File::from_raw_handle(stdout_read as RawHandle) };
        let stderr_file = unsafe { File::from_raw_handle(stderr_read as RawHandle) };
        let (stdout, stdout_done) = drain(stdout_file);
        let (stderr, stderr_done) = drain(stderr_file);

        let timeout_ms = timeout.as_millis().try_into().unwrap_or(INFINITE_EXTENDED);
        let wait = unsafe { WaitForSingleObject(process_info.hProcess, timeout_ms) };
        let timed_out = wait == WAIT_TIMEOUT_EXTENDED;
        if timed_out {
            unsafe {
                TerminateProcess(process_info.hProcess, 1);
                WaitForSingleObject(process_info.hProcess, 5_000);
            }
        }
        let mut exit_code = 0u32;
        unsafe {
            GetExitCodeProcess(process_info.hProcess, &mut exit_code);
            CloseHandle(process_info.hThread);
            CloseHandle(process_info.hProcess);
        }

        let drain_deadline = Instant::now() + Duration::from_millis(500);
        let _ = stdout_done.recv_timeout(drain_deadline.saturating_duration_since(Instant::now()));
        let _ = stderr_done.recv_timeout(drain_deadline.saturating_duration_since(Instant::now()));
        let stdout =
            String::from_utf8_lossy(&stdout.lock().unwrap_or_else(|poison| poison.into_inner()))
                .into_owned();
        let stderr =
            String::from_utf8_lossy(&stderr.lock().unwrap_or_else(|poison| poison.into_inner()))
                .into_owned();
        let mut output = combine(stdout, stderr);
        if timed_out {
            output.push_str("\n[命令超时已被终止]");
        }
        Ok(SandboxExec {
            exit_code: exit_code as i32,
            denied: denied_output(SandboxMode::WorkspaceWrite, &output),
            output: cap_output(&output, MAX_OUTPUT_CHARS),
            timed_out,
            enforcement: "partial",
        })
    }

    pub(super) fn execute(
        policy: &SandboxPolicy,
        command: &str,
        cwd: Option<&str>,
        timeout: Duration,
    ) -> Result<SandboxExec, String> {
        if !policy.mode.is_confined() {
            return Err("danger-full-access 不应进入沙箱后端".to_string());
        }

        let workspace_sid_value = derive_sid(&policy.workspace_root);
        let workspace_sid = OwnedSid::from_string(&workspace_sid_value)?;
        let temp_root = std::env::temp_dir();
        let canonical_temp_root = std::fs::canonicalize(&temp_root).unwrap_or(temp_root);
        if canonical_temp_root.starts_with(&policy.workspace_root) {
            return Err(
                "系统临时目录位于当前工作区内，无法建立独立沙箱临时目录；命令未执行".to_string(),
            );
        }
        let temp_dir = canonical_temp_root.join(format!("omni-sandbox-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&temp_dir).map_err(|error| format!("创建沙箱临时目录失败：{error}"))?;
        let temp_sid_value = derive_temp_sid(&temp_dir);
        let temp_sid = OwnedSid::from_string(&temp_sid_value)?;
        let world_buffer = well_known_sid(WinWorldSid)?;
        let low_buffer = well_known_sid(WinLowLabelSid)?;
        let world_sid = world_buffer.as_ptr() as PSID;
        let low_sid = low_buffer.as_ptr() as PSID;

        let _acl_lock = if policy.mode == SandboxMode::WorkspaceWrite {
            Some(
                ACL_WRITE_LOCK
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner()),
            )
        } else {
            None
        };
        let _workspace_acl = if policy.mode == SandboxMode::WorkspaceWrite {
            Some(
                grant_write(
                    &policy.workspace_root,
                    workspace_sid.ptr(),
                    low_sid,
                    world_sid,
                )
                .map_err(|error| {
                    let _ = std::fs::remove_dir_all(&temp_dir);
                    error
                })?,
            )
        } else {
            None
        };
        let _temp_acl = if policy.mode == SandboxMode::WorkspaceWrite {
            Some(
                grant_write(&temp_dir, temp_sid.ptr(), low_sid, world_sid).map_err(|error| {
                    let _ = std::fs::remove_dir_all(&temp_dir);
                    error
                })?,
            )
        } else {
            None
        };

        let token = match create_restricted_token(policy.mode, workspace_sid.ptr(), temp_sid.ptr())
        {
            Ok(token) => token,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&temp_dir);
                return Err(error);
            }
        };
        let result = run_token_process(token, command, cwd, &temp_dir, timeout);
        unsafe {
            CloseHandle(token);
        }
        drop(_temp_acl);
        drop(_workspace_acl);
        drop(_acl_lock);
        let _ = std::fs::remove_dir_all(&temp_dir);
        let mut result = result?;
        result.denied = denied_output(policy.mode, &result.output);
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_modes_have_workdsh_order_and_names() {
        assert!(SandboxMode::ReadOnly.rank() < SandboxMode::WorkspaceWrite.rank());
        assert!(SandboxMode::WorkspaceWrite.rank() < SandboxMode::DangerFullAccess.rank());
        assert_eq!(SandboxMode::ReadOnly.as_str(), "read-only");
        assert_eq!(SandboxMode::WorkspaceWrite.as_str(), "workspace-write");
        assert_eq!(SandboxMode::DangerFullAccess.as_str(), "danger-full-access");
    }

    #[test]
    fn default_mode_is_fail_closed_on_supported_platforms() {
        let expected = if is_platform_sandbox_supported() {
            SandboxMode::WorkspaceWrite
        } else {
            SandboxMode::DangerFullAccess
        };
        assert_eq!(SandboxMode::default(), expected);
    }

    #[test]
    fn denial_signatures_are_scoped_to_confined_modes() {
        assert!(denied_output(
            SandboxMode::WorkspaceWrite,
            "Access is denied."
        ));
        assert!(denied_output(SandboxMode::ReadOnly, "拒绝访问。"));
        assert!(!denied_output(
            SandboxMode::DangerFullAccess,
            "Access is denied."
        ));
        assert!(!denied_output(SandboxMode::WorkspaceWrite, "exit code 2"));
        assert!(denied_output(
            SandboxMode::ReadOnly,
            "sandbox-exec: Operation not permitted"
        ));
    }

    #[test]
    fn explicit_file_writes_follow_standing_policy() {
        let root = temp_dir("explicit-workspace");
        let outside_root = std::env::current_dir()
            .expect("resolve current dir")
            .join(format!("omni-sandbox-outside-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&outside_root).expect("create outside dir");
        let inside = root.join("nested").join("a.txt");
        let outside = outside_root.join("a.txt");
        assert!(ensure_explicit_write_allowed(
            SandboxMode::DangerFullAccess,
            &outside,
            None,
            false,
        )
        .is_ok());
        assert!(
            ensure_explicit_write_allowed(SandboxMode::ReadOnly, &inside, Some(&root), true,)
                .is_err()
        );
        assert!(ensure_explicit_write_allowed(
            SandboxMode::WorkspaceWrite,
            &inside,
            Some(&root),
            false,
        )
        .is_ok());
        assert!(ensure_explicit_write_allowed(
            SandboxMode::WorkspaceWrite,
            &outside,
            Some(&root),
            false,
        )
        .is_err());
        assert!(ensure_explicit_write_allowed(
            SandboxMode::WorkspaceWrite,
            &outside,
            Some(&root),
            true,
        )
        .is_err());
        std::fs::remove_dir_all(root).expect("workspace cleanup");
        std::fs::remove_dir_all(outside_root).expect("outside cleanup");
    }

    #[cfg(unix)]
    #[test]
    fn explicit_file_writes_reject_symlink_escape() {
        use std::os::unix::fs::symlink;

        let root = temp_dir("symlink-workspace");
        let outside_root = std::env::current_dir()
            .expect("resolve current dir")
            .join(format!("omni-symlink-outside-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&outside_root).expect("create outside dir");
        let link = root.join("outside-link");
        symlink(&outside_root, &link).expect("create escape symlink");
        let target = link.join("escaped.txt");
        assert!(ensure_explicit_write_allowed(
            SandboxMode::WorkspaceWrite,
            &target,
            Some(&root),
            false,
        )
        .is_err());
        std::fs::remove_dir_all(root).expect("workspace cleanup");
        std::fs::remove_dir_all(outside_root).expect("outside cleanup");
    }

    #[test]
    fn platform_sandbox_support_matches_compiled_backend() {
        assert_eq!(
            is_platform_sandbox_supported(),
            cfg!(any(target_os = "windows", target_os = "macos"))
        );
    }

    fn temp_dir(prefix: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "omni-sandbox-test-{prefix}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_profiles_match_workdsh_write_boundary() {
        let workspace = temp_dir("mac-profile");
        let read_only = mac::profile(
            &SandboxPolicy::new(SandboxMode::ReadOnly, &workspace).expect("read-only policy"),
        )
        .expect("read-only profile");
        assert!(read_only.contains("(deny file-write*)"));
        assert!(read_only.contains("(literal \"/dev/null\")"));
        assert!(!read_only.contains("(subpath"));

        let workspace_write = mac::profile(
            &SandboxPolicy::new(SandboxMode::WorkspaceWrite, &workspace)
                .expect("workspace-write policy"),
        )
        .expect("workspace-write profile");
        let canonical = std::fs::canonicalize(&workspace).expect("canonical workspace");
        assert!(workspace_write.contains(&format!("(subpath \"{}\")", canonical.to_string_lossy())));
        std::fs::remove_dir_all(workspace).expect("workspace cleanup");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_workspace_write_allows_workspace_and_denies_outside() {
        let workspace = temp_dir("mac-workspace");
        let outside_root = std::env::current_dir()
            .expect("resolve current dir")
            .join(format!("omni-mac-outside-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&outside_root).expect("create outside dir");
        let inside_file = workspace.join("inside.txt");
        let outside_file = outside_root.join("outside.txt");
        let workspace_arg = workspace.to_string_lossy().into_owned();

        let inside = super::execute(
            &SandboxPolicy::new(SandboxMode::WorkspaceWrite, &workspace).unwrap(),
            "printf inside > inside.txt",
            Some(&workspace_arg),
            Duration::from_secs(30),
            Some("/bin/zsh"),
        )
        .expect("workspace-write inside execution");
        assert_eq!(inside.exit_code, 0, "output={}", inside.output);
        assert!(std::fs::read_to_string(&inside_file)
            .unwrap_or_default()
            .contains("inside"));

        let escaped_path = outside_file.to_string_lossy().replace('"', "\\\"");
        let outside = super::execute(
            &SandboxPolicy::new(SandboxMode::WorkspaceWrite, &workspace).unwrap(),
            &format!("printf outside > \"{escaped_path}\""),
            Some(&workspace_arg),
            Duration::from_secs(30),
            Some("/bin/zsh"),
        )
        .expect("workspace-write outside execution");
        assert_ne!(outside.exit_code, 0, "outside write unexpectedly succeeded");
        assert!(outside.denied, "output={}", outside.output);
        assert!(!outside_file.exists(), "outside file was created");

        std::fs::remove_dir_all(&workspace).expect("workspace cleanup");
        std::fs::remove_dir_all(&outside_root).expect("outside temp cleanup");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_read_only_denies_workspace_write() {
        let workspace = temp_dir("mac-readonly");
        let workspace_arg = workspace.to_string_lossy().into_owned();
        let result = super::execute(
            &SandboxPolicy::new(SandboxMode::ReadOnly, &workspace).unwrap(),
            "printf blocked > blocked.txt",
            Some(&workspace_arg),
            Duration::from_secs(30),
            Some("/bin/zsh"),
        )
        .expect("read-only execution");

        assert_ne!(
            result.exit_code, 0,
            "read-only write unexpectedly succeeded"
        );
        assert!(result.denied, "output={}", result.output);
        assert!(!workspace.join("blocked.txt").exists());
        std::fs::remove_dir_all(&workspace).expect("read-only temp cleanup");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_workspace_write_allows_workspace_and_denies_outside() {
        let workspace = temp_dir("workspace");
        let outside_root = std::env::current_dir()
            .expect("resolve current dir")
            .join(format!("omni-win-outside-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&outside_root).expect("create outside dir");
        let inside_file = workspace.join("inside.txt");
        let outside_file = outside_root.join("outside.txt");
        let workspace_arg = workspace.to_string_lossy().into_owned();

        let inside = super::execute(
            &SandboxPolicy::new(SandboxMode::WorkspaceWrite, &workspace).unwrap(),
            "echo inside> inside.txt",
            Some(&workspace_arg),
            Duration::from_secs(30),
            None,
        )
        .expect("workspace-write inside execution");
        assert_eq!(inside.exit_code, 0, "output={}", inside.output);
        assert!(std::fs::read_to_string(&inside_file)
            .unwrap_or_default()
            .contains("inside"));

        let escaped_path = outside_file.to_string_lossy().replace('"', "\"\"");
        let outside = super::execute(
            &SandboxPolicy::new(SandboxMode::WorkspaceWrite, &workspace).unwrap(),
            &format!("echo outside> \"{escaped_path}\""),
            Some(&workspace_arg),
            Duration::from_secs(30),
            None,
        )
        .expect("workspace-write outside execution");
        assert_ne!(outside.exit_code, 0, "outside write unexpectedly succeeded");
        assert!(outside.denied, "output={}", outside.output);
        assert!(!outside_file.exists(), "outside file was created");

        std::fs::remove_dir_all(&workspace).expect("workspace ACL must be restored for cleanup");
        std::fs::remove_dir_all(&outside_root).expect("outside temp cleanup");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_read_only_denies_workspace_write() {
        let workspace = temp_dir("readonly");
        let workspace_arg = workspace.to_string_lossy().into_owned();
        let result = super::execute(
            &SandboxPolicy::new(SandboxMode::ReadOnly, &workspace).unwrap(),
            "echo blocked> blocked.txt",
            Some(&workspace_arg),
            Duration::from_secs(30),
            None,
        )
        .expect("read-only execution");

        assert_ne!(
            result.exit_code, 0,
            "read-only write unexpectedly succeeded"
        );
        assert!(result.denied, "output={}", result.output);
        assert!(!workspace.join("blocked.txt").exists());
        std::fs::remove_dir_all(&workspace).expect("read-only temp cleanup");
    }
}
