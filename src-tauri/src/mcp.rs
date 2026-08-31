// Omni - MCP (Model Context Protocol) stdio 客户端
//
// 连接器运行层：把「外部服务接入型连接器」以 MCP 服务器形态跑起来，
// 与 WorkBuddy 的连接器模型（MCP 服务器 + 凭证 → mcp__xxx 工具）对齐。
//
// 协议：JSON-RPC 2.0 over stdio（Content-Length 帧），零第三方依赖。
// 每个服务器是一个子进程；连接建立后依次：
//   initialize → notifications/initialized → tools/list → tools/call
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
// 连接管理（跨命令共享）
// ---------------------------------------------------------------------------

fn servers() -> &'static Mutex<Option<HashMap<String, Arc<Mutex<McpConnection>>>>> {
    static LOCK: Mutex<Option<HashMap<String, Arc<Mutex<McpConnection>>>>> = Mutex::new(None);
    &LOCK
}

fn next_request_id() -> u64 {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

struct McpConnection {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Option<BufReader<ChildStdout>>,
    /// 子进程 stderr 日志（后台线程持续读取，避免写满阻塞）
    stderr_lines: Arc<Mutex<Vec<String>>>,
    server_info: Value,
}

// ---------------------------------------------------------------------------
// 帧读写（MCP/JSON-RPC over stdio）
// ---------------------------------------------------------------------------

fn write_message(stdin: &mut ChildStdin, message: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(message).map_err(|e| format!("序列化失败: {e}"))?;
    write!(stdin, "Content-Length: {}\r\n\r\n", body.len()).map_err(|e| format!("写入失败: {e}"))?;
    stdin
        .write_all(&body)
        .map_err(|e| format!("写入失败: {e}"))?;
    stdin.flush().map_err(|e| format!("写入失败: {e}"))
}

fn read_message(reader: &mut BufReader<ChildStdout>) -> Result<Value, String> {
    // 读头部直到 \r\n\r\n
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

/// 读下一条非通知消息（通知没有 id，需要跳过）。
fn read_response(reader: &mut BufReader<ChildStdout>) -> Result<Value, String> {
    loop {
        let message = read_message(reader)?;
        if message.get("id").is_some() {
            return Ok(message);
        }
        // 忽略 notifications/… 消息
    }
}

// ---------------------------------------------------------------------------
// MCP 握手与调用
// ---------------------------------------------------------------------------

fn mcp_initialize(conn: &mut McpConnection) -> Result<Value, String> {
    let id = next_request_id();
    write_message(
        conn.stdin.as_mut().ok_or("stdin 已关闭")?,
        &json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "omni", "version": env!("CARGO_PKG_VERSION") }
            }
        }),
    )?;
    let response = read_response(conn.stdout.as_mut().ok_or("stdout 已关闭")?)?;
    if let Some(error) = response.get("error") {
        return Err(format!("MCP initialize 失败: {error}"));
    }
    // initialized 通知（协议要求 initialize 后发送）
    let _ = write_message(
        conn.stdin.as_mut().ok_or("stdin 已关闭")?,
        &json!({ "jsonrpc": "2.0", "method": "notifications/initialized", "params": {} }),
    );
    Ok(response.get("result").cloned().unwrap_or(json!({})))
}

fn mcp_request(conn: &mut McpConnection, method: &str, params: Value) -> Result<Value, String> {
    let id = next_request_id();
    write_message(
        conn.stdin.as_mut().ok_or("stdin 已关闭")?,
        &json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        }),
    )?;
    let response = read_response(conn.stdout.as_mut().ok_or("stdout 已关闭")?)?;
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
// Tauri 命令
// ---------------------------------------------------------------------------

fn get_connection(id: &str) -> Result<Arc<Mutex<McpConnection>>, String> {
    let guard = servers()
        .lock()
        .map_err(|_| "MCP 连接表锁失败".to_string())?;
    let map = guard.as_ref().ok_or("MCP 服务未初始化")?;
    map.get(id)
        .cloned()
        .ok_or_else(|| format!("MCP 服务器未启动: {id}"))
}

fn spawn_server(
    command: &str,
    args: &[String],
    env: &HashMap<String, String>,
) -> Result<Arc<Mutex<McpConnection>>, String> {
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
        child,
        stdin,
        stdout,
        stderr_lines,
        server_info: json!({}),
    };

    conn.server_info = mcp_initialize(&mut conn)?;
    Ok(Arc::new(Mutex::new(conn)))
}

/// 启动（或复用已启动的）MCP 服务器。command 为可执行命令（如 npx），
/// args 为命令参数（如 ["-y", "@modelcontextprotocol/server-github"]）。
#[tauri::command]
pub fn start_mcp_server(
    id: String,
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
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
                let stderr_tail = conn.stderr_lines.lock().map(|l| l.clone()).unwrap_or_default();
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

    let empty_env = HashMap::new();
    let connection = spawn_server(&command, &args, env.as_ref().unwrap_or(&empty_env))?;
    let mut conn = connection.lock().map_err(|_| "连接锁失败".to_string())?;
    let stderr_tail = conn.stderr_lines.lock().map(|l| l.clone()).unwrap_or_default();
    let server_info = conn.server_info.clone();
    let tools = list_tools_locked(&mut conn)?;
    drop(conn);

    let mut guard = servers().lock().map_err(|_| "MCP 连接表锁失败".to_string())?;
    if guard.is_none() {
        *guard = Some(HashMap::new());
    }
    guard
        .as_mut()
        .unwrap()
        .insert(id.clone(), connection);

    Ok(McpServerInfo {
        id,
        server_info,
        capabilities: json!({}),
        tools,
        stderr_tail,
    })
}

/// 停止并移除 MCP 服务器进程。
#[tauri::command]
pub fn stop_mcp_server(id: String) -> Result<Vec<String>, String> {
    let mut guard = servers().lock().map_err(|_| "MCP 连接表锁失败".to_string())?;
    let map = guard.as_mut().ok_or("MCP 服务未初始化")?;
    let removed = map
        .remove(&id)
        .ok_or_else(|| format!("MCP 服务器未启动: {id}"))?;
    let mut conn = removed.lock().map_err(|_| "连接锁失败".to_string())?;
    let stderr = conn
        .stderr_lines
        .lock()
        .map(|l| l.clone())
        .unwrap_or_default();
    let _ = conn.child.kill();
    let _ = conn.child.wait();
    drop(conn);
    Ok(stderr)
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
            name: tool.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
            description: tool.get("description").and_then(Value::as_str).unwrap_or("").to_string(),
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
pub fn call_mcp_tool(id: String, name: String, arguments: Option<Value>) -> Result<McpToolResult, String> {
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
    Ok(McpToolResult {
        ok: !is_error,
        text: text.join("\n"),
        error: if is_error {
            Some("MCP 工具执行返回错误（详见 text 或 stderr 日志）".to_string())
        } else {
            None
        },
    })
}

/// 读取已启动 MCP 服务器的 stderr 日志（尾部）。
#[tauri::command]
pub fn read_mcp_stderr(id: String) -> Result<Vec<String>, String> {
    let connection = get_connection(&id)?;
    let conn = connection.lock().map_err(|_| "连接锁失败".to_string())?;
    Ok(conn.stderr_lines.lock().map(|l| l.clone()).unwrap_or_default())
}
