//! 后台 worker：认领任务、执行、超时恢复与 tick 调度。
//!
//! 由 knowledge_pipeline 单文件拆分而来，保持逻辑不变。

use rusqlite::{params, Connection, OptionalExtension};
use std::fs;

use super::*;

pub(crate) fn complete_partial_job(
    app: &tauri::AppHandle,
    connection: &Connection,
    job: &PipelineJobClaim,
    source_name: &str,
    file_extension: Option<&str>,
    parsed: ParsedDocument,
    processing_warnings: Vec<String>,
    embedded_assets: Vec<crate::knowledge_embedded_images::EmbeddedImageAssetCandidate>,
) -> Result<(), String> {
    start_step(connection, job, "chunk", 45)?;
    let text_chunks = split_parsed_document_into_chunks(&parsed, source_name, file_extension);
    finish_step(connection, job, "chunk", STEP_STATUS_SUCCEEDED, 100, None)?;
    if matches!(check_job_control(connection, job)?, ControlFlow::Stop) {
        return Ok(());
    }

    let now = current_timestamp_ms();
    let (persisted_assets, asset_storage_warnings) = persist_embedded_image_candidates(
        app,
        &job.collection_id,
        &job.document_id,
        &embedded_assets,
    );
    let embedded = build_embedded_image_assets_and_chunks(
        &text_chunks,
        &persisted_assets,
        &job.document_id,
        &job.collection_id,
        now,
    );

    let mut prepared_chunks = Vec::new();
    let mut chunk_slices = Vec::new();
    let mut text_chunk_ids = Vec::new();
    for (index, chunk) in embedded.text_chunks.iter().enumerate() {
        let chunk_id = uuid::Uuid::new_v4().to_string();
        text_chunk_ids.push(chunk_id.clone());
        chunk_slices.push(chunk.clone());
        prepared_chunks.push((
            chunk_id,
            index as i64,
            chunk.title.clone(),
            chunk.content.clone(),
            "text".to_string(),
            Option::<String>::None,
            Option::<String>::None,
            Option::<String>::None,
        ));
    }

    let mut next_chunk_index = prepared_chunks.len() as i64;
    for child in &embedded.child_chunks {
        let parent_chunk_id = text_chunk_ids
            .get(child.parent_chunk_index)
            .cloned()
            .or_else(|| text_chunk_ids.last().cloned());
        let chunk_id = uuid::Uuid::new_v4().to_string();
        chunk_slices.push(crate::knowledge_chunker::ChunkSlice {
            title: child.title.clone(),
            content: child.content.clone(),
        });
        prepared_chunks.push((
            chunk_id,
            next_chunk_index,
            child.title.clone(),
            child.content.clone(),
            child.chunk_type.clone(),
            parent_chunk_id,
            Some(child.asset_id.clone()),
            Some(child.image_info.clone()),
        ));
        next_chunk_index += 1;
    }

    start_step(connection, job, "embed", 65)?;
    // P1：embedding 改走非阻塞异步路径（worker 线程不再被长时 HTTP 钉死）。
    // 返回形状与同步版完全一致，下游 vectorized_chunk_count / 落库逻辑无需改动。
    let (chunk_embeddings, embedding_model_key) =
        crate::generate_chunk_embeddings_async_blocking(connection, &chunk_slices);
    let vectorized_chunk_count = crate::count_vectorized_chunks(&chunk_embeddings);
    let embedding_error = if chunk_slices.is_empty() {
        None
    } else if vectorized_chunk_count <= 0 {
        Some("indexed without embeddings")
    } else if vectorized_chunk_count < chunk_slices.len() as i64 {
        Some("partial")
    } else {
        None
    };
    finish_step(
        connection,
        job,
        "embed",
        if embedding_error.is_some() {
            STEP_STATUS_SKIPPED
        } else {
            STEP_STATUS_SUCCEEDED
        },
        100,
        embedding_error,
    )?;
    if let Some(message) = embedding_error {
        log_job(
            connection,
            &job.id,
            &job.document_id,
            "warn",
            Some("embed"),
            message,
            parsed.metadata_json.as_deref(),
        )?;
    }
    if matches!(check_job_control(connection, job)?, ControlFlow::Stop) {
        return Ok(());
    }

    start_step(connection, job, "index", 80)?;
    let content_preview = preview_text(&parsed.content, 240);
    let chunk_count = prepared_chunks.len() as i64;
    let mut warning_messages = processing_warnings;
    warning_messages.extend(asset_storage_warnings);
    if let Some(message) = embedding_error {
        warning_messages.push(message.to_string());
    }
    let document_status = if warning_messages.is_empty()
        && (chunk_count <= 0 || vectorized_chunk_count >= chunk_count)
    {
        DOCUMENT_STATUS_SEARCHABLE
    } else {
        DOCUMENT_STATUS_PARTIAL
    };
    let document_error = if warning_messages.is_empty() {
        None
    } else {
        Some(warning_messages.join(" | "))
    };
    let stale_asset_paths = {
        let mut stmt = connection
            .prepare(
                "SELECT stored_file_path FROM knowledge_document_assets WHERE document_id = ?1",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![job.document_id], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?;
        rows
    };
    let tx = connection
        .unchecked_transaction()
        .map_err(|err| err.to_string())?;
    tx.execute(
        "DELETE FROM knowledge_document_assets WHERE document_id = ?1",
        params![job.document_id],
    )
    .map_err(|err| err.to_string())?;
    tx.execute(
        "DELETE FROM knowledge_chunks WHERE document_id = ?1",
        params![job.document_id],
    )
    .map_err(|err| err.to_string())?;
    {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO knowledge_document_assets (
                  id, document_id, collection_id, asset_kind, source_name, stored_file_path, mime_type,
                  file_extension, preview_type, thumbnail_data_url, ocr_text, caption_text, content_preview,
                  page_index, asset_index, metadata_json, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
                "#,
            )
            .map_err(|err| err.to_string())?;
        for asset in &embedded.assets {
            stmt.execute(params![
                asset.id,
                asset.document_id,
                asset.collection_id,
                asset.asset_kind,
                asset.source_name,
                asset.stored_file_path,
                asset.mime_type,
                asset.file_extension,
                asset.preview_type,
                asset.thumbnail_data_url,
                asset.ocr_text,
                asset.caption_text,
                asset.content_preview,
                asset.page_index,
                asset.asset_index,
                asset.metadata_json,
                asset.created_at,
                asset.updated_at,
            ])
            .map_err(|err| err.to_string())?;
        }
    }
    {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO knowledge_chunks (
                  id, document_id, collection_id, chunk_index, title, content, chunk_type,
                  parent_chunk_id, asset_id, image_info, embedding_json, embedding_model_key, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                "#,
            )
            .map_err(|err| err.to_string())?;
        for (index, chunk) in prepared_chunks.into_iter().enumerate() {
            stmt.execute(params![
                chunk.0,
                job.document_id,
                job.collection_id,
                chunk.1,
                chunk.2,
                chunk.3,
                chunk.4,
                chunk.5,
                chunk.6,
                chunk.7,
                chunk_embeddings.get(index).cloned().unwrap_or(None),
                embedding_model_key.clone(),
                now,
            ])
            .map_err(|err| err.to_string())?;
        }
    }
    tx.execute(
        r#"
        UPDATE knowledge_documents
        SET preview_type = ?2, content = ?3, content_preview = ?4, chunk_count = ?5,
            processing_status = ?6, error_message = ?7, content_version = content_version + 1,
            last_processed_at = ?8, updated_at = ?9
        WHERE id = ?1
        "#,
        params![
            job.document_id,
            parsed.preview_type,
            parsed.content,
            content_preview,
            chunk_count,
            document_status,
            document_error.as_deref(),
            now,
            now,
        ],
    )
    .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;
    cleanup_stored_embedded_asset_files(&stale_asset_paths);
    finish_step(connection, job, "index", STEP_STATUS_SUCCEEDED, 100, None)?;
    if matches!(check_job_control(connection, job)?, ControlFlow::Stop) {
        return Ok(());
    }

    start_step(connection, job, "finalize", 95)?;
    let now = current_timestamp_ms();
    connection
        .execute(
            r#"
            UPDATE knowledge_documents
            SET processing_status = ?2, error_message = ?3, active_job_id = NULL, last_processed_at = ?4,
                updated_at = ?5
            WHERE id = ?1
            "#,
            params![
                job.document_id,
                document_status,
                document_error.as_deref(),
                now,
                now
            ],
        )
        .map_err(|err| err.to_string())?;
    connection
        .execute(
            r#"
            UPDATE knowledge_processing_jobs
            SET status = ?2, progress = 100, error_message = ?3, fail_count = 0, next_run_at = NULL,
                finished_at = ?4, updated_at = ?5
            WHERE id = ?1
            "#,
            params![
                job.id,
                JOB_STATUS_SUCCEEDED,
                document_error.as_deref(),
                now,
                now,
            ],
        )
        .map_err(|err| err.to_string())?;
    finish_step(
        connection,
        job,
        "finalize",
        STEP_STATUS_SUCCEEDED,
        100,
        None,
    )?;
    log_job(
        connection,
        &job.id,
        &job.document_id,
        "info",
        Some("finalize"),
        if document_status == DOCUMENT_STATUS_SEARCHABLE {
            "job completed as searchable"
        } else {
            "job completed as partial"
        },
        None,
    )
}

pub(crate) fn recover_timed_out_running_jobs(
    connection: &Connection,
    timeout_ms: i64,
    max_auto_retries: i64,
) -> Result<i64, String> {
    let now = current_timestamp_ms();
    let cutoff = now.saturating_sub(timeout_ms.max(10_000));
    let timeout_message = format!("job timed out after {} ms", timeout_ms.max(10_000));

    let mut stmt = connection
        .prepare(
            r#"
            SELECT id, document_id, current_step
            FROM knowledge_processing_jobs
            WHERE status = ?1 AND updated_at < ?2
            "#,
        )
        .map_err(|err| err.to_string())?;
    let stale_jobs = stmt
        .query_map(params![JOB_STATUS_RUNNING, cutoff], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    for (job_id, document_id, step_name) in &stale_jobs {
        let (fail_count, max_attempts): (i64, i64) = connection
            .query_row(
                "SELECT fail_count, max_attempts FROM knowledge_processing_jobs WHERE id = ?1",
                params![job_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|err| err.to_string())?;
        let next_fail_count = fail_count.saturating_add(1);
        let retry_cap = max_auto_retries.min(max_attempts).max(0);
        let should_retry = next_fail_count <= retry_cap;

        connection
            .execute(
                r#"
                UPDATE knowledge_processing_steps
                SET status = ?2, error_message = ?3, finished_at = ?4, updated_at = ?5
                WHERE job_id = ?1 AND status = ?6
                "#,
                params![
                    job_id,
                    STEP_STATUS_FAILED,
                    timeout_message,
                    now,
                    now,
                    STEP_STATUS_RUNNING
                ],
            )
            .map_err(|err| err.to_string())?;
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
                        job_id,
                        JOB_STATUS_QUEUED,
                        next_fail_count,
                        retry_at,
                        timeout_message,
                        now
                    ],
                )
                .map_err(|err| err.to_string())?;
            connection
                .execute(
                    r#"
                    UPDATE knowledge_documents
                    SET processing_status = ?2, error_message = ?3, active_job_id = ?4, updated_at = ?5
                    WHERE id = ?1 AND active_job_id = ?4
                    "#,
                    params![document_id, DOCUMENT_STATUS_PENDING, timeout_message, job_id, now],
                )
                .map_err(|err| err.to_string())?;
            log_job(
                connection,
                job_id,
                document_id,
                "warn",
                step_name.as_deref(),
                "timed out and re-queued",
                Some(&format!(
                    "{{\"failCount\":{next_fail_count},\"retryAt\":{retry_at},\"timeoutMs\":{}}}",
                    timeout_ms.max(10_000)
                )),
            )?;
        } else {
            connection
                .execute(
                    r#"
                    UPDATE knowledge_processing_jobs
                    SET status = ?2, fail_count = ?3, progress = 100, error_message = ?4,
                        next_run_at = NULL, finished_at = ?5, updated_at = ?6
                    WHERE id = ?1
                    "#,
                    params![
                        job_id,
                        JOB_STATUS_FAILED,
                        next_fail_count,
                        timeout_message,
                        now,
                        now
                    ],
                )
                .map_err(|err| err.to_string())?;
            let failed_job_record = load_job_record(connection, job_id)?;
            let failed_job_claim = PipelineJobClaim {
                id: job_id.clone(),
                document_id: document_id.clone(),
                collection_id: failed_job_record.collection_id.clone(),
            };
            upsert_dead_letter(
                connection,
                &failed_job_claim,
                &failed_job_record,
                &timeout_message,
                now,
            )?;
            connection
                .execute(
                    r#"
                    UPDATE knowledge_documents
                    SET processing_status = ?2, error_message = ?3, active_job_id = NULL, updated_at = ?4
                    WHERE id = ?1 AND active_job_id = ?5
                    "#,
                    params![document_id, DOCUMENT_STATUS_FAILED, timeout_message, now, job_id],
                )
                .map_err(|err| err.to_string())?;
            log_job(
                connection,
                job_id,
                document_id,
                "error",
                step_name.as_deref(),
                &timeout_message,
                None,
            )?;
        }
    }

    Ok(stale_jobs.len() as i64)
}

