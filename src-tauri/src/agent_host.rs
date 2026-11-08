//! Agent Host process manager and native tool router.
//!
//! The Node SEA sidecar owns the event-sourced agent runtime. This module keeps
//! the sidecar alive, correlates typed Host RPC responses, forwards runtime
//! events to the webview, and executes native tool calls through Omni's existing
//! permission and sandbox-aware command implementations.

use crate::{
    filemod::{edit_file_tool, write_file_tool},
    sandbox::SandboxMode,
    shellcmd::{execute_command, ExecuteCommandInput},
    workspace_files,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};

pub(crate) const EVENT_NAME: &str = "omni-agent-event";
pub(crate) const STATUS_EVENT_NAME: &str = "omni-agent-host-status";

const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
const SIDECAR_FILE_NAME: &str = "omni-agent-host.exe";
#[cfg(not(windows))]
const SIDECAR_FILE_NAME: &str = "omni-agent-host";

#[derive(Clone, Default)]
pub(crate) struct AgentHostState {
    inner: Arc<AgentHostInner>,
}

impl AgentHostState {
    pub(crate) fn start(&self, app: &AppHandle) -> Result<(), String> {
        self.inner.ensure_started(app)
    }

    pub(crate) fn stop(&self, app: &AppHandle) {
        self.inner.stop(app);
    }
}

#[derive(Default)]
struct AgentHostInner {
    process: Mutex<Option<AgentHostProcess>>,
    pending: Mutex<HashMap<String, mpsc::Sender<Result<Value, String>>>>,
    session_cwds: Mutex<HashMap<String, String>>,
    native_calls: Mutex<HashMap<String, Arc<AtomicBool>>>,
    running: AtomicBool,
    binary_path: Mutex<Option<PathBuf>>,
    data_dir: Mutex<Option<PathBuf>>,
}

struct AgentHostProcess {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentHostStatus {
    running: bool,
    pid: Option<u32>,
    binary_path: Option<String>,
    data_dir: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentHostRequestInput {
    command: String,
    #[serde(default)]
    params: Option<Value>,
}

impl AgentHostInner {
    fn status(&self) -> AgentHostStatus {
        let pid = self
            .process
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .map(|process| process.child.id());
        AgentHostStatus {
            running: self.running.load(Ordering::SeqCst),
            pid,
            binary_path: self
                .binary_path
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            data_dir: self
                .data_dir
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
        }
    }

    fn write(&self, value: &Value) -> Result<(), String> {
        let stdin = {
            let process = self
                .process
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            process
                .as_ref()
                .map(|process| Arc::clone(&process.stdin))
                .ok_or_else(|| "Agent Host 未启动".to_string())?
        };
        let mut writer = stdin.lock().unwrap_or_else(|error| error.into_inner());
        writer
            .write_all(format!("{}\n", value).as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|error| format!("写入 Agent Host 失败：{error}"))
    }

    fn request(&self, id: &str, command: &str, params: Option<Value>) -> Result<Value, String> {
        let (sender, receiver) = mpsc::channel();
        self.pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(id.to_string(), sender);

        let mut message = json!({
            "kind": "request",
            "id": id,
            "command": command,
        });
        if let Some(params) = params {
            message["params"] = params;
        }
        if let Err(error) = self.write(&message) {
            self.pending
                .lock()
                .unwrap_or_else(|inner| inner.into_inner())
                .remove(id);
            return Err(error);
        }

        match receiver.recv_timeout(REQUEST_TIMEOUT) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.pending
                    .lock()
                    .unwrap_or_else(|inner| inner.into_inner())
                    .remove(id);
                Err(format!("Agent Host 请求超时：{command}"))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err(format!("Agent Host 已退出：{command}"))
            }
        }
    }

