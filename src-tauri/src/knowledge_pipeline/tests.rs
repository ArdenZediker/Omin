//! knowledge_pipeline 单元测试（由单文件拆分而来，断言与用例未改动）。

use super::*;
// 拆分前 `Connection` 由父模块顶部的私有 use 提供；父模块现在只做重导出，故显式引入。
use rusqlite::{params, Connection};

fn new_test_connection() -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch(
            r#"
                CREATE TABLE IF NOT EXISTS knowledge_collections (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  description TEXT NOT NULL,
                  retrieval_mode TEXT NOT NULL DEFAULT 'hybrid',
                  embedding_profile_id TEXT,
                  multimodal_config_json TEXT,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS app_kv (
                  key TEXT PRIMARY KEY,
                  value TEXT NOT NULL,
                  updated_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS knowledge_documents (
                  id TEXT PRIMARY KEY,
                  collection_id TEXT NOT NULL,
                  source_name TEXT NOT NULL,
                  source_path TEXT,
                  stored_file_path TEXT,
                  mime_type TEXT,
                  file_extension TEXT,
                  preview_type TEXT,
                  content TEXT,
                  content_preview TEXT NOT NULL,
                  thumbnail_data_url TEXT,
                  file_hash TEXT,
                  file_size INTEGER,
                  processing_status TEXT NOT NULL DEFAULT 'searchable',
                  error_message TEXT,
                  active_job_id TEXT,
                  content_version INTEGER NOT NULL DEFAULT 1,
                  parser_profile_id TEXT,
                  last_processed_at INTEGER,
                  chunk_count INTEGER NOT NULL,
                  tags_json TEXT NOT NULL,
                  favorite INTEGER NOT NULL DEFAULT 0,
                  access_count INTEGER NOT NULL DEFAULT 0,
                  last_accessed_at INTEGER,
                  title_hierarchy TEXT,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS knowledge_chunks (
                  id TEXT PRIMARY KEY,
                  document_id TEXT NOT NULL,
                  collection_id TEXT NOT NULL,
                  chunk_index INTEGER NOT NULL,
                  title TEXT,
                  content TEXT NOT NULL,
                  embedding_json TEXT,
                  embedding_model_key TEXT,
                  created_at INTEGER NOT NULL,
                  UNIQUE(document_id, chunk_index)
                );
                "#,
        )
        .unwrap();
    ensure_pipeline_schema(&connection).unwrap();
    crate::ensure_knowledge_schema(&connection).unwrap();
    connection
}

fn seed_collection_and_document(connection: &Connection) -> (String, String) {
    let now = current_timestamp_ms();
    let collection_id = "col-test".to_string();
    let document_id = "doc-test".to_string();
    connection
        .execute(
            r#"
                INSERT INTO knowledge_collections (
                  id, name, description, retrieval_mode, embedding_profile_id, created_at, updated_at
                ) VALUES (?1, ?2, ?3, 'hybrid', NULL, ?4, ?5)
                "#,
            params![collection_id, "测试库", "测试用", now, now],
        )
        .unwrap();
    connection
        .execute(
            r#"
                INSERT INTO knowledge_documents (
                  id, collection_id, source_name, source_path, stored_file_path, mime_type, file_extension,
                  preview_type, content, content_preview, chunk_count, tags_json, favorite, access_count,
                  last_accessed_at, title_hierarchy, created_at, updated_at
                ) VALUES (?1, ?2, ?3, NULL, NULL, NULL, 'txt', 'text', 'hello', 'hello', 0, '[]', 0, 0, NULL, NULL, ?4, ?5)
                "#,
            params![document_id, collection_id, "smoke.txt", now, now],
        )
        .unwrap();
    (collection_id, document_id)
}

fn set_collection_multimodal_config(
    connection: &Connection,
    collection_id: &str,
    config_json: &str,
) {
    connection
        .execute(
            "UPDATE knowledge_collections SET multimodal_config_json = ?2 WHERE id = ?1",
            params![collection_id, config_json],
        )
        .unwrap();
}

fn set_global_multimodal_config(connection: &Connection, config_json: &str) {
    connection
        .execute(
            r#"
                INSERT INTO app_kv (key, value, updated_at)
                VALUES ('omni_knowledge_multimodal_profile', ?1, ?2)
                ON CONFLICT(key) DO UPDATE SET
                  value = excluded.value,
                  updated_at = excluded.updated_at
                "#,
            params![config_json, current_timestamp_ms()],
        )
        .unwrap();
}

#[test]
fn csv_to_markdown_pads_and_escapes_cells() {
    let markdown = csv_to_markdown("name,value\nalpha,1\npipe,a|b", ',');

    assert_eq!(
        markdown,
        "| name | value |\n| --- | --- |\n| alpha | 1 |\n| pipe | a\\|b |\n"
    );
}

#[test]
fn parse_markdown_keeps_markdown_preview() {
    let parsed =
        parse_simple_document("notes.md", Some("md"), None, None, b"# Title\nBody", None)
            .unwrap();

    assert_eq!(parsed.content, "# Title\nBody");
    assert_eq!(parsed.preview_type, "markdown");
    assert!(parsed.metadata_json.is_none());
}

#[test]
fn parse_csv_converts_to_markdown_table() {
    let parsed =
        parse_simple_document("data.csv", Some(".csv"), None, None, b"a,b\n1,2", None).unwrap();

    assert_eq!(parsed.preview_type, "markdown");
    assert!(parsed.content.contains("| a | b |"));
    assert!(parsed.content.contains("| 1 | 2 |"));
}

#[test]
fn parse_pdf_uses_frontend_bridge_content() {
    let parsed = parse_simple_document(
        "report.pdf",
        Some("pdf"),
        None,
        None,
        b"%PDF",
        Some("Extracted text"),
    )
    .unwrap();

    assert_eq!(parsed.preview_type, "pdf");
    assert_eq!(parsed.content, "Extracted text");
    assert_eq!(
        parsed.metadata_json.as_deref(),
        Some("{\"mode\":\"frontend_bridge\"}")
    );
}

#[test]
fn parse_docx_strips_markdown_data_images() {
    let parsed = parse_simple_document(
        "report.docx",
        Some("docx"),
        None,
        None,
        b"PK",
        Some("标题\n\n![](data:image/png;base64,AAAA)\n\n正文"),
    )
    .unwrap();

    assert_eq!(parsed.preview_type, "docx");
    assert_eq!(parsed.content, "标题\n正文");
}

#[test]
fn parse_image_uses_placeholder() {
    let parsed = parse_simple_document(
        "photo.png",
        Some("png"),
        Some("image/png"),
        None,
        &[1, 2, 3],
        None,
    )
    .unwrap();

    assert_eq!(parsed.preview_type, "image");
    assert!(parsed.content.contains("图片文件"));
    assert!(parsed.content.contains("photo.png"));
    assert_eq!(
        parsed.metadata_json.as_deref(),
        Some("{\"mode\":\"store_with_placeholder\"}")
    );
}

#[test]
fn parse_audio_uses_placeholder() {
    let parsed = parse_simple_document(
        "meeting.mp3",
        Some("mp3"),
        Some("audio/mpeg"),
        None,
        &[1, 2, 3],
        None,
    )
    .unwrap();

    assert_eq!(parsed.preview_type, "audio");
    assert!(parsed.content.contains("音频文件"));
    assert!(parsed.content.contains("meeting.mp3"));
    assert_eq!(
        parsed.metadata_json.as_deref(),
        Some("{\"mode\":\"store_with_placeholder\"}")
    );
}

#[test]
fn parse_unknown_extension_is_unsupported() {
    let err = parse_simple_document("archive.zip", Some("zip"), None, None, &[1, 2, 3], None)
        .unwrap_err();

    assert!(err.contains(".zip"));
}

#[test]
fn merge_multimodal_content_appends_separator() {
    let merged = merge_multimodal_content("正文", "图片摘要");

    assert!(merged.contains("--- 多模态分析 ---"));
    assert!(merged.contains("图片摘要"));
}

#[test]
fn format_audio_enrichment_keeps_transcript_and_summary() {
    let text = format_audio_enrichment(
        "call.mp3",
        Some("audio/mpeg"),
        Some("你好，世界"),
        Some("简短摘要"),
        true,
    );

    assert!(text.contains("音频转写："));
    assert!(text.contains("你好，世界"));
    assert!(text.contains("音频摘要："));
    assert!(text.contains("简短摘要"));
}

#[test]
fn ensure_knowledge_schema_adds_embedded_image_columns() {
    let connection = new_test_connection();

    crate::ensure_knowledge_schema(&connection).unwrap();

    assert!(crate::table_has_column(&connection, "knowledge_chunks", "chunk_type").unwrap());
    assert!(
        crate::table_has_column(&connection, "knowledge_chunks", "parent_chunk_id").unwrap()
    );
    assert!(crate::table_has_column(&connection, "knowledge_chunks", "asset_id").unwrap());
    assert!(crate::table_has_column(&connection, "knowledge_chunks", "image_info").unwrap());
    assert!(crate::table_has_column(&connection, "knowledge_document_assets", "id").unwrap());
    assert!(
        crate::table_has_column(&connection, "knowledge_document_assets", "ocr_text").unwrap()
    );
    assert!(
        crate::table_has_column(&connection, "knowledge_document_assets", "caption_text")
            .unwrap()
    );
}

#[test]
fn build_embedded_image_child_chunks_attaches_to_text_chunks() {
    let parsed = ParsedDocument {
        content: "Overview\n\nSystem diagram anchor\n\nDetails".to_string(),
        preview_type: "docx".to_string(),
        metadata_json: None,
    };
    let text_chunks = split_parsed_document_into_chunks(&parsed, "report.docx", Some("docx"));
    let now = current_timestamp_ms();
    let assets = vec![PersistedEmbeddedImageAsset {
        asset_id: "asset-1".to_string(),
        source_name: "image1.png".to_string(),
        stored_file_path: "C:/tmp/image1.png".to_string(),
        mime_type: Some("image/png".to_string()),
        file_extension: Some("png".to_string()),
        page_index: None,
        asset_index: 0,
        anchor_text: Some("System diagram anchor".to_string()),
        ocr_text: Some("database connection string".to_string()),
        caption_text: Some("architecture overview".to_string()),
        thumbnail_data_url: None,
    }];

    let output = build_embedded_image_assets_and_chunks(
        &text_chunks,
        &assets,
        "doc-test",
        "col-test",
        now,
    );

    assert_eq!(output.assets.len(), 1);
    assert_eq!(output.child_chunks.len(), 2);
    assert!(output
        .child_chunks
        .iter()
        .all(|chunk| chunk.parent_chunk_index < output.text_chunks.len()));
    assert!(output
        .child_chunks
        .iter()
        .any(|chunk| chunk.chunk_type == "image_ocr"));
    assert!(output
        .child_chunks
        .iter()
        .any(|chunk| chunk.chunk_type == "image_caption"));
}

#[test]
fn search_knowledge_chunks_rolls_child_hits_back_to_parent() {
    let connection = new_test_connection();
    let (collection_id, document_id) = seed_collection_and_document(&connection);
    let now = current_timestamp_ms();

    connection
        .execute(
            "DELETE FROM knowledge_chunks WHERE document_id = ?1",
            params![document_id],
        )
        .unwrap();

    connection
        .execute(
            r#"
                INSERT INTO knowledge_chunks (
                  id, document_id, collection_id, chunk_index, title, content, chunk_type, parent_chunk_id,
                  asset_id, image_info, embedding_json, embedding_model_key, created_at
                ) VALUES (?1, ?2, ?3, 0, 'Parent', 'Parent section describing the system.', 'text', NULL, NULL, NULL, NULL, NULL, ?4)
                "#,
            params!["text-1", document_id, collection_id, now],
        )
        .unwrap();
    connection
        .execute(
            r#"
                INSERT INTO knowledge_chunks (
                  id, document_id, collection_id, chunk_index, title, content, chunk_type, parent_chunk_id,
                  asset_id, image_info, embedding_json, embedding_model_key, created_at
                ) VALUES (?1, ?2, ?3, 1, 'Image OCR', 'database connection string inside image', 'image_ocr', 'text-1', 'asset-1', '{"assetId":"asset-1","sourceName":"diagram.png","ocrText":"database connection string"}', NULL, NULL, ?4)
                "#,
            params!["ocr-1", document_id, collection_id, now],
        )
        .unwrap();
    connection
        .execute(
            r#"
                INSERT INTO knowledge_document_assets (
                  id, document_id, collection_id, asset_kind, source_name, stored_file_path, mime_type, file_extension,
                  preview_type, thumbnail_data_url, ocr_text, caption_text, content_preview, page_index, asset_index,
                  metadata_json, created_at, updated_at
                ) VALUES (?1, ?2, ?3, 'embedded_image', 'diagram.png', 'C:/tmp/diagram.png', 'image/png', 'png', 'image', NULL, 'database connection string', NULL, 'diagram', NULL, 0, NULL, ?4, ?4)
                "#,
            params!["asset-1", document_id, collection_id, now],
        )
        .unwrap();

    let results = crate::search_knowledge_chunks(
        &connection,
        crate::SearchKnowledgeChunksInput {
            query: "database connection".to_string(),
            limit: Some(5),
            collection_id: Some(collection_id),
            query_embedding: None,
            query_embedding_model_key: None,
        },
    )
    .unwrap();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].chunk.id, "text-1");
    assert_eq!(
        results[0]
            .display_chunk
            .as_ref()
            .map(|chunk| chunk.id.as_str()),
        Some("text-1")
    );
    assert_eq!(
        results[0]
            .matched_chunk
            .as_ref()
            .map(|chunk| chunk.id.as_str()),
        Some("ocr-1")
    );
    assert_eq!(results[0].matched_chunk_type.as_deref(), Some("image_ocr"));
    assert_eq!(
        results[0]
            .matched_asset
            .as_ref()
            .map(|asset| asset.id.as_str()),
        Some("asset-1")
    );
}

