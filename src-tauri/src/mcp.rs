// Omni - MCP (Model Context Protocol) 客户端
//
// 连接器运行层：把「外部服务接入型连接器」以 MCP 服务器形态跑起来，
// 与 WorkBuddy 的连接器模型（MCP 服务器 + 凭证 → mcp__xxx 工具）对齐。
//
// 协议：JSON-RPC 2.0。支持两种传输：
//   - stdio：本地子进程，Content-Length 帧
//   - Streamable HTTP：2025-03-26 规范，单个 HTTP 端点，POST 请求，
//     响应可以是 application/json 或 text/event-stream
//
// 安全：spawn 是用户显式触发（前端连接器「启动」按钮），进程受系统权限约束；
// 命令参数来自用户配置，不做额外 shell 解析（Command 直接传参，无 shell 注入面）。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------

fn servers() -> &'static Mutex<Option<HashMap<String, Arc<Mutex<McpConnection>>>>> {
    static LOCK: Mutex<Option<HashMap<String, Arc<Mutex<McpConnection>>>>> = Mutex::new(None);
    &LOCK
}

fn next_request_id() -> u64 {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

// ---------------------------------------------------------------------------
// 传输层抽象
// ---------------------------------------------------------------------------

enum McpTransport {
    Stdio {
        child: Child,
        stdin: Option<ChildStdin>,
        stdout: Option<BufReader<ChildStdout>>,
        stderr_lines: Arc<Mutex<Vec<String>>>,
    },
    Http {
        client: reqwest::blocking::Client,
        url: String,
        headers: HashMap<String, String>,
        session_id: Arc<Mutex<Option<String>>>,
    },
}

impl McpTransport {
    /// 发送一条 JSON-RPC 通知，不等待响应。
    fn send_message(&mut self, message: &Value) -> Result<(), String> {
        match self {
            McpTransport::Stdio { stdin, .. } => {
                let stdin = stdin.as_mut().ok_or("stdin 已关闭")?;
                write_stdio_frame(stdin, message)
            }
            McpTransport::Http {
                client,
                url,
                headers,
                session_id,
            } => {
                let mut req = client
                    .post(url.as_str())
                    .header(reqwest::header::ACCEPT, "application/json, text/event-stream");
                for (key, value) in headers.iter() {
                    req = req.header(key, value);
                }
                if let Some(sid) = session_id.lock().unwrap().as_ref() {
                    req = req.header("Mcp-Session-Id", sid);
                }
                let resp = req
                    .json(message)
                    .send()
                    .map_err(|e| format!("MCP HTTP 发送失败: {e}"))?;
                let status = resp.status();
                if status.is_success() || status == reqwest::StatusCode::ACCEPTED {
                    Ok(())
                } else {
                    let body = resp.text().unwrap_or_default();
                    Err(format!("MCP HTTP 通知失败: HTTP {status} {body}"))
                }
            }
        }
    }

    /// 发送一条 JSON-RPC 请求并等待对应 id 的响应。
    fn request(&mut self, message: &Value, request_id: u64) -> Result<Value, String> {
        match self {
            McpTransport::Stdio { stdin, stdout, .. } => {
                let stdin = stdin.as_mut().ok_or("stdin 已关闭")?;
                let stdout = stdout.as_mut().ok_or("stdout 已关闭")?;
                write_stdio_frame(stdin, message)?;
                read_stdio_response(stdout, request_id)
            }
            McpTransport::Http {
                client,
                url,
                headers,
                session_id,
            } => {
                let mut req = client
                    .post(url.as_str())
                    .header(reqwest::header::ACCEPT, "application/json, text/event-stream")
                    .header(reqwest::header::CONTENT_TYPE, "application/json");
                for (key, value) in headers.iter() {
                    req = req.header(key, value);
                }
                if let Some(sid) = session_id.lock().unwrap().as_ref() {
                    req = req.header("Mcp-Session-Id", sid);
                }
                let mut resp = req
                    .json(message)
                    .send()
                    .map_err(|e| format!("MCP HTTP 请求失败: {e}"))?;

                // 记录服务端返回的 session id，后续请求带上传达会话。
                if let Some(sid) = resp
                    .headers()
                    .get("Mcp-Session-Id")
                    .and_then(|v| v.to_str().ok())
                {
                    *session_id.lock().unwrap() = Some(sid.to_string());
                }

                let content_type = resp
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_lowercase();

                if content_type.starts_with("application/json") {
                    let body = resp
                        .json::<Value>()
                        .map_err(|e| format!("MCP HTTP 响应 JSON 解析失败: {e}"))?;
                    verify_response_id(&body, request_id)?;
                    Ok(body)
                } else if content_type.starts_with("text/event-stream") {
                    read_sse_response(&mut resp, request_id)
                } else {
                    // 未知 Content-Type：尝试按 JSON 解析（部分服务器返回 200 + JSON 但缺头）
                    let body = resp.text().unwrap_or_default();
                    if body.trim().is_empty() {
                        return Err("MCP HTTP 响应为空且不含 Content-Type".to_string());
                    }
                    let value = serde_json::from_str(&body)
                        .map_err(|e| format!("MCP HTTP 响应解析失败: {e}"))?;
                    verify_response_id(&value, request_id)?;
                    Ok(value)
                }
            }
        }
    }

    fn stderr_tail(&self) -> Vec<String> {
        match self {
            McpTransport::Stdio { stderr_lines, .. } => stderr_lines
                .lock()
                .map(|lines| lines.clone())
                .unwrap_or_default(),
            McpTransport::Http { .. } => Vec::new(),
        }
    }

    fn stop(&mut self) {
        if let McpTransport::Stdio { child, .. } = self {
            let _ = child.kill();
            let _ = child.wait();
        }
        // HTTP transport 无需显式关闭（无持久 GET SSE 后台线程时）
    }
}

fn verify_response_id(value: &Value, request_id: u64) -> Result<(), String> {
    if let Some(id) = value.get("id").and_then(Value::as_u64) {
        if id != request_id {
            return Err(format!(
                "MCP 响应 id 不匹配: 期望 {request_id}, 实际 {id}"
            ));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// stdio 帧读写
// ---------------------------------------------------------------------------

fn write_stdio_frame(stdin: &mut ChildStdin, message: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(message).map_err(|e| format!("序列化失败: {e}"))?;
    write!(stdin, "Content-Length: {}\r\n\r\n", body.len())
        .map_err(|e| format!("写入失败: {e}"))?;
    stdin
        .write_all(&body)
        .map_err(|e| format!("写入失败: {e}"))?;
    stdin.flush().map_err(|e| format!("写入失败: {e}"))
}

fn read_stdio_message(reader: &mut BufReader<ChildStdout>) -> Result<Value, String> {
    let mut header = String::new();
    let mut byte = [0u8; 1];
    loop {
        reader
            .read_exact(&mut byte)
            .map_err(|e| format!("读取 MCP 响应头失败（进程可能已退出）: {e}"))?;
        header.push(byte[0] as char);
        if header.ends_with("\r\n\r\n") {
            break;
        }
        if header.len() > 8192 {
            return Err("MCP 响应头过长".to_string());
        }
    }

    let content_length: usize = header
        .lines()
        .find(|line| line.to_ascii_lowercase().starts_with("content-length:"))
        .and_then(|line| line.split(':').nth(1))
        .map(|value| value.trim().parse::<usize>())
        .transpose()
        .map_err(|_| "Content-Length 解析失败".to_string())?
        .ok_or_else(|| "缺少 Content-Length 头".to_string())?;

    let mut body = vec![0u8; content_length];
    reader
        .read_exact(&mut body)
        .map_err(|e| format!("读取 MCP 响应体失败: {e}"))?;
    serde_json::from_slice(&body).map_err(|e| format!("MCP 响应 JSON 解析失败: {e}"))
}

fn read_stdio_response(
    reader: &mut BufReader<ChildStdout>,
    request_id: u64,
) -> Result<Value, String> {
    loop {
        let message = read_stdio_message(reader)?;
        if message.get("id").and_then(Value::as_u64) == Some(request_id) {
            return Ok(message);
        }
        // 跳过通知/无关响应
    }
}

// ---------------------------------------------------------------------------
// HTTP SSE 解析
// ---------------------------------------------------------------------------

fn read_sse_response(resp: &mut reqwest::blocking::Response, request_id: u64) -> Result<Value, String> {
    let reader = BufReader::new(resp);
    let mut current_data = String::new();
    for line in reader.lines() {
        let line = line.map_err(|e| format!("读取 SSE 行失败: {e}"))?;
        let line = line.trim_end();
        if line.is_empty() {
            if !current_data.is_empty() {
                let data = current_data.trim();
                if let Ok(value) = serde_json::from_str::<Value>(data) {
                    if value.get("id").and_then(Value::as_u64) == Some(request_id) {
                        return Ok(value);
                    }
                }
                current_data.clear();
            }
        } else if let Some(data_part) = line.strip_prefix("data:") {
            if !current_data.is_empty() {
                current_data.push('\n');
            }
            current_data.push_str(data_part.trim_start());
        }
        // 忽略 event: / id: / retry: 等字段
    }
    Err("SSE 流结束但未收到匹配的响应".to_string())
}

// ---------------------------------------------------------------------------
// MCP 连接
// ---------------------------------------------------------------------------

struct McpConnection {
    transport: McpTransport,
    server_info: Value,
}

fn mcp_initialize(conn: &mut McpConnection) -> Result<Value, String> {
    let id = next_request_id();
    let init_msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "omni", "version": env!("CARGO_PKG_VERSION") }
        }
    });
    let response = conn.transport.request(&init_msg, id)?;
    if let Some(error) = response.get("error") {
        return Err(format!("MCP initialize 失败: {error}"));
    }
    // initialized 通知（协议要求 initialize 后发送）
    let _ = conn.transport.send_message(&json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
        "params": {}
    }));
    Ok(response.get("result").cloned().unwrap_or(json!({})))
}

