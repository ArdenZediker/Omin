//! 数据库行 -> 记录结构体的读取，以及任务/步骤行的写入。
//!
//! 由 knowledge_pipeline 单文件拆分而来，保持逻辑不变。

use rusqlite::{params, Connection, OptionalExtension};

use super::*;

pub(crate) fn read_job_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<KnowledgeProcessingJobRecord> {
    Ok(KnowledgeProcessingJobRecord {
        id: row.get(0)?,
        document_id: row.get(1)?,
        collection_id: row.get(2)?,
        job_type: row.get(3)?,
        status: row.get(4)?,
        current_step: row.get(5)?,
        progress: row.get(6)?,
        attempt: row.get(7)?,
        max_attempts: row.get(8)?,
        priority: row.get(9)?,
        fail_count: row.get(10)?,
        next_run_at: row.get(11)?,
        source_job_id: row.get(12)?,
        cancel_requested: row.get(13)?,
        pause_requested: row.get(14)?,
        error_message: row.get(15)?,
        created_at: row.get(16)?,
        started_at: row.get(17)?,
        finished_at: row.get(18)?,
        updated_at: row.get(19)?,
    })
}

pub(crate) fn read_step_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<KnowledgeProcessingStepRecord> {
    Ok(KnowledgeProcessingStepRecord {
        id: row.get(0)?,
        job_id: row.get(1)?,
        document_id: row.get(2)?,
        step_name: row.get(3)?,
        status: row.get(4)?,
        progress: row.get(5)?,
        error_message: row.get(6)?,
        started_at: row.get(7)?,
        finished_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

pub(crate) fn read_log_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<KnowledgeProcessingLogRecord> {
    Ok(KnowledgeProcessingLogRecord {
        id: row.get(0)?,
        job_id: row.get(1)?,
        document_id: row.get(2)?,
        level: row.get(3)?,
        step_name: row.get(4)?,
        message: row.get(5)?,
        details_json: row.get(6)?,
        created_at: row.get(7)?,
    })
}

pub(crate) fn dead_letter_job_type_label(job_type: &str) -> &'static str {
    match job_type {
        "initial_import" => "初次导入",
        "reindex" => "重新处理",
        "refresh_preview" => "刷新预览",
        "refresh_embeddings" => "刷新向量索引",
        _ => "处理任务",
    }
}

pub(crate) fn dead_letter_status_label(status: &str) -> &'static str {
    match status {
        "failed" => "失败",
        "replayed" => "已回放",
        "running" => "处理中",
        "queued" => "排队中",
        "canceled" => "已取消",
        _ => "未知状态",
    }
}

pub(crate) fn dead_letter_snapshot_text(metadata_json: Option<&str>, field: &str) -> Option<String> {
    metadata_json
        .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
        .and_then(|value| {
            value
                .get(field)
                .and_then(|item| item.as_str())
                .map(str::trim)
                .map(str::to_string)
        })
        .filter(|value| !value.is_empty())
}

pub(crate) fn dead_letter_user_message(error_message: Option<&str>) -> String {
    let Some(message) = error_message
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return "处理失败，请查看详情。".to_string();
    };

    let lower = message.to_lowercase();
    if lower.contains("query returned no rows") || lower.contains("job not found") {
        return "没有找到对应的处理记录。".to_string();
    }
    if lower.contains("timeout") || lower.contains("timed out") {
        return "任务处理超时。".to_string();
    }
    if lower.contains("permission denied") || lower.contains("access is denied") {
        return "没有足够权限访问这个文件。".to_string();
    }
    if lower.contains("not found") || lower.contains("no such file") {
        return "找不到对应文件，可能已被移动或删除。".to_string();
    }
    if lower.contains("parse") || lower.contains("decode") {
        return "文档解析失败。".to_string();
    }
    if lower.contains("sqlite") || lower.contains("database") {
        return "处理记录写入失败。".to_string();
    }
    "处理失败，请查看详情。".to_string()
}

pub(crate) fn dead_letter_user_action(error_message: Option<&str>, status: &str) -> Option<String> {
    if status == "replayed" {
        return Some("该任务已回放，可稍后刷新查看最新状态。".to_string());
    }

    let lower = error_message.unwrap_or_default().to_lowercase();
    if lower.contains("query returned no rows") || lower.contains("job not found") {
        return Some("建议确认文档和任务记录仍存在，再尝试回放。".to_string());
    }
    if lower.contains("timeout") || lower.contains("timed out") {
        return Some("建议先回放一次；若仍失败，再检查文档内容或超时设置。".to_string());
    }
    if lower.contains("permission denied") || lower.contains("access is denied") {
        return Some("请检查文件权限或文件是否被其他程序占用。".to_string());
    }
    if lower.contains("not found") || lower.contains("no such file") {
        return Some("请确认原文件路径有效，必要时重新导入文档。".to_string());
    }
    Some("可尝试回放一次；若仍失败，请展开详情查看原始错误。".to_string())
}