#[test]
fn search_knowledge_chunks_does_not_return_unrelated_title_only_candidates() {
    let connection = new_test_connection();
    let (collection_id, document_id) = seed_collection_and_document(&connection);
    let now = current_timestamp_ms();

    connection
        .execute(
            "DELETE FROM knowledge_chunks WHERE document_id = ?1",
            params![document_id],
        )
        .unwrap();
    connection
        .execute(
            r#"
                INSERT INTO knowledge_chunks (
                  id, document_id, collection_id, chunk_index, title, content, chunk_type, parent_chunk_id,
                  asset_id, image_info, embedding_json, embedding_model_key, created_at
                ) VALUES (?1, ?2, ?3, 0, 'AQS overview', 'AbstractQueuedSynchronizer coordinates locks and synchronizers.', 'text', NULL, NULL, NULL, NULL, NULL, ?4)
                "#,
            params!["aqs-1", document_id, collection_id, now],
        )
        .unwrap();

    let results = crate::search_knowledge_chunks(
        &connection,
        crate::SearchKnowledgeChunksInput {
            query: "比较并替换是什么".to_string(),
            limit: Some(5),
            collection_id: Some(collection_id),
            query_embedding: None,
            query_embedding_model_key: None,
        },
    )
    .unwrap();

    assert!(results.is_empty());
}