    fn record_session_cwd(&self, command: &str, params: &Option<Value>, result: &Value) {
        if command != "session.create" {
            return;
        }
        let Some(session_id) = result.get("sessionId").and_then(Value::as_str) else {
            return;
        };
        let Some(cwd) = params
            .as_ref()
            .and_then(|value| value.get("cwd"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return;
        };
        self.session_cwds
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(session_id.to_string(), cwd.to_string());
    }

    fn session_cwd(&self, session_id: &str) -> Option<String> {
        self.session_cwds
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(session_id)
            .cloned()
    }

    fn send_native_result(&self, id: &str, result: Result<Value, String>) {
        let cancelled = self
            .native_calls
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(id)
            .is_some_and(|flag| flag.load(Ordering::SeqCst));
        if cancelled {
            return;
        }
        let message = match result {
            Ok(result) => json!({
                "kind": "native-tool-result",
                "id": id,
                "ok": true,
                "result": result,
            }),
            Err(error) => json!({
                "kind": "native-tool-result",
                "id": id,
                "ok": false,
                "error": { "message": error, "code": "NATIVE_TOOL_ERROR" },
            }),
        };
        if let Err(error) = self.write(&message) {
            eprintln!("[Omni] 回传原生工具结果失败：{error}");
        }
    }

    fn cancel_native_call(&self, id: &str) {
        if let Some(cancelled) = self
            .native_calls
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(id)
        {
            cancelled.store(true, Ordering::SeqCst);
        }
        self.native_calls
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(id);
    }

    fn fail_pending(&self, reason: &str) {
        let pending = {
            let mut guard = self
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            std::mem::take(&mut *guard)
        };
        for sender in pending.into_values() {
            let _ = sender.send(Err(reason.to_string()));
        }
        for cancelled in self
            .native_calls
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .drain()
            .map(|(_, value)| value)
        {
            cancelled.store(true, Ordering::SeqCst);
        }
        self.running.store(false, Ordering::SeqCst);
    }

    fn mark_exited(&self, app: &AppHandle, reason: &str) {
        self.process
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        self.fail_pending(reason);
        let _ = app.emit(
            STATUS_EVENT_NAME,
            json!({ "running": false, "reason": reason }),
        );
    }

    fn ensure_started(self: &Arc<Self>, app: &AppHandle) -> Result<(), String> {
        if self.running.load(Ordering::SeqCst) {
            return Ok(());
        }

        let binary = resolve_sidecar_path()?;
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("读取应用数据目录失败：{error}"))?
            .join("agent-host");
        std::fs::create_dir_all(&data_dir)
            .map_err(|error| format!("创建 Agent Host 数据目录失败：{error}"))?;

        let mut command = Command::new(&binary);
        command
            .arg("--data-dir")
            .arg(&data_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command
            .spawn()
            .map_err(|error| format!("启动 Agent Host 失败（{}）：{error}", binary.display()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Agent Host stdin 不可用".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Agent Host stdout 不可用".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Agent Host stderr 不可用".to_string())?;

        *self
            .binary_path
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(binary);
        *self
            .data_dir
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(data_dir);
        *self
            .process
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(AgentHostProcess {
            child,
            stdin: Arc::new(Mutex::new(stdin)),
        });
        self.running.store(true, Ordering::SeqCst);

        spawn_stderr_reader(stderr);
        spawn_stdout_reader(app.clone(), Arc::clone(self), stdout);
        let _ = app.emit(
            STATUS_EVENT_NAME,
            json!({ "running": true, "pid": self.status().pid }),
        );

        let tools_id = format!("native-tools-{}", uuid::Uuid::new_v4());
        self.request(
            &tools_id,
            "tools.configure",
            Some(json!({ "tools": native_tool_descriptors() })),
        )?;
        Ok(())
    }

    fn stop(&self, app: &AppHandle) {
        let shutdown_id = format!("host-shutdown-{}", uuid::Uuid::new_v4());
        let _ = self.request(&shutdown_id, "host.shutdown", None);
        let process = self
            .process
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(mut process) = process {
            let exited = (0..120).any(|_| {
                if process.child.try_wait().ok().flatten().is_some() {
                    true
                } else {
                    thread::sleep(Duration::from_millis(25));
                    false
                }
            });
            if !exited {
                let _ = process.child.kill();
            }
            let _ = process.child.wait();
        }
        self.mark_exited(app, "Agent Host 已停止");
    }
}

fn spawn_stderr_reader(stderr: impl std::io::Read + Send + 'static) {
    thread::Builder::new()
        .name("omni-agent-host-stderr".to_string())
        .spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                if !line.trim().is_empty() {
                    eprintln!("[agent-host] {line}");
                }
            }
        })
        .ok();
}