pub(crate) fn read_dead_letter_record(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<KnowledgeProcessingDeadLetterRecord> {
    let job_type: String = row.get(6)?;
    let status: String = row.get(7)?;
    let error_message: Option<String> = row.get(8)?;
    let metadata_json: Option<String> = row.get(17)?;
    let document_name = row
        .get::<_, Option<String>>(3)?
        .and_then(|value| {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        })
        .or_else(|| dead_letter_snapshot_text(metadata_json.as_deref(), "sourceName"));
    let collection_name = row
        .get::<_, Option<String>>(5)?
        .and_then(|value| {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        })
        .or_else(|| dead_letter_snapshot_text(metadata_json.as_deref(), "collectionName"));
    Ok(KnowledgeProcessingDeadLetterRecord {
        id: row.get(0)?,
        job_id: row.get(1)?,
        document_id: row.get(2)?,
        document_name,
        collection_id: row.get(4)?,
        collection_name,
        job_type: job_type.clone(),
        job_type_label: dead_letter_job_type_label(&job_type).to_string(),
        status: status.clone(),
        status_label: dead_letter_status_label(&status).to_string(),
        user_message: dead_letter_user_message(error_message.as_deref()),
        user_action: dead_letter_user_action(error_message.as_deref(), &status),
        error_message,
        fail_count: row.get(9)?,
        attempt: row.get(10)?,
        max_attempts: row.get(11)?,
        first_failed_at: row.get(12)?,
        last_failed_at: row.get(13)?,
        replayed_at: row.get(14)?,
        replayed_job_id: row.get(15)?,
        resolved_at: row.get(16)?,
        metadata_json,
    })
}
pub(crate) fn load_job_record(
    connection: &Connection,
    job_id: &str,
) -> Result<KnowledgeProcessingJobRecord, String> {
    connection
        .query_row(
            r#"
            SELECT id, document_id, collection_id, job_type, status, current_step, progress,
                   attempt, max_attempts, priority, fail_count, next_run_at, source_job_id,
                   cancel_requested, pause_requested, error_message, created_at, started_at,
                   finished_at, updated_at
            FROM knowledge_processing_jobs
            WHERE id = ?1
            "#,
            params![job_id],
            read_job_record,
        )
        .optional()
        .map_err(|err| err.to_string())?
        .ok_or_else(|| format!("knowledge processing job not found: {job_id}"))
}

pub(crate) fn insert_default_step_rows(
    connection: &Connection,
    job_id: &str,
    document_id: &str,
    now: i64,
) -> Result<(), String> {
    let mut stmt = connection
        .prepare(
            r#"
            INSERT INTO knowledge_processing_steps (
              id, job_id, document_id, step_name, status, progress, error_message,
              started_at, finished_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL, NULL, NULL, ?6)
            "#,
        )
        .map_err(|err| err.to_string())?;

    for step_name in PIPELINE_STEPS {
        stmt.execute(params![
            uuid::Uuid::new_v4().to_string(),
            job_id,
            document_id,
            step_name,
            STEP_STATUS_PENDING,
            now,
        ])
        .map_err(|err| err.to_string())?;
    }

    Ok(())
}

pub(crate) fn insert_job_record(
    connection: &Connection,
    document_id: &str,
    collection_id: &str,
    job_type: &str,
    attempt: i64,
    max_attempts: i64,
    priority: i64,
    fail_count: i64,
    next_run_at: Option<i64>,
    source_job_id: Option<&str>,
    now: i64,
) -> Result<KnowledgeProcessingJobRecord, String> {
    let job_id = uuid::Uuid::new_v4().to_string();
    connection
        .execute(
            r#"
            INSERT INTO knowledge_processing_jobs (
              id, document_id, collection_id, job_type, status, current_step, progress, attempt,
              max_attempts, priority, fail_count, next_run_at, source_job_id, cancel_requested,
              pause_requested, error_message, created_at, started_at, finished_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9, ?10, ?11, ?12, 0, 0, NULL, ?13, NULL, NULL, ?14)
            "#,
            params![
                job_id,
                document_id,
                collection_id,
                job_type,
                JOB_STATUS_QUEUED,
                PIPELINE_STEPS[0],
                attempt,
                max_attempts,
                priority,
                fail_count,
                next_run_at,
                source_job_id,
                now,
                now,
            ],
        )
        .map_err(|err| err.to_string())?;
    insert_default_step_rows(connection, &job_id, document_id, now)?;
    load_job_record(connection, &job_id)
}