#[test]
fn resolve_preview_types_uses_audio_video_inference_for_upload_guard() {
    let (audio_preview_type, audio_guard_preview_type) =
        resolve_preview_types(None, Some("mp3"), None);
    assert_eq!(audio_preview_type, "audio");
    assert_eq!(audio_guard_preview_type, "audio");

    let (video_preview_type, video_guard_preview_type) =
        resolve_preview_types(None, None, Some("video/mp4"));
    assert_eq!(video_preview_type, "video");
    assert_eq!(video_guard_preview_type, "video");
}

#[test]
fn resolve_preview_types_keeps_explicit_type_when_inference_is_unsupported() {
    let (preview_type, upload_guard_preview_type) =
        resolve_preview_types(Some("video"), Some("bin"), None);

    assert_eq!(preview_type, "video");
    assert_eq!(upload_guard_preview_type, "video");
}

#[test]
fn validate_multimodal_upload_rejects_image_without_collection_enablement() {
    let connection = new_test_connection();
    let (collection_id, _) = seed_collection_and_document(&connection);

    let err = crate::validate_knowledge_multimodal_upload(&connection, &collection_id, "image")
        .unwrap_err();

    assert!(!err.trim().is_empty());
}

#[test]
fn validate_multimodal_upload_accepts_ready_audio_model() {
    let connection = new_test_connection();
    let (collection_id, _) = seed_collection_and_document(&connection);
    set_collection_multimodal_config(
        &connection,
        &collection_id,
        &serde_json::json!({
            "enabled": true,
            "mergeMode": "append",
            "image": {
                "enabled": false,
                "modelId": null,
                "extractText": true,
                "generateSummary": true
            },
            "audio": {
                "enabled": true,
                "modelId": "audio:test",
                "keepTranscript": true,
                "generateSummary": true
            }
        })
        .to_string(),
    );
    set_global_multimodal_config(
        &connection,
        &serde_json::json!({
            "enabled": true,
            "activeImageModelId": null,
            "activeAudioModelId": "audio:test",
            "models": [{
                "id": "audio:test",
                "name": "Audio Test",
                "capability": "audio",
                "provider": "openai",
                "baseUrl": "https://api.openai.com/v1",
                "model": "gpt-4o-mini-transcribe",
                "apiKey": "test-key"
            }]
        })
        .to_string(),
    );

    crate::validate_knowledge_multimodal_upload(&connection, &collection_id, "audio").unwrap();
}