pub(crate) fn execute_claimed_job(
    app: &tauri::AppHandle,
    connection: &Connection,
    job: &PipelineJobClaim,
) -> Result<(), String> {
    let now = current_timestamp_ms();
    connection
        .execute(
            r#"
            UPDATE knowledge_documents
            SET processing_status = ?2, error_message = NULL, active_job_id = ?3, updated_at = ?4
            WHERE id = ?1
            "#,
            params![job.document_id, DOCUMENT_STATUS_PROCESSING, job.id, now],
        )
        .map_err(|err| err.to_string())?;

    start_step(connection, job, "validate", 5)?;
    let document = load_document_source(connection, &job.document_id)?;
    if document.collection_id != job.collection_id || document.id != job.document_id {
        return Err("document/job mismatch".into());
    }
    let stored_file_path = document
        .stored_file_path
        .as_ref()
        .ok_or_else(|| "stored file path is missing".to_string())?;
    let bytes = fs::read(stored_file_path).map_err(|err| err.to_string())?;
    validate_upload_size(&bytes)?;
    finish_step(
        connection,
        job,
        "validate",
        STEP_STATUS_SUCCEEDED,
        100,
        None,
    )?;
    if matches!(check_job_control(connection, job)?, ControlFlow::Stop) {
        return Ok(());
    }

    start_step(connection, job, "parse", 20)?;
    let mut parsed = match parse_simple_document(
        &document.source_name,
        document.file_extension.as_deref(),
        document.mime_type.as_deref(),
        document.preview_type.as_deref(),
        &bytes,
        document.content.as_deref(),
    ) {
        Ok(parsed) => parsed,
        Err(err) => {
            mark_unsupported(connection, job, &err)?;
            return Ok(());
        }
    };
    finish_step(connection, job, "parse", STEP_STATUS_SUCCEEDED, 100, None)?;
    if matches!(check_job_control(connection, job)?, ControlFlow::Stop) {
        return Ok(());
    }

    let collection_multimodal =
        resolve_collection_multimodal_config(connection, &job.collection_id)?;
    let mut processing_warnings = Vec::new();
    let mut embedded_assets = Vec::new();

    if parsed.preview_type == "image" {
        start_step(connection, job, "enrich_image", 35)?;
        if !collection_multimodal.enabled || !collection_multimodal.image.enabled {
            skip_step(
                connection,
                job,
                "enrich_image",
                "image enrichment disabled for this collection",
            )?;
        } else if !collection_multimodal.image.extract_text
            && !collection_multimodal.image.generate_summary
        {
            skip_step(
                connection,
                job,
                "enrich_image",
                "image enrichment options disabled for this collection",
            )?;
        } else if let Some(model_id) = collection_multimodal
            .image
            .model_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let model = resolve_multimodal_model(connection, model_id, "image")
                .map_err(|err| format!("image enrichment failed: {err}"))?;
            let output = enrich_image_document(&document, &bytes, &model, &collection_multimodal)
                .map_err(|err| format!("image enrichment failed: {err}"))?;
            if let Some(extra_content) = output.content.as_deref() {
                parsed.content = merge_multimodal_content(&parsed.content, extra_content);
            }
            if let Some(warning) = output.warning {
                processing_warnings.push(warning.clone());
                log_job(
                    connection,
                    &job.id,
                    &job.document_id,
                    "warn",
                    Some("enrich_image"),
                    &warning,
                    parsed.metadata_json.as_deref(),
                )?;
            }
            finish_step(
                connection,
                job,
                "enrich_image",
                STEP_STATUS_SUCCEEDED,
                100,
                None,
            )?;
        } else {
            return Err(
                "image enrichment failed: image multimodal model is missing or unusable"
                    .to_string(),
            );
        }
    } else if matches!(parsed.preview_type.as_str(), "docx" | "pdf") {
        start_step(connection, job, "enrich_image", 35)?;
        let extraction_result = if parsed.preview_type == "docx" {
            crate::knowledge_embedded_images::extract_docx_embedded_images(&bytes)
        } else {
            crate::knowledge_embedded_images::extract_pdf_embedded_images(&bytes)
        };

        match extraction_result {
            Ok(extracted) => {
                if extracted.is_empty() {
                    skip_step(connection, job, "enrich_image", "no embedded images found")?;
                } else {
                    embedded_assets = extracted;
                    let image_analysis_enabled =
                        collection_multimodal.enabled && collection_multimodal.image.enabled;
                    let image_options_enabled = collection_multimodal.image.extract_text
                        || collection_multimodal.image.generate_summary;
                    let model_id = collection_multimodal
                        .image
                        .model_id
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty());
                    let resolved_model = if image_analysis_enabled && image_options_enabled {
                        match model_id {
                            Some(model_id) => {
                                match resolve_multimodal_model(connection, model_id, "image") {
                                    Ok(model) => Some(model),
                                    Err(err) => {
                                        let message =
                                            format!("embedded image enrichment unavailable: {err}");
                                        processing_warnings.push(message.clone());
                                        log_job(
                                            connection,
                                            &job.id,
                                            &job.document_id,
                                            "warn",
                                            Some("enrich_image"),
                                            &message,
                                            parsed.metadata_json.as_deref(),
                                        )?;
                                        None
                                    }
                                }
                            }
                            None => {
                                let message = "embedded image enrichment skipped: no usable image multimodal model is configured".to_string();
                                processing_warnings.push(message.clone());
                                log_job(
                                    connection,
                                    &job.id,
                                    &job.document_id,
                                    "warn",
                                    Some("enrich_image"),
                                    &message,
                                    parsed.metadata_json.as_deref(),
                                )?;
                                None
                            }
                        }
                    } else {
                        None
                    };

                    if let Some(model) = resolved_model.as_ref() {
                        for asset in &mut embedded_assets {
                            let asset_source = PipelineDocumentSource {
                                id: format!("{}:asset:{}", document.id, asset.asset_index),
                                collection_id: document.collection_id.clone(),
                                source_name: asset.source_name.clone(),
                                stored_file_path: None,
                                mime_type: asset.mime_type.clone(),
                                file_extension: asset.file_extension.clone(),
                                preview_type: Some("image".to_string()),
                                content: None,
                            };
                            match enrich_image_document(
                                &asset_source,
                                &asset.bytes,
                                model,
                                &collection_multimodal,
                            ) {
                                Ok(output) => {
                                    if output.ocr_text.is_some() {
                                        asset.ocr_text = output.ocr_text;
                                    }
                                    if output.summary.is_some() {
                                        asset.caption_text = output.summary;
                                    }
                                    if let Some(warning) = output.warning {
                                        processing_warnings.push(warning.clone());
                                        log_job(
                                            connection,
                                            &job.id,
                                            &job.document_id,
                                            "warn",
                                            Some("enrich_image"),
                                            &warning,
                                            parsed.metadata_json.as_deref(),
                                        )?;
                                    }
                                }
                                Err(err) => {
                                    let message = format!(
                                        "embedded image enrichment failed for {}: {err}",
                                        asset.source_name
                                    );
                                    processing_warnings.push(message.clone());
                                    log_job(
                                        connection,
                                        &job.id,
                                        &job.document_id,
                                        "warn",
                                        Some("enrich_image"),
                                        &message,
                                        parsed.metadata_json.as_deref(),
                                    )?;
                                }
                            }
                        }
                    } else if !image_analysis_enabled {
                        log_job(
                            connection,
                            &job.id,
                            &job.document_id,
                            "info",
                            Some("enrich_image"),
                            "stored embedded images without multimodal enrichment",
                            None,
                        )?;
                    }

                    finish_step(
                        connection,
                        job,
                        "enrich_image",
                        STEP_STATUS_SUCCEEDED,
                        100,
                        None,
                    )?;
                }
            }
            Err(err) => {
                let message = format!("embedded image extraction failed: {err}");
                processing_warnings.push(message.clone());
                log_job(
                    connection,
                    &job.id,
                    &job.document_id,
                    "warn",
                    Some("enrich_image"),
                    &message,
                    parsed.metadata_json.as_deref(),
                )?;
                skip_step(
                    connection,
                    job,
                    "enrich_image",
                    "embedded image extraction failed",
                )?;
            }
        }
    } else {
        skip_step(
            connection,
            job,
            "enrich_image",
            "image enrichment not applicable",
        )?;
    }
    if matches!(check_job_control(connection, job)?, ControlFlow::Stop) {
        return Ok(());
    }

    if parsed.preview_type == "audio" {
        start_step(connection, job, "enrich_audio", 45)?;
        if !collection_multimodal.enabled || !collection_multimodal.audio.enabled {
            skip_step(
                connection,
                job,
                "enrich_audio",
                "audio enrichment disabled for this collection",
            )?;
        } else if !collection_multimodal.audio.keep_transcript
            && !collection_multimodal.audio.generate_summary
        {
            skip_step(
                connection,
                job,
                "enrich_audio",
                "audio enrichment options disabled for this collection",
            )?;
        } else if let Some(model_id) = collection_multimodal
            .audio
            .model_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let model = resolve_multimodal_model(connection, model_id, "audio")
                .map_err(|err| format!("audio enrichment failed: {err}"))?;
            let output = enrich_audio_document(&document, &bytes, &model, &collection_multimodal)
                .map_err(|err| format!("audio enrichment failed: {err}"))?;
            if let Some(extra_content) = output.content.as_deref() {
                parsed.content = merge_multimodal_content(&parsed.content, extra_content);
            }
            if let Some(warning) = output.warning {
                processing_warnings.push(warning.clone());
                log_job(
                    connection,
                    &job.id,
                    &job.document_id,
                    "warn",
                    Some("enrich_audio"),
                    &warning,
                    parsed.metadata_json.as_deref(),
                )?;
            }
            finish_step(
                connection,
                job,
                "enrich_audio",
                STEP_STATUS_SUCCEEDED,
                100,
                None,
            )?;
        } else {
            return Err(
                "audio enrichment failed: audio multimodal model is missing or unusable"
                    .to_string(),
            );
        }
    } else {
        skip_step(
            connection,
            job,
            "enrich_audio",
            "audio enrichment not applicable",
        )?;
    }
    if matches!(check_job_control(connection, job)?, ControlFlow::Stop) {
        return Ok(());
    }

    complete_partial_job(
        app,
        connection,
        job,
        &document.source_name,
        document.file_extension.as_deref(),
        parsed,
        processing_warnings,
        embedded_assets,
    )
}

