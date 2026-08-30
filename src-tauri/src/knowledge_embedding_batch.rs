//! 由 lib.rs 拆分而来，逻辑保持不变。

use reqwest::blocking::Client as BlockingHttpClient;
use reqwest::Client as HttpClient;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::{
    cmp::Ordering,
    collections::HashMap,
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

use super::*;

#[derive(Deserialize)]
pub(crate) struct EmbeddingApiItem {
    pub(crate) embedding: Vec<f64>,
    pub(crate) index: usize,
}

#[derive(Deserialize)]
pub(crate) struct EmbeddingApiResponse {
    pub(crate) data: Vec<EmbeddingApiItem>,
}

pub(crate) fn request_embedding_batch(
    client: &BlockingHttpClient,
    base_url: &str,
    api_key: &str,
    model: &str,
    input: &[&str],
) -> Result<Vec<Option<String>>, String> {
    let request_body = serde_json::json!({
        "model": model,
        "input": input,
    });

    let response = client
        .post(format!("{}/embeddings", base_url.trim_end_matches('/')))
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&request_body)
        .send()
        .map_err(|err| err.to_string())?;

    if !response.status().is_success() {
        return Err(response.text().unwrap_or_default());
    }

    let payload: EmbeddingApiResponse = response.json().map_err(|err| err.to_string())?;
    let mut embeddings = vec![None; input.len()];
    for item in payload.data {
        if item.index >= embeddings.len() {
            continue;
        }
        embeddings[item.index] = serde_json::to_string(&item.embedding).ok();
    }

    Ok(embeddings)
}

pub(crate) fn collect_missing_embedding_spans(embeddings: &[Option<String>]) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut span_start = None;

    for (index, value) in embeddings.iter().enumerate() {
        if value.is_none() {
            if span_start.is_none() {
                span_start = Some(index);
            }
            continue;
        }

        if let Some(start) = span_start.take() {
            spans.push((start, index));
        }
    }

    if let Some(start) = span_start {
        spans.push((start, embeddings.len()));
    }

    spans
}

pub(crate) fn recover_embedding_batch<F>(
    batch: &[knowledge_chunker::ChunkSlice],
    provider: &str,
    request_embeddings: &mut F,
) -> Vec<Option<String>>
where
    F: FnMut(&[knowledge_chunker::ChunkSlice]) -> Result<Vec<Option<String>>, String>,
{
    if batch.is_empty() {
        return Vec::new();
    }

    let requested = batch.len();
    let response = request_embeddings(batch);
    match response {
        Ok(mut embeddings) => {
            if embeddings.len() < requested {
                embeddings.resize(requested, None);
            } else if embeddings.len() > requested {
                embeddings.truncate(requested);
            }

            let missing_spans = collect_missing_embedding_spans(&embeddings);
            if missing_spans.is_empty() {
                return embeddings;
            }

            let missing_count = missing_spans
                .iter()
                .map(|(start, end)| end - start)
                .sum::<usize>();
            eprintln!(
                "Knowledge embedding batch returned partial data ({provider}) requested={requested} recovered={} missing={missing_count}",
                requested.saturating_sub(missing_count)
            );

            if requested == 1 {
                return embeddings;
            }

            if missing_spans.len() == 1 && missing_spans[0] == (0, requested) {
                let split = requested / 2;
                let mut left =
                    recover_embedding_batch(&batch[..split], provider, request_embeddings);
                let right = recover_embedding_batch(&batch[split..], provider, request_embeddings);
                left.extend(right);
                return left;
            }

            for (start, end) in missing_spans {
                let recovered =
                    recover_embedding_batch(&batch[start..end], provider, request_embeddings);
                for (offset, embedding) in recovered.into_iter().enumerate() {
                    if embedding.is_some() {
                        embeddings[start + offset] = embedding;
                    }
                }
            }

            embeddings
        }
        Err(err) => {
            eprintln!(
                "Knowledge embedding batch request failed ({provider}) requested={requested}: {err}"
            );
            if requested == 1 {
                return vec![None];
            }

            let split = requested / 2;
            let mut left = recover_embedding_batch(&batch[..split], provider, request_embeddings);
            let right = recover_embedding_batch(&batch[split..], provider, request_embeddings);
            left.extend(right);
            left
        }
    }
}

