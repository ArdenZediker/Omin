//! 仓储：收敛 `knowledge_pipeline` 的公开命令。
//!
//! 新增 / 替换存储行为（如建复合索引、缓存嵌入向量、读写分离）时，
//! 实现新的 `Repository` 即可，命令层无需改动。

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use tauri::AppHandle;

use crate::knowledge::contracts::{PersistChunksInput, Repository};
use crate::knowledge::error::KnowledgeError;

pub struct KnowledgeRepository;

impl Repository for KnowledgeRepository {
    fn import_document(
        &self,
        app: &AppHandle,
        conn: &Connection,
        input: crate::knowledge_pipeline::PipelineImportInput,
    ) -> Result<crate::knowledge_pipeline::PipelineImportResult, String> {
        crate::knowledge_pipeline::create_pipeline_import(app, conn, input)
    }

    fn list_jobs(
        &self,
        conn: &Connection,
        document_id: &str,
    ) -> Result<Vec<crate::knowledge_pipeline::KnowledgeProcessingJobRecord>, String> {
        crate::knowledge_pipeline::list_processing_jobs(conn, Some(document_id.to_string()))
    }

    fn load_status_summary(
        &self,
        conn: &Connection,
        collection_id: &str,
    ) -> Result<crate::knowledge_pipeline::KnowledgeProcessingStatusSummary, String> {
        crate::knowledge_pipeline::load_processing_status_summary(conn, Some(collection_id.to_string()))
    }

