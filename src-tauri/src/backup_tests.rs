use super::*;

#[path = "backup_verbatim_tests.rs"]
mod verbatim;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("omni-backup-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn source(&self) -> PathBuf {
        let root = self.0.join("source");
        fs::create_dir(&root).unwrap();
        let connection = rusqlite::Connection::open(root.join(DB_FILE_NAME)).unwrap();
        connection.execute_batch("CREATE TABLE app_kv(key TEXT PRIMARY KEY, value TEXT);
            INSERT INTO app_kv VALUES ('test', 'original');
            CREATE TABLE knowledge_documents(id TEXT PRIMARY KEY, stored_file_path TEXT);
            CREATE TABLE knowledge_document_assets(id TEXT PRIMARY KEY, stored_file_path TEXT);
            CREATE TABLE chat_sessions(id TEXT PRIMARY KEY, messages_json TEXT, workspace_path TEXT);").unwrap();
        let original = root.join("knowledge_files/c/d/source.txt");
        fs::create_dir_all(original.parent().unwrap()).unwrap();
        fs::write(&original, b"knowledge original").unwrap();
        connection
            .execute(
                "INSERT INTO knowledge_documents VALUES ('d', ?1)",
                [original.to_str().unwrap()],
            )
            .unwrap();
        let session = root.join("chat-sessions/project/s/session.jsonl");
        fs::create_dir_all(session.parent().unwrap()).unwrap();
        fs::write(
            session,
            "{\"__omni_session_format\":1}\n{\"role\":\"user\",\"content\":\"hello\"}\n",
        )
        .unwrap();
        fs::create_dir_all(root.join("persona")).unwrap();
        fs::write(root.join("persona/long-term-memory.md"), "记住这个决定").unwrap();
        fs::create_dir_all(root.join("fallback-workspace")).unwrap();
        fs::write(root.join("fallback-workspace/note.txt"), "workspace file").unwrap();
        fs::create_dir_all(root.join("pasted-attachments")).unwrap();
        fs::write(root.join("pasted-attachments/readme.txt"), "attachment").unwrap();
        connection
            .execute("INSERT INTO chat_sessions VALUES ('s', '[]', '')", [])
            .unwrap();
        root
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[cfg(unix)]
#[test]
fn checked_path_allows_system_temp_root_but_rejects_user_symlinks() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new();
    let link = fixture.0.join("user-link");
    symlink(fixture.source(), &link).unwrap();

    assert!(checked_path(&std::env::temp_dir()).is_ok());
    assert!(checked_path(&link).is_err());
}

#[test]
fn encrypted_roundtrip_restores_files() {
    let f = Fixture::new();
    let source = f.source();
    let zip = f.0.join("encrypted.zip");
    build_backup(&source, &zip, Some("secret")).unwrap();
    let target = f.0.join("restored");
    restore_backup(&zip, &target, Some("secret")).unwrap();
    assert_eq!(
        fs::read(target.join("knowledge_files/c/d/source.txt")).unwrap(),
        b"knowledge original"
    );
    assert!(target
        .join("chat-sessions/project/s/session.jsonl")
        .is_file());
    assert_eq!(
        fs::read_to_string(target.join("persona/long-term-memory.md")).unwrap(),
        "记住这个决定"
    );
    assert_eq!(
        fs::read_to_string(target.join("fallback-workspace/note.txt")).unwrap(),
        "workspace file"
    );
    assert_eq!(
        fs::read_to_string(target.join("pasted-attachments/readme.txt")).unwrap(),
        "attachment"
    );
}

#[test]
fn restore_refuses_nonempty_target_without_changing_bytes() {
    let f = Fixture::new();
    let source = f.source();
    let zip = f.0.join("backup.zip");
    build_backup(&source, &zip, None).unwrap();
    let target = f.0.join("occupied");
    fs::create_dir(&target).unwrap();
    fs::write(target.join(DB_FILE_NAME), b"existing user data").unwrap();
    assert!(restore_backup(&zip, &target, None).is_err());
    assert_eq!(
        fs::read(target.join(DB_FILE_NAME)).unwrap(),
        b"existing user data"
    );
}

#[test]
fn reject_portable_unsafe_entry_names() {
    for name in [
        "/absolute",
        "../outside",
        "a/../outside",
        "C:/outside",
        "C:outside",
        "\\\\server\\file",
        "a\\..\\outside",
        "a/file:stream",
        "a/NUL",
        "a/file.",
    ] {
        assert!(
            sanitize_entry(name).is_err(),
            "accepted unsafe path: {name}"
        );
    }
}

#[test]
fn backup_refuses_missing_internal_original() {
    let f = Fixture::new();
    let source = f.source();
    fs::remove_file(source.join("knowledge_files/c/d/source.txt")).unwrap();
    let zip = f.0.join("backup.zip");
    assert!(build_backup(&source, &zip, None).is_err());
    assert!(!zip.exists());
}

#[test]
fn wrong_password_does_not_create_target() {
    let f = Fixture::new();
    let source = f.source();
    let zip = f.0.join("backup.zip");
    build_backup(&source, &zip, Some("right")).unwrap();
    let target = f.0.join("restored");
    assert!(restore_backup(&zip, &target, Some("wrong")).is_err());
    assert!(!target.exists());
}

#[test]
fn failed_export_preserves_existing_archive() {
    let f = Fixture::new();
    let source = f.source();
    fs::remove_file(source.join("knowledge_files/c/d/source.txt")).unwrap();
    let zip = f.0.join("backup.zip");
    fs::write(&zip, b"last good backup").unwrap();
    assert!(build_backup(&source, &zip, None).is_err());
    assert_eq!(fs::read(zip).unwrap(), b"last good backup");
}

#[test]
fn backup_waits_for_an_inflight_database_and_jsonl_write() {
    use std::sync::{mpsc, Arc};
    use std::time::{Duration, Instant};

    let fixture = Fixture::new();
    let source = fixture.source();
    let archive = fixture.0.join("concurrent.zip");
    let gate = Arc::new(crate::database::maintenance::Gate::default());
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let writer_gate = Arc::clone(&gate);
    let writer_source = source.clone();
    let writer = std::thread::spawn(move || {
        let _operation = writer_gate.operation().unwrap();
        let db = rusqlite::Connection::open(writer_source.join(DB_FILE_NAME)).unwrap();
        db.execute("UPDATE app_kv SET value='after' WHERE key='test'", [])
            .unwrap();
        fs::write(
            writer_source.join("chat-sessions/project/s/session.jsonl"),
            "{\"__omni_session_format\":1}\n{\"role\":\"user\",\"content\":\"after\"}\n",
        )
        .unwrap();
        started_tx.send(()).unwrap();
        release_rx.recv().unwrap();
    });
    started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let backup_gate = Arc::clone(&gate);
    let backup_source = source.clone();
    let backup_archive = archive.clone();
    let backup = std::thread::spawn(move || {
        let _maintenance = backup_gate.maintenance(Duration::from_secs(3)).unwrap();
        build_backup(&backup_source, &backup_archive, None).unwrap();
    });
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match gate.operation() {
            Err(_) => break,
            Ok(operation) => drop(operation),
        }
        assert!(
            Instant::now() < deadline,
            "maintenance did not start draining"
        );
        std::thread::yield_now();
    }
    assert!(
        !backup.is_finished(),
        "backup escaped the inflight operation"
    );
    release_tx.send(()).unwrap();
    writer.join().unwrap();
    backup.join().unwrap();
    let restored = fixture.0.join("concurrent-restored");
    restore_backup(&archive, &restored, None).unwrap();
    let db = rusqlite::Connection::open(restored.join(DB_FILE_NAME)).unwrap();
    let value: String = db
        .query_row("SELECT value FROM app_kv WHERE key='test'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(value, "after");
    assert!(
        fs::read_to_string(restored.join("chat-sessions/project/s/session.jsonl"))
            .unwrap()
            .contains("after")
    );
}

#[test]
fn migration_copies_complete_snapshot_and_rebases_internal_paths() {
    let fixture = Fixture::new();
    let source = fixture.source();
    let destination = fixture.0.join("migrated");
    let session = source.join("chat-sessions/project/s/session.jsonl");
    fs::write(
        &session,
        format!(
            "{{\"__omni_session_format\":1}}\n{{\"role\":\"assistant\",\"filePath\":{}}}\n",
            serde_json::to_string(
                &source
                    .join("pasted-attachments/readme.txt")
                    .to_string_lossy()
            )
            .unwrap()
        ),
    )
    .unwrap();
    let db = rusqlite::Connection::open(source.join(DB_FILE_NAME)).unwrap();
    db.execute(
        "UPDATE chat_sessions SET workspace_path=?1 WHERE id='s'",
        [source.join("fallback-workspace").to_string_lossy().as_ref()],
    )
    .unwrap();
    drop(db);

    checked_path(&source).expect("source path check");
    checked_path(&destination).expect("destination path check");
    let published = migrate_snapshot(&source, &destination).unwrap();
    assert_eq!(published, checked_path(&destination).unwrap());
    assert!(crate::storage_paths::path_risk(&published).is_none());
    assert_eq!(
        fs::read_to_string(published.join("persona/long-term-memory.md")).unwrap(),
        "记住这个决定"
    );
    assert_eq!(
        fs::read_to_string(published.join("pasted-attachments/readme.txt")).unwrap(),
        "attachment"
    );
    let migrated_session =
        fs::read_to_string(published.join("chat-sessions/project/s/session.jsonl")).unwrap();
    let attachment_path: String =
        serde_json::from_str::<serde_json::Value>(migrated_session.lines().nth(1).unwrap())
            .unwrap()["filePath"]
            .as_str()
            .unwrap()
            .to_string();
    assert_eq!(
        attachment_path,
        published
            .join("pasted-attachments/readme.txt")
            .to_string_lossy()
    );
    let migrated_db = rusqlite::Connection::open(published.join(DB_FILE_NAME)).unwrap();
    let workspace: String = migrated_db
        .query_row(
            "SELECT workspace_path FROM chat_sessions WHERE id='s'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        workspace,
        published.join("fallback-workspace").to_string_lossy()
    );
    let stored: String = migrated_db
        .query_row(
            "SELECT stored_file_path FROM knowledge_documents WHERE id='d'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        stored,
        published
            .join("knowledge_files/c/d/source.txt")
            .to_string_lossy()
    );
}

#[test]
fn migration_refuses_nonempty_target_without_changing_existing_bytes() {
    let fixture = Fixture::new();
    let source = fixture.source();
    let target = fixture.0.join("occupied");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("keep.txt"), b"user data").unwrap();
    assert!(migrate_snapshot(&source, &target).is_err());
    assert_eq!(fs::read(target.join("keep.txt")).unwrap(), b"user data");
    assert_eq!(fs::read_dir(target).unwrap().count(), 1);
}