pub(crate) fn generate_chunk_embeddings_resilient(
    active_model: &KnowledgeEmbeddingModelConfigRecord,
    provider: &str,
    base_url: &str,
    api_key: &str,
    chunks: &[knowledge_chunker::ChunkSlice],
) -> Result<Vec<Option<String>>, String> {
    let client = BlockingHttpClient::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|err| format!("知识库 embedding 客户端创建失败 ({provider}): {err}"))?;

    let mut embeddings = vec![None; chunks.len()];
    for (batch_index, batch) in chunks.chunks(EMBEDDING_BATCH_SIZE).enumerate() {
        let batch_start = batch_index * EMBEDDING_BATCH_SIZE;
        let mut request_embeddings =
            |items: &[knowledge_chunker::ChunkSlice]| -> Result<Vec<Option<String>>, String> {
                let input: Vec<&str> = items.iter().map(|chunk| chunk.content.as_str()).collect();
                request_embedding_batch(&client, base_url, api_key, &active_model.model, &input)
            };
        let recovered = recover_embedding_batch(batch, provider, &mut request_embeddings);

        for (offset, embedding) in recovered.into_iter().enumerate() {
            let target = batch_start + offset;
            if target >= embeddings.len() {
                break;
            }
            embeddings[target] = embedding;
        }
    }

    Ok(embeddings)
}

pub(crate) fn generate_chunk_embeddings_safe(
    connection: &Connection,
    chunks: &[knowledge_chunker::ChunkSlice],
) -> (Vec<Option<String>>, Option<String>) {
    if chunks.is_empty() {
        return (Vec::new(), None);
    }

    let Some((_, active_model)) = load_knowledge_embedding_active_model(connection)
        .ok()
        .flatten()
    else {
        return (vec![None; chunks.len()], None);
    };

    let provider = active_model.provider.clone();
    let base_url = active_model.base_url.trim();
    let api_key = active_model.api_key.trim();
    if base_url.is_empty() || api_key.is_empty() {
        return (vec![None; chunks.len()], None);
    }

    let embeddings = match generate_chunk_embeddings_resilient(
        &active_model,
        &provider,
        base_url,
        api_key,
        chunks,
    ) {
        Ok(embeddings) => embeddings,
        Err(err) => {
            eprintln!("{err}");
            vec![None; chunks.len()]
        }
    };

    let model_key = format!(
        "{}:{}:{}",
        active_model.provider,
        active_model.model,
        fingerprint_text(active_model.api_key.trim())
    );
    (embeddings, Some(model_key))
}

// ===== 异步孪生：非阻塞 embedding（P1）=====
//
// 与 `generate_chunk_embeddings_safe` 行为一致，但 HTTP 调用走 `reqwest` 异步客户端，
// 不在调用线程上阻塞。可在 tokio 运行时中并发处理批量文档，避免 worker 线程被
// 长时 HTTP（120s 超时）卡死、并发吞吐受限。同步版保持不变，所有既有调用方零影响。

pub(crate) async fn request_embedding_batch_async(
    client: &HttpClient,
    base_url: &str,
    api_key: &str,
    model: &str,
    batch: &[knowledge_chunker::ChunkSlice],
) -> Result<Vec<Option<String>>, String> {
    let input: Vec<&str> = batch.iter().map(|c| c.content.as_str()).collect();
    let request_body = serde_json::json!({
        "model": model,
        "input": input,
    });

    let response = client
        .post(format!(
            "{}/embeddings",
            base_url.trim_end_matches('/')
        ))
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&request_body)
        .send()
        .await
        .map_err(|err| err.to_string())?;

    if !response.status().is_success() {
        return Err(response.text().await.unwrap_or_default());
    }

    let payload: EmbeddingApiResponse = response.json().await.map_err(|err| err.to_string())?;
    let mut embeddings = vec![None; input.len()];
    for item in payload.data {
        if item.index >= embeddings.len() {
            continue;
        }
        embeddings[item.index] = serde_json::to_string(&item.embedding).ok();
    }

    Ok(embeddings)
}

