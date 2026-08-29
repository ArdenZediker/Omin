//! 关键词检索器（self-contained）：对 `knowledge_chunks` 做 LIKE 匹配。
//!
//! 真实生产检索仍走 legacy 的 vector + keyword 融合；此实现证明 `Retriever`
//! trait 可被独立实现与替换，是迁移目标形态的占位切片。

use std::sync::Arc;

use rusqlite::Connection;

use crate::knowledge::contracts::{RetrievedChunk, Retriever};

pub struct KeywordRetriever;

impl Retriever for KeywordRetriever {
    fn retrieve(
        &self,
        conn: &Connection,
        collection_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<RetrievedChunk>, String> {
        // 转义 LIKE 通配符，使用 ESCAPE 子句。
        let escaped = query.replace('%', "\\%").replace('_', "\\_");
        let like = format!("%{escaped}%");
        let sql = "SELECT id, document_id, collection_id, title, content \
                   FROM knowledge_chunks \
                   WHERE collection_id = ?1 AND content LIKE ?2 ESCAPE '\\' \
                   ORDER BY rowid DESC LIMIT ?3";
        let mut stmt = conn
            .prepare(sql)
            .map_err(|e| format!("prepare retrieve failed: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params![collection_id, like, limit as i64], |row| {
                let content: String = row.get(4)?;
                let score = if content.contains(query) { 1.0 } else { 0.5 };
                Ok(RetrievedChunk {
                    chunk_id: row.get(0)?,
                    document_id: row.get(1)?,
                    collection_id: row.get(2)?,
                    title: row.get(3)?,
                    content,
                    score,
                })
            })
            .map_err(|e| format!("query retrieve failed: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("row retrieve failed: {e}"))?);
        }
        Ok(out)
    }
}

/// 构建默认检索器（注册表 / 编排器入口使用）。
pub fn default_retriever() -> Arc<dyn Retriever> {
    Arc::new(KeywordRetriever)
}