fn mcp_request(conn: &mut McpConnection, method: &str, params: Value) -> Result<Value, String> {
    let id = next_request_id();
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params
    });
    let response = conn.transport.request(&msg, id)?;
    if let Some(error) = response.get("error") {
        return Err(format!("MCP {method} 失败: {error}"));
    }
    Ok(response.get("result").cloned().unwrap_or(json!({})))
}

// ---------------------------------------------------------------------------
// 对外数据结构
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, Clone)]
pub struct McpServerInfo {
    pub id: String,
    pub server_info: Value,
    pub capabilities: Value,
    pub tools: Vec<McpToolInfo>,
    pub stderr_tail: Vec<String>,
}

#[derive(serde::Serialize, Clone)]
pub struct McpToolInfo {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(serde::Serialize)]
pub struct McpToolResult {
    pub ok: bool,
    pub text: String,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// 连接创建
// ---------------------------------------------------------------------------

fn spawn_stdio_server(
    command: &str,
    args: &[String],
    env: &HashMap<String, String>,
) -> Result<McpConnection, String> {
    let mut builder = Command::new(command);
    builder
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in env {
        builder.env(key, value);
    }
    // 让 MCP 服务器继承父进程 PATH（npx / uvx / bun 等依赖 PATH）
    let mut child = builder.spawn().map_err(|e| {
        format!("启动 MCP 服务器失败（{command}）: {e}。请确认命令可执行，或改用绝对路径")
    })?;

    let stdin = child.stdin.take();
    let stdout = child.stdout.take().map(BufReader::new);
    let stderr = child.stderr.take();

    // 后台线程持续读取 stderr，避免缓冲区写满阻塞子进程
    let stderr_lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    if let Some(stderr_pipe) = stderr {
        let lines = Arc::clone(&stderr_lines);
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr_pipe);
            for line in reader.lines() {
                if let Ok(line) = line {
                    let mut guard = match lines.lock() {
                        Ok(guard) => guard,
                        Err(_) => break,
                    };
                    guard.push(line);
                    let overflow = guard.len().saturating_sub(200);
                    if overflow > 0 {
                        guard.drain(0..overflow);
                    }
                }
            }
        });
    }

    let mut conn = McpConnection {
        transport: McpTransport::Stdio {
            child,
            stdin,
            stdout,
            stderr_lines,
        },
        server_info: json!({}),
    };
    conn.server_info = mcp_initialize(&mut conn)?;
    Ok(conn)
}