fn spawn_stdout_reader(
    app: AppHandle,
    inner: Arc<AgentHostInner>,
    stdout: impl std::io::Read + Send + 'static,
) {
    thread::Builder::new()
        .name("omni-agent-host-stdout".to_string())
        .spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(line) if line.trim().is_empty() => {}
                    Ok(line) => match serde_json::from_str::<Value>(&line) {
                        Ok(message) => handle_host_message(&app, &inner, message),
                        Err(error) => {
                            eprintln!("[Omni] Agent Host 输出了无效 JSON：{error}；{line}");
                        }
                    },
                    Err(error) => {
                        inner.mark_exited(&app, &format!("读取 Agent Host 输出失败：{error}"));
                        return;
                    }
                }
            }
            inner.mark_exited(&app, "Agent Host 输出已关闭");
        })
        .ok();
}

fn handle_host_message(app: &AppHandle, inner: &Arc<AgentHostInner>, message: Value) {
    match message.get("kind").and_then(Value::as_str) {
        Some("response") => {
            let Some(id) = message.get("id").and_then(Value::as_str) else {
                return;
            };
            let sender = inner
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(id);
            if let Some(sender) = sender {
                let result = if message.get("ok").and_then(Value::as_bool) == Some(true) {
                    Ok(message.get("result").cloned().unwrap_or_else(|| json!({})))
                } else {
                    Err(message
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("Agent Host 请求失败")
                        .to_string())
                };
                let _ = sender.send(result);
            }
        }
        Some("event") => {
            let _ = app.emit(EVENT_NAME, message);
        }
        Some("native-tool-call") => {
            dispatch_native_call(app.clone(), inner.clone(), message);
        }
        Some("native-tool-cancel") => {
            if let Some(id) = message.get("id").and_then(Value::as_str) {
                inner.cancel_native_call(id);
            }
        }
        Some(other) => {
            eprintln!("[Omni] 忽略未知 Agent Host 消息类型：{other}");
        }
        None => {
            eprintln!("[Omni] 忽略缺少 kind 的 Agent Host 消息");
        }
    }
}

fn dispatch_native_call(app: AppHandle, inner: Arc<AgentHostInner>, message: Value) {
    let Some(id) = message
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return;
    };
    let Some(tool) = message
        .get("tool")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        inner.send_native_result(&id, Err("原生工具调用缺少 tool".to_string()));
        return;
    };
    let arguments = message
        .get("arguments")
        .and_then(Value::as_str)
        .unwrap_or("{}")
        .to_string();
    let session_id = message
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let cancelled = Arc::new(AtomicBool::new(false));
    inner
        .native_calls
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(id.clone(), Arc::clone(&cancelled));

    tauri::async_runtime::spawn(async move {
        let result = if cancelled.load(Ordering::SeqCst) {
            Err("原生工具调用已取消".to_string())
        } else {
            let args = match serde_json::from_str::<Value>(&arguments) {
                Ok(args) => args,
                Err(error) => {
                    inner.send_native_result(
                        &id,
                        Err(format!("原生工具参数不是有效 JSON：{error}")),
                    );
                    return;
                }
            };
            let session_cwd = inner.session_cwd(&session_id);
            run_native_tool(&app, &tool, args, session_cwd)
                .await
                .map(|value| native_tool_result(&tool, value))
        };
        inner.send_native_result(&id, result);
    });
}

