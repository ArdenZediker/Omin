//! 面向前端的查询与批量操作：列表、详情、汇总、重试、回放、设置。
//!
//! 由 knowledge_pipeline 单文件拆分而来，保持逻辑不变。

use rusqlite::{params, Connection, OptionalExtension};

use super::*;

pub fn list_processing_jobs(
    connection: &Connection,
    document_id: Option<String>,
) -> Result<Vec<KnowledgeProcessingJobRecord>, String> {
    let normalized_document_id = document_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let sql = if normalized_document_id.is_some() {
        r#"
        SELECT id, document_id, collection_id, job_type, status, current_step, progress,
               attempt, max_attempts, priority, fail_count, next_run_at, source_job_id,
               cancel_requested, pause_requested, error_message, created_at, started_at,
               finished_at, updated_at
        FROM knowledge_processing_jobs
        WHERE document_id = ?1
        ORDER BY created_at DESC, id DESC
        "#
    } else {
        r#"
        SELECT id, document_id, collection_id, job_type, status, current_step, progress,
               attempt, max_attempts, priority, fail_count, next_run_at, source_job_id,
               cancel_requested, pause_requested, error_message, created_at, started_at,
               finished_at, updated_at
        FROM knowledge_processing_jobs
        ORDER BY created_at DESC, id DESC
        "#
    };

    let mut stmt = connection.prepare(sql).map_err(|err| err.to_string())?;
    let rows = if let Some(document_id) = normalized_document_id {
        stmt.query_map(params![document_id], read_job_record)
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
    } else {
        stmt.query_map([], read_job_record)
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
    };

    rows.map_err(|err| err.to_string())
}

pub fn load_processing_job_detail(
    connection: &Connection,
    job_id: &str,
) -> Result<KnowledgeProcessingJobDetail, String> {
    let job = load_job_record(connection, job_id)?;

    let mut steps_stmt = connection
        .prepare(
            r#"
            SELECT id, job_id, document_id, step_name, status, progress, error_message,
                   started_at, finished_at, updated_at
            FROM knowledge_processing_steps
            WHERE job_id = ?1
            ORDER BY
              CASE step_name
                WHEN 'validate' THEN 0
                WHEN 'parse' THEN 1
                WHEN 'enrich_image' THEN 2
                WHEN 'enrich_audio' THEN 3
                WHEN 'chunk' THEN 4
                WHEN 'embed' THEN 5
                WHEN 'index' THEN 6
                WHEN 'finalize' THEN 7
                ELSE 99
              END,
              updated_at ASC
            "#,
        )
        .map_err(|err| err.to_string())?;
    let steps = steps_stmt
        .query_map(params![job_id], read_step_record)
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    let mut logs_stmt = connection
        .prepare(
            r#"
            SELECT id, job_id, document_id, level, step_name, message, details_json, created_at
            FROM knowledge_processing_logs
            WHERE job_id = ?1
            ORDER BY created_at ASC, id ASC
            "#,
        )
        .map_err(|err| err.to_string())?;
    let logs = logs_stmt
        .query_map(params![job_id], read_log_record)
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    Ok(KnowledgeProcessingJobDetail { job, steps, logs })
}

