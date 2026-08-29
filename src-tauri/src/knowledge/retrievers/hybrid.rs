//! 混合检索器（P3-#9）：keyword + vector 余弦融合。
//!
//! 真实生产检索仍走 legacy 融合；此实现证明 `Retriever` trait 可被独立实现，
//! 并给出可离线测试的融合逻辑（余弦相似度 + 关键词匹配）。向量侧需要 query 的
//! embedding，由上层用 `Embedder` 对 query 文本向量化后通过 `with_query_embedding`
//! 注入；未注入时优雅降级为纯关键词检索。

use std::collections::HashMap;
use std::sync::Arc;

use rusqlite::Connection;

use crate::knowledge::contracts::{RetrievedChunk, Retriever};

/// 余弦相似度（任一向量为空或长度不等返回 0.0）。
pub fn cosine_similarity(a: &[f64], b: &[f64]) -> f64 {
    if a.is_empty() || b.is_empty() || a.len() != b.len() {
        return 0.0;
    }
    let dot: f64 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let norm_a: f64 = a.iter().map(|x| x * x).sum::<f64>().sqrt();
    let norm_b: f64 = b.iter().map(|x| x * x).sum::<f64>().sqrt();
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a * norm_b)
}

/// 把分数向量线性归一化到 [0,1]。
fn normalize_scores(scores: &mut [f64]) {
    let max = scores.iter().cloned().fold(0.0_f64, f64::max);
    if max > 0.0 {
        for s in scores.iter_mut() {
            *s /= max;
        }
    }
}

pub struct HybridRetriever {
    keyword_weight: f64,
    vector_weight: f64,
    /// 可选注入的 query embedding；生产由上层向量化后注入，否则纯关键词。
    query_embedding: Option<Vec<f64>>,
}

impl HybridRetriever {
    pub fn new(keyword_weight: f64, vector_weight: f64) -> Self {
        Self {
            keyword_weight,
            vector_weight,
            query_embedding: None,
        }
    }

    /// 注入 query embedding（链式）。运行时融合向量召回。
    pub fn with_query_embedding(mut self, embedding: Vec<f64>) -> Self {
        self.query_embedding = Some(embedding);
        self
    }