/// 异步版缺失片段收集（与同步版 `collect_missing_embedding_spans` 同语义）。
pub(crate) fn collect_missing_embedding_spans_async(embeddings: &[Option<String>]) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut span_start: Option<usize> = None;

    for (index, value) in embeddings.iter().enumerate() {
        if value.is_none() {
            if span_start.is_none() {
                span_start = Some(index);
            }
            continue;
        }
        if let Some(start) = span_start.take() {
            spans.push((start, index));
        }
    }
    if let Some(start) = span_start {
        spans.push((start, embeddings.len()));
    }
    spans
}

/// 异步版批量重试/分治恢复（与同步版 `recover_embedding_batch` 同语义）。
///
/// 直接持有 `reqwest` 异步客户端与模型参数，递归地对缺失/失败片段做二分重试，
/// 不再依赖高阶闭包（`AsyncFnMut` 在复杂递归里易触发类型推导问题）。
pub(crate) fn recover_embedding_batch_async<'a>(
    client: &'a HttpClient,
    provider: &'a str,
    base_url: &'a str,
    api_key: &'a str,
    model: &'a str,
    batch: &'a [knowledge_chunker::ChunkSlice],
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<Option<String>>> + Send + 'a>> {
    Box::pin(async move {
        if batch.is_empty() {
            return Vec::new();
        }

        let requested = batch.len();
        let response = request_embedding_batch_async(client, base_url, api_key, model, batch).await;
        match response {
            Ok(mut embeddings) => {
                if embeddings.len() < requested {
                    embeddings.resize(requested, None);
                } else if embeddings.len() > requested {
                    embeddings.truncate(requested);
                }

                let missing_spans = collect_missing_embedding_spans_async(&embeddings);
                if missing_spans.is_empty() {
                    return embeddings;
                }

                let missing_count =
                    missing_spans.iter().map(|(start, end)| end - start).sum::<usize>();
                eprintln!(
                    "Knowledge embedding batch returned partial data ({provider}) requested={requested} recovered={} missing={missing_count}",
                    requested.saturating_sub(missing_count)
                );

                if requested == 1 {
                    return embeddings;
                }

                if missing_spans.len() == 1 && missing_spans[0] == (0, requested) {
                    let split = requested / 2;
                    let mut left = recover_embedding_batch_async(
                        client,
                        provider,
                        base_url,
                        api_key,
                        model,
                        &batch[..split],
                    )
                    .await;
                    let right = recover_embedding_batch_async(
                        client,
                        provider,
                        base_url,
                        api_key,
                        model,
                        &batch[split..],
                    )
                    .await;
                    left.extend(right);
                    return left;
                }

                for (start, end) in missing_spans {
                    let recovered = recover_embedding_batch_async(
                        client,
                        provider,
                        base_url,
                        api_key,
                        model,
                        &batch[start..end],
                    )
                    .await;
                    for (offset, embedding) in recovered.into_iter().enumerate() {
                        if embedding.is_some() {
                            embeddings[start + offset] = embedding;
                        }
                    }
                }

                embeddings
            }
            Err(err) => {
                eprintln!(
                    "Knowledge embedding batch request failed ({provider}) requested={requested}: {err}"
                );
                if requested == 1 {
                    return vec![None];
                }

                let split = requested / 2;
                let mut left = recover_embedding_batch_async(
                    client,
                    provider,
                    base_url,
                    api_key,
                    model,
                    &batch[..split],
                )
                .await;
                let right = recover_embedding_batch_async(
                    client,
                    provider,
                    base_url,
                    api_key,
                    model,
                    &batch[split..],
                )
                .await;
                left.extend(right);
                left
            }
        }
    })
}

