//! 异步向量化器（P1）：委派 `crate::generate_chunk_embeddings_async`，
//! 走 `reqwest` 异步客户端，不在调用线程阻塞——可在 tokio 运行时中并发处理
//! 批量文档，避免 worker 线程被长时 HTTP 卡死。
//!
//! 与 `legacy.rs`（`LegacyEmbedder` 委派同步版）形成对照：同一份 provider 配置
//! 与降级逻辑，只是 HTTP 调用从阻塞改为异步。异步嵌入器是独立类型（非
//! `dyn Embedder`），编排器在异步路径中直接持有它并 `await`。

use std::sync::Arc;

use rusqlite::Connection;

use crate::knowledge_chunker::ChunkSlice;

/// 异步向量化器。
pub struct AsyncEmbedder;

impl AsyncEmbedder {
    /// 异步生成 embedding，不阻塞调用线程。
    pub async fn embed_async(
        &self,
        conn: &Connection,
        chunks: &[ChunkSlice],
    ) -> Result<(Vec<Option<String>>, Option<String>), String> {
        Ok(crate::generate_chunk_embeddings_async(conn, chunks).await)
    }
}

/// 构建异步向量化器。
pub fn default_async_embedder() -> Arc<AsyncEmbedder> {
    Arc::new(AsyncEmbedder)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[tokio::test]
    async fn embed_async_empty_chunks_returns_empty_without_network() {
        // 空 chunks 应直接短路，不发起任何 DB/网络请求。
        let conn = Connection::open_in_memory().unwrap();
        let embedder = AsyncEmbedder;
        let (embeddings, model_key) = embedder.embed_async(&conn, &[]).await.unwrap();
        assert!(embeddings.is_empty());
        assert_eq!(model_key, None);
    }

    #[tokio::test]
    async fn embed_async_degrades_when_no_model_configured() {
        // 内存库无 embedding 模型配置 → 降级为全 None，且不触网。
        let conn = Connection::open_in_memory().unwrap();
        let embedder = AsyncEmbedder;
        let chunks = vec![
            ChunkSlice {
                content: "alpha".into(),
                title: None,
            },
            ChunkSlice {
                content: "beta".into(),
                title: None,
            },
        ];
        let (embeddings, _model_key) = embedder.embed_async(&conn, &chunks).await.unwrap();
        assert_eq!(embeddings.len(), 2);
        assert!(embeddings.iter().all(|e| e.is_none()));
    }
}