pub fn load_processing_status_summary(
    connection: &Connection,
    collection_id: Option<String>,
) -> Result<KnowledgeProcessingStatusSummary, String> {
    let normalized_collection_id = collection_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let (scope, collection_id) = if let Some(collection_id) = normalized_collection_id {
        ("collection".to_string(), Some(collection_id))
    } else {
        ("global".to_string(), None)
    };

    let (queued, running, failed): (i64, i64, i64) =
        if let Some(collection_id) = collection_id.as_ref() {
            connection
                .query_row(
                    r#"
                SELECT
                  SUM(CASE WHEN status = ?2 THEN 1 ELSE 0 END) AS queued_count,
                  SUM(CASE WHEN status = ?3 THEN 1 ELSE 0 END) AS running_count,
                  SUM(CASE WHEN status = ?4 THEN 1 ELSE 0 END) AS failed_count
                FROM knowledge_processing_jobs
                WHERE collection_id = ?1
                "#,
                    params![
                        collection_id,
                        JOB_STATUS_QUEUED,
                        JOB_STATUS_RUNNING,
                        JOB_STATUS_FAILED
                    ],
                    |row| {
                        Ok((
                            row.get::<_, Option<i64>>(0)?.unwrap_or(0),
                            row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                            row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                        ))
                    },
                )
                .map_err(|err| err.to_string())?
        } else {
            connection
                .query_row(
                    r#"
                SELECT
                  SUM(CASE WHEN status = ?1 THEN 1 ELSE 0 END) AS queued_count,
                  SUM(CASE WHEN status = ?2 THEN 1 ELSE 0 END) AS running_count,
                  SUM(CASE WHEN status = ?3 THEN 1 ELSE 0 END) AS failed_count
                FROM knowledge_processing_jobs
                "#,
                    params![JOB_STATUS_QUEUED, JOB_STATUS_RUNNING, JOB_STATUS_FAILED],
                    |row| {
                        Ok((
                            row.get::<_, Option<i64>>(0)?.unwrap_or(0),
                            row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                            row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                        ))
                    },
                )
                .map_err(|err| err.to_string())?
        };

    Ok(KnowledgeProcessingStatusSummary {
        scope,
        collection_id,
        queued,
        running,
        failed,
    })
}

pub fn list_failed_processing_jobs(
    connection: &Connection,
    input: FailedJobQueryInput,
) -> Result<FailedJobQueryResult, String> {
    let normalized_collection_id = input
        .collection_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let limit = input.limit.unwrap_or(100).clamp(1, 500);
    let offset = input.offset.unwrap_or(0).max(0);

    let (scope, collection_id) = if let Some(collection_id) = normalized_collection_id {
        ("collection".to_string(), Some(collection_id))
    } else {
        ("global".to_string(), None)
    };

    let total: i64 = if let Some(collection_id) = collection_id.as_ref() {
        connection
            .query_row(
                r#"
                SELECT COUNT(1)
                FROM knowledge_processing_jobs
                WHERE status = ?1 AND collection_id = ?2
                "#,
                params![JOB_STATUS_FAILED, collection_id],
                |row| row.get(0),
            )
            .map_err(|err| err.to_string())?
    } else {
        connection
            .query_row(
                r#"
                SELECT COUNT(1)
                FROM knowledge_processing_jobs
                WHERE status = ?1
                "#,
                params![JOB_STATUS_FAILED],
                |row| row.get(0),
            )
            .map_err(|err| err.to_string())?
    };

    let sql_with_collection = r#"
        SELECT id, document_id, collection_id, job_type, status, current_step, progress,
               attempt, max_attempts, priority, fail_count, next_run_at, source_job_id,
               cancel_requested, pause_requested, error_message, created_at, started_at,
               finished_at, updated_at
        FROM knowledge_processing_jobs
        WHERE status = ?1 AND collection_id = ?2
        ORDER BY updated_at DESC, created_at DESC, id DESC
        LIMIT ?3 OFFSET ?4
    "#;
    let sql_global = r#"
        SELECT id, document_id, collection_id, job_type, status, current_step, progress,
               attempt, max_attempts, priority, fail_count, next_run_at, source_job_id,
               cancel_requested, pause_requested, error_message, created_at, started_at,
               finished_at, updated_at
        FROM knowledge_processing_jobs
        WHERE status = ?1
        ORDER BY updated_at DESC, created_at DESC, id DESC
        LIMIT ?2 OFFSET ?3
    "#;

    let mut stmt = connection
        .prepare(if collection_id.is_some() {
            sql_with_collection
        } else {
            sql_global
        })
        .map_err(|err| err.to_string())?;
    let jobs = if let Some(collection_id) = collection_id.as_ref() {
        stmt.query_map(
            params![JOB_STATUS_FAILED, collection_id, limit, offset],
            read_job_record,
        )
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?
    } else {
        stmt.query_map(params![JOB_STATUS_FAILED, limit, offset], read_job_record)
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?
    };

    let has_more = offset.saturating_add(limit) < total;
    Ok(FailedJobQueryResult {
        scope,
        collection_id,
        total,
        has_more,
        jobs,
    })
}

