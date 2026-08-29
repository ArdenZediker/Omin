//! 知识库统一错误类型（P3-#17，增量引入）。
//!
//! 当前仅在“新架构”的落库路径（`Repository::persist_chunks` 及向量缓存方法）
//! 使用；legacy 路径仍保持 `Result<T, String>`，避免一次性大规模改动带来的风险。
//! 后续可逐步把各 trait 的错误统一到本类型。
//!
//! 注：未引入 `thiserror` 等新依赖——手动实现 `Display` / `Error`，保持依赖面不变。

use std::fmt;

/// 知识库错误：区分数据库、资源不存在、输入非法与向量化四类，便于调用方精细化处理。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KnowledgeError {
    Db(String),
    NotFound(String),
    InvalidInput(String),
    Embedding(String),
}

impl fmt::Display for KnowledgeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KnowledgeError::Db(m) => write!(f, "知识库数据库错误: {m}"),
            KnowledgeError::NotFound(m) => write!(f, "知识库资源不存在: {m}"),
            KnowledgeError::InvalidInput(m) => write!(f, "知识库输入非法: {m}"),
            KnowledgeError::Embedding(m) => write!(f, "知识库向量化错误: {m}"),
        }
    }
}

impl std::error::Error for KnowledgeError {}

impl From<rusqlite::Error> for KnowledgeError {
    fn from(err: rusqlite::Error) -> Self {
        KnowledgeError::Db(err.to_string())
    }
}

impl From<String> for KnowledgeError {
    fn from(err: String) -> Self {
        KnowledgeError::Db(err)
    }
}

impl From<&str> for KnowledgeError {
    fn from(err: &str) -> Self {
        KnowledgeError::Db(err.to_string())
    }
}
