//! 七步流程编排器（strangler-fig 入口）。
//!
//! 目前 `process_text` 走"新架构"的 validate→parse→chunk→embed 切片，
//! 验证 trait 组合可行；持久化与复杂格式仍由 legacy `knowledge_pipeline` 处理。
//! 下一步把 `execute_claimed_job` 的步骤逐步替换为 `PipelineOrchestrator` 的对应方法。

use std::sync::Arc;

use rusqlite::Connection;
use tauri::AppHandle;

use crate::knowledge_chunker;

use super::chunkers::legacy::LegacyChunker;
use super::chunkers::markdown::MarkdownHeadingChunker;
use super::chunkers::router::RouterChunker;
use super::contracts::*;
use super::embedders::async_embed::{AsyncEmbedder, default_async_embedder};
use super::embedders::legacy::LegacyEmbedder;
use super::parsers::text::TextDocumentParser;
use super::repository::KnowledgeRepository;
use super::retrievers::keyword::KeywordRetriever;

/// 持有五个可插拔组件的管线编排器。
#[allow(dead_code)]
pub struct PipelineOrchestrator {
    pub parser: Arc<dyn DocumentParser>,
    pub chunker: Arc<dyn Chunker>,
    pub embedder: Arc<dyn Embedder>,
    pub retriever: Arc<dyn Retriever>,
    pub repository: Arc<dyn Repository>,
    /// 异步向量化器（P1）：嵌入走非阻塞 HTTP，可在 tokio 运行时并发处理。
    pub async_embedder: Arc<AsyncEmbedder>,
}

/// `process_text` 产出的中间产物（尚未落库，待 `Repository::persist_chunks` 迁移）。
#[derive(Debug, Clone)]
pub struct ProcessedDocument {
    pub parsed: ParsedDoc,
    pub chunks: Vec<knowledge_chunker::ChunkSlice>,
    pub embeddings: Vec<Option<String>>,
    pub embedding_model_key: Option<String>,
}

impl PipelineOrchestrator {
    /// 使用默认实现装配编排器。
    ///
    /// 切分策略默认走路由：`.md`/`.markdown` 用 `MarkdownHeadingChunker`（按标题
    /// 切分，更贴合 RAG 语义），其余文档回退到既有 `LegacyChunker`。
    pub fn with_defaults() -> Self {
        let chunker: Arc<dyn Chunker> = Arc::new(RouterChunker::new(
            Arc::new(MarkdownHeadingChunker),
            Arc::new(LegacyChunker),
        ));
        Self {
            parser: Arc::new(TextDocumentParser),
            chunker,
            embedder: Arc::new(LegacyEmbedder),
            retriever: Arc::new(KeywordRetriever),
            repository: Arc::new(KnowledgeRepository),
            async_embedder: default_async_embedder(),
        }
    }

    /// 对纯文本类文档走新架构切片（validate→parse→chunk→embed）。
    ///
    /// 持久化步骤保留给后续 `Repository::persist_chunks`，此处仅产出中间产物，
    /// 便于在不破坏既有行为的前提下验证 trait 组合。
    #[allow(dead_code)]
    pub fn process_text(
        &self,
        _app: &AppHandle,
        conn: &Connection,
        input: &ParseInput,
    ) -> Result<ProcessedDocument, String> {
        // STEP_VALIDATE
        if input.bytes.is_empty() {
            return Err("empty document bytes".into());
        }
        // STEP_PARSE
        let parsed = self.parser.parse(input)?;
        // STEP_CHUNK
        let chunks = self.chunker.chunk(&parsed.content, &input.source_name)?;
        // STEP_EMBED
        let (embeddings, embedding_model_key) = self.embedder.embed(conn, &chunks)?;
        Ok(ProcessedDocument {
            parsed,
            chunks,
            embeddings,
            embedding_model_key,
        })
    }

    /// 异步版管线（P1）：在"新架构"上跑 validate→parse→chunk→embed，
    /// 但 embedding 走 `AsyncEmbedder`（非阻塞 HTTP），可在 tokio 运行时并发处理，
    /// 避免 worker 线程被长时 embedding 请求卡死。
    #[allow(dead_code)]
    pub async fn process_text_async(
        &self,
        conn: &Connection,
        input: &ParseInput,
    ) -> Result<ProcessedDocument, String> {
        if input.bytes.is_empty() {
            return Err("empty document bytes".into());
        }
        let parsed = self.parser.parse(input)?;
        let chunks = self.chunker.chunk(&parsed.content, &input.source_name)?;
        let (embeddings, embedding_model_key) =
            self.async_embedder.embed_async(conn, &chunks).await?;
        Ok(ProcessedDocument {
            parsed,
            chunks,
            embeddings,
            embedding_model_key,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::contracts::ParseInput;
    use rusqlite::Connection;

    #[tokio::test]
    async fn process_text_async_runs_full_pipeline_without_network() {
        let orch = PipelineOrchestrator::with_defaults();
        let conn = Connection::open_in_memory().unwrap();
        let input = ParseInput {
            source_name: "guide.md".into(),
            file_extension: Some("md".into()),
            mime_type: None,
            preview_type: None,
            bytes: "# Overview\n\nIntro text.\n\n## Setup\n\nSteps here.".as_bytes().to_vec(),
            bridged_content: None,
        };
        let doc = orch.process_text_async(&conn, &input).await.unwrap();
        // 标题切分：Overview + Setup 两个小节，至少 2 个 chunk。
        assert!(
            doc.chunks.len() >= 2,
            "expected >=2 chunks, got {}",
            doc.chunks.len()
        );
        // 无 embedding 模型配置 → 全部 None，且 model_key 为 None（不触网）。
        assert!(doc.embeddings.iter().all(|e| e.is_none()));
        assert_eq!(doc.embedding_model_key, None);
    }

    #[tokio::test]
    async fn process_text_async_rejects_empty_bytes() {
        let orch = PipelineOrchestrator::with_defaults();
        let conn = Connection::open_in_memory().unwrap();
        let input = ParseInput {
            source_name: "empty.md".into(),
            file_extension: Some("md".into()),
            mime_type: None,
            preview_type: None,
            bytes: Vec::new(),
            bridged_content: None,
        };
        assert!(orch.process_text_async(&conn, &input).await.is_err());
    }
}