#[test]
fn migration_refuses_source_ancestors_and_descendants() {
    let fixture = Fixture::new();
    let source = fixture.source();
    assert!(migrate_snapshot(&source, &fixture.0).is_err());
    let nested = source.join("nested-new-target");
    assert!(migrate_snapshot(&source, &nested).is_err());
    assert!(!nested.exists());
    assert!(source.join(DB_FILE_NAME).is_file());
}

#[test]
fn migration_failure_cleans_staging_without_publishing_target() {
    let fixture = Fixture::new();
    let source = fixture.source();
    fs::remove_file(source.join("knowledge_files/c/d/source.txt")).unwrap();
    let target = fixture.0.join("target-after-invalid-source");
    assert!(migrate_snapshot(&source, &target).is_err());
    assert!(!target.exists());
    assert!(source.join(DB_FILE_NAME).is_file());
    assert!(!fs::read_dir(&fixture.0).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".omni-staging-")
    }));
}

#[test]
#[ignore = "requires an existing encrypted backup and an empty target via environment variables"]
fn restore_existing_backup_from_environment() {
    let backup = std::env::var_os("OMNI_RESTORE_SMOKE_ZIP")
        .expect("OMNI_RESTORE_SMOKE_ZIP must point to an encrypted backup");
    let target = std::env::var_os("OMNI_RESTORE_SMOKE_TARGET")
        .expect("OMNI_RESTORE_SMOKE_TARGET must point to an empty directory");
    let secret = std::env::var("OMNI_RESTORE_SMOKE_SECRET")
        .expect("OMNI_RESTORE_SMOKE_SECRET must contain the backup password");
    restore_backup(Path::new(&backup), Path::new(&target), Some(&secret)).unwrap();
}