pub(crate) async fn generate_chunk_embeddings_resilient_async(
    active_model: &KnowledgeEmbeddingModelConfigRecord,
    provider: &str,
    base_url: &str,
    api_key: &str,
    chunks: &[knowledge_chunker::ChunkSlice],
) -> Result<Vec<Option<String>>, String> {
    let client = HttpClient::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|err| format!("知识库 embedding 客户端创建失败 ({provider}): {err}"))?;

    // P1-#1：各 batch 并发在飞——用 `futures_util::join_all` 把多个 batch 的
    // 恢复/重试 future 一次性派发，真正抬升吞吐（底层 `reqwest` 异步客户端
    // 在 tokio 运行时内并发处理多个 HTTP 请求，不再串行等待）。
    let mut batch_futures: Vec<_> = Vec::new();
    for batch in chunks.chunks(EMBEDDING_BATCH_SIZE) {
        let future = recover_embedding_batch_async(
            &client,
            provider,
            base_url,
            api_key,
            &active_model.model,
            batch,
        );
        batch_futures.push(future);
    }
    let batch_results = futures_util::future::join_all(batch_futures).await;

    let mut embeddings = vec![None; chunks.len()];
    for (batch_index, recovered) in batch_results.into_iter().enumerate() {
        let batch_start = batch_index * EMBEDDING_BATCH_SIZE;
        for (offset, embedding) in recovered.into_iter().enumerate() {
            let target = batch_start + offset;
            if target >= embeddings.len() {
                break;
            }
            embeddings[target] = embedding;
        }
    }

    Ok(embeddings)
}

/// 异步版批量生成 chunk embedding（与 `generate_chunk_embeddings_safe` 同返回形状）。
///
/// 非阻塞：HTTP 走 `reqwest` 异步客户端，可在 tokio 运行时中并发调用，避免
/// 调用线程被长时 HTTP 卡死。降级逻辑与同步版一致（无模型/无密钥/请求失败 → 返回 `None`）。
/// 当前毫秒时间戳（向量缓存落库用）。
pub(crate) fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) async fn generate_chunk_embeddings_async(
    connection: &Connection,
    chunks: &[knowledge_chunker::ChunkSlice],
) -> (Vec<Option<String>>, Option<String>) {
    if chunks.is_empty() {
        return (Vec::new(), None);
    }

    let Some((_, active_model)) = load_knowledge_embedding_active_model(connection)
        .ok()
        .flatten()
    else {
        return (vec![None; chunks.len()], None);
    };

    let provider = active_model.provider.clone();
    let base_url = active_model.base_url.trim();
    let api_key = active_model.api_key.trim();
    if base_url.is_empty() || api_key.is_empty() {
        return (vec![None; chunks.len()], None);
    }

    let model_key = format!(
        "{}:{}:{}",
        active_model.provider,
        active_model.model,
        fingerprint_text(active_model.api_key.trim())
    );

    // === 向量缓存（P3-#8，best-effort）===
    // 命中缓存的片段直接复用，仅未命中的才真正请求模型；请求成功后再回填缓存。
    // 任何缓存异常都被忽略（缓存是加速层，不应影响主链路）。
    let mut embeddings: Vec<Option<String>> = Vec::with_capacity(chunks.len());
    let mut miss_indices: Vec<usize> = Vec::new();
    for (index, chunk) in chunks.iter().enumerate() {
        let content_hash = fingerprint_text(&chunk.content);
        let cached = connection
            .query_row(
                "SELECT embedding_json FROM embedding_cache WHERE model_key = ?1 AND content_hash = ?2",
                rusqlite::params![model_key, content_hash],
                |row| row.get::<_, String>(0),
            )
            .ok();
        match cached {
            Some(json) => embeddings.push(Some(json)),
            None => {
                embeddings.push(None);
                miss_indices.push(index);
            }
        }
    }

    if !miss_indices.is_empty() {
        let miss_chunks: Vec<knowledge_chunker::ChunkSlice> =
            miss_indices.iter().map(|i| chunks[*i].clone()).collect();
        let miss_embeddings = match generate_chunk_embeddings_resilient_async(
            &active_model,
            &provider,
            base_url,
            api_key,
            &miss_chunks,
        )
        .await
        {
            Ok(e) => e,
            Err(err) => {
                eprintln!("{err}");
                vec![None; miss_chunks.len()]
            }
        };
        for (offset, emb) in miss_embeddings.into_iter().enumerate() {
            let target = miss_indices[offset];
            embeddings[target] = emb.clone();
            if let Some(json) = &emb {
                let content_hash = fingerprint_text(&miss_chunks[offset].content);
                let _ = connection.execute(
                    "INSERT OR REPLACE INTO embedding_cache (model_key, content_hash, embedding_json, created_at) VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![model_key, content_hash, json, now_ms()],
                );
            }
        }
    }

    (embeddings, Some(model_key))
}