fn connect_http_server(
    url: &str,
    headers: &HashMap<String, String>,
) -> Result<McpConnection, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(None)
        .build()
        .map_err(|e| format!("创建 HTTP client 失败: {e}"))?;
    let mut conn = McpConnection {
        transport: McpTransport::Http {
            client,
            url: url.to_string(),
            headers: headers.clone(),
            session_id: Arc::new(Mutex::new(None)),
        },
        server_info: json!({}),
    };
    conn.server_info = mcp_initialize(&mut conn)?;
    Ok(conn)
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

fn get_connection(id: &str) -> Result<Arc<Mutex<McpConnection>>, String> {
    let guard = servers().lock().map_err(|_| "MCP 连接表锁失败".to_string())?;
    let map = guard.as_ref().ok_or("MCP 服务未初始化")?;
    map.get(id)
        .cloned()
        .ok_or_else(|| format!("MCP 服务器未启动: {id}"))
}

/// 启动（或复用已启动的）MCP 服务器。
/// 提供 `command` 则走 stdio 子进程；提供 `url` 则走 Streamable HTTP。
#[tauri::command]
pub fn start_mcp_server(
    id: String,
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
    url: Option<String>,
    headers: Option<HashMap<String, String>>,
) -> Result<McpServerInfo, String> {
    let normalized_id = if id.trim().is_empty() {
        "default".to_string()
    } else {
        id.trim().to_string()
    };
    let id = normalized_id;

    // 已启动则直接返回当前状态
    {
        let guard = servers().lock().map_err(|_| "MCP 连接表锁失败".to_string())?;
        if let Some(map) = guard.as_ref() {
            if let Some(existing) = map.get(&id) {
                let mut conn = existing.lock().map_err(|_| "连接锁失败".to_string())?;
                let stderr_tail = conn.transport.stderr_tail();
                return Ok(McpServerInfo {
                    id: id.clone(),
                    server_info: conn.server_info.clone(),
                    capabilities: json!({}),
                    tools: list_tools_locked(&mut conn)?,
                    stderr_tail,
                });
            }
        }
    }

    let connection = Arc::new(Mutex::new(if let Some(url) = url.filter(|u| !u.trim().is_empty()) {
        connect_http_server(&url, &headers.unwrap_or_default())?
    } else {
        let cmd = command.ok_or("缺少启动命令（command 或 url 必须提供一个）")?;
        let args = args.unwrap_or_default();
        let env = env.unwrap_or_default();
        spawn_stdio_server(&cmd, &args, &env)?
    }));

    let mut conn = connection.lock().map_err(|_| "连接锁失败".to_string())?;
    let stderr_tail = conn.transport.stderr_tail();
    let server_info = conn.server_info.clone();
    let tools = list_tools_locked(&mut conn)?;
    drop(conn);

    let mut guard = servers().lock().map_err(|_| "MCP 连接表锁失败".to_string())?;
    if guard.is_none() {
        *guard = Some(HashMap::new());
    }
    guard.as_mut().unwrap().insert(id.clone(), connection);

    Ok(McpServerInfo {
        id,
        server_info,
        capabilities: json!({}),
        tools,
        stderr_tail,
    })
}

