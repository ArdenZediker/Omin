//! 知识库管线的可插拔契约（trait）。
//!
//! 这是 P0 重构的核心。把"解析 / 切分 / 嵌入 / 检索 / 存储"五个关注点抽象成
//! trait，使扩展点清晰、可测试、可替换，而无需触碰核心管线。
//!
//! 注意：`ChunkSlice` 与 `PipelineImportInput` 等类型直接复用既有模块
//! （`knowledge_chunker` / `knowledge_pipeline`），避免重复定义数据结构。

use rusqlite::Connection;

use crate::knowledge::error::KnowledgeError;

/// 七步流程步名常量，与 legacy `execute_claimed_job` 对齐。
pub const STEP_VALIDATE: &str = "validate";
pub const STEP_PARSE: &str = "parse";
pub const STEP_EXTRACT_ASSETS: &str = "extract_assets";
pub const STEP_CHUNK: &str = "chunk";
pub const STEP_EMBED: &str = "embed";
pub const STEP_INDEX: &str = "index";
pub const STEP_FINALIZE: &str = "finalize";

/// 解析阶段输入。
#[derive(Debug, Clone)]
pub struct ParseInput {
    pub source_name: String,
    pub file_extension: Option<String>,
    pub mime_type: Option<String>,
    pub preview_type: Option<String>,
    pub bytes: Vec<u8>,
    /// 前端已桥接的文本内容（pdf/docx 等复杂格式由前端抽取后回传）。
    pub bridged_content: Option<String>,
}

/// 解析阶段产物（对齐 legacy 私有 `ParsedDocument`）。
#[derive(Debug, Clone)]
pub struct ParsedDoc {
    pub content: String,
    pub preview_type: String,
    pub metadata_json: Option<String>,
}

/// 检索命中的片段。
#[derive(Debug, Clone)]
pub struct RetrievedChunk {
    pub chunk_id: String,
    pub document_id: String,
    pub collection_id: String,
    pub title: Option<String>,
    pub content: String,
    /// 0~1 相关性分数（keyword 检索时为朴素匹配度）。
    pub score: f64,
}

/// 落库输入（对齐 legacy chunk 落库所需的字段，P1-#2 / P3-#8）。
#[derive(Debug, Clone)]
pub struct PersistChunksInput<'a> {
    pub document_id: &'a str,
    pub collection_id: &'a str,
    pub preview_type: &'a str,
    pub content: &'a str,
    pub content_preview: &'a str,
    pub chunk_type: &'a str,
    pub chunks: &'a [crate::knowledge_chunker::ChunkSlice],
    pub embeddings: &'a [Option<String>],
    pub embedding_model_key: Option<&'a str>,
}

/// 文档解析器：把原始字节转换为纯文本 + 预览类型。
pub trait DocumentParser: Send + Sync {
    /// 支持的扩展名（小写、不含点），用于注册表路由。
    fn supported_extensions(&self) -> &'static [&'static str];
    fn parse(&self, input: &ParseInput) -> Result<ParsedDoc, String>;
}

/// 文本切分器：把一篇文档切成若干 `ChunkSlice`。
pub trait Chunker: Send + Sync {
    /// 切分策略名（用于配置与日志）。
    fn strategy(&self) -> &'static str;
    fn chunk(
        &self,
        content: &str,
        source_name: &str,
    ) -> Result<Vec<crate::knowledge_chunker::ChunkSlice>, String>;
}

/// 向量化器：把切片批量转为 embedding，复用既有 provider 配置与降级逻辑。
pub trait Embedder: Send + Sync {
    /// 返回 `(每片 embedding JSON 或 None, embedding model key)`，
    /// 签名与 `crate::generate_chunk_embeddings_safe` 对齐。
    fn embed(
        &self,
        conn: &Connection,
        chunks: &[crate::knowledge_chunker::ChunkSlice],
    ) -> Result<(Vec<Option<String>>, Option<String>), String>;
}

/// 检索器：按 query 从集合中召回片段。
pub trait Retriever: Send + Sync {
    fn retrieve(
        &self,
        conn: &Connection,
        collection_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<RetrievedChunk>, String>;
}

/// 持久化仓储：收敛 `knowledge_pipeline` 的公开命令，
/// 便于建复合索引 / 缓存嵌入向量 / 替换测试替身。
pub trait Repository: Send + Sync {
    fn import_document(
        &self,
        app: &tauri::AppHandle,
        conn: &Connection,
        input: crate::knowledge_pipeline::PipelineImportInput,
    ) -> Result<crate::knowledge_pipeline::PipelineImportResult, String>;

    fn list_jobs(
        &self,
        conn: &Connection,
        document_id: &str,
    ) -> Result<Vec<crate::knowledge_pipeline::KnowledgeProcessingJobRecord>, String>;

    fn load_status_summary(
        &self,
        conn: &Connection,
        collection_id: &str,
    ) -> Result<crate::knowledge_pipeline::KnowledgeProcessingStatusSummary, String>;

    /// 把切片与向量落库（P1-#2）。replace 语义：先删旧 chunk 再插入新 chunk，
    /// 并更新文档 `processing_status` / `chunk_count` / 内容预览。
    fn persist_chunks(&self, conn: &Connection, input: PersistChunksInput)
        -> Result<(), KnowledgeError>;

    /// 向量缓存读取（P3-#8）。命中返回 embedding JSON，未命中返回 `Ok(None)`。
    fn get_cached_embedding(
        &self,
        conn: &Connection,
        model_key: &str,
        content_hash: &str,
    ) -> Result<Option<String>, KnowledgeError>;

    /// 向量缓存写入（P3-#8）。
    fn put_cached_embedding(
        &self,
        conn: &Connection,
        model_key: &str,
        content_hash: &str,
        embedding_json: &str,
    ) -> Result<(), KnowledgeError>;
}
