//! 任务生命周期控制：暂停/恢复/取消、步骤状态流转、失败与死信。
//!
//! 由 knowledge_pipeline 单文件拆分而来，保持逻辑不变。

use rusqlite::{params, Connection, OptionalExtension};

use super::*;

pub fn request_job_pause(connection: &Connection, job_id: &str) -> Result<(), String> {
    let job = load_job_record(connection, job_id)?;
    let now = current_timestamp_ms();
    let status = if job.status == JOB_STATUS_QUEUED {
        JOB_STATUS_PAUSED
    } else {
        job.status.as_str()
    };
    connection
        .execute(
            r#"
            UPDATE knowledge_processing_jobs
            SET pause_requested = 1, status = ?2, updated_at = ?3
            WHERE id = ?1
            "#,
            params![job_id, status, now],
        )
        .map_err(|err| err.to_string())?;
    log_job(
        connection,
        job_id,
        &job.document_id,
        "info",
        None,
        "pause requested",
        None,
    )
}

pub fn request_job_resume(connection: &Connection, job_id: &str) -> Result<(), String> {
    let job = load_job_record(connection, job_id)?;
    let now = current_timestamp_ms();
    let status = if job.status == JOB_STATUS_PAUSED {
        JOB_STATUS_QUEUED
    } else {
        job.status.as_str()
    };
    connection
        .execute(
            r#"
            UPDATE knowledge_processing_jobs
            SET pause_requested = 0, status = ?2, next_run_at = CASE WHEN ?2 = ?4 THEN NULL ELSE next_run_at END, updated_at = ?3
            WHERE id = ?1
            "#,
            params![job_id, status, now, JOB_STATUS_QUEUED],
        )
        .map_err(|err| err.to_string())?;
    log_job(
        connection,
        job_id,
        &job.document_id,
        "info",
        None,
        "resume requested",
        None,
    )
}

pub fn request_job_cancel(connection: &Connection, job_id: &str) -> Result<(), String> {
    let job = load_job_record(connection, job_id)?;
    let now = current_timestamp_ms();
    let tx = connection
        .unchecked_transaction()
        .map_err(|err| err.to_string())?;
    tx.execute(
        r#"
        UPDATE knowledge_processing_jobs
        SET cancel_requested = 1, updated_at = ?2
        WHERE id = ?1
        "#,
        params![job_id, now],
    )
    .map_err(|err| err.to_string())?;

    if matches!(job.status.as_str(), JOB_STATUS_QUEUED | JOB_STATUS_PAUSED) {
        tx.execute(
            r#"
            UPDATE knowledge_processing_steps
            SET status = ?2, finished_at = ?3, updated_at = ?4
            WHERE job_id = ?1 AND status = ?5
            "#,
            params![job_id, STEP_STATUS_SKIPPED, now, now, STEP_STATUS_PENDING],
        )
        .map_err(|err| err.to_string())?;
        tx.execute(
            r#"
            UPDATE knowledge_processing_jobs
            SET status = ?2, progress = 100, next_run_at = NULL, finished_at = ?3, updated_at = ?4
            WHERE id = ?1
            "#,
            params![job_id, JOB_STATUS_CANCELED, now, now],
        )
        .map_err(|err| err.to_string())?;
        tx.execute(
            r#"
            UPDATE knowledge_documents
            SET processing_status = ?2, error_message = NULL, active_job_id = NULL, updated_at = ?3
            WHERE id = ?1 AND active_job_id = ?4
            "#,
            params![job.document_id, DOCUMENT_STATUS_CANCELED, now, job_id],
        )
        .map_err(|err| err.to_string())?;
    }

    tx.commit().map_err(|err| err.to_string())?;
    log_job(
        connection,
        job_id,
        &job.document_id,
        "warn",
        None,
        "cancel requested",
        None,
    )
}