async fn run_native_tool(
    app: &AppHandle,
    tool: &str,
    args: Value,
    session_cwd: Option<String>,
) -> Result<Value, String> {
    match tool {
        "list_files" => {
            let project_path = optional_string(&args, "projectPath")?.or(session_cwd);
            let glob = optional_string(&args, "glob")?;
            let limit = optional_usize(&args, "limit")?;
            let result = tauri::async_runtime::spawn_blocking(move || {
                workspace_files::list_files(project_path, glob, limit)
            })
            .await
            .map_err(|error| format!("list_files 任务失败：{error}"))??;
            serde_json::to_value(result).map_err(|error| error.to_string())
        }
        "read_file" => {
            let path = required_string(&args, "path")?;
            let project_path = optional_string(&args, "projectPath")?.or(session_cwd);
            let max_chars = optional_usize(&args, "maxChars")?;
            let offset_chars = optional_usize(&args, "offsetChars")?;
            let limit_chars = optional_usize(&args, "limitChars")?;
            let result = tauri::async_runtime::spawn_blocking(move || {
                workspace_files::read_file(project_path, path, max_chars, offset_chars, limit_chars)
            })
            .await
            .map_err(|error| format!("read_file 任务失败：{error}"))??;
            serde_json::to_value(result).map_err(|error| error.to_string())
        }
        "search_files" => {
            let pattern = required_string(&args, "pattern")?;
            let project_path = optional_string(&args, "projectPath")?.or(session_cwd);
            let path = optional_string(&args, "path")?;
            let glob = optional_string(&args, "glob")?;
            let literal = optional_bool(&args, "literal")?;
            let ignore_case = optional_bool(&args, "ignoreCase")?;
            let context = optional_usize(&args, "context")?;
            let limit = optional_usize(&args, "limit")?;
            let result = tauri::async_runtime::spawn_blocking(move || {
                workspace_files::search_files(
                    project_path,
                    pattern,
                    path,
                    glob,
                    literal,
                    ignore_case,
                    context,
                    limit,
                )
            })
            .await
            .map_err(|error| format!("search_files 任务失败：{error}"))??;
            serde_json::to_value(result).map_err(|error| error.to_string())
        }
        "write_file" => {
            let path = required_string(&args, "path")?;
            let content = required_raw_string(&args, "content")?;
            let overwrite = optional_bool(&args, "overwrite")?;
            let workspace_path = optional_string(&args, "workspacePath")?.or(session_cwd);
            let confirmed_outside = optional_bool(&args, "confirmedOutside")?;
            let sandbox_mode = optional_sandbox_mode(&args, "sandboxMode")?;
            let outcome = write_file_tool(
                app.clone(),
                path,
                content,
                overwrite,
                workspace_path,
                confirmed_outside,
                sandbox_mode,
            )
            .await?;
            serde_json::to_value(outcome).map_err(|error| error.to_string())
        }
        "edit_file" => {
            let path = required_string(&args, "path")?;
            let find = required_raw_string(&args, "find")?;
            let replace = required_raw_string(&args, "replace")?;
            let replace_all = optional_bool(&args, "replaceAll")?;
            let workspace_path = optional_string(&args, "workspacePath")?.or(session_cwd);
            let confirmed_outside = optional_bool(&args, "confirmedOutside")?;
            let sandbox_mode = optional_sandbox_mode(&args, "sandboxMode")?;
            let outcome = edit_file_tool(
                app.clone(),
                path,
                find,
                replace,
                replace_all,
                workspace_path,
                confirmed_outside,
                sandbox_mode,
            )
            .await?;
            serde_json::to_value(outcome).map_err(|error| error.to_string())
        }
        "execute_command" => {
            let mut input: ExecuteCommandInput = serde_json::from_value(args)
                .map_err(|error| format!("execute_command 参数无效：{error}"))?;
            if input
                .cwd
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .is_none()
            {
                input.cwd = session_cwd;
            }
            let result = execute_command(app.clone(), input).await?;
            serde_json::to_value(result).map_err(|error| error.to_string())
        }
        other => Err(format!("未知原生工具：{other}")),
    }
}