    /// 关键词侧：LIKE 匹配 + 内容直接包含加权（与 `KeywordRetriever` 一致）。
    fn keyword_scores(
        &self,
        conn: &Connection,
        collection_id: &str,
        query: &str,
    ) -> Result<Vec<(String, String, Option<String>, String, f64)>, String> {
        let escaped = query.replace('%', "\\%").replace('_', "\\_");
        let like = format!("%{escaped}%");
        let sql = "SELECT id, document_id, title, content FROM knowledge_chunks \
                   WHERE collection_id = ?1 AND content LIKE ?2 ESCAPE '\\' \
                   ORDER BY rowid DESC";
        let mut stmt = conn
            .prepare(sql)
            .map_err(|e| format!("prepare hybrid keyword failed: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params![collection_id, like], |row| {
                let id: String = row.get(0)?;
                let document_id: String = row.get(1)?;
                let title: Option<String> = row.get(2)?;
                let content: String = row.get(3)?;
                let score = if content.contains(query) { 1.0 } else { 0.5 };
                Ok((id, document_id, title, content, score))
            })
            .map_err(|e| format!("query hybrid keyword failed: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            let item = r.map_err(|e| format!("row hybrid keyword failed: {e}"))?;
            out.push(item);
        }
        Ok(out)
    }

    /// 向量侧：加载集合内已嵌入 chunk 的 embedding_json，与 query embedding 算余弦。
    fn vector_scores(
        &self,
        conn: &Connection,
        collection_id: &str,
        query_embedding: &[f64],
    ) -> Vec<(String, f64)> {
        let sql = "SELECT id, embedding_json FROM knowledge_chunks \
                   WHERE collection_id = ?1 AND embedding_json IS NOT NULL";
        let mut stmt = match conn.prepare(sql) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = match stmt.query_map(rusqlite::params![collection_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };
        let mut scored: Vec<(String, f64)> = Vec::new();
        for r in rows.flatten() {
            let (id, json) = r;
            let vec: Vec<f64> = match serde_json::from_str::<Vec<f64>>(&json) {
                Ok(v) => v,
                Err(_) => continue,
            };
            scored.push((id, cosine_similarity(query_embedding, &vec)));
        }
        scored
    }

    /// 带 query embedding 的融合检索（核心逻辑，便于离线测试）。
    pub fn retrieve_with_query_embedding(
        &self,
        conn: &Connection,
        collection_id: &str,
        query: &str,
        query_embedding: &[f64],
        limit: usize,
    ) -> Result<Vec<RetrievedChunk>, String> {
        let kw = self.keyword_scores(conn, collection_id, query)?;
        let vec = self.vector_scores(conn, collection_id, query_embedding);

        // 元数据：id -> (document_id, title, content)
        let mut meta: HashMap<String, (String, Option<String>, String)> = HashMap::new();
        for (id, document_id, title, content, _score) in &kw {
            meta.insert(id.clone(), (document_id.clone(), title.clone(), content.clone()));
        }

        let mut kw_norm: Vec<f64> = kw.iter().map(|(_, _, _, _, s)| *s).collect();
        normalize_scores(&mut kw_norm);

        let mut fused: HashMap<String, (f64, String, Option<String>, String)> = HashMap::new();
        for (i, (id, document_id, title, content, _raw)) in kw.iter().enumerate() {
            let kw_s = kw_norm.get(i).copied().unwrap_or(0.0);
            let vec_s = vec
                .iter()
                .find(|(vid, _)| vid == id)
                .map(|(_, s)| *s)
                .unwrap_or(0.0);
            let score = kw_s * self.keyword_weight + vec_s * self.vector_weight;
            fused.insert(
                id.clone(),
                (score, document_id.clone(), title.clone(), content.clone()),
            );
        }
        // 向量侧命中、但关键词侧未覆盖的 chunk 也纳入候选
        for (id, s) in &vec {
            if !fused.contains_key(id) {
                fused.insert(
                    id.clone(),
                    (*s * self.vector_weight, String::new(), None, String::new()),
                );
            }
        }

        let mut ranked: Vec<(String, f64, String, Option<String>, String)> = fused
            .into_iter()
            .map(|(id, (score, document_id, title, content))| {
                (id, score, document_id, title, content)
            })
            .collect();
        ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        ranked.truncate(limit);

        Ok(ranked
            .into_iter()
            .map(|(chunk_id, score, document_id, title, content)| RetrievedChunk {
                chunk_id,
                document_id,
                collection_id: collection_id.to_string(),
                title,
                content,
                score,
            })
            .collect())
    }
}

impl Retriever for HybridRetriever {
    fn retrieve(
        &self,
        conn: &Connection,
        collection_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<RetrievedChunk>, String> {
        match &self.query_embedding {
            Some(q) => self.retrieve_with_query_embedding(conn, collection_id, query, q, limit),
            None => {
                // 纯关键词降级（与 `KeywordRetriever` 行为一致）。
                let kw = self.keyword_scores(conn, collection_id, query)?;
                Ok(kw
                    .into_iter()
                    .map(|(chunk_id, document_id, title, content, score)| RetrievedChunk {
                        chunk_id,
                        document_id,
                        collection_id: collection_id.to_string(),
                        title,
                        content,
                        score,
                    })
                    .take(limit)
                    .collect())
            }
        }
    }
}

/// 构建默认混合检索器（注册表 / 编排器入口使用）。
pub fn default_hybrid_retriever() -> Arc<dyn Retriever> {
    Arc::new(HybridRetriever::new(0.6, 0.4))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn seed(conn: &Connection) {
        conn.execute(
            "CREATE TABLE knowledge_chunks (id TEXT, document_id TEXT, collection_id TEXT, title TEXT, content TEXT, embedding_json TEXT)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO knowledge_chunks (id, document_id, collection_id, title, content, embedding_json) VALUES ('a','d1','c1','Title A','alpha beta','[1.0,0.0,0.0]')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO knowledge_chunks (id, document_id, collection_id, title, content, embedding_json) VALUES ('b','d1','c1','Title B','gamma delta','[0.0,1.0,0.0]')",
            [],
        )
        .unwrap();
    }

    #[test]
    fn cosine_pure_function() {
        assert_eq!(cosine_similarity(&[1.0, 0.0], &[1.0, 0.0]), 1.0);
        assert_eq!(cosine_similarity(&[1.0, 0.0], &[0.0, 1.0]), 0.0);
        assert_eq!(cosine_similarity(&[], &[1.0]), 0.0);
    }

    #[test]
    fn hybrid_fuses_vector_and_keyword() {
        let conn = Connection::open_in_memory().unwrap();
        seed(&conn);
        // query embedding == chunk a 的向量 → a 向量分高；query 文本 "alpha" 也命中 a 关键词。
        let retriever = HybridRetriever::new(0.6, 0.4).with_query_embedding(vec![1.0, 0.0, 0.0]);
        let results = retriever.retrieve(&conn, "c1", "alpha", 10).unwrap();
        assert!(!results.is_empty());
        assert_eq!(results[0].chunk_id, "a");
        let ids: Vec<&str> = results.iter().map(|r| r.chunk_id.as_str()).collect();
        assert!(ids.contains(&"a"));
        assert!(ids.contains(&"b"));
    }
}