/// 在 worker 线程上以"当前线程 tokio 运行时 + `block_on`"方式调用异步 embedding，
/// 返回形状与 `generate_chunk_embeddings_safe` 完全一致，下游落库逻辑无需任何改动。
///
/// 这是 P1 "把异步路径接线到 worker" 的最小侵入实现：底层 HTTP 改走 `reqwest`
/// 异步客户端（事件循环驱动，不再占用 `reqwest::blocking` 的线程池），避免长时
/// embedding 请求把 worker 线程钉死。运行时创建失败时自动回退到同步实现，保证不降级。
pub(crate) fn generate_chunk_embeddings_async_blocking(
    connection: &Connection,
    chunks: &[knowledge_chunker::ChunkSlice],
) -> (Vec<Option<String>>, Option<String>) {
    if chunks.is_empty() {
        return (Vec::new(), None);
    }
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(err) => {
            eprintln!("知识库 embedding 异步运行时创建失败，回退同步路径: {err}");
            return generate_chunk_embeddings_safe(connection, chunks);
        }
    };
    rt.block_on(generate_chunk_embeddings_async(connection, chunks))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(content: &str) -> knowledge_chunker::ChunkSlice {
        knowledge_chunker::ChunkSlice {
            content: content.to_string(),
            title: None,
        }
    }

    #[test]
    fn recover_embedding_batch_recovers_partial_responses() {
        let chunks = vec![
            chunk("chunk-0"),
            chunk("chunk-1"),
            chunk("chunk-2"),
            chunk("chunk-3"),
            chunk("chunk-4"),
        ];
        let mut request_embeddings =
            |items: &[knowledge_chunker::ChunkSlice]| -> Result<Vec<Option<String>>, String> {
                let mut values = vec![None; items.len()];
                if let Some(first) = items.first() {
                    values[0] = Some(format!("embed:{}", first.content));
                }
                Ok(values)
            };

        let recovered = recover_embedding_batch(&chunks, "test", &mut request_embeddings);

        assert_eq!(recovered.len(), chunks.len());
        for (index, embedding) in recovered.iter().enumerate() {
            assert_eq!(
                embedding.as_deref(),
                Some(format!("embed:chunk-{index}").as_str())
            );
        }
    }

    #[test]
    fn recover_embedding_batch_recovers_failed_batches() {
        let chunks = vec![
            chunk("chunk-a"),
            chunk("chunk-b"),
            chunk("chunk-c"),
            chunk("chunk-d"),
        ];
        let mut request_embeddings =
            |items: &[knowledge_chunker::ChunkSlice]| -> Result<Vec<Option<String>>, String> {
                if items.len() > 1 {
                    return Err("batch too large".into());
                }
                Ok(vec![Some(format!("embed:{}", items[0].content))])
            };

        let recovered = recover_embedding_batch(&chunks, "test", &mut request_embeddings);

        assert_eq!(recovered.len(), chunks.len());
        assert_eq!(
            recovered,
            vec![
                Some("embed:chunk-a".to_string()),
                Some("embed:chunk-b".to_string()),
                Some("embed:chunk-c".to_string()),
                Some("embed:chunk-d".to_string())
            ]
        );
    }

    #[test]
    fn async_blocking_bridge_returns_early_for_empty_chunks() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        let chunks: Vec<knowledge_chunker::ChunkSlice> = Vec::new();
        let (embeddings, model_key) =
            generate_chunk_embeddings_async_blocking(&connection, &chunks);
        assert!(embeddings.is_empty());
        assert_eq!(model_key, None);
    }

    #[test]
    fn async_blocking_bridge_runs_without_model_config() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        let chunks = vec![chunk("hello"), chunk("world")];
        // 无 embedding 模型配置 → 全部 None，且不触网、不 panic。
        let (embeddings, model_key) =
            generate_chunk_embeddings_async_blocking(&connection, &chunks);
        assert_eq!(embeddings, vec![None, None]);
        assert_eq!(model_key, None);
    }
}
