//! 切分器：复用既有 `knowledge_chunker::split_document_text`，零重写。
//!
//! 这样既拿到既有逻辑（标题推导、受保护单元、重叠窗口等），又通过 trait
//! 暴露出清晰的"切分"扩展点——未来可新增 `HeadingChunker` / `SentenceChunker`
//! 而无需改动这里。

use std::sync::Arc;

use crate::knowledge::contracts::Chunker;
use crate::knowledge_chunker;

pub struct LegacyChunker;

impl Chunker for LegacyChunker {
    fn strategy(&self) -> &'static str {
        "legacy-heuristic"
    }

    fn chunk(
        &self,
        content: &str,
        source_name: &str,
    ) -> Result<Vec<knowledge_chunker::ChunkSlice>, String> {
        let slices = knowledge_chunker::split_document_text(
            content,
            source_name,
            None,
            None,
            knowledge_chunker::DEFAULT_CHUNK_SIZE,
            knowledge_chunker::DEFAULT_CHUNK_OVERLAP,
        );
        Ok(slices)
    }
}

/// 构建默认切分器（注册表 / 编排器入口使用）。
pub fn default_chunker() -> Arc<dyn Chunker> {
    Arc::new(LegacyChunker)
}