/// Native tools return structured Rust values, while the Agent Host tool
/// contract carries model-facing text. Normalize at the process boundary so
/// arrays/outcomes are never rejected as malformed tool results.
fn native_tool_result(tool: &str, value: Value) -> Value {
    let content = match tool {
        "read_file" => {
            let body = value
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default();
            format!(
                "{body}\n\n[file-meta total={} offset={} returned={} lines={}-{} truncated={}]",
                value
                    .get("total_chars")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                value
                    .get("offset_chars")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                value
                    .get("returned_chars")
                    .and_then(Value::as_u64)
                    .unwrap_or(body.chars().count() as u64),
                value.get("start_line").and_then(Value::as_u64).unwrap_or(1),
                value.get("end_line").and_then(Value::as_u64).unwrap_or(1),
                value
                    .get("truncated")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            )
        }
        "list_files" => {
            let mut lines = Vec::new();
            if let Some(entries) = value.as_array() {
                for entry in entries {
                    let path = entry
                        .get("path")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let is_dir = entry
                        .get("is_dir")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    lines.push(format!("{}{path}", if is_dir { "[dir] " } else { "" }));
                }
            }
            if lines.is_empty() {
                "(no files matched)".to_string()
            } else {
                lines.join("\n")
            }
        }
        "search_files" => {
            let mut lines = Vec::new();
            if let Some(matches) = value.as_array() {
                for item in matches {
                    let path = item.get("path").and_then(Value::as_str).unwrap_or_default();
                    let line = item.get("line_number").and_then(Value::as_u64).unwrap_or(0);
                    let text = item.get("line").and_then(Value::as_str).unwrap_or_default();
                    lines.push(format!("{path}:{line}: {text}"));
                }
            }
            if lines.is_empty() {
                "(no matches)".to_string()
            } else {
                lines.join("\n")
            }
        }
        "execute_command" => {
            let output = value
                .get("output")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let exit_code = value
                .get("exitCode")
                .and_then(Value::as_i64)
                .unwrap_or_default();
            let timed_out = value
                .get("timedOut")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let denied = value
                .get("denied")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let enforcement = value
                .get("enforcement")
                .and_then(Value::as_str)
                .unwrap_or("none");
            let body = if output.trim().is_empty() {
                "(no output)"
            } else {
                output
            };
            format!(
                "{body}\n\n[command-meta exitCode={exit_code} timedOut={timed_out} denied={denied} enforcement={enforcement}]"
            )
        }
        "write_file" | "edit_file" => {
            let path = value
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let created = value
                .get("created")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let replacements = value
                .get("replacements")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let size = value.get("size").and_then(Value::as_u64).unwrap_or(0);
            format!(
                "{}: {path} (size={size}, created={created}, replacements={replacements})",
                if created { "created" } else { "updated" }
            )
        }
        _ => serde_json::to_string_pretty(&value)
            .unwrap_or_else(|_| "native tool completed without a displayable result".to_string()),
    };

    let is_error = if tool == "execute_command" {
        let exit_code = value
            .get("exitCode")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        let timed_out = value
            .get("timedOut")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let denied = value
            .get("denied")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        exit_code != 0 || timed_out || denied
    } else {
        false
    };

    json!({
        "content": content,
        "isError": is_error,
    })
}