pub(crate) fn running_step_name(connection: &Connection, job_id: &str) -> Result<Option<String>, String> {
    connection
        .query_row(
            r#"
            SELECT step_name
            FROM knowledge_processing_steps
            WHERE job_id = ?1 AND status = ?2
            ORDER BY updated_at DESC, id DESC
            LIMIT 1
            "#,
            params![job_id, STEP_STATUS_RUNNING],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| err.to_string())
}

pub(crate) fn process_claimed_job(
    app: &tauri::AppHandle,
    job: PipelineJobClaim,
    max_auto_retries: i64,
) -> Result<(), String> {
    let connection = open_pipeline_connection(app)?;
    if let Err(err) = execute_claimed_job(app, &connection, &job) {
        let failed_step = running_step_name(&connection, &job.id)?;
        fail_job(
            &connection,
            &job,
            failed_step.as_deref(),
            &err,
            max_auto_retries,
        )?;
    }
    Ok(())
}

pub fn run_pipeline_worker_tick(app: &tauri::AppHandle) -> Result<bool, String> {
    // tick 每 750ms 触发一次，这里复用进程内缓存的连接，避免高频重复打开 SQLite。
    let tick_connection = pipeline_tick_connection(app)?;
    let connection: &Connection = &tick_connection;
    let settings = load_pipeline_settings(connection)?;
    if !settings.enabled {
        return Ok(false);
    }

    recover_timed_out_running_jobs(
        connection,
        settings.job_timeout_ms,
        settings.max_auto_retries,
    )?;
    let running_jobs = count_running_jobs(connection)?;
    let mut capacity = (settings.max_concurrent_jobs - running_jobs).max(0);
    if capacity <= 0 {
        return Ok(false);
    }

    let mut launched = 0_i64;
    while capacity > 0 {
        let maybe_job =
            claim_next_job_with_limits(connection, settings.per_collection_max_running)?;
        let Some(job) = maybe_job else {
            break;
        };

        let worker_app = app.clone();
        let retry_limit = settings.max_auto_retries;
        std::thread::spawn(move || {
            if let Err(err) = process_claimed_job(&worker_app, job, retry_limit) {
                eprintln!("[Omni] knowledge pipeline job execution error: {err}");
            }
        });
        launched += 1;
        capacity -= 1;
    }

    Ok(launched > 0)
}