pub fn retry_failed_jobs(
    connection: &Connection,
    input: RetryFailedJobsInput,
) -> Result<RetryFailedJobsResult, String> {
    let normalized_collection_id = input
        .collection_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let limit = input.limit.unwrap_or(200).clamp(1, 1000);
    let (scope, collection_id) = if let Some(collection_id) = normalized_collection_id {
        ("collection".to_string(), Some(collection_id))
    } else {
        ("global".to_string(), None)
    };

    let sql_with_collection = r#"
        SELECT id
        FROM knowledge_processing_jobs
        WHERE status = ?1 AND collection_id = ?2
        ORDER BY updated_at DESC, created_at DESC, id DESC
        LIMIT ?3
    "#;
    let sql_global = r#"
        SELECT id
        FROM knowledge_processing_jobs
        WHERE status = ?1
        ORDER BY updated_at DESC, created_at DESC, id DESC
        LIMIT ?2
    "#;
    let mut stmt = connection
        .prepare(if collection_id.is_some() {
            sql_with_collection
        } else {
            sql_global
        })
        .map_err(|err| err.to_string())?;
    let job_ids = if let Some(collection_id) = collection_id.as_ref() {
        stmt.query_map(params![JOB_STATUS_FAILED, collection_id, limit], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?
    } else {
        stmt.query_map(params![JOB_STATUS_FAILED, limit], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?
    };

    let attempted = job_ids.len() as i64;
    if attempted == 0 {
        return Ok(RetryFailedJobsResult {
            scope,
            collection_id,
            attempted: 0,
            retried: 0,
            skipped: 0,
            errors: Vec::new(),
        });
    }

    let mut retried = 0_i64;
    let mut skipped = 0_i64;
    let mut errors = Vec::new();
    for job_id in job_ids {
        match retry_job(connection, &job_id) {
            Ok(_) => retried = retried.saturating_add(1),
            Err(err) => {
                skipped = skipped.saturating_add(1);
                errors.push(format!("{job_id}: {err}"));
            }
        }
    }

    Ok(RetryFailedJobsResult {
        scope,
        collection_id,
        attempted,
        retried,
        skipped,
        errors,
    })
}

pub fn list_dead_letters(
    connection: &Connection,
    input: DeadLetterQueryInput,
) -> Result<DeadLetterQueryResult, String> {
    let normalized_collection_id = input
        .collection_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let normalized_status = input
        .status
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let limit = input.limit.unwrap_or(100).clamp(1, 500);
    let offset = input.offset.unwrap_or(0).max(0);

    let (scope, collection_id) = if let Some(collection_id) = normalized_collection_id {
        ("collection".to_string(), Some(collection_id))
    } else {
        ("global".to_string(), None)
    };

    let base_select = r#"
        SELECT dl.id, dl.job_id, dl.document_id, d.source_name, dl.collection_id, c.name,
               dl.job_type, dl.status, dl.error_message, dl.fail_count, dl.attempt,
               dl.max_attempts, dl.first_failed_at, dl.last_failed_at, dl.replayed_at,
               dl.replayed_job_id, dl.resolved_at, dl.metadata_json
        FROM knowledge_processing_dead_letters dl
        LEFT JOIN knowledge_documents d ON d.id = dl.document_id
        LEFT JOIN knowledge_collections c ON c.id = dl.collection_id
    "#;
    let base_count = "SELECT COUNT(1) FROM knowledge_processing_dead_letters";
    let order = " ORDER BY dl.last_failed_at DESC, dl.first_failed_at DESC, dl.id DESC ";

    let (total, items) = match (collection_id.as_ref(), normalized_status.as_ref()) {
        (Some(collection_id), Some(status)) => {
            let count_sql = format!("{base_count} WHERE collection_id = ?1 AND status = ?2");
            let list_sql = format!("{base_select} WHERE dl.collection_id = ?1 AND dl.status = ?2 {order} LIMIT ?3 OFFSET ?4");
            let total: i64 = connection
                .query_row(&count_sql, params![collection_id, status], |row| row.get(0))
                .map_err(|err| err.to_string())?;
            let mut stmt = connection
                .prepare(&list_sql)
                .map_err(|err| err.to_string())?;
            let items = stmt
                .query_map(
                    params![collection_id, status, limit, offset],
                    read_dead_letter_record,
                )
                .map_err(|err| err.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| err.to_string())?;
            (total, items)
        }
        (Some(collection_id), None) => {
            let count_sql = format!("{base_count} WHERE collection_id = ?1");
            let list_sql =
                format!("{base_select} WHERE dl.collection_id = ?1 {order} LIMIT ?2 OFFSET ?3");
            let total: i64 = connection
                .query_row(&count_sql, params![collection_id], |row| row.get(0))
                .map_err(|err| err.to_string())?;
            let mut stmt = connection
                .prepare(&list_sql)
                .map_err(|err| err.to_string())?;
            let items = stmt
                .query_map(
                    params![collection_id, limit, offset],
                    read_dead_letter_record,
                )
                .map_err(|err| err.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| err.to_string())?;
            (total, items)
        }
        (None, Some(status)) => {
            let count_sql = format!("{base_count} WHERE status = ?1");
            let list_sql = format!("{base_select} WHERE dl.status = ?1 {order} LIMIT ?2 OFFSET ?3");
            let total: i64 = connection
                .query_row(&count_sql, params![status], |row| row.get(0))
                .map_err(|err| err.to_string())?;
            let mut stmt = connection
                .prepare(&list_sql)
                .map_err(|err| err.to_string())?;
            let items = stmt
                .query_map(params![status, limit, offset], read_dead_letter_record)
                .map_err(|err| err.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| err.to_string())?;
            (total, items)
        }
        (None, None) => {
            let count_sql = base_count.to_string();
            let list_sql = format!("{base_select} {order} LIMIT ?1 OFFSET ?2");
            let total: i64 = connection
                .query_row(&count_sql, [], |row| row.get(0))
                .map_err(|err| err.to_string())?;
            let mut stmt = connection
                .prepare(&list_sql)
                .map_err(|err| err.to_string())?;
            let items = stmt
                .query_map(params![limit, offset], read_dead_letter_record)
                .map_err(|err| err.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| err.to_string())?;
            (total, items)
        }
    };
    let has_more = offset.saturating_add(limit) < total;
    Ok(DeadLetterQueryResult {
        scope,
        collection_id,
        status: normalized_status,
        total,
        has_more,
        items,
    })
}

pub fn replay_dead_letters(
    connection: &Connection,
    input: ReplayDeadLettersInput,
) -> Result<ReplayDeadLettersResult, String> {
    let normalized_collection_id = input
        .collection_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let normalized_status = input
        .status
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let limit = input.limit.unwrap_or(200).clamp(1, 1000);
    let (scope, collection_id) = if let Some(collection_id) = normalized_collection_id {
        ("collection".to_string(), Some(collection_id))
    } else {
        ("global".to_string(), None)
    };

    let status_value = normalized_status.unwrap_or_else(|| "failed".to_string());
    let sql_with_collection = r#"
        SELECT job_id, status
        FROM knowledge_processing_dead_letters
        WHERE status = ?1 AND collection_id = ?2
        ORDER BY last_failed_at DESC, id DESC
        LIMIT ?3
    "#;
    let sql_global = r#"
        SELECT job_id, status
        FROM knowledge_processing_dead_letters
        WHERE status = ?1
        ORDER BY last_failed_at DESC, id DESC
        LIMIT ?2
    "#;
    let mut stmt = connection
        .prepare(if collection_id.is_some() {
            sql_with_collection
        } else {
            sql_global
        })
        .map_err(|err| err.to_string())?;
    let dead_letter_candidates = if let Some(collection_id) = collection_id.as_ref() {
        stmt.query_map(params![status_value, collection_id, limit], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?
    } else {
        stmt.query_map(params![status_value, limit], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?
    };

    let attempted = dead_letter_candidates.len() as i64;
    if attempted == 0 {
        return Ok(ReplayDeadLettersResult {
            scope,
            collection_id,
            attempted: 0,
            replayed: 0,
            skipped: 0,
            errors: Vec::new(),
        });
    }

    let mut replayed = 0_i64;
    let mut skipped = 0_i64;
    let mut errors = Vec::new();
    for (job_id, dead_letter_status) in dead_letter_candidates {
        if dead_letter_status != JOB_STATUS_FAILED {
            skipped = skipped.saturating_add(1);
            errors.push(format!(
                "{job_id}: dead letter status is '{dead_letter_status}', only 'failed' can be replayed"
            ));
            continue;
        }
        match retry_job(connection, &job_id) {
            Ok(_) => replayed = replayed.saturating_add(1),
            Err(err) => {
                skipped = skipped.saturating_add(1);
                errors.push(format!("{job_id}: {err}"));
            }
        }
    }

    Ok(ReplayDeadLettersResult {
        scope,
        collection_id,
        attempted,
        replayed,
        skipped,
        errors,
    })
}

pub fn load_pipeline_settings(
    connection: &Connection,
) -> Result<KnowledgePipelineSettings, String> {
    let settings_json = connection
        .query_row(
            "SELECT settings_json FROM knowledge_pipeline_settings WHERE id = 'default'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?;

    let mut settings = settings_json
        .as_deref()
        .and_then(|value| serde_json::from_str::<KnowledgePipelineSettings>(value).ok())
        .unwrap_or_default();

    // Migrate the old success-log default (7 days) down to the new leaner default.
    // This setting is not user-facing today, so preserving the legacy value mostly
    // means keeping invisible success logs longer than we need.
    if settings.keep_successful_logs_days == 7 {
        settings.keep_successful_logs_days = 1;
    }

    let settings = settings.clamped();

    Ok(settings)
}

pub fn save_pipeline_settings(
    connection: &Connection,
    settings: KnowledgePipelineSettings,
) -> Result<KnowledgePipelineSettings, String> {
    let settings = settings.clamped();
    let settings_json = serde_json::to_string(&settings).map_err(|err| err.to_string())?;
    let now = current_timestamp_ms();

    connection
        .execute(
            r#"
            INSERT INTO knowledge_pipeline_settings (id, settings_json, updated_at)
            VALUES ('default', ?1, ?2)
            ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at
            "#,
            params![settings_json, now],
        )
        .map_err(|err| err.to_string())?;

    Ok(settings)
}

pub fn cleanup_processing_logs(connection: &Connection) -> Result<i64, String> {
    let settings = load_pipeline_settings(connection)?;
    let now = current_timestamp_ms();
    let day_ms = 86_400_000_i64;
    let successful_cutoff =
        now.saturating_sub(settings.keep_successful_logs_days.saturating_mul(day_ms));
    let failed_cutoff = now.saturating_sub(settings.keep_failed_logs_days.saturating_mul(day_ms));

    let deleted_successful = connection
        .execute(
            r#"
            DELETE FROM knowledge_processing_logs
            WHERE created_at < ?1
              AND job_id IN (
                SELECT id FROM knowledge_processing_jobs
                WHERE status = ?2
              )
            "#,
            params![successful_cutoff, JOB_STATUS_SUCCEEDED],
        )
        .map_err(|err| err.to_string())?;
    let deleted_failed = connection
        .execute(
            r#"
            DELETE FROM knowledge_processing_logs
            WHERE created_at < ?1
              AND job_id IN (
                SELECT id FROM knowledge_processing_jobs
                WHERE status IN (?2, ?3)
              )
            "#,
            params![failed_cutoff, JOB_STATUS_FAILED, JOB_STATUS_CANCELED],
        )
        .map_err(|err| err.to_string())?;

    Ok((deleted_successful + deleted_failed) as i64)
}