    /// 把切片与向量落库（P1-#2）。replace 语义：先删旧 chunk 再插入新 chunk，
    /// 并更新文档 `processing_status` / `chunk_count` / 内容预览。
    fn persist_chunks(&self, conn: &Connection, input: PersistChunksInput) -> Result<(), KnowledgeError> {
        let now = now_ms();
        conn.execute("BEGIN IMMEDIATE", []).map_err(KnowledgeError::from)?;
        let result: Result<(), KnowledgeError> = (|| {
            conn.execute(
                "DELETE FROM knowledge_chunks WHERE document_id = ?1",
                [input.document_id],
            )?;
            let mut stmt = conn.prepare(
                "INSERT INTO knowledge_chunks (\
                    id, document_id, collection_id, chunk_index, title, content, chunk_type, \
                    parent_chunk_id, asset_id, image_info, embedding_json, embedding_model_key, created_at\
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            )?;
            for (index, chunk) in input.chunks.iter().enumerate() {
                let id = uuid::Uuid::new_v4().to_string();
                let embedding = input.embeddings.get(index).cloned().unwrap_or(None);
                stmt.execute(rusqlite::params![
                    id,
                    input.document_id,
                    input.collection_id,
                    index as i64,
                    chunk.title.clone(),
                    chunk.content.as_str(),
                    input.chunk_type,
                    Option::<String>::None,
                    Option::<String>::None,
                    Option::<String>::None,
                    embedding,
                    input.embedding_model_key.map(|s| s.to_string()),
                    now,
                ])?;
            }
            drop(stmt);
            conn.execute(
                "UPDATE knowledge_documents \
                 SET processing_status = 'searchable', chunk_count = ?2, \
                     content = ?4, content_preview = ?5, preview_type = ?6, \
                     content_version = content_version + 1, last_processed_at = ?3, updated_at = ?3 \
                 WHERE id = ?1",
                rusqlite::params![
                    input.document_id,
                    input.chunks.len() as i64,
                    now,
                    input.content,
                    input.content_preview,
                    input.preview_type,
                ],
            )?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                conn.execute("COMMIT", []).map_err(KnowledgeError::from)?;
                Ok(())
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    fn get_cached_embedding(
        &self,
        conn: &Connection,
        model_key: &str,
        content_hash: &str,
    ) -> Result<Option<String>, KnowledgeError> {
        let mut stmt = conn.prepare(
            "SELECT embedding_json FROM embedding_cache WHERE model_key = ?1 AND content_hash = ?2",
        )?;
        let mut rows = stmt.query_map(rusqlite::params![model_key, content_hash], |row| {
            row.get::<_, String>(0)
        })?;
        match rows.next() {
            Some(Ok(json)) => Ok(Some(json)),
            Some(Err(e)) => Err(e.into()),
            None => Ok(None),
        }
    }

    fn put_cached_embedding(
        &self,
        conn: &Connection,
        model_key: &str,
        content_hash: &str,
        embedding_json: &str,
    ) -> Result<(), KnowledgeError> {
        conn.execute(
            "INSERT OR REPLACE INTO embedding_cache (model_key, content_hash, embedding_json, created_at) \
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![model_key, content_hash, embedding_json, now_ms()],
        )?;
        Ok(())
    }
}

/// 当前毫秒时间戳。
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 构建默认仓储（注册表 / 编排器入口使用）。
pub fn default_repository() -> Arc<dyn Repository> {
    Arc::new(KnowledgeRepository)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::contracts::ParseInput;
    use crate::knowledge::orchestrator::PipelineOrchestrator;
    use crate::knowledge_schema::{ensure_embedding_cache_table, ensure_knowledge_indexes};
    use rusqlite::Connection;

    fn seed_schema(conn: &Connection) {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS knowledge_documents (\
                id TEXT PRIMARY KEY, collection_id TEXT, processing_status TEXT, \
                chunk_count INTEGER, content_version INTEGER, last_processed_at INTEGER, \
                updated_at INTEGER, preview_type TEXT, content TEXT, content_preview TEXT)",
            [],
        )
        .unwrap();
        conn.execute(
            "CREATE TABLE IF NOT EXISTS knowledge_chunks (\
                id TEXT, document_id TEXT, collection_id TEXT, chunk_index INTEGER, title TEXT, \
                content TEXT, chunk_type TEXT, parent_chunk_id TEXT, asset_id TEXT, image_info TEXT, \
                embedding_json TEXT, embedding_model_key TEXT, created_at INTEGER)",
            [],
        )
        .unwrap();
        conn.execute(
            "CREATE TABLE IF NOT EXISTS knowledge_document_assets (\
                id TEXT PRIMARY KEY, document_id TEXT, collection_id TEXT, asset_kind TEXT, \
                source_name TEXT, stored_file_path TEXT, mime_type TEXT, file_extension TEXT, \
                preview_type TEXT, thumbnail_data_url TEXT, ocr_text TEXT, caption_text TEXT, \
                content_preview TEXT, page_index INTEGER, asset_index INTEGER, metadata_json TEXT, \
                created_at INTEGER, updated_at INTEGER)",
            [],
        )
        .unwrap();
        ensure_knowledge_indexes(conn).unwrap();
        ensure_embedding_cache_table(conn).unwrap();
    }

    #[test]
    fn embedding_cache_roundtrip() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_embedding_cache_table(&conn).unwrap();
        let repo = KnowledgeRepository;
        assert_eq!(repo.get_cached_embedding(&conn, "m", "h1").unwrap(), None);
        repo.put_cached_embedding(&conn, "m", "h1", "[0.1,0.2]").unwrap();
        assert_eq!(
            repo.get_cached_embedding(&conn, "m", "h1").unwrap(),
            Some("[0.1,0.2]".to_string())
        );
    }

    #[test]
    fn knowledge_indexes_created() {
        let conn = Connection::open_in_memory().unwrap();
        seed_schema(&conn);
        let mut stmt = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_knowledge_chunks_document'",
            )
            .unwrap();
        let exists = stmt.exists([]).unwrap();
        assert!(exists, "idx_knowledge_chunks_document should exist");
    }

    #[tokio::test]
    async fn end_to_end_persist_chunks_without_network() {
        let conn = Connection::open_in_memory().unwrap();
        seed_schema(&conn);
        conn.execute(
            "INSERT INTO knowledge_documents (id, collection_id, processing_status, chunk_count, \
             content_version, last_processed_at, updated_at, preview_type, content, content_preview) \
             VALUES ('doc1', 'col1', 'pending', 0, 0, 0, 0, 'markdown', '# T\n\nbody', 'prev')",
            [],
        )
        .unwrap();

        let orch = PipelineOrchestrator::with_defaults();
        let input = ParseInput {
            source_name: "guide.md".into(),
            file_extension: Some("md".into()),
            mime_type: None,
            preview_type: None,
            bytes: "# Overview\n\nIntro text.\n\n## Setup\n\nSteps here.".as_bytes().to_vec(),
            bridged_content: None,
        };
        let doc = orch.process_text_async(&conn, &input).await.unwrap();
        assert!(
            doc.chunks.len() >= 2,
            "expected >=2 chunks, got {}",
            doc.chunks.len()
        );

        let repo = KnowledgeRepository;
        let persist_input = PersistChunksInput {
            document_id: "doc1",
            collection_id: "col1",
            preview_type: "markdown",
            content: &doc.parsed.content,
            content_preview: &doc.parsed.content,
            chunk_type: "text",
            chunks: &doc.chunks,
            embeddings: &doc.embeddings,
            embedding_model_key: doc.embedding_model_key.as_deref(),
        };
        repo.persist_chunks(&conn, persist_input).unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM knowledge_chunks WHERE document_id = 'doc1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count as usize, doc.chunks.len());

        let status: String = conn
            .query_row(
                "SELECT processing_status FROM knowledge_documents WHERE id = 'doc1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "searchable");
    }
}