fn native_tool_descriptors() -> Value {
    json!([
        {
            "name": "list_files",
            "description": "List files in the current project workspace. Relative paths are resolved against the session workspace.",
            "parameters": object_schema(json!({
                "projectPath": { "type": "string", "description": "Optional workspace root. Defaults to the current session cwd." },
                "glob": { "type": "string", "description": "Optional glob filter such as **/*.ts." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 2000 }
            }), &[]),
            "parallelSafe": true
        },
        {
            "name": "read_file",
            "description": "Read a UTF-8 text file. Absolute paths are allowed; relative paths are resolved inside the project workspace. Sensitive credential files are blocked.",
            "parameters": object_schema(json!({
                "path": { "type": "string", "description": "Absolute path or path relative to the project workspace." },
                "projectPath": { "type": "string", "description": "Optional workspace root. Defaults to the current session cwd." },
                "maxChars": { "type": "integer", "minimum": 1, "maximum": 80000 },
                "offsetChars": { "type": "integer", "minimum": 0 },
                "limitChars": { "type": "integer", "minimum": 1, "maximum": 80000 }
            }), &["path"]),
            "parallelSafe": true
        },
        {
            "name": "search_files",
            "description": "Search text in the current project workspace using ripgrep-compatible path and glob filtering.",
            "parameters": object_schema(json!({
                "pattern": { "type": "string", "description": "Text or regular expression to search for." },
                "projectPath": { "type": "string", "description": "Optional workspace root. Defaults to the current session cwd." },
                "path": { "type": "string", "description": "Optional relative path to restrict the search." },
                "glob": { "type": "string", "description": "Optional glob filter." },
                "literal": { "type": "boolean", "description": "Treat pattern as literal text." },
                "ignoreCase": { "type": "boolean" },
                "context": { "type": "integer", "minimum": 0, "maximum": 20 },
                "limit": { "type": "integer", "minimum": 1, "maximum": 1000 }
            }), &["pattern"]),
            "parallelSafe": true
        },
        {
            "name": "write_file",
            "description": "Create a text file or overwrite an existing text file. Workspace escape, no-go zones, sandbox policy, and user confirmation remain enforced by Omni.",
            "parameters": object_schema(json!({
                "path": { "type": "string" },
                "content": { "type": "string" },
                "overwrite": { "type": "boolean", "default": false },
                "workspacePath": { "type": "string", "description": "Optional workspace root. Defaults to the current session cwd." },
                "confirmedOutside": { "type": "boolean", "default": false },
                "sandboxMode": { "type": "string", "enum": ["read-only", "workspace-write", "danger-full-access"] }
            }), &["path", "content"]),
            "parallelSafe": false
        },
        {
            "name": "edit_file",
            "description": "Replace an exact text fragment in an existing text file. Ambiguous matches require replaceAll or more context. Omni permission checks remain enforced.",
            "parameters": object_schema(json!({
                "path": { "type": "string" },
                "find": { "type": "string" },
                "replace": { "type": "string" },
                "replaceAll": { "type": "boolean", "default": false },
                "workspacePath": { "type": "string", "description": "Optional workspace root. Defaults to the current session cwd." },
                "confirmedOutside": { "type": "boolean", "default": false },
                "sandboxMode": { "type": "string", "enum": ["read-only", "workspace-write", "danger-full-access"] }
            }), &["path", "find", "replace"]),
            "parallelSafe": false
        },
        {
            "name": "execute_command",
            "description": "Run a shell command in the current project workspace. Omni's existing command timeout and platform sandbox policy remain enforced.",
            "parameters": object_schema(json!({
                "command": { "type": "string" },
                "cwd": { "type": "string", "description": "Optional working directory. Defaults to the current session cwd." },
                "shellPath": { "type": "string" },
                "timeoutMs": { "type": "integer", "minimum": 1 },
                "sandboxMode": { "type": "string", "enum": ["read-only", "workspace-write", "danger-full-access"] },
                "sandbox": { "type": "boolean", "description": "Legacy compatibility switch." }
            }), &["command"]),
            "parallelSafe": false
        }
    ])
}

fn object_schema(properties: Value, required: &[&str]) -> Value {
    let mut schema = json!({
        "type": "object",
        "properties": properties,
        "additionalProperties": false
    });
    if !required.is_empty() {
        schema["required"] = json!(required);
    }
    schema
}

fn optional_string(args: &Value, key: &str) -> Result<Option<String>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            let value = value.trim();
            if value.is_empty() {
                Ok(None)
            } else {
                Ok(Some(value.to_string()))
            }
        }
        Some(_) => Err(format!("参数 {key} 必须是字符串")),
    }
}

fn required_string(args: &Value, key: &str) -> Result<String, String> {
    optional_string(args, key)?.ok_or_else(|| format!("缺少必填参数 {key}"))
}

fn required_raw_string(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("缺少必填字符串参数 {key}"))
}

fn optional_bool(args: &Value, key: &str) -> Result<Option<bool>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(format!("参数 {key} 必须是布尔值")),
    }
}

fn optional_usize(args: &Value, key: &str) -> Result<Option<usize>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(value)) => value
            .as_u64()
            .and_then(|value| usize::try_from(value).ok())
            .map(Some)
            .ok_or_else(|| format!("参数 {key} 必须是非负整数")),
        Some(Value::String(value)) => value
            .parse::<usize>()
            .map(Some)
            .map_err(|_| format!("参数 {key} 必须是非负整数")),
        Some(_) => Err(format!("参数 {key} 必须是非负整数")),
    }
}

fn optional_sandbox_mode(args: &Value, key: &str) -> Result<Option<SandboxMode>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|_| {
                format!("参数 {key} 必须是 read-only、workspace-write 或 danger-full-access")
            }),
    }
}

