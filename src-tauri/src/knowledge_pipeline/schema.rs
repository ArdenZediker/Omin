//! 流水线相关表结构的建表与列补齐（幂等迁移）。
//!
//! 由 knowledge_pipeline 单文件拆分而来，保持逻辑不变。

use rusqlite::Connection;


pub(crate) fn table_has_column(connection: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let sql = format!("PRAGMA table_info({table})");
    let mut stmt = connection.prepare(&sql).map_err(|err| err.to_string())?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    Ok(columns.iter().any(|item| item == column))
}

pub fn ensure_pipeline_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
        CREATE TABLE IF NOT EXISTS knowledge_processing_jobs (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL,
          collection_id TEXT NOT NULL,
          job_type TEXT NOT NULL,
          status TEXT NOT NULL,
          current_step TEXT,
          progress INTEGER NOT NULL DEFAULT 0,
          attempt INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          priority INTEGER NOT NULL DEFAULT 0,
          fail_count INTEGER NOT NULL DEFAULT 0,
          next_run_at INTEGER,
          source_job_id TEXT,
          cancel_requested INTEGER NOT NULL DEFAULT 0,
          pause_requested INTEGER NOT NULL DEFAULT 0,
          error_message TEXT,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          finished_at INTEGER,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS knowledge_processing_steps (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          document_id TEXT NOT NULL,
          step_name TEXT NOT NULL,
          status TEXT NOT NULL,
          progress INTEGER NOT NULL DEFAULT 0,
          error_message TEXT,
          started_at INTEGER,
          finished_at INTEGER,
          updated_at INTEGER NOT NULL,
          UNIQUE(job_id, step_name)
        );

        CREATE TABLE IF NOT EXISTS knowledge_processing_logs (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          document_id TEXT NOT NULL,
          level TEXT NOT NULL,
          step_name TEXT,
          message TEXT NOT NULL,
          details_json TEXT,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS knowledge_parser_profiles (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          is_default INTEGER NOT NULL DEFAULT 0,
          config_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS knowledge_pipeline_settings (
          id TEXT PRIMARY KEY,
          settings_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS knowledge_processing_dead_letters (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL UNIQUE,
          document_id TEXT NOT NULL,
          collection_id TEXT NOT NULL,
          job_type TEXT NOT NULL,
          status TEXT NOT NULL,
          error_message TEXT,
          fail_count INTEGER NOT NULL DEFAULT 0,
          attempt INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 0,
          first_failed_at INTEGER NOT NULL,
          last_failed_at INTEGER NOT NULL,
          replayed_at INTEGER,
          replayed_job_id TEXT,
          resolved_at INTEGER,
          metadata_json TEXT
        );
        "#,
        )
        .map_err(|err| err.to_string())?;

    if !table_has_column(connection, "knowledge_processing_jobs", "priority")? {
        connection
            .execute(
                "ALTER TABLE knowledge_processing_jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|err| err.to_string())?;
    }
    if !table_has_column(connection, "knowledge_processing_jobs", "fail_count")? {
        connection
            .execute(
                "ALTER TABLE knowledge_processing_jobs ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|err| err.to_string())?;
    }
    if !table_has_column(connection, "knowledge_processing_jobs", "next_run_at")? {
        connection
            .execute(
                "ALTER TABLE knowledge_processing_jobs ADD COLUMN next_run_at INTEGER",
                [],
            )
            .map_err(|err| err.to_string())?;
    }
    if !table_has_column(connection, "knowledge_processing_jobs", "source_job_id")? {
        connection
            .execute(
                "ALTER TABLE knowledge_processing_jobs ADD COLUMN source_job_id TEXT",
                [],
            )
            .map_err(|err| err.to_string())?;
    }
    connection
        .execute_batch(
            r#"
        CREATE INDEX IF NOT EXISTS idx_knowledge_processing_jobs_status_next_run_created
          ON knowledge_processing_jobs(status, next_run_at, created_at, id);

        CREATE INDEX IF NOT EXISTS idx_knowledge_processing_jobs_collection_status_created
          ON knowledge_processing_jobs(collection_id, status, created_at, id);

        CREATE INDEX IF NOT EXISTS idx_knowledge_dead_letters_collection_status_failed_at
          ON knowledge_processing_dead_letters(collection_id, status, last_failed_at, id);
        "#,
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}