#[test]
fn validate_multimodal_upload_rejects_video_even_without_config_lookup() {
    let connection = new_test_connection();

    let err = crate::validate_knowledge_multimodal_upload(&connection, "missing", "video")
        .unwrap_err();

    assert!(!err.trim().is_empty());
}

#[test]
fn dead_letter_flow_failed_then_replayed() {
    let connection = new_test_connection();
    let (collection_id, document_id) = seed_collection_and_document(&connection);
    let now = current_timestamp_ms();

    let job = insert_job_record(
        &connection,
        &document_id,
        &collection_id,
        "initial_import",
        0,
        3,
        DEFAULT_JOB_PRIORITY,
        0,
        None,
        None,
        now,
    )
    .unwrap();
    let claim = PipelineJobClaim {
        id: job.id.clone(),
        document_id: document_id.clone(),
        collection_id: collection_id.clone(),
    };
    fail_job(&connection, &claim, Some("parse"), "smoke failure", 0).unwrap();

    let failed_job = load_job_record(&connection, &job.id).unwrap();
    assert_eq!(failed_job.status, JOB_STATUS_FAILED);

    let failed_result = list_dead_letters(
        &connection,
        DeadLetterQueryInput {
            collection_id: Some(collection_id.clone()),
            status: Some("failed".to_string()),
            limit: Some(10),
            offset: Some(0),
        },
    )
    .unwrap();
    assert_eq!(failed_result.total, 1);
    assert_eq!(failed_result.items.len(), 1);
    assert_eq!(failed_result.items[0].status, JOB_STATUS_FAILED);

    let replay_result = replay_dead_letters(
        &connection,
        ReplayDeadLettersInput {
            collection_id: Some(collection_id.clone()),
            status: Some("failed".to_string()),
            limit: Some(10),
        },
    )
    .unwrap();
    assert_eq!(replay_result.attempted, 1);
    assert_eq!(replay_result.replayed, 1);
    assert_eq!(replay_result.skipped, 0);

    let replayed_result = list_dead_letters(
        &connection,
        DeadLetterQueryInput {
            collection_id: Some(collection_id.clone()),
            status: Some("replayed".to_string()),
            limit: Some(10),
            offset: Some(0),
        },
    )
    .unwrap();
    assert_eq!(replayed_result.total, 1);
    assert_eq!(replayed_result.items.len(), 1);
    assert_eq!(replayed_result.items[0].status, "replayed");
    assert!(replayed_result.items[0].replayed_job_id.is_some());

    let queued_jobs: i64 = connection
        .query_row(
            "SELECT COUNT(1) FROM knowledge_processing_jobs WHERE status = ?1 AND collection_id = ?2",
            params![JOB_STATUS_QUEUED, collection_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(queued_jobs, 1);

    let current_document_status: String = connection
        .query_row(
            "SELECT processing_status FROM knowledge_documents WHERE id = ?1",
            params![document_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(current_document_status, DOCUMENT_STATUS_PENDING);
}

#[test]
fn dead_letter_replay_status_filter_blocks_replayed_items() {
    let connection = new_test_connection();
    let (collection_id, document_id) = seed_collection_and_document(&connection);
    let now = current_timestamp_ms();

    let job = insert_job_record(
        &connection,
        &document_id,
        &collection_id,
        "initial_import",
        0,
        3,
        DEFAULT_JOB_PRIORITY,
        0,
        None,
        None,
        now,
    )
    .unwrap();
    let claim = PipelineJobClaim {
        id: job.id.clone(),
        document_id: document_id.clone(),
        collection_id: collection_id.clone(),
    };
    fail_job(&connection, &claim, Some("parse"), "smoke failure", 0).unwrap();

    let first_replay = replay_dead_letters(
        &connection,
        ReplayDeadLettersInput {
            collection_id: Some(collection_id.clone()),
            status: Some("failed".to_string()),
            limit: Some(10),
        },
    )
    .unwrap();
    assert_eq!(first_replay.attempted, 1);
    assert_eq!(first_replay.replayed, 1);

    let second_replay = replay_dead_letters(
        &connection,
        ReplayDeadLettersInput {
            collection_id: Some(collection_id.clone()),
            status: Some("replayed".to_string()),
            limit: Some(10),
        },
    )
    .unwrap();
    assert_eq!(second_replay.attempted, 1);
    assert_eq!(second_replay.replayed, 0);
    assert_eq!(second_replay.skipped, 1);
}