pub fn retry_job(
    connection: &Connection,
    job_id: &str,
) -> Result<KnowledgeProcessingJobRecord, String> {
    let old_job = load_job_record(connection, job_id)?;
    let now = current_timestamp_ms();
    let tx = connection
        .unchecked_transaction()
        .map_err(|err| err.to_string())?;
    let job = insert_job_record(
        &tx,
        &old_job.document_id,
        &old_job.collection_id,
        &old_job.job_type,
        old_job.attempt + 1,
        old_job.max_attempts,
        old_job.priority,
        0,
        None,
        Some(job_id),
        now,
    )?;
    tx.execute(
        r#"
        UPDATE knowledge_documents
        SET processing_status = ?2, error_message = NULL, active_job_id = ?3, updated_at = ?4
        WHERE id = ?1
        "#,
        params![old_job.document_id, DOCUMENT_STATUS_PENDING, job.id, now],
    )
    .map_err(|err| err.to_string())?;
    tx.execute(
        r#"
        UPDATE knowledge_processing_dead_letters
        SET status = ?2, replayed_at = ?3, replayed_job_id = ?4, resolved_at = ?5
        WHERE job_id = ?1
        "#,
        params![job_id, "replayed", now, job.id, now],
    )
    .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;
    log_job(
        connection,
        &job.id,
        &job.document_id,
        "info",
        None,
        "job queued as retry",
        Some(&format!("{{\"sourceJobId\":\"{job_id}\"}}")),
    )?;
    Ok(job)
}

