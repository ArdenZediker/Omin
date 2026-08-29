//! 向量化器：直接委派给既有 `crate::generate_chunk_embeddings_safe`。
//!
//! 因此天然继承现有的 provider 配置、批量调用与降级策略
//! （无 API key 时返回 `None` 向量，全链路降级而非阻断）。

use std::sync::Arc;

use rusqlite::Connection;

use crate::knowledge::contracts::Embedder;
use crate::knowledge_chunker;

pub struct LegacyEmbedder;

impl Embedder for LegacyEmbedder {
    fn embed(
        &self,
        conn: &Connection,
        chunks: &[knowledge_chunker::ChunkSlice],
    ) -> Result<(Vec<Option<String>>, Option<String>), String> {
        // 直接复用既有实现，签名一致（返回非 Result，此处包成 Ok）。
        Ok(crate::generate_chunk_embeddings_safe(conn, chunks))
    }
}

/// 构建默认向量化器（注册表 / 编排器入口使用）。
pub fn default_embedder() -> Arc<dyn Embedder> {
    Arc::new(LegacyEmbedder)
}
