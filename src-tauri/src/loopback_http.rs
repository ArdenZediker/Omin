use futures_util::StreamExt;
use reqwest::{header::HeaderMap, Client, Method, Url};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    net::IpAddr,
    sync::{Arc, Mutex},
};
use tauri::{ipc::Channel, State};
use tokio::sync::oneshot;

#[derive(Clone, Default)]
pub(crate) struct LoopbackProxyState {
    cancellations: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoopbackRequest {
    request_id: String,
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum LoopbackEvent {
    Headers {
        status: u16,
        headers: HashMap<String, String>,
    },
    Chunk {
        data: Vec<u8>,
    },
    End,
    Error {
        message: String,
    },
}

pub(crate) fn is_loopback_url(raw: &str) -> bool {
    let Ok(url) = Url::parse(raw) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    match url.host_str() {
        Some("localhost") => true,
        Some(host) => host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback()),
        None => false,
    }
}

#[tauri::command]
pub(crate) async fn loopback_http_request(
    request: LoopbackRequest,
    on_event: Channel<LoopbackEvent>,
    state: State<'_, LoopbackProxyState>,
) -> Result<(), String> {
    if !is_loopback_url(&request.url) {
        return Err("本机 HTTP 代理只允许 localhost 或 loopback IP 地址".into());
    }
    let url = Url::parse(&request.url).map_err(|err| format!("无效的 URL：{err}"))?;
    let method = Method::from_bytes(request.method.as_bytes())
        .map_err(|err| format!("无效的 HTTP 方法：{err}"))?;
    let mut headers = HeaderMap::new();
    for (name, value) in request.headers {
        let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|err| err.to_string())?;
        if matches!(
            name.as_str(),
            "host" | "content-length" | "connection" | "origin"
        ) {
            continue;
        }
        let value =
            reqwest::header::HeaderValue::from_str(&value).map_err(|err| err.to_string())?;
        headers.insert(name, value);
    }

    let timeout =
        std::time::Duration::from_millis(request.timeout_ms.unwrap_or(60_000).clamp(1, 900_000));
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|err| err.to_string())?;
    let mut builder = client.request(method, url).headers(headers);
    if let Some(body) = request.body {
        builder = builder.body(body);
    }

    let (cancel_tx, mut cancel_rx) = oneshot::channel();
    {
        let mut cancellations = state.cancellations.lock().map_err(|_| "取消状态锁不可用")?;
        cancellations.insert(request.request_id.clone(), cancel_tx);
    }
    let response = tokio::select! {
        result = tokio::time::timeout(timeout, builder.send()) => match result {
            Err(_) => {
                if let Ok(mut cancellations) = state.cancellations.lock() { cancellations.remove(&request.request_id); }
                return Err(format!("连接本机模型网关超时（{}ms）", timeout.as_millis()));
            }
            Ok(Ok(response)) => response,
            Ok(Err(error)) => {
                if let Ok(mut cancellations) = state.cancellations.lock() { cancellations.remove(&request.request_id); }
                return Err(format!("连接本机模型网关失败：{error}"));
            }
        },
        _ = &mut cancel_rx => {
            if let Ok(mut cancellations) = state.cancellations.lock() { cancellations.remove(&request.request_id); }
            return Ok(());
        }
    };
    let status = response.status().as_u16();
    let response_headers = ["content-type", "retry-after", "cache-control"]
        .into_iter()
        .filter_map(|name| {
            response
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(|value| (name.to_string(), value.to_string()))
        })
        .collect();
    if let Err(error) = on_event.send(LoopbackEvent::Headers {
        status,
        headers: response_headers,
    }) {
        if let Ok(mut cancellations) = state.cancellations.lock() {
            cancellations.remove(&request.request_id);
        }
        return Err(error.to_string());
    }

    let state = state.inner().clone();
    let request_id = request.request_id;
    tauri::async_runtime::spawn(async move {
        let mut stream = response.bytes_stream();
        loop {
            tokio::select! {
                _ = &mut cancel_rx => break,
                item = stream.next() => match item {
                    Some(Ok(bytes)) => {
                        if on_event.send(LoopbackEvent::Chunk { data: bytes.to_vec() }).is_err() { break; }
                    }
                    Some(Err(error)) => {
                        let _ = on_event.send(LoopbackEvent::Error { message: format!("本机网关响应中断：{error}") });
                        break;
                    }
                    None => {
                        let _ = on_event.send(LoopbackEvent::End);
                        break;
                    }
                }
            }
        }
        if let Ok(mut cancellations) = state.cancellations.lock() {
            cancellations.remove(&request_id);
        }
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn cancel_loopback_http_request(
    request_id: String,
    state: State<'_, LoopbackProxyState>,
) {
    if let Ok(mut cancellations) = state.cancellations.lock() {
        if let Some(cancel) = cancellations.remove(&request_id) {
            let _ = cancel.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::is_loopback_url;

    #[test]
    fn only_http_urls_with_explicit_loopback_hosts_are_allowed() {
        for url in [
            "http://127.0.0.1:3425/v1",
            "https://localhost:3425/v1",
            "http://[::1]:3425/v1",
        ] {
            assert!(is_loopback_url(url), "{url}");
        }
        for url in [
            "https://api.openai.com/v1",
            "http://192.168.1.2:3425/v1",
            "http://localhost.attacker.test/v1",
            "file:///etc/passwd",
            "http://user:pass@localhost:3425/v1",
        ] {
            assert!(!is_loopback_url(url), "{url}");
        }
    }
}