fn resolve_sidecar_path() -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os("OMNI_AGENT_HOST_PATH") {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Ok(path);
        }
        return Err(format!(
            "OMNI_AGENT_HOST_PATH 指向的文件不存在：{}",
            path.display()
        ));
    }

    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join(SIDECAR_FILE_NAME));
        }
    }
    let triple = env!("OMNI_TARGET_TRIPLE");
    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!(
                "{}{}",
                sidecar_triple_name(triple),
                std::env::consts::EXE_SUFFIX
            )),
    );
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join(format!(
                "{}{}",
                sidecar_triple_name(triple),
                std::env::consts::EXE_SUFFIX
            )));
        }
    }

    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            format!(
                "未找到 Agent Host sidecar。请先运行 `pnpm agent-host:build`，或设置 OMNI_AGENT_HOST_PATH。目标平台：{triple}"
            )
        })
}

fn sidecar_triple_name(triple: &str) -> String {
    format!("omni-agent-host-{triple}")
}

#[tauri::command]
pub(crate) async fn agent_host_start(
    app: AppHandle,
    state: State<'_, AgentHostState>,
) -> Result<AgentHostStatus, String> {
    let inner = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        inner.ensure_started(&app)?;
        Ok(inner.status())
    })
    .await
    .map_err(|error| format!("启动 Agent Host 任务失败：{error}"))?
}

#[tauri::command]
pub(crate) async fn agent_host_stop(
    app: AppHandle,
    state: State<'_, AgentHostState>,
) -> Result<(), String> {
    let inner = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        inner.stop(&app);
        Ok(())
    })
    .await
    .map_err(|error| format!("停止 Agent Host 任务失败：{error}"))?
}

#[tauri::command]
pub(crate) fn agent_host_status(state: State<'_, AgentHostState>) -> AgentHostStatus {
    state.inner.status()
}

#[tauri::command]
pub(crate) async fn agent_host_request(
    state: State<'_, AgentHostState>,
    request: AgentHostRequestInput,
) -> Result<Value, String> {
    let inner = Arc::clone(&state.inner);
    let command = request.command.trim().to_string();
    if command.is_empty() {
        return Err("Agent Host command 不能为空".to_string());
    }
    let params = request.params;
    tauri::async_runtime::spawn_blocking(move || {
        let id = uuid::Uuid::new_v4().to_string();
        let result = inner.request(&id, &command, params.clone())?;
        inner.record_session_cwd(&command, &params, &result);
        Ok(result)
    })
    .await
    .map_err(|error| format!("Agent Host 请求任务失败：{error}"))?
}

pub(crate) fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<AgentHostState>() {
        state.stop(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_names_include_target_triple() {
        assert_eq!(
            sidecar_triple_name("x86_64-pc-windows-msvc"),
            "omni-agent-host-x86_64-pc-windows-msvc"
        );
    }

    #[test]
    fn native_schemas_have_required_fields() {
        let tools = native_tool_descriptors();
        let tools = tools.as_array().expect("tool descriptors");
        let read = tools
            .iter()
            .find(|tool| tool["name"] == "read_file")
            .expect("read_file");
        assert_eq!(read["parameters"]["required"], json!(["path"]));
        let command = tools
            .iter()
            .find(|tool| tool["name"] == "execute_command")
            .expect("execute_command");
        assert_eq!(command["parameters"]["required"], json!(["command"]));
    }

    #[test]
    fn native_tool_results_are_model_readable() {
        let listing = native_tool_result(
            "list_files",
            json!([
                { "path": "src/main.ts", "is_dir": false },
                { "path": "src/app", "is_dir": true }
            ]),
        );
        assert_eq!(listing["isError"], false);
        assert_eq!(listing["content"], "src/main.ts\n[dir] src/app");

        let failed_command = native_tool_result(
            "execute_command",
            json!({
                "exitCode": 1,
                "output": "failed",
                "timedOut": false,
                "denied": false,
                "enforcement": "full"
            }),
        );
        assert_eq!(failed_command["isError"], true);
        assert!(failed_command["content"]
            .as_str()
            .unwrap_or_default()
            .contains("exitCode=1"));
    }
}