pub fn create_document_job(
    connection: &Connection,
    document_id: &str,
    job_type: &str,
) -> Result<KnowledgeProcessingJobRecord, String> {
    if !matches!(
        job_type,
        "reparse" | "rechunk" | "revectorize" | "full_rebuild"
    ) {
        return Err(format!("unsupported document job type: {job_type}"));
    }

    let (document_id, collection_id): (String, String) = connection
        .query_row(
            "SELECT id, collection_id FROM knowledge_documents WHERE id = ?1",
            params![document_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .ok_or_else(|| format!("knowledge document not found: {document_id}"))?;

    let now = current_timestamp_ms();
    let tx = connection
        .unchecked_transaction()
        .map_err(|err| err.to_string())?;
    let job = insert_job_record(
        &tx,
        &document_id,
        &collection_id,
        job_type,
        0,
        3,
        DEFAULT_JOB_PRIORITY,
        0,
        None,
        None,
        now,
    )?;
    tx.execute(
        r#"
        UPDATE knowledge_documents
        SET processing_status = ?2, error_message = NULL, active_job_id = ?3, updated_at = ?4
        WHERE id = ?1
        "#,
        params![document_id, DOCUMENT_STATUS_PENDING, job.id, now],
    )
    .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;
    log_job(
        connection,
        &job.id,
        &job.document_id,
        "info",
        None,
        "document job queued",
        None,
    )?;
    Ok(job)
}

pub(crate) fn count_running_jobs(connection: &Connection) -> Result<i64, String> {
    connection
        .query_row(
            "SELECT COUNT(1) FROM knowledge_processing_jobs WHERE status = ?1",
            params![JOB_STATUS_RUNNING],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())
}

pub(crate) fn claim_next_job_with_limits(
    connection: &Connection,
    per_collection_max_running: i64,
) -> Result<Option<PipelineJobClaim>, String> {
    let now = current_timestamp_ms();
    let Some(job) = connection
        .query_row(
            r#"
            SELECT q.id, q.document_id, q.collection_id
            FROM knowledge_processing_jobs q
            WHERE q.status = ?1
              AND q.cancel_requested = 0
              AND q.pause_requested = 0
              AND (q.next_run_at IS NULL OR q.next_run_at <= ?2)
              AND (
                SELECT COUNT(1)
                FROM knowledge_processing_jobs r
                WHERE r.collection_id = q.collection_id
                  AND r.status = ?3
              ) < ?4
            ORDER BY
              q.priority DESC,
              COALESCE(q.next_run_at, q.created_at) ASC,
              q.created_at ASC,
              q.id ASC
            LIMIT 1
            "#,
            params![
                JOB_STATUS_QUEUED,
                now,
                JOB_STATUS_RUNNING,
                per_collection_max_running
            ],
            |row| {
                Ok(PipelineJobClaim {
                    id: row.get(0)?,
                    document_id: row.get(1)?,
                    collection_id: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(|err| err.to_string())?
    else {
        return Ok(None);
    };

    let changed = connection
        .execute(
            r#"
            UPDATE knowledge_processing_jobs
            SET status = ?2,
                current_step = ?3,
                progress = 1,
                started_at = COALESCE(started_at, ?4),
                updated_at = ?5
            WHERE id = ?1
              AND status = ?6
              AND cancel_requested = 0
              AND pause_requested = 0
              AND (next_run_at IS NULL OR next_run_at <= ?4)
            "#,
            params![
                job.id,
                JOB_STATUS_RUNNING,
                PIPELINE_STEPS[0],
                now,
                now,
                JOB_STATUS_QUEUED
            ],
        )
        .map_err(|err| err.to_string())?;

    if changed == 0 {
        Ok(None)
    } else {
        Ok(Some(job))
    }
}

pub(crate) fn load_document_source(
    connection: &Connection,
    document_id: &str,
) -> Result<PipelineDocumentSource, String> {
    connection
        .query_row(
            r#"
            SELECT id, collection_id, source_name, stored_file_path, mime_type, file_extension, preview_type, content
            FROM knowledge_documents
            WHERE id = ?1
            "#,
            params![document_id],
            |row| {
                Ok(PipelineDocumentSource {
                    id: row.get(0)?,
                    collection_id: row.get(1)?,
                    source_name: row.get(2)?,
                    stored_file_path: row.get(3)?,
                    mime_type: row.get(4)?,
                    file_extension: row.get(5)?,
                    preview_type: row.get(6)?,
                    content: row.get(7)?,
                })
            },
        )
        .map_err(|err| err.to_string())
}

pub(crate) fn log_job(
    connection: &Connection,
    job_id: &str,
    document_id: &str,
    level: &str,
    step_name: Option<&str>,
    message: &str,
    details_json: Option<&str>,
) -> Result<(), String> {
    connection
        .execute(
            r#"
            INSERT INTO knowledge_processing_logs (
              id, job_id, document_id, level, step_name, message, details_json, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            "#,
            params![
                uuid::Uuid::new_v4().to_string(),
                job_id,
                document_id,
                level,
                step_name,
                message,
                details_json,
                current_timestamp_ms(),
            ],
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}

pub(crate) fn start_step(
    connection: &Connection,
    job: &PipelineJobClaim,
    step_name: &str,
    progress: i64,
) -> Result<(), String> {
    let now = current_timestamp_ms();
    connection
        .execute(
            r#"
            UPDATE knowledge_processing_steps
            SET status = ?3, progress = 0, error_message = NULL,
                started_at = COALESCE(started_at, ?4), finished_at = NULL, updated_at = ?5
            WHERE job_id = ?1 AND step_name = ?2
            "#,
            params![job.id, step_name, STEP_STATUS_RUNNING, now, now],
        )
        .map_err(|err| err.to_string())?;
    connection
        .execute(
            r#"
            UPDATE knowledge_processing_jobs
            SET current_step = ?2, progress = ?3, updated_at = ?4
            WHERE id = ?1
            "#,
            params![job.id, step_name, progress, now],
        )
        .map_err(|err| err.to_string())?;
    log_job(
        connection,
        &job.id,
        &job.document_id,
        "info",
        Some(step_name),
        "step started",
        None,
    )
}

pub(crate) fn finish_step(
    connection: &Connection,
    job: &PipelineJobClaim,
    step_name: &str,
    status: &str,
    progress: i64,
    error_message: Option<&str>,
) -> Result<(), String> {
    let now = current_timestamp_ms();
    connection
        .execute(
            r#"
            UPDATE knowledge_processing_steps
            SET status = ?3, progress = ?4, error_message = ?5, finished_at = ?6, updated_at = ?7
            WHERE job_id = ?1 AND step_name = ?2
            "#,
            params![job.id, step_name, status, progress, error_message, now, now],
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}

pub(crate) fn skip_step(
    connection: &Connection,
    job: &PipelineJobClaim,
    step_name: &str,
    message: &str,
) -> Result<(), String> {
    finish_step(connection, job, step_name, STEP_STATUS_SKIPPED, 100, None)?;
    log_job(
        connection,
        &job.id,
        &job.document_id,
        "info",
        Some(step_name),
        message,
        None,
    )
}

pub(crate) fn check_job_control(
    connection: &Connection,
    job: &PipelineJobClaim,
) -> Result<ControlFlow, String> {
    let (cancel_requested, pause_requested): (i64, i64) = connection
        .query_row(
            "SELECT cancel_requested, pause_requested FROM knowledge_processing_jobs WHERE id = ?1",
            params![job.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|err| err.to_string())?;

    if cancel_requested != 0 {
        let now = current_timestamp_ms();
        connection
            .execute(
                r#"
                UPDATE knowledge_processing_steps
                SET status = ?2, finished_at = ?3, updated_at = ?4
                WHERE job_id = ?1 AND status = ?5
                "#,
                params![job.id, STEP_STATUS_SKIPPED, now, now, STEP_STATUS_RUNNING],
            )
            .map_err(|err| err.to_string())?;
        connection
            .execute(
                r#"
                UPDATE knowledge_processing_jobs
                SET status = ?2, progress = 100, next_run_at = NULL, finished_at = ?3, updated_at = ?4
                WHERE id = ?1
                "#,
                params![job.id, JOB_STATUS_CANCELED, now, now],
            )
            .map_err(|err| err.to_string())?;
        connection
            .execute(
                r#"
                UPDATE knowledge_documents
                SET processing_status = ?2, error_message = NULL, active_job_id = NULL, updated_at = ?3
                WHERE id = ?1
                "#,
                params![job.document_id, DOCUMENT_STATUS_CANCELED, now],
            )
            .map_err(|err| err.to_string())?;
        log_job(
            connection,
            &job.id,
            &job.document_id,
            "warn",
            None,
            "job canceled",
            None,
        )?;
        return Ok(ControlFlow::Stop);
    }

    if pause_requested != 0 {
        let now = current_timestamp_ms();
        connection
            .execute(
                r#"
                UPDATE knowledge_processing_jobs
                SET status = ?2, next_run_at = CASE WHEN ?2 = ?4 THEN NULL ELSE next_run_at END, updated_at = ?3
                WHERE id = ?1
                "#,
                params![job.id, JOB_STATUS_PAUSED, now, JOB_STATUS_PAUSED],
            )
            .map_err(|err| err.to_string())?;
        log_job(
            connection,
            &job.id,
            &job.document_id,
            "info",
            None,
            "job paused",
            None,
        )?;
        return Ok(ControlFlow::Stop);
    }

    Ok(ControlFlow::Continue)
}

pub(crate) fn compute_retry_delay_ms(fail_count: i64) -> i64 {
    if fail_count <= 0 {
        return 0;
    }
    let index = usize::try_from(fail_count - 1).unwrap_or(usize::MAX);
    *RETRY_BACKOFF_MS
        .get(index)
        .unwrap_or(RETRY_BACKOFF_MS.last().unwrap_or(&600_000))
}

pub(crate) fn upsert_dead_letter(
    connection: &Connection,
    job: &PipelineJobClaim,
    job_record: &KnowledgeProcessingJobRecord,
    error_message: &str,
    now: i64,
) -> Result<(), String> {
    let source_name = connection
        .query_row(
            "SELECT source_name FROM knowledge_documents WHERE id = ?1",
            params![job.document_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let collection_name = connection
        .query_row(
            "SELECT name FROM knowledge_collections WHERE id = ?1",
            params![job.collection_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let metadata_json = serde_json::json!({
        "source": "pipeline",
        "final": true,
        "jobStatus": JOB_STATUS_FAILED,
        "sourceName": source_name,
        "collectionName": collection_name,
    })
    .to_string();

    connection
        .execute(
            r#"
            INSERT INTO knowledge_processing_dead_letters (
              id, job_id, document_id, collection_id, job_type, status, error_message,
              fail_count, attempt, max_attempts, first_failed_at, last_failed_at, metadata_json
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
            ON CONFLICT(job_id) DO UPDATE SET
              status = excluded.status,
              error_message = excluded.error_message,
              fail_count = excluded.fail_count,
              attempt = excluded.attempt,
              max_attempts = excluded.max_attempts,
              last_failed_at = excluded.last_failed_at,
              metadata_json = excluded.metadata_json
            "#,
            params![
                uuid::Uuid::new_v4().to_string(),
                job.id,
                job.document_id,
                job.collection_id,
                job_record.job_type,
                JOB_STATUS_FAILED,
                error_message,
                job_record.fail_count,
                job_record.attempt,
                job_record.max_attempts,
                now,
                now,
                Some(metadata_json),
            ],
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}
pub(crate) fn fail_job(
    connection: &Connection,
    job: &PipelineJobClaim,
    step_name: Option<&str>,
    error_message: &str,
    max_auto_retries: i64,
) -> Result<(), String> {
    let now = current_timestamp_ms();
    let (current_fail_count, max_attempts): (i64, i64) = connection
        .query_row(
            "SELECT fail_count, max_attempts FROM knowledge_processing_jobs WHERE id = ?1",
            params![job.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|err| err.to_string())?;
    let next_fail_count = current_fail_count.saturating_add(1);
    let retry_cap = max_auto_retries.min(max_attempts).max(0);
    let should_retry = next_fail_count <= retry_cap;

    if let Some(step_name) = step_name {
        finish_step(
            connection,
            job,
            step_name,
            STEP_STATUS_FAILED,
            100,
            Some(error_message),
        )?;
    } else {
        connection
            .execute(
                r#"
                UPDATE knowledge_processing_steps
                SET status = ?2, error_message = ?3, finished_at = ?4, updated_at = ?5
                WHERE job_id = ?1 AND status = ?6
                "#,
                params![
                    job.id,
                    STEP_STATUS_FAILED,
                    error_message,
                    now,
                    now,
                    STEP_STATUS_RUNNING
                ],
            )
            .map_err(|err| err.to_string())?;
    }
    if should_retry {
        let retry_at = now.saturating_add(compute_retry_delay_ms(next_fail_count));
        connection
            .execute(
                r#"
                UPDATE knowledge_processing_jobs
                SET status = ?2, fail_count = ?3, next_run_at = ?4, error_message = ?5,
                    finished_at = NULL, updated_at = ?6
                WHERE id = ?1
                "#,
                params![
                    job.id,
                    JOB_STATUS_QUEUED,
                    next_fail_count,
                    retry_at,
                    error_message,
                    now
                ],
            )
            .map_err(|err| err.to_string())?;
        connection
            .execute(
                r#"
                UPDATE knowledge_documents
                SET processing_status = ?2, error_message = ?3, active_job_id = ?4, updated_at = ?5
                WHERE id = ?1
                "#,
                params![
                    job.document_id,
                    DOCUMENT_STATUS_PENDING,
                    error_message,
                    job.id,
                    now
                ],
            )
            .map_err(|err| err.to_string())?;
        log_job(
            connection,
            &job.id,
            &job.document_id,
            "warn",
            step_name,
            "job failed and re-queued",
            Some(&format!(
                "{{\"failCount\":{next_fail_count},\"retryAt\":{retry_at},\"error\":\"{}\"}}",
                error_message.replace('\"', "\\\"")
            )),
        )?;
        return Ok(());
    }

    connection
        .execute(
            r#"
            UPDATE knowledge_processing_jobs
            SET status = ?2, fail_count = ?3, progress = 100, error_message = ?4,
                next_run_at = NULL, finished_at = ?5, updated_at = ?6
            WHERE id = ?1
            "#,
            params![
                job.id,
                JOB_STATUS_FAILED,
                next_fail_count,
                error_message,
                now,
                now
            ],
        )
        .map_err(|err| err.to_string())?;
    let failed_job_record = load_job_record(connection, &job.id)?;
    upsert_dead_letter(connection, job, &failed_job_record, error_message, now)?;
    connection
        .execute(
            r#"
            UPDATE knowledge_documents
            SET processing_status = ?2, error_message = ?3, active_job_id = NULL, updated_at = ?4
            WHERE id = ?1
            "#,
            params![job.document_id, DOCUMENT_STATUS_FAILED, error_message, now],
        )
        .map_err(|err| err.to_string())?;
    log_job(
        connection,
        &job.id,
        &job.document_id,
        "error",
        step_name,
        error_message,
        None,
    )
}

pub(crate) fn mark_unsupported(
    connection: &Connection,
    job: &PipelineJobClaim,
    error_message: &str,
) -> Result<(), String> {
    let now = current_timestamp_ms();
    finish_step(
        connection,
        job,
        "parse",
        STEP_STATUS_SKIPPED,
        100,
        Some(error_message),
    )?;
    for step_name in [
        "enrich_image",
        "enrich_audio",
        "chunk",
        "embed",
        "index",
        "finalize",
    ] {
        finish_step(connection, job, step_name, STEP_STATUS_SKIPPED, 100, None)?;
    }
    connection
        .execute(
            r#"
            UPDATE knowledge_documents
            SET processing_status = ?2, error_message = ?3, last_processed_at = ?4,
                active_job_id = NULL, updated_at = ?5
            WHERE id = ?1
            "#,
            params![
                job.document_id,
                DOCUMENT_STATUS_UNSUPPORTED,
                error_message,
                now,
                now
            ],
        )
        .map_err(|err| err.to_string())?;
    connection
        .execute(
            r#"
            UPDATE knowledge_processing_jobs
            SET status = ?2, progress = 100, error_message = ?3, finished_at = ?4, updated_at = ?5
            WHERE id = ?1
            "#,
            params![job.id, JOB_STATUS_SUCCEEDED, error_message, now, now],
        )
        .map_err(|err| err.to_string())?;
    log_job(
        connection,
        &job.id,
        &job.document_id,
        "warn",
        Some("parse"),
        error_message,
        None,
    )
}