/// 停止并移除 MCP 服务器。
#[tauri::command]
pub fn stop_mcp_server(id: String) -> Result<Vec<String>, String> {
    let mut guard = servers().lock().map_err(|_| "MCP 连接表锁失败".to_string())?;
    let map = guard.as_mut().ok_or("MCP 服务未初始化")?;
    let removed = map
        .remove(&id)
        .ok_or_else(|| format!("MCP 服务器未启动: {id}"))?;
    let mut conn = removed.lock().map_err(|_| "连接锁失败".to_string())?;
    let stderr_tail = conn.transport.stderr_tail();
    conn.transport.stop();
    drop(conn);
    Ok(stderr_tail)
}

fn list_tools_locked(conn: &mut McpConnection) -> Result<Vec<McpToolInfo>, String> {
    let result = mcp_request(conn, "tools/list", json!({}))?;
    let tools = result
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(tools
        .into_iter()
        .map(|tool| McpToolInfo {
            name: tool
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            description: tool
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            input_schema: tool.get("inputSchema").cloned().unwrap_or(json!({})),
        })
        .collect())
}

/// 列出已启动 MCP 服务器的工具。
#[tauri::command]
pub fn list_mcp_tools(id: String) -> Result<Vec<McpToolInfo>, String> {
    let connection = get_connection(&id)?;
    let mut conn = connection.lock().map_err(|_| "连接锁失败".to_string())?;
    list_tools_locked(&mut conn)
}

/// 调用 MCP 服务器上的一个工具，返回文本结果。
#[tauri::command]
pub fn call_mcp_tool(
    id: String,
    name: String,
    arguments: Option<Value>,
) -> Result<McpToolResult, String> {
    let connection = get_connection(&id)?;
    let mut conn = connection.lock().map_err(|_| "连接锁失败".to_string())?;
    let params = json!({
        "name": name,
        "arguments": arguments.unwrap_or(json!({})),
    });
    let result = mcp_request(&mut conn, "tools/call", params)?;
    let is_error = result.get("isError").and_then(Value::as_bool).unwrap_or(false);
    let content = result
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let text: Vec<String> = content
        .into_iter()
        .filter_map(|block| {
            if let Some(text) = block.get("text").and_then(Value::as_str) {
                return Some(text.to_string());
            }
            if let Some(link) = block.get("url").and_then(Value::as_str) {
                return Some(format!("资源: {link}"));
            }
            None
        })
        .collect();
    // 超长 MCP 结果截断 + 完整落盘（此前完全没截断，几 MB 的 JSON 会直接撑爆上下文）。
    // 文件名带 `mcp:<server>:<tool>` 前缀便于事后定位来源。
    let text = crate::tool_output_spill::cap_and_spill(
        &text.join("\n"),
        crate::tool_output_spill::DEFAULT_TOOL_RESULT_CHARS,
        &format!("mcp:{id}:{name}"),
    );
    Ok(McpToolResult {
        ok: !is_error,
        text,
        error: if is_error {
            Some("MCP 工具执行返回错误（详见 text 或 stderr 日志）".to_string())
        } else {
            None
        },
    })
}

/// 读取已启动 MCP 服务器的 stderr 日志（尾部）。HTTP 传输返回空。
#[tauri::command]
pub fn read_mcp_stderr(id: String) -> Result<Vec<String>, String> {
    let connection = get_connection(&id)?;
    let conn = connection.lock().map_err(|_| "连接锁失败".to_string())?;
    Ok(conn.transport.stderr_tail())
}
