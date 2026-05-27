use reqwest::blocking::Client as BlockingHttpClient;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::{
    cmp::Ordering,
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

mod knowledge_chunker;
mod knowledge_pipeline;

#[derive(Serialize)]
struct WorkspaceFileEntry {
    path: String,
    is_dir: bool,
}

#[derive(Serialize)]
struct WorkspaceSearchMatch {
    path: String,
    line_number: usize,
    line_preview: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatStoragePayload {
    assistants_json: Option<String>,
    sessions_json: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestStoragePayload {
    assistant_presets_json: Option<String>,
    tool_manifests_json: Option<String>,
    skill_manifests_json: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryStoragePayload {
    assistant_memories_json: Option<String>,
    user_preferences_json: Option<String>,
    session_summaries_json: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AutomationStoragePayload {
    scheduled_tasks_json: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppStoragePayload {
    entries: HashMap<String, String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CodexPetPackageRecord {
    id: String,
    display_name: String,
    description: String,
    spritesheet_path: String,
    spritesheet_web_path: String,
    package_dir: String,
    manifest_path: String,
    spritesheet_exists: bool,
    source: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexPetPackageListPayload {
    packages: Vec<CodexPetPackageRecord>,
    active_pet_id: Option<String>,
    codex_home: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexPetManifestInput {
    id: String,
    display_name: String,
    description: String,
    spritesheet_path: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DbAssistantProfile {
    id: String,
    kind: String,
    source_preset_id: Option<String>,
    title: String,
    description: String,
    system_prompt: Option<String>,
    default_model_id: Option<String>,
    allowed_tool_ids: Vec<String>,
    allowed_skill_ids: Vec<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DbChatUsageStats {
    request_count: i64,
    prompt_tokens: i64,
    completion_tokens: i64,
    total_tokens: i64,
    total_cost_usd: f64,
    last_model: Option<String>,
    last_used_at: Option<i64>,
    has_estimated_usage: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DbChatSession {
    id: String,
    assistant_id: String,
    title: String,
    messages: serde_json::Value,
    pinned: Option<bool>,
    favorite: Option<bool>,
    created_at: i64,
    updated_at: i64,
    usage: DbChatUsageStats,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DbProviderConfigRecord {
    api_key: String,
    base_url: Option<String>,
    name: Option<String>,
    custom_models: Option<JsonValue>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeCollectionRecord {
    id: String,
    name: String,
    description: String,
    retrieval_mode: String,
    embedding_profile_id: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeDocumentRecord {
    id: String,
    collection_id: String,
    source_name: String,
    source_path: Option<String>,
    stored_file_path: Option<String>,
    mime_type: Option<String>,
    file_extension: Option<String>,
    preview_type: Option<String>,
    content: Option<String>,
    content_preview: String,
    thumbnail_data_url: Option<String>,
    file_hash: Option<String>,
    file_size: Option<i64>,
    processing_status: Option<String>,
    error_message: Option<String>,
    active_job_id: Option<String>,
    content_version: Option<i64>,
    parser_profile_id: Option<String>,
    last_processed_at: Option<i64>,
    chunk_count: i64,
    vectorized_chunk_count: i64,
    vectorization_state: String,
    tags: Vec<String>,
    favorite: bool,
    access_count: i64,
    last_accessed_at: Option<i64>,
    title_hierarchy: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeChunkRecord {
    id: String,
    document_id: String,
    collection_id: String,
    chunk_index: i64,
    title: Option<String>,
    content: String,
    embedding_json: Option<String>,
    embedding_model_key: Option<String>,
    created_at: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeLibraryPayload {
    collections: Vec<KnowledgeCollectionRecord>,
    documents: Vec<KnowledgeDocumentRecord>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeDocumentDetailPayload {
    document: KnowledgeDocumentRecord,
    chunks: Vec<KnowledgeChunkRecord>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportKnowledgeDocumentInput {
    collection_id: Option<String>,
    source_name: String,
    source_path: Option<String>,
    content: String,
    content_bytes: Option<Vec<u8>>,
    mime_type: Option<String>,
    file_extension: Option<String>,
    preview_type: Option<String>,
    thumbnail_data_url: Option<String>,
    tags: Option<Vec<String>>,
    title_hierarchy: Option<String>,
    favorite: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateKnowledgeCollectionInput {
    collection_id: String,
    name: Option<String>,
    description: Option<String>,
    retrieval_mode: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct KnowledgeEmbeddingModelConfigRecord {
    id: String,
    name: String,
    provider: String,
    base_url: String,
    model: String,
    api_key: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct KnowledgeEmbeddingConfigRecord {
    enabled: bool,
    active_model_id: String,
    models: Vec<KnowledgeEmbeddingModelConfigRecord>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchKnowledgeChunksInput {
    query: String,
    limit: Option<usize>,
    collection_id: Option<String>,
    query_embedding: Option<Vec<f64>>,
    query_embedding_model_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RevectorizeKnowledgeDocumentInput {
    document_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadKnowledgeDocumentInput {
    document_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadKnowledgeDocumentFileInput {
    document_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeDocumentBinaryPayload {
    bytes: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchKnowledgeChunkResult {
    chunk: KnowledgeChunkRecord,
    score: f64,
    source_name: String,
    source_path: Option<String>,
    collection_name: String,
    tags: Vec<String>,
    favorite: bool,
    access_count: i64,
    last_accessed_at: Option<i64>,
    title_hierarchy: Option<String>,
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("你好，{}！欢迎使用 Omni AI 助手！", name)
}

fn validate_codex_pet_id(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_lowercase();
    if normalized.is_empty() {
        return Err("pet id is required".into());
    }

    if !normalized
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' || ch == '_')
    {
        return Err(
            "pet id may only contain lowercase letters, digits, hyphen, or underscore".into(),
        );
    }

    Ok(normalized)
}

fn read_codex_pet_manifest(path: &Path) -> Result<Option<CodexPetManifestInput>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let manifest =
        serde_json::from_str::<CodexPetManifestInput>(&raw).map_err(|err| err.to_string())?;
    Ok(Some(manifest))
}

fn codex_pet_template_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(root) = project_pets_root() {
        candidates.push(root.join("omni-schnauzer/spritesheet.webp"));
        candidates.push(root.join("ikun-hoops/spritesheet.webp"));
        candidates.push(root.join("Gardevoir/spritesheet.webp"));
    }

    candidates
}

fn copy_codex_pet_template(target: &Path) -> Result<(), String> {
    for candidate in codex_pet_template_candidates() {
        if candidate.exists() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|err| err.to_string())?;
            }
            fs::copy(&candidate, target).map_err(|err| err.to_string())?;
            return Ok(());
        }
    }

    Err("no spritesheet template was found for a new pet package".into())
}

fn load_codex_pet_package_record(
    package_dir: &Path,
) -> Result<Option<CodexPetPackageRecord>, String> {
    let manifest_path = package_dir.join("pet.json");
    let Some(manifest) = read_codex_pet_manifest(&manifest_path)? else {
        return Ok(None);
    };

    let id = validate_codex_pet_id(&manifest.id)?;
    let display_name = manifest.display_name.trim().to_string();
    let description = manifest.description.trim().to_string();
    let spritesheet_path = manifest.spritesheet_path.trim().to_string();
    let spritesheet_file_path = package_dir.join(&spritesheet_path);
    let spritesheet_exists = spritesheet_file_path.exists();
    let package_name = package_dir
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&id);
    let spritesheet_web_path = format!(
        "/pets/{package_name}/{}",
        spritesheet_path.replace('\\', "/")
    );

    Ok(Some(CodexPetPackageRecord {
        id,
        display_name,
        description,
        spritesheet_path,
        spritesheet_web_path,
        package_dir: package_dir.to_string_lossy().to_string(),
        manifest_path: manifest_path.to_string_lossy().to_string(),
        spritesheet_exists,
        source: "custom".to_string(),
    }))
}

#[tauri::command]
fn load_codex_pet_packages() -> Result<CodexPetPackageListPayload, String> {
    let pet_root = current_pet_root()?;
    fs::create_dir_all(&pet_root).map_err(|err| err.to_string())?;

    let mut packages = Vec::new();
    for entry in fs::read_dir(&pet_root).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let package_dir = entry.path();
        if !package_dir.is_dir() {
            continue;
        }

        if let Some(record) = load_codex_pet_package_record(&package_dir)? {
            packages.push(record);
        }
    }

    packages.sort_by(|left, right| {
        left.display_name
            .to_lowercase()
            .cmp(&right.display_name.to_lowercase())
            .then_with(|| left.id.cmp(&right.id))
    });

    let active_pet_id = packages
        .iter()
        .find(|package| package.spritesheet_exists)
        .or_else(|| packages.first())
        .map(|package| package.id.clone());

    Ok(CodexPetPackageListPayload {
        packages,
        active_pet_id,
        codex_home: pet_root.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn create_codex_pet_package() -> Result<CodexPetPackageRecord, String> {
    let pet_root = current_pet_root()?;
    fs::create_dir_all(&pet_root).map_err(|err| err.to_string())?;

    let base_id = "new-pet";
    let mut pet_id = base_id.to_string();
    let mut suffix = 1;
    while pet_root.join(&pet_id).exists() {
        pet_id = format!("{base_id}-{suffix}");
        suffix += 1;
    }

    let package_dir = pet_root.join(&pet_id);
    fs::create_dir_all(&package_dir).map_err(|err| err.to_string())?;

    let spritesheet_path = package_dir.join("spritesheet.webp");
    copy_codex_pet_template(&spritesheet_path)?;

    let manifest = CodexPetManifestInput {
        id: pet_id.clone(),
        display_name: "New Pet".to_string(),
        description: "Custom Codex pet package.".to_string(),
        spritesheet_path: "spritesheet.webp".to_string(),
    };
    let manifest_path = package_dir.join("pet.json");
    let manifest_json = serde_json::to_string_pretty(&manifest).map_err(|err| err.to_string())?;
    fs::write(&manifest_path, format!("{manifest_json}\n")).map_err(|err| err.to_string())?;

    Ok(CodexPetPackageRecord {
        id: manifest.id,
        display_name: manifest.display_name,
        description: manifest.description,
        spritesheet_path: manifest.spritesheet_path,
        spritesheet_web_path: format!("/pets/{pet_id}/spritesheet.webp"),
        package_dir: package_dir.to_string_lossy().to_string(),
        manifest_path: manifest_path.to_string_lossy().to_string(),
        spritesheet_exists: true,
        source: "custom".to_string(),
    })
}

fn workspace_root() -> Result<PathBuf, String> {
    let current_dir = std::env::current_dir().map_err(|err| err.to_string())?;
    if current_dir.file_name().and_then(|name| name.to_str()) == Some("src-tauri") {
        return current_dir
            .parent()
            .map(PathBuf::from)
            .ok_or_else(|| "Unable to resolve workspace root".to_string());
    }
    Ok(current_dir)
}

fn project_pets_root() -> Result<PathBuf, String> {
    let root = workspace_root()?;
    let pets_root = root.join("public").join("pets");
    fs::create_dir_all(&pets_root).map_err(|err| err.to_string())?;
    Ok(pets_root)
}

fn current_pet_root() -> Result<PathBuf, String> {
    project_pets_root()
}

#[tauri::command]
fn load_workspace_pet_dir_command() -> Result<String, String> {
    Ok(current_pet_root()?.to_string_lossy().to_string())
}

fn current_timestamp_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn knowledge_files_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    let root = app_data_dir.join("knowledge_files");
    fs::create_dir_all(&root).map_err(|err| err.to_string())?;
    Ok(root)
}

fn sanitize_storage_file_name(value: &str) -> String {
    let mut cleaned = value
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ if ch.is_control() => '_',
            _ => ch,
        })
        .collect::<String>();
    cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.is_empty() {
        "document".to_string()
    } else {
        cleaned
    }
}

fn file_extension_from_name(value: &str) -> Option<String> {
    Path::new(value)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.trim().to_lowercase())
        .filter(|ext| !ext.is_empty())
}

fn normalize_file_extension(extension: Option<String>, source_name: &str) -> Option<String> {
    extension
        .and_then(|value| {
            let trimmed = value.trim().trim_start_matches('.').to_lowercase();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        })
        .or_else(|| file_extension_from_name(source_name))
}

fn infer_preview_type(extension: Option<&str>, mime_type: Option<&str>) -> String {
    let extension = extension.unwrap_or_default().to_lowercase();
    let mime_type = mime_type.unwrap_or_default().to_lowercase();

    if matches!(
        extension.as_str(),
        "md" | "markdown"
            | "txt"
            | "log"
            | "json"
            | "csv"
            | "tsv"
            | "html"
            | "htm"
            | "xml"
            | "yml"
            | "yaml"
            | "js"
            | "jsx"
            | "ts"
            | "tsx"
            | "py"
            | "rs"
            | "css"
            | "toml"
            | "ini"
            | "sql"
            | "sh"
            | "bat"
            | "cmd"
    ) || mime_type.starts_with("text/")
        || mime_type == "application/json"
    {
        return if extension == "md" || extension == "markdown" {
            "markdown".to_string()
        } else {
            "text".to_string()
        };
    }

    if matches!(extension.as_str(), "pdf") || mime_type == "application/pdf" {
        return "pdf".to_string();
    }

    if matches!(extension.as_str(), "docx")
        || mime_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    {
        return "docx".to_string();
    }

    if matches!(
        extension.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "avif" | "ico"
    ) || mime_type.starts_with("image/")
    {
        return "image".to_string();
    }

    if matches!(extension.as_str(), "doc" | "rtf") {
        return "unsupported".to_string();
    }

    "unsupported".to_string()
}

fn document_file_name(source_name: &str, document_id: &str) -> String {
    let base = sanitize_storage_file_name(source_name);
    if base == "document" {
        format!("{document_id}.bin")
    } else {
        base
    }
}

fn store_knowledge_document_bytes(
    app: &tauri::AppHandle,
    collection_id: &str,
    document_id: &str,
    source_name: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    let collection_dir = sanitize_storage_file_name(collection_id);
    let document_dir = sanitize_storage_file_name(document_id);
    let file_name = document_file_name(source_name, document_id);
    let stored_path = knowledge_files_root(app)?
        .join(collection_dir)
        .join(document_dir)
        .join(file_name);
    if let Some(parent) = stored_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(&stored_path, bytes).map_err(|err| err.to_string())?;
    Ok(stored_path)
}

fn delete_stored_document_file(path: Option<&str>) {
    let Some(path) = path else {
        return;
    };

    let stored_path = PathBuf::from(path);
    if stored_path.is_file() {
        let _ = fs::remove_file(&stored_path);
    }

    fn remove_if_empty(path: &Path) {
        if !path.is_dir() {
            return;
        }

        let is_empty = fs::read_dir(path)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);
        if is_empty {
            let _ = fs::remove_dir(path);
        }
    }

    if let Some(document_dir) = stored_path.parent() {
        remove_if_empty(document_dir);
        if let Some(collection_dir) = document_dir.parent() {
            remove_if_empty(collection_dir);
        }
    }
}

fn run_database_migrations(connection: &Connection) -> Result<(), String> {
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|err| err.to_string())?;

    if version < 1 {
        connection
            .execute_batch("PRAGMA user_version = 1;")
            .map_err(|err| err.to_string())?;
    }

    if version < 2 {
        connection
            .execute_batch("PRAGMA user_version = 2;")
            .map_err(|err| err.to_string())?;
    }

    if version < 3 {
        connection
            .execute_batch("PRAGMA user_version = 3;")
            .map_err(|err| err.to_string())?;
    }

    if version < 4 {
        connection
            .execute_batch("PRAGMA user_version = 4;")
            .map_err(|err| err.to_string())?;
    }

    Ok(())
}

fn sqlite_db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|err| err.to_string())?;
    Ok(app_data_dir.join("omni.sqlite3"))
}

pub(crate) fn open_sqlite_connection(app: &tauri::AppHandle) -> Result<Connection, String> {
    let connection = Connection::open(sqlite_db_path(app)?).map_err(|err| err.to_string())?;
    connection
        .execute_batch(
            r#"
        CREATE TABLE IF NOT EXISTS app_kv (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS window_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS provider_configs (
          provider TEXT PRIMARY KEY,
          api_key TEXT NOT NULL,
          base_url TEXT,
          name TEXT,
          custom_models_json TEXT,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS model_connection_status (
          model_id TEXT PRIMARY KEY,
          connected INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS assistants (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          source_preset_id TEXT,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          system_prompt TEXT,
          default_model_id TEXT,
          allowed_tool_ids_json TEXT NOT NULL,
          allowed_skill_ids_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS assistant_presets (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          avatar_code TEXT,
          system_prompt TEXT,
          default_model_id TEXT,
          allowed_tool_ids_json TEXT NOT NULL,
          allowed_skill_ids_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tool_manifests (
          id TEXT PRIMARY KEY,
          payload_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS skill_manifests (
          id TEXT PRIMARY KEY,
          payload_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS assistant_memories (
          id TEXT PRIMARY KEY,
          assistant_id TEXT NOT NULL,
          content TEXT NOT NULL,
          source_session_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS user_preferences (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS session_summaries (
          session_id TEXT PRIMARY KEY,
          assistant_id TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS scheduled_tasks (
          id TEXT PRIMARY KEY,
          payload_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chat_sessions (
          id TEXT PRIMARY KEY,
          assistant_id TEXT NOT NULL,
          title TEXT NOT NULL,
          messages_json TEXT NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0,
          favorite INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          usage_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS knowledge_collections (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          retrieval_mode TEXT NOT NULL DEFAULT 'hybrid',
          embedding_profile_id TEXT,
          created_at INTEGER NOT NULL,
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
        .map_err(|err| err.to_string())?;
    run_database_migrations(&connection)?;
    ensure_storage_migrations(&connection)?;
    ensure_knowledge_schema(&connection)?;
    ensure_knowledge_defaults(&connection)?;
    Ok(connection)
}

fn read_kv(connection: &Connection, key: &str) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT value FROM app_kv WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| err.to_string())
}

fn write_kv(connection: &Connection, key: &str, value: &str) -> Result<(), String> {
    connection
        .execute(
            r#"
            INSERT INTO app_kv (key, value, updated_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(key) DO UPDATE SET
              value = excluded.value,
              updated_at = excluded.updated_at
            "#,
            params![key, value, current_timestamp_ms()],
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn remove_kv(connection: &Connection, key: &str) -> Result<(), String> {
    connection
        .execute("DELETE FROM app_kv WHERE key = ?1", params![key])
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn is_window_state_key(key: &str) -> bool {
    matches!(
        key,
        "omni_main_view" | "omni_compact_position" | "omni_main_position"
    )
}

fn is_provider_config_key(key: &str) -> bool {
    key == "omni_provider_configs"
}

fn is_model_connection_status_key(key: &str) -> bool {
    key == "omni_model_connection_status"
}

fn is_knowledge_embedding_config_key(key: &str) -> bool {
    key == "omni_knowledge_embedding_profile"
}

fn read_simple_table_value(
    connection: &Connection,
    table: &str,
    key: &str,
) -> Result<Option<String>, String> {
    let sql = format!("SELECT value FROM {table} WHERE key = ?1");
    connection
        .query_row(&sql, params![key], |row| row.get(0))
        .optional()
        .map_err(|err| err.to_string())
}

fn write_simple_table_value(
    connection: &Connection,
    table: &str,
    key: &str,
    value: &str,
) -> Result<(), String> {
    let sql = format!(
        r#"
        INSERT INTO {table} (key, value, updated_at)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
        "#
    );

    connection
        .execute(&sql, params![key, value, current_timestamp_ms()])
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn remove_simple_table_value(
    connection: &Connection,
    table: &str,
    key: &str,
) -> Result<(), String> {
    let sql = format!("DELETE FROM {table} WHERE key = ?1");
    connection
        .execute(&sql, params![key])
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn read_provider_configs_value(connection: &Connection) -> Result<Option<String>, String> {
    let mut stmt = connection
        .prepare(
            r#"
            SELECT provider, api_key, base_url, name, custom_models_json
            FROM provider_configs
            ORDER BY provider ASC
            "#,
        )
        .map_err(|err| err.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    if rows.is_empty() {
        return Ok(None);
    }

    let mut result = JsonMap::new();
    for (provider, api_key, base_url, name, custom_models_json) in rows {
        let mut item = JsonMap::new();
        item.insert("apiKey".into(), JsonValue::String(api_key));
        if let Some(base_url) = base_url {
            item.insert("baseUrl".into(), JsonValue::String(base_url));
        }
        if let Some(name) = name {
            item.insert("name".into(), JsonValue::String(name));
        }
        if let Some(custom_models_json) = custom_models_json {
            let parsed = serde_json::from_str::<JsonValue>(&custom_models_json)
                .unwrap_or(JsonValue::Array(Vec::new()));
            item.insert("customModels".into(), parsed);
        }
        result.insert(provider, JsonValue::Object(item));
    }

    Ok(Some(
        serde_json::to_string(&JsonValue::Object(result)).map_err(|err| err.to_string())?,
    ))
}

fn write_provider_configs_value(connection: &Connection, value: &str) -> Result<(), String> {
    let parsed: JsonMap<String, JsonValue> =
        serde_json::from_str(value).map_err(|err| err.to_string())?;
    let tx = connection
        .unchecked_transaction()
        .map_err(|err| err.to_string())?;
    tx.execute("DELETE FROM provider_configs", [])
        .map_err(|err| err.to_string())?;

    {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO provider_configs (provider, api_key, base_url, name, custom_models_json, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                "#,
            )
            .map_err(|err| err.to_string())?;

        for (provider, item) in parsed {
            let record: DbProviderConfigRecord =
                serde_json::from_value(item).map_err(|err| err.to_string())?;
            stmt.execute(params![
                provider,
                record.api_key,
                record.base_url,
                record.name,
                record
                    .custom_models
                    .map(|value| serde_json::to_string(&value))
                    .transpose()
                    .map_err(|err| err.to_string())?,
                current_timestamp_ms(),
            ])
            .map_err(|err| err.to_string())?;
        }
    }

    tx.commit().map_err(|err| err.to_string())?;
    Ok(())
}

fn remove_provider_configs_value(connection: &Connection) -> Result<(), String> {
    connection
        .execute("DELETE FROM provider_configs", [])
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn read_model_connection_status_value(connection: &Connection) -> Result<Option<String>, String> {
    let mut stmt = connection
        .prepare("SELECT model_id, connected FROM model_connection_status ORDER BY model_id ASC")
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0))
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    if rows.is_empty() {
        return Ok(None);
    }

    let mut result = JsonMap::new();
    for (model_id, connected) in rows {
        result.insert(model_id, JsonValue::Bool(connected));
    }

    Ok(Some(
        serde_json::to_string(&JsonValue::Object(result)).map_err(|err| err.to_string())?,
    ))
}

fn write_model_connection_status_value(connection: &Connection, value: &str) -> Result<(), String> {
    let parsed: HashMap<String, bool> =
        serde_json::from_str(value).map_err(|err| err.to_string())?;
    let tx = connection
        .unchecked_transaction()
        .map_err(|err| err.to_string())?;
    tx.execute("DELETE FROM model_connection_status", [])
        .map_err(|err| err.to_string())?;

    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO model_connection_status (model_id, connected, updated_at) VALUES (?1, ?2, ?3)",
            )
            .map_err(|err| err.to_string())?;

        for (model_id, connected) in parsed {
            stmt.execute(params![
                model_id,
                if connected { 1_i64 } else { 0_i64 },
                current_timestamp_ms()
            ])
            .map_err(|err| err.to_string())?;
        }
    }

    tx.commit().map_err(|err| err.to_string())?;
    Ok(())
}

fn remove_model_connection_status_value(connection: &Connection) -> Result<(), String> {
    connection
        .execute("DELETE FROM model_connection_status", [])
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn read_structured_app_value(connection: &Connection, key: &str) -> Result<Option<String>, String> {
    if is_provider_config_key(key) {
        return read_provider_configs_value(connection);
    }
    if is_model_connection_status_key(key) {
        return read_model_connection_status_value(connection);
    }
    if is_knowledge_embedding_config_key(key) {
        return read_kv(connection, key);
    }
    if is_window_state_key(key) {
        return read_simple_table_value(connection, "window_state", key);
    }
    read_simple_table_value(connection, "app_settings", key)
}

fn write_structured_app_value(
    connection: &Connection,
    key: &str,
    value: &str,
) -> Result<(), String> {
    if is_provider_config_key(key) {
        return write_provider_configs_value(connection, value);
    }
    if is_model_connection_status_key(key) {
        return write_model_connection_status_value(connection, value);
    }
    if is_knowledge_embedding_config_key(key) {
        return write_kv(connection, key, value);
    }
    if is_window_state_key(key) {
        return write_simple_table_value(connection, "window_state", key, value);
    }
    write_simple_table_value(connection, "app_settings", key, value)
}

fn remove_structured_app_value(connection: &Connection, key: &str) -> Result<(), String> {
    if is_provider_config_key(key) {
        return remove_provider_configs_value(connection);
    }
    if is_model_connection_status_key(key) {
        return remove_model_connection_status_value(connection);
    }
    if is_knowledge_embedding_config_key(key) {
        return remove_kv(connection, key);
    }
    if is_window_state_key(key) {
        return remove_simple_table_value(connection, "window_state", key);
    }
    remove_simple_table_value(connection, "app_settings", key)
}

fn has_structured_chat_storage(connection: &Connection) -> Result<bool, String> {
    let assistant_count: i64 = connection
        .query_row("SELECT COUNT(1) FROM assistants", [], |row| row.get(0))
        .map_err(|err| err.to_string())?;
    let session_count: i64 = connection
        .query_row("SELECT COUNT(1) FROM chat_sessions", [], |row| row.get(0))
        .map_err(|err| err.to_string())?;
    Ok(assistant_count > 0 || session_count > 0)
}

fn load_structured_chat_storage(connection: &Connection) -> Result<ChatStoragePayload, String> {
    let mut assistant_stmt = connection
        .prepare(
            r#"
            SELECT id, kind, title, description, system_prompt, default_model_id, allowed_tool_ids_json, allowed_skill_ids_json, created_at, updated_at
            SELECT id, kind, source_preset_id, title, description, system_prompt, default_model_id, allowed_tool_ids_json, allowed_skill_ids_json, created_at, updated_at
            FROM assistants
            ORDER BY created_at ASC, id ASC
            "#,
        )
        .map_err(|err| err.to_string())?;

    let assistants = assistant_stmt
        .query_map([], |row| {
            let allowed_tool_ids_json: String = row.get(7)?;
            let allowed_skill_ids_json: String = row.get(8)?;

            Ok(DbAssistantProfile {
                id: row.get(0)?,
                kind: row.get(1)?,
                source_preset_id: row.get(2)?,
                title: row.get(3)?,
                description: row.get(4)?,
                system_prompt: row.get(5)?,
                default_model_id: row.get(6)?,
                allowed_tool_ids: serde_json::from_str(&allowed_tool_ids_json).unwrap_or_default(),
                allowed_skill_ids: serde_json::from_str(&allowed_skill_ids_json)
                    .unwrap_or_default(),
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
            })
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    let mut session_stmt = connection
        .prepare(
            r#"
            SELECT id, assistant_id, title, messages_json, pinned, favorite, created_at, updated_at, usage_json
            FROM chat_sessions
            ORDER BY updated_at DESC, created_at DESC, id DESC
            "#,
        )
        .map_err(|err| err.to_string())?;

    let sessions = session_stmt
        .query_map([], |row| {
            let messages_json: String = row.get(3)?;
            let usage_json: String = row.get(8)?;

            Ok(DbChatSession {
                id: row.get(0)?,
                assistant_id: row.get(1)?,
                title: row.get(2)?,
                messages: serde_json::from_str(&messages_json)
                    .unwrap_or_else(|_| serde_json::Value::Array(Vec::new())),
                pinned: Some(row.get::<_, i64>(4)? != 0),
                favorite: Some(row.get::<_, i64>(5)? != 0),
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
                usage: serde_json::from_str(&usage_json).unwrap_or(DbChatUsageStats {
                    request_count: 0,
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0,
                    total_cost_usd: 0.0,
                    last_model: None,
                    last_used_at: None,
                    has_estimated_usage: false,
                }),
            })
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    Ok(ChatStoragePayload {
        assistants_json: Some(serde_json::to_string(&assistants).map_err(|err| err.to_string())?),
        sessions_json: Some(serde_json::to_string(&sessions).map_err(|err| err.to_string())?),
    })
}

fn save_structured_chat_storage(
    connection: &Connection,
    assistants_json: &str,
    sessions_json: &str,
) -> Result<(), String> {
    let assistants: Vec<DbAssistantProfile> =
        serde_json::from_str(assistants_json).map_err(|err| err.to_string())?;
    let sessions: Vec<DbChatSession> =
        serde_json::from_str(sessions_json).map_err(|err| err.to_string())?;

    let tx = connection
        .unchecked_transaction()
        .map_err(|err| err.to_string())?;
    tx.execute("DELETE FROM assistants", [])
        .map_err(|err| err.to_string())?;
    tx.execute("DELETE FROM chat_sessions", [])
        .map_err(|err| err.to_string())?;

    {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO assistants (
                  id, kind, source_preset_id, title, description, system_prompt, default_model_id,
                  allowed_tool_ids_json, allowed_skill_ids_json, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                "#,
            )
            .map_err(|err| err.to_string())?;

        for assistant in assistants {
            stmt.execute(params![
                assistant.id,
                assistant.kind,
                assistant.source_preset_id,
                assistant.title,
                assistant.description,
                assistant.system_prompt,
                assistant.default_model_id,
                serde_json::to_string(&assistant.allowed_tool_ids).map_err(|err| err.to_string())?,
                serde_json::to_string(&assistant.allowed_skill_ids)
                    .map_err(|err| err.to_string())?,
                assistant.created_at,
                assistant.updated_at,
            ])
            .map_err(|err| err.to_string())?;
        }
    }

    {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO chat_sessions (
                  id, assistant_id, title, messages_json, pinned, favorite, created_at, updated_at, usage_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                "#,
            )
            .map_err(|err| err.to_string())?;

        for session in sessions {
            stmt.execute(params![
                session.id,
                session.assistant_id,
                session.title,
                serde_json::to_string(&session.messages).map_err(|err| err.to_string())?,
                if session.pinned.unwrap_or(false) {
                    1_i64
                } else {
                    0_i64
                },
                if session.favorite.unwrap_or(false) {
                    1_i64
                } else {
                    0_i64
                },
                session.created_at,
                session.updated_at,
                serde_json::to_string(&session.usage).map_err(|err| err.to_string())?,
            ])
            .map_err(|err| err.to_string())?;
        }
    }

    tx.commit().map_err(|err| err.to_string())?;
    Ok(())
}

fn load_manifest_storage(connection: &Connection) -> Result<ManifestStoragePayload, String> {
    let assistant_presets_json =
        read_simple_table_value(connection, "assistant_presets", "builtin")?;
    let tool_manifests_json = read_simple_table_value(connection, "tool_manifests", "builtin")?;
    let skill_manifests_json = read_simple_table_value(connection, "skill_manifests", "builtin")?;

    Ok(ManifestStoragePayload {
        assistant_presets_json,
        tool_manifests_json,
        skill_manifests_json,
    })
}

fn save_manifest_storage(
    connection: &Connection,
    assistant_presets_json: Option<&str>,
    tool_manifests_json: Option<&str>,
    skill_manifests_json: Option<&str>,
) -> Result<(), String> {
    if let Some(value) = assistant_presets_json {
        write_simple_table_value(connection, "assistant_presets", "builtin", value)?;
    }
    if let Some(value) = tool_manifests_json {
        write_simple_table_value(connection, "tool_manifests", "builtin", value)?;
    }
    if let Some(value) = skill_manifests_json {
        write_simple_table_value(connection, "skill_manifests", "builtin", value)?;
    }
    Ok(())
}

fn load_memory_storage(connection: &Connection) -> Result<MemoryStoragePayload, String> {
    let assistant_memories_json =
        read_simple_table_value(connection, "assistant_memories", "builtin")?;
    let user_preferences_json = read_simple_table_value(connection, "user_preferences", "builtin")?;
    let session_summaries_json =
        read_simple_table_value(connection, "session_summaries", "builtin")?;

    Ok(MemoryStoragePayload {
        assistant_memories_json,
        user_preferences_json,
        session_summaries_json,
    })
}

fn save_memory_storage(
    connection: &Connection,
    assistant_memories_json: Option<&str>,
    user_preferences_json: Option<&str>,
    session_summaries_json: Option<&str>,
) -> Result<(), String> {
    if let Some(value) = assistant_memories_json {
        write_simple_table_value(connection, "assistant_memories", "builtin", value)?;
    }
    if let Some(value) = user_preferences_json {
        write_simple_table_value(connection, "user_preferences", "builtin", value)?;
    }
    if let Some(value) = session_summaries_json {
        write_simple_table_value(connection, "session_summaries", "builtin", value)?;
    }
    Ok(())
}

fn load_automation_storage(connection: &Connection) -> Result<AutomationStoragePayload, String> {
    let scheduled_tasks_json = read_simple_table_value(connection, "scheduled_tasks", "builtin")?;
    Ok(AutomationStoragePayload {
        scheduled_tasks_json,
    })
}

fn save_automation_storage(
    connection: &Connection,
    scheduled_tasks_json: Option<&str>,
) -> Result<(), String> {
    if let Some(value) = scheduled_tasks_json {
        write_simple_table_value(connection, "scheduled_tasks", "builtin", value)?;
    }
    Ok(())
}

fn ensure_knowledge_defaults(_connection: &Connection) -> Result<(), String> {
    Ok(())
}

fn normalize_knowledge_collection_id(value: Option<String>) -> String {
    value
        .unwrap_or_default()
        .trim()
        .to_string()
        .if_empty_then("")
}

fn derive_vectorization_state(chunk_count: i64, vectorized_chunk_count: i64) -> String {
    if chunk_count <= 0 {
        "empty".to_string()
    } else if vectorized_chunk_count <= 0 {
        "unvectorized".to_string()
    } else if vectorized_chunk_count >= chunk_count {
        "vectorized".to_string()
    } else {
        "partial".to_string()
    }
}

fn count_vectorized_chunks(chunks: &[Option<String>]) -> i64 {
    chunks.iter().filter(|value| value.is_some()).count() as i64
}

fn normalize_knowledge_retrieval_mode(_value: &str) -> String {
    "hybrid".to_string()
}

const OPENAI_COMPATIBLE_EMBEDDING_PROVIDERS: [&str; 6] = [
    "openai",
    "openrouter",
    "moonshot",
    "siliconflow",
    "dashscope",
    "zhipu",
];

const DEFAULT_EMBEDDING_MODEL: &str = "text-embedding-3-small";
const KNOWLEDGE_EMBEDDING_CONFIG_KEY: &str = "omni_knowledge_embedding_profile";
const DEFAULT_BASE_URL_FALLBACK: &str = "https://api.openai.com/v1";

fn provider_supports_embeddings(provider: &str) -> bool {
    OPENAI_COMPATIBLE_EMBEDDING_PROVIDERS.contains(&provider)
}

fn fingerprint_text(value: &str) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn default_knowledge_embedding_config() -> KnowledgeEmbeddingConfigRecord {
    KnowledgeEmbeddingConfigRecord {
        enabled: false,
        active_model_id: format!("openai:{DEFAULT_EMBEDDING_MODEL}:0"),
        models: vec![KnowledgeEmbeddingModelConfigRecord {
            id: format!("openai:{DEFAULT_EMBEDDING_MODEL}:0"),
            name: "默认向量模型".to_string(),
            provider: "openai".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            model: DEFAULT_EMBEDDING_MODEL.to_string(),
            api_key: String::new(),
        }],
    }
}

fn normalize_knowledge_embedding_config_record(
    input: KnowledgeEmbeddingConfigRecord,
) -> KnowledgeEmbeddingConfigRecord {
    let default_model_id = input
        .active_model_id
        .trim()
        .to_string()
        .if_empty_then(&format!("openai:{DEFAULT_EMBEDDING_MODEL}:0"));
    let mut seen_ids = std::collections::HashSet::new();
    let mut models = Vec::new();
    for (index, model) in input.models.into_iter().enumerate() {
        let provider = if provider_supports_embeddings(&model.provider) {
            model.provider.trim().to_string()
        } else {
            "openai".to_string()
        };
        let raw_model = model.model.trim();
        let model_value = if raw_model.is_empty() {
            DEFAULT_EMBEDDING_MODEL.to_string()
        } else {
            raw_model.to_string()
        };
        let model_name = model.name.trim().to_string();
        let model_id = if model.id.trim().is_empty() {
            format!("{provider}:{model_value}:{index}")
        } else {
            model.id.trim().to_string()
        };
        let base_url = {
            let trimmed = model.base_url.trim();
            if trimmed.is_empty() {
                DEFAULT_BASE_URL_FALLBACK.to_string()
            } else {
                trimmed.to_string()
            }
        };
        let unique_id = if seen_ids.contains(&model_id) {
            format!("{model_id}-{index}")
        } else {
            model_id
        };
        seen_ids.insert(unique_id.clone());
        models.push(KnowledgeEmbeddingModelConfigRecord {
            id: unique_id,
            name: if model_name.is_empty() {
                model_value.clone()
            } else {
                model_name
            },
            provider,
            base_url,
            model: model_value,
            api_key: model.api_key.trim().to_string(),
        });
    }

    if models.is_empty() {
        models = vec![KnowledgeEmbeddingModelConfigRecord {
            id: default_model_id.clone(),
            name: "默认向量模型".to_string(),
            provider: "openai".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            model: DEFAULT_EMBEDDING_MODEL.to_string(),
            api_key: String::new(),
        }];
    }

    let active_model_id = if models.iter().any(|model| model.id == input.active_model_id) {
        input.active_model_id
    } else {
        default_model_id.clone()
    };

    KnowledgeEmbeddingConfigRecord {
        enabled: input.enabled,
        active_model_id,
        models,
    }
}

fn load_knowledge_embedding_config(
    connection: &Connection,
) -> Result<KnowledgeEmbeddingConfigRecord, String> {
    let raw = read_kv(connection, KNOWLEDGE_EMBEDDING_CONFIG_KEY)?;
    match raw {
        Some(value) => match serde_json::from_str::<KnowledgeEmbeddingConfigRecord>(&value) {
            Ok(parsed) => Ok(normalize_knowledge_embedding_config_record(parsed)),
            Err(_) => load_legacy_knowledge_embedding_config(connection)
                .map(|value| value.unwrap_or_else(default_knowledge_embedding_config)),
        },
        None => Ok(default_knowledge_embedding_config()),
    }
}

fn load_knowledge_embedding_active_model(
    connection: &Connection,
) -> Result<
    Option<(
        KnowledgeEmbeddingConfigRecord,
        KnowledgeEmbeddingModelConfigRecord,
    )>,
    String,
> {
    let config = load_knowledge_embedding_config(connection)?;
    if !config.enabled {
        return Ok(None);
    }

    let active = config
        .models
        .iter()
        .find(|model| model.id == config.active_model_id)
        .cloned()
        .or_else(|| config.models.first().cloned())
        .filter(|model| {
            !model.api_key.trim().is_empty() && provider_supports_embeddings(&model.provider)
        });

    Ok(active.map(|model| (config, model)))
}

fn load_legacy_knowledge_embedding_config(
    connection: &Connection,
) -> Result<Option<KnowledgeEmbeddingConfigRecord>, String> {
    let raw = read_kv(connection, KNOWLEDGE_EMBEDDING_CONFIG_KEY)?;
    let Some(value) = raw else {
        return Ok(None);
    };

    let parsed: JsonValue = serde_json::from_str(&value).map_err(|err| err.to_string())?;
    let Some(object) = parsed.as_object() else {
        return Ok(None);
    };

    let enabled = object
        .get("enabled")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    let active_model_id = object
        .get("activeModelId")
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .to_string();
    let api_key = object
        .get("apiKey")
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .to_string();

    let models = object
        .get("models")
        .and_then(JsonValue::as_array)
        .map(|entries| {
            entries
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    let model = item.as_object();
                    let model_name = model
                        .and_then(|value| value.get("name"))
                        .and_then(JsonValue::as_str)
                        .unwrap_or("")
                        .to_string();
                    let model_provider = model
                        .and_then(|value| value.get("provider"))
                        .and_then(JsonValue::as_str)
                        .unwrap_or("openai")
                        .to_string();
                    let model_base_url = model
                        .and_then(|value| value.get("baseUrl"))
                        .and_then(JsonValue::as_str)
                        .unwrap_or("https://api.openai.com/v1")
                        .to_string();
                    let model_id = model
                        .and_then(|value| value.get("id"))
                        .and_then(JsonValue::as_str)
                        .unwrap_or("")
                        .to_string();
                    let model_value = model
                        .and_then(|value| value.get("model"))
                        .and_then(JsonValue::as_str)
                        .unwrap_or(DEFAULT_EMBEDDING_MODEL)
                        .to_string();
                    let model_api_key = model
                        .and_then(|value| value.get("apiKey"))
                        .and_then(JsonValue::as_str)
                        .unwrap_or("")
                        .to_string();

                    KnowledgeEmbeddingModelConfigRecord {
                        id: if model_id.is_empty() {
                            format!("{}:{}:{}", model_provider, model_value, index)
                        } else {
                            model_id
                        },
                        name: if model_name.is_empty() {
                            model_value.clone()
                        } else {
                            model_name
                        },
                        provider: model_provider,
                        base_url: model_base_url,
                        model: model_value,
                        api_key: if model_api_key.is_empty() {
                            api_key.clone()
                        } else {
                            model_api_key
                        },
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(Some(normalize_knowledge_embedding_config_record(
        KnowledgeEmbeddingConfigRecord {
            enabled,
            active_model_id,
            models,
        },
    )))
}

fn generate_chunk_embeddings(
    connection: &Connection,
    chunks: &[knowledge_chunker::ChunkSlice],
) -> (Vec<Option<String>>, Option<String>) {
    if chunks.is_empty() {
        return (Vec::new(), None);
    }

    let Some((_, active_model)) = load_knowledge_embedding_active_model(connection)
        .ok()
        .flatten()
    else {
        return (vec![None; chunks.len()], None);
    };
    let provider = active_model.provider.clone();

    let base_url = active_model.base_url.trim();
    let api_key = active_model.api_key.trim();
    if base_url.is_empty() || api_key.is_empty() {
        return (vec![None; chunks.len()], None);
    }

    let client = match BlockingHttpClient::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
    {
        Ok(client) => client,
        Err(err) => {
            eprintln!("知识库 embedding 客户端创建失败 ({provider}): {err}");
            return (vec![None; chunks.len()], None);
        }
    };

    let input: Vec<&str> = chunks.iter().map(|chunk| chunk.content.as_str()).collect();
    let request_body = serde_json::json!({
        "model": active_model.model,
        "input": input,
    });

    let response = match client
        .post(format!("{}/embeddings", base_url.trim_end_matches('/')))
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&request_body)
        .send()
    {
        Ok(response) => response,
        Err(err) => {
            eprintln!("知识库 embedding 请求失败 ({provider}): {err}");
            return (vec![None; chunks.len()], None);
        }
    };

    if !response.status().is_success() {
        let err_text = response.text().unwrap_or_default();
        eprintln!("知识库 embedding API 返回错误 ({provider}): {err_text}");
        return (vec![None; chunks.len()], None);
    }

    #[derive(Deserialize)]
    struct EmbeddingApiItem {
        embedding: Vec<f64>,
        index: usize,
    }

    #[derive(Deserialize)]
    struct EmbeddingApiResponse {
        data: Vec<EmbeddingApiItem>,
    }

    let payload: EmbeddingApiResponse = match response.json() {
        Ok(payload) => payload,
        Err(err) => {
            eprintln!("知识库 embedding 响应解析失败 ({provider}): {err}");
            return (vec![None; chunks.len()], None);
        }
    };

    let mut ordered = payload.data;
    ordered.sort_by_key(|item| item.index);

    let mut embeddings = vec![None; chunks.len()];
    for (index, item) in ordered.into_iter().enumerate() {
        if index >= embeddings.len() {
            break;
        }
        embeddings[index] = serde_json::to_string(&item.embedding).ok();
    }

    let model_key = format!(
        "{}:{}:{}",
        active_model.provider,
        active_model.model,
        fingerprint_text(active_model.api_key.trim())
    );
    (embeddings, Some(model_key))
}

trait EmptyFallback {
    fn if_empty_then(self, fallback: &str) -> String;
}

impl EmptyFallback for String {
    fn if_empty_then(self, fallback: &str) -> String {
        if self.trim().is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

fn normalize_text_for_search(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .to_lowercase()
}

fn preview_text(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim();
    let count = trimmed.chars().count();
    if count <= max_chars {
        return trimmed.to_string();
    }
    let clipped: String = trimmed.chars().take(max_chars.saturating_sub(3)).collect();
    format!("{clipped}...")
}

fn parse_tags_json(value: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(value).unwrap_or_default()
}

fn collection_exists(connection: &Connection, collection_id: &str) -> Result<bool, String> {
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(1) FROM knowledge_collections WHERE id = ?1",
            params![collection_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    Ok(count > 0)
}

fn load_knowledge_library(connection: &Connection) -> Result<KnowledgeLibraryPayload, String> {
    ensure_knowledge_defaults(connection)?;

    let mut collections_stmt = connection
        .prepare(
            r#"
            SELECT id, name, description, retrieval_mode, embedding_profile_id, created_at, updated_at
            FROM knowledge_collections
            ORDER BY created_at ASC, id ASC
            "#,
        )
        .map_err(|err| err.to_string())?;
    let collections = collections_stmt
        .query_map([], |row| {
            Ok(KnowledgeCollectionRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                retrieval_mode: row.get(3)?,
                embedding_profile_id: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    let mut documents_stmt = connection
        .prepare(
            r#"
            SELECT id, collection_id, source_name, source_path, stored_file_path, mime_type, file_extension, preview_type,
                   content, content_preview, chunk_count, thumbnail_data_url, tags_json, favorite,
                   access_count, last_accessed_at, title_hierarchy, created_at, updated_at,
                   file_hash, file_size, processing_status, error_message, active_job_id, content_version,
                   parser_profile_id, last_processed_at,
                   (
                     SELECT COUNT(1)
                     FROM knowledge_chunks c
                     WHERE c.document_id = knowledge_documents.id
                       AND c.embedding_json IS NOT NULL
                       AND TRIM(c.embedding_json) <> ''
                   ) AS vectorized_chunk_count
            FROM knowledge_documents
            ORDER BY updated_at DESC, created_at DESC, id DESC
            "#,
        )
        .map_err(|err| err.to_string())?;
    let documents = documents_stmt
        .query_map([], |row| {
            let tags_json: String = row.get(12)?;
            let chunk_count: i64 = row.get(10)?;
            let vectorized_chunk_count: i64 = row.get(27)?;
            Ok(KnowledgeDocumentRecord {
                id: row.get(0)?,
                collection_id: row.get(1)?,
                source_name: row.get(2)?,
                source_path: row.get(3)?,
                stored_file_path: row.get(4)?,
                mime_type: row.get(5)?,
                file_extension: row.get(6)?,
                preview_type: row.get(7)?,
                content: None,
                content_preview: row.get(9)?,
                chunk_count,
                thumbnail_data_url: row.get(11)?,
                file_hash: row.get(19)?,
                file_size: row.get(20)?,
                processing_status: row.get(21)?,
                error_message: row.get(22)?,
                active_job_id: row.get(23)?,
                content_version: row.get(24)?,
                parser_profile_id: row.get(25)?,
                last_processed_at: row.get(26)?,
                vectorized_chunk_count,
                vectorization_state: derive_vectorization_state(
                    chunk_count,
                    vectorized_chunk_count,
                ),
                tags: parse_tags_json(&tags_json),
                favorite: row.get::<_, i64>(13)? != 0,
                access_count: row.get(14)?,
                last_accessed_at: row.get(15)?,
                title_hierarchy: row.get(16)?,
                created_at: row.get(17)?,
                updated_at: row.get(18)?,
            })
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    Ok(KnowledgeLibraryPayload {
        collections,
        documents,
    })
}

fn load_knowledge_document(
    connection: &Connection,
    document_id: &str,
) -> Result<KnowledgeDocumentDetailPayload, String> {
    ensure_knowledge_defaults(connection)?;

    let document = connection
        .query_row(
            r#"
            SELECT id, collection_id, source_name, source_path, stored_file_path, mime_type, file_extension, preview_type,
                   content, content_preview, chunk_count, thumbnail_data_url, tags_json, favorite,
                   access_count, last_accessed_at, title_hierarchy, created_at, updated_at,
                   file_hash, file_size, processing_status, error_message, active_job_id, content_version,
                   parser_profile_id, last_processed_at,
                   (
                     SELECT COUNT(1)
                     FROM knowledge_chunks c
                     WHERE c.document_id = knowledge_documents.id
                       AND c.embedding_json IS NOT NULL
                       AND TRIM(c.embedding_json) <> ''
                   ) AS vectorized_chunk_count
            FROM knowledge_documents
            WHERE id = ?1
            "#,
            params![document_id],
            |row| {
                let tags_json: String = row.get(12)?;
                let chunk_count: i64 = row.get(10)?;
                let vectorized_chunk_count: i64 = row.get(27)?;
                Ok(KnowledgeDocumentRecord {
                    id: row.get(0)?,
                    collection_id: row.get(1)?,
                    source_name: row.get(2)?,
                    source_path: row.get(3)?,
                    stored_file_path: row.get(4)?,
                    mime_type: row.get(5)?,
                    file_extension: row.get(6)?,
                    preview_type: row.get(7)?,
                    content: row.get(8)?,
                    content_preview: row.get(9)?,
                    chunk_count,
                    thumbnail_data_url: row.get(11)?,
                    file_hash: row.get(19)?,
                    file_size: row.get(20)?,
                    processing_status: row.get(21)?,
                    error_message: row.get(22)?,
                    active_job_id: row.get(23)?,
                    content_version: row.get(24)?,
                    parser_profile_id: row.get(25)?,
                    last_processed_at: row.get(26)?,
                    vectorized_chunk_count,
                    vectorization_state: derive_vectorization_state(chunk_count, vectorized_chunk_count),
                    tags: parse_tags_json(&tags_json),
                    favorite: row.get::<_, i64>(13)? != 0,
                    access_count: row.get(14)?,
                    last_accessed_at: row.get(15)?,
                    title_hierarchy: row.get(16)?,
                    created_at: row.get(17)?,
                    updated_at: row.get(18)?,
                })
            },
        )
        .map_err(|err| err.to_string())?;

    let mut chunk_stmt = connection
        .prepare(
            r#"
            SELECT id, document_id, collection_id, chunk_index, title, content, embedding_json, embedding_model_key, created_at
            FROM knowledge_chunks
            WHERE document_id = ?1
            ORDER BY chunk_index ASC, created_at ASC, id ASC
            "#,
        )
        .map_err(|err| err.to_string())?;
    let chunks = chunk_stmt
        .query_map(params![document_id], |row| {
            Ok(KnowledgeChunkRecord {
                id: row.get(0)?,
                document_id: row.get(1)?,
                collection_id: row.get(2)?,
                chunk_index: row.get(3)?,
                title: row.get(4)?,
                content: row.get(5)?,
                embedding_json: row.get(6)?,
                embedding_model_key: row.get(7)?,
                created_at: row.get(8)?,
            })
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    Ok(KnowledgeDocumentDetailPayload { document, chunks })
}

fn load_knowledge_document_file(
    connection: &Connection,
    document_id: &str,
) -> Result<KnowledgeDocumentBinaryPayload, String> {
    ensure_knowledge_defaults(connection)?;

    let stored_file_path = connection
        .query_row(
            "SELECT stored_file_path FROM knowledge_documents WHERE id = ?1",
            params![document_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .flatten()
        .ok_or_else(|| "文档没有可用的原文件".to_string())?;

    let bytes = fs::read(&stored_file_path).map_err(|err| err.to_string())?;
    Ok(KnowledgeDocumentBinaryPayload { bytes })
}

fn create_knowledge_collection(
    connection: &Connection,
    name: &str,
    description: &str,
) -> Result<KnowledgeCollectionRecord, String> {
    let now = current_timestamp_ms();
    let id = uuid::Uuid::new_v4().to_string();
    let name = name.trim();
    let description = description.trim();

    if name.is_empty() {
        return Err("知识库名称不能为空".into());
    }

    connection
        .execute(
            r#"
            INSERT INTO knowledge_collections (id, name, description, retrieval_mode, embedding_profile_id, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            "#,
            params![id, name, description, "hybrid", Option::<String>::None, now, now],
        )
        .map_err(|err| err.to_string())?;

    Ok(KnowledgeCollectionRecord {
        id,
        name: name.to_string(),
        description: description.to_string(),
        retrieval_mode: "hybrid".to_string(),
        embedding_profile_id: None,
        created_at: now,
        updated_at: now,
    })
}

fn update_knowledge_collection(
    connection: &Connection,
    input: UpdateKnowledgeCollectionInput,
) -> Result<KnowledgeCollectionRecord, String> {
    let collection_id = input.collection_id.trim().to_string();
    if collection_id.is_empty() {
        return Err("知识库 ID 不能为空".into());
    }

    let existing = connection
        .query_row(
            r#"
            SELECT id, name, description, retrieval_mode, embedding_profile_id, created_at, updated_at
            FROM knowledge_collections
            WHERE id = ?1
            "#,
            params![collection_id],
            |row| {
                Ok(KnowledgeCollectionRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    retrieval_mode: row.get(3)?,
                    embedding_profile_id: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            },
        )
        .optional()
        .map_err(|err| err.to_string())?
        .ok_or_else(|| format!("知识库不存在: {collection_id}"))?;

    let name = input.name.unwrap_or(existing.name).trim().to_string();
    let description = input
        .description
        .unwrap_or(existing.description)
        .trim()
        .to_string();
    let retrieval_mode = input
        .retrieval_mode
        .map(|value| normalize_knowledge_retrieval_mode(&value))
        .unwrap_or_else(|| existing.retrieval_mode.clone());
    let updated_at = current_timestamp_ms();

    connection
        .execute(
            r#"
            UPDATE knowledge_collections
            SET name = ?2, description = ?3, retrieval_mode = ?4, updated_at = ?5
            WHERE id = ?1
            "#,
            params![collection_id, name, description, retrieval_mode, updated_at],
        )
        .map_err(|err| err.to_string())?;

    Ok(KnowledgeCollectionRecord {
        id: existing.id,
        name,
        description,
        retrieval_mode,
        embedding_profile_id: existing.embedding_profile_id,
        created_at: existing.created_at,
        updated_at,
    })
}

fn delete_knowledge_collection(connection: &Connection, collection_id: &str) -> Result<(), String> {
    let collection_id = collection_id.trim();
    if collection_id.is_empty() {
        return Err("知识库 ID 不能为空".into());
    }

    let stored_paths = {
        let mut stmt = connection
            .prepare(
                r#"
                SELECT stored_file_path
                FROM knowledge_documents
                WHERE collection_id = ?1
                "#,
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![collection_id], |row| {
                row.get::<_, Option<String>>(0)
            })
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?;
        rows
    };

    let tx = connection
        .unchecked_transaction()
        .map_err(|err| err.to_string())?;
    tx.execute(
        "DELETE FROM knowledge_chunks WHERE collection_id = ?1",
        params![collection_id],
    )
    .map_err(|err| err.to_string())?;
    tx.execute(
        "DELETE FROM knowledge_documents WHERE collection_id = ?1",
        params![collection_id],
    )
    .map_err(|err| err.to_string())?;
    tx.execute(
        "DELETE FROM knowledge_collections WHERE id = ?1",
        params![collection_id],
    )
    .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;

    for path in stored_paths {
        delete_stored_document_file(path.as_deref());
    }

    Ok(())
}

fn delete_knowledge_document(connection: &Connection, document_id: &str) -> Result<(), String> {
    let document_id = document_id.trim();
    if document_id.is_empty() {
        return Err("文档 ID 不能为空".into());
    }

    let stored_file_path = connection
        .query_row(
            "SELECT stored_file_path FROM knowledge_documents WHERE id = ?1",
            params![document_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .flatten();

    let tx = connection
        .unchecked_transaction()
        .map_err(|err| err.to_string())?;
    tx.execute(
        "DELETE FROM knowledge_chunks WHERE document_id = ?1",
        params![document_id],
    )
    .map_err(|err| err.to_string())?;
    tx.execute(
        "DELETE FROM knowledge_documents WHERE id = ?1",
        params![document_id],
    )
    .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;

    delete_stored_document_file(stored_file_path.as_deref());
    Ok(())
}

fn import_knowledge_document(
    app: &tauri::AppHandle,
    connection: &Connection,
    input: ImportKnowledgeDocumentInput,
) -> Result<KnowledgeDocumentRecord, String> {
    ensure_knowledge_defaults(connection)?;

    let collection_id = normalize_knowledge_collection_id(input.collection_id);
    if !collection_exists(connection, &collection_id)? {
        return Err(format!("知识库不存在: {collection_id}"));
    }

    let source_name = input.source_name.trim();
    if source_name.is_empty() {
        return Err("sourceName 不能为空".into());
    }

    let content = input.content.trim().to_string();

    let now = current_timestamp_ms();
    let document_id = uuid::Uuid::new_v4().to_string();
    let tags = input.tags.unwrap_or_default();
    let tags_json = serde_json::to_string(&tags).map_err(|err| err.to_string())?;
    let title_hierarchy = input
        .title_hierarchy
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let file_extension = normalize_file_extension(input.file_extension, source_name);
    let mime_type = input
        .mime_type
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let preview_type = input
        .preview_type
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| infer_preview_type(file_extension.as_deref(), mime_type.as_deref()));
    let thumbnail_data_url = input
        .thumbnail_data_url
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let chunks = if content.trim().is_empty() {
        Vec::new()
    } else {
        knowledge_chunker::split_document_text(
            &content,
            source_name,
            Some(preview_type.as_str()),
            file_extension.as_deref(),
            knowledge_chunker::DEFAULT_CHUNK_SIZE,
            knowledge_chunker::DEFAULT_CHUNK_OVERLAP,
        )
    };
    let chunk_count = chunks.len() as i64;
    let (chunk_embeddings, embedding_model_key) = generate_chunk_embeddings(connection, &chunks);
    let vectorized_chunk_count = count_vectorized_chunks(&chunk_embeddings);
    let content_preview = if content.trim().is_empty() {
        preview_text(source_name, 240)
    } else {
        preview_text(&content, 240)
    };
    let favorite = input.favorite.unwrap_or(false);
    let stored_file_path = input
        .content_bytes
        .as_ref()
        .filter(|bytes| !bytes.is_empty())
        .map(|bytes| {
            store_knowledge_document_bytes(app, &collection_id, &document_id, source_name, bytes)
        })
        .transpose()?
        .map(|path| path.to_string_lossy().to_string());
    let stored_file_size = input
        .content_bytes
        .as_ref()
        .filter(|_| stored_file_path.is_some())
        .map(|bytes| bytes.len() as i64);

    let tx = connection
        .unchecked_transaction()
        .map_err(|err| err.to_string())?;
    tx.execute(
        r#"
        INSERT INTO knowledge_documents (
          id, collection_id, source_name, source_path, stored_file_path, mime_type, file_extension, preview_type,
          content, content_preview, chunk_count, thumbnail_data_url, tags_json, favorite,
          access_count, last_accessed_at, title_hierarchy, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 0, NULL, ?15, ?16, ?17)
        "#,
        params![
            document_id,
            collection_id,
            source_name,
            input.source_path,
            stored_file_path,
            mime_type,
            file_extension,
            preview_type,
            content,
            content_preview,
            chunk_count,
            thumbnail_data_url,
            tags_json,
            if favorite { 1_i64 } else { 0_i64 },
            title_hierarchy,
            now,
            now,
        ],
    )
    .map_err(|err| err.to_string())?;

    {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO knowledge_chunks (
                  id, document_id, collection_id, chunk_index, title, content, embedding_json, embedding_model_key, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                "#,
            )
            .map_err(|err| err.to_string())?;

        for (index, chunk_content) in chunks.into_iter().enumerate() {
            let chunk_id = uuid::Uuid::new_v4().to_string();
            let chunk_title = chunk_content.title.or_else(|| {
                if index == 0 {
                    Some(source_name.to_string())
                } else {
                    None
                }
            });
            stmt.execute(params![
                chunk_id,
                document_id,
                collection_id,
                index as i64,
                chunk_title,
                chunk_content.content,
                chunk_embeddings.get(index).cloned().unwrap_or(None),
                embedding_model_key.clone(),
                now,
            ])
            .map_err(|err| err.to_string())?;
        }
    }

    tx.commit().map_err(|err| err.to_string())?;

    Ok(KnowledgeDocumentRecord {
        id: document_id,
        collection_id,
        source_name: source_name.to_string(),
        source_path: input.source_path,
        stored_file_path,
        mime_type,
        file_extension,
        preview_type: Some(preview_type),
        content: if content.trim().is_empty() {
            None
        } else {
            Some(content)
        },
        content_preview,
        thumbnail_data_url,
        file_hash: None,
        file_size: stored_file_size,
        processing_status: Some(knowledge_pipeline::DOCUMENT_STATUS_SEARCHABLE.to_string()),
        error_message: None,
        active_job_id: None,
        content_version: Some(1),
        parser_profile_id: None,
        last_processed_at: Some(now),
        chunk_count,
        vectorized_chunk_count,
        vectorization_state: derive_vectorization_state(chunk_count, vectorized_chunk_count),
        tags,
        favorite,
        access_count: 0,
        last_accessed_at: None,
        title_hierarchy,
        created_at: now,
        updated_at: now,
    })
}

fn rebuild_document_embeddings(
    connection: &Connection,
    document_id: &str,
) -> Result<KnowledgeDocumentRecord, String> {
    ensure_knowledge_defaults(connection)?;

    let document = load_knowledge_document(connection, document_id)?.document;

    let mut chunk_stmt = connection
        .prepare(
            r#"
            SELECT chunk_index, content
            FROM knowledge_chunks
            WHERE document_id = ?1
            ORDER BY chunk_index ASC, created_at ASC, id ASC
            "#,
        )
        .map_err(|err| err.to_string())?;
    let chunk_rows = chunk_stmt
        .query_map(params![document_id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    let chunk_slices = chunk_rows
        .into_iter()
        .map(|(_, content)| knowledge_chunker::ChunkSlice {
            content,
            title: None,
        })
        .collect::<Vec<_>>();

    let (embeddings, embedding_model_key) = generate_chunk_embeddings(connection, &chunk_slices);
    let vectorized_chunk_count = count_vectorized_chunks(&embeddings);
    let now = current_timestamp_ms();

    let tx = connection
        .unchecked_transaction()
        .map_err(|err| err.to_string())?;
    {
        let mut stmt = tx
            .prepare("UPDATE knowledge_chunks SET embedding_json = ?2, embedding_model_key = ?3 WHERE document_id = ?1 AND chunk_index = ?4")
            .map_err(|err| err.to_string())?;
        for (index, embedding_json) in embeddings.into_iter().enumerate() {
            stmt.execute(params![
                document_id,
                embedding_json,
                embedding_model_key.clone(),
                index as i64
            ])
            .map_err(|err| err.to_string())?;
        }
    }

    tx.execute(
        "UPDATE knowledge_documents SET updated_at = ?2 WHERE id = ?1",
        params![document_id, now],
    )
    .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;

    Ok(KnowledgeDocumentRecord {
        vectorized_chunk_count,
        vectorization_state: derive_vectorization_state(
            document.chunk_count,
            vectorized_chunk_count,
        ),
        updated_at: now,
        ..document
    })
}

fn score_search_candidate(
    query: &str,
    query_terms: &[String],
    query_embedding: Option<&[f64]>,
    retrieval_mode: &str,
    candidate: &KnowledgeSearchCandidate,
) -> f64 {
    let mut score = 0.0;
    let haystack = normalize_text_for_search(&format!(
        "{} {} {} {} {} {}",
        candidate.source_name,
        candidate.source_path.as_deref().unwrap_or_default(),
        candidate.title_hierarchy.as_deref().unwrap_or_default(),
        candidate.title.as_deref().unwrap_or_default(),
        candidate.tags.join(" "),
        candidate.content
    ));

    if haystack.contains(query) {
        score += 8.0;
    }

    for term in query_terms {
        if haystack.contains(term) {
            score += 1.5;
        }
    }

    if haystack.contains(&normalize_text_for_search(&candidate.source_name)) {
        score += 1.0;
    }
    if candidate
        .title
        .as_deref()
        .map(normalize_text_for_search)
        .as_deref()
        .map(|title| haystack.contains(title))
        .unwrap_or(false)
    {
        score += 0.8;
    }

    let allow_embedding = matches!(retrieval_mode, "hybrid" | "vector");
    if allow_embedding {
        if let Some(query_embedding) = query_embedding {
            if let Some(candidate_embedding) = candidate
                .embedding_json
                .as_deref()
                .and_then(parse_embedding_json)
            {
                score += cosine_similarity(query_embedding, &candidate_embedding) * 2.0;
            }
        }
    }

    if matches!(retrieval_mode, "vector") {
        score += 0.2;
    }

    if matches!(retrieval_mode, "keyword") {
        score += 0.1;
    }

    score
}

fn parse_embedding_json(value: &str) -> Option<Vec<f64>> {
    serde_json::from_str::<Vec<f64>>(value).ok()
}

fn cosine_similarity(left: &[f64], right: &[f64]) -> f64 {
    let len = left.len().min(right.len());
    if len == 0 {
        return 0.0;
    }

    let mut dot = 0.0;
    let mut left_norm = 0.0;
    let mut right_norm = 0.0;

    for index in 0..len {
        let l = left[index];
        let r = right[index];
        dot += l * r;
        left_norm += l * l;
        right_norm += r * r;
    }

    let denominator = left_norm.sqrt() * right_norm.sqrt();
    if denominator == 0.0 {
        0.0
    } else {
        dot / denominator
    }
}

struct KnowledgeSearchCandidate {
    chunk_id: String,
    document_id: String,
    collection_id: String,
    chunk_index: i64,
    title: Option<String>,
    content: String,
    embedding_json: Option<String>,
    embedding_model_key: Option<String>,
    created_at: i64,
    source_name: String,
    source_path: Option<String>,
    collection_name: String,
    retrieval_mode: String,
    tags: Vec<String>,
    favorite: bool,
    access_count: i64,
    last_accessed_at: Option<i64>,
    title_hierarchy: Option<String>,
}

fn search_knowledge_chunks(
    connection: &Connection,
    input: SearchKnowledgeChunksInput,
) -> Result<Vec<SearchKnowledgeChunkResult>, String> {
    let query = input.query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    ensure_knowledge_defaults(connection)?;
    let query_terms: Vec<String> = query
        .split_whitespace()
        .filter(|term| !term.is_empty())
        .map(|term| term.to_string())
        .collect();
    let limit = input.limit.unwrap_or(10).clamp(1, 50);
    let query_model_key = input
        .query_embedding_model_key
        .as_deref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let collection_filter = input.collection_id.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });
    let query_embedding = input.query_embedding;
    let mut stmt = connection
        .prepare(
            r#"
            SELECT
              c.id,
              c.document_id,
              c.collection_id,
              c.chunk_index,
              c.title,
              c.content,
              c.embedding_json,
              c.embedding_model_key,
              c.created_at,
              d.source_name,
              d.source_path,
              d.tags_json,
              d.favorite,
              d.access_count,
              d.last_accessed_at,
              d.title_hierarchy,
              k.name,
              k.retrieval_mode
            FROM knowledge_chunks c
            JOIN knowledge_documents d ON d.id = c.document_id
            JOIN knowledge_collections k ON k.id = c.collection_id
            "#,
        )
        .map_err(|err| err.to_string())?;

    let candidates = stmt
        .query_map([], |row| {
            let tags_json: String = row.get(11)?;
            Ok(KnowledgeSearchCandidate {
                chunk_id: row.get(0)?,
                document_id: row.get(1)?,
                collection_id: row.get(2)?,
                chunk_index: row.get(3)?,
                title: row.get(4)?,
                content: row.get(5)?,
                embedding_json: row.get(6)?,
                embedding_model_key: row.get(7)?,
                created_at: row.get(8)?,
                source_name: row.get(9)?,
                source_path: row.get(10)?,
                tags: parse_tags_json(&tags_json),
                favorite: row.get::<_, i64>(12)? != 0,
                access_count: row.get(13)?,
                last_accessed_at: row.get(14)?,
                title_hierarchy: row.get(15)?,
                collection_name: row.get(16)?,
                retrieval_mode: row.get(17)?,
            })
        })
        .map_err(|err| err.to_string())?
        .filter_map(|row| row.ok())
        .filter(|candidate| {
            collection_filter
                .as_ref()
                .map(|collection_id| &candidate.collection_id == collection_id)
                .unwrap_or(true)
        })
        .collect::<Vec<_>>();

    let mut scored = Vec::new();
    for candidate in candidates {
        let retrieval_mode = normalize_knowledge_retrieval_mode(candidate.retrieval_mode.as_str());
        let embedding_matches = query_model_key
            .as_deref()
            .map(|model_key| {
                candidate
                    .embedding_model_key
                    .as_deref()
                    .map(|value| value == model_key)
                    .unwrap_or(false)
            })
            .unwrap_or(true);
        if !embedding_matches {
            continue;
        }

        let effective_embedding = if matches!(retrieval_mode.as_str(), "hybrid" | "vector") {
            query_embedding.as_deref()
        } else {
            None
        };
        let score = score_search_candidate(
            &query,
            &query_terms,
            effective_embedding,
            &retrieval_mode,
            &candidate,
        );
        if score <= 0.0 && !candidate.content.to_lowercase().contains(&query) {
            continue;
        }

        scored.push((score, candidate));
    }

    scored.sort_by(|left, right| {
        right
            .0
            .partial_cmp(&left.0)
            .unwrap_or(Ordering::Equal)
            .then_with(|| right.1.access_count.cmp(&left.1.access_count))
            .then_with(|| left.1.created_at.cmp(&right.1.created_at))
    });

    Ok(scored
        .into_iter()
        .take(limit)
        .map(|(score, candidate)| SearchKnowledgeChunkResult {
            chunk: KnowledgeChunkRecord {
                id: candidate.chunk_id,
                document_id: candidate.document_id,
                collection_id: candidate.collection_id,
                chunk_index: candidate.chunk_index,
                title: candidate.title,
                content: candidate.content,
                embedding_json: candidate.embedding_json,
                embedding_model_key: candidate.embedding_model_key,
                created_at: candidate.created_at,
            },
            score,
            source_name: candidate.source_name,
            source_path: candidate.source_path,
            collection_name: candidate.collection_name,
            tags: candidate.tags,
            favorite: candidate.favorite,
            access_count: candidate.access_count,
            last_accessed_at: candidate.last_accessed_at,
            title_hierarchy: candidate.title_hierarchy,
        })
        .collect())
}

#[tauri::command]
fn load_knowledge_library_command(
    app: tauri::AppHandle,
) -> Result<KnowledgeLibraryPayload, String> {
    let connection = open_sqlite_connection(&app)?;
    load_knowledge_library(&connection)
}

#[tauri::command]
fn load_knowledge_document_command(
    app: tauri::AppHandle,
    input: LoadKnowledgeDocumentInput,
) -> Result<KnowledgeDocumentDetailPayload, String> {
    let connection = open_sqlite_connection(&app)?;
    load_knowledge_document(&connection, &input.document_id)
}

#[tauri::command]
fn load_knowledge_document_file_command(
    app: tauri::AppHandle,
    input: LoadKnowledgeDocumentFileInput,
) -> Result<KnowledgeDocumentBinaryPayload, String> {
    let connection = open_sqlite_connection(&app)?;
    load_knowledge_document_file(&connection, &input.document_id)
}

#[tauri::command]
fn create_knowledge_collection_command(
    app: tauri::AppHandle,
    name: String,
    description: String,
) -> Result<KnowledgeCollectionRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    create_knowledge_collection(&connection, &name, &description)
}

#[tauri::command]
fn ensure_default_knowledge_collection_command(
    app: tauri::AppHandle,
) -> Result<KnowledgeCollectionRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    ensure_knowledge_defaults(&connection)?;

    connection
        .query_row(
            r#"
            SELECT id, name, description, retrieval_mode, embedding_profile_id, created_at, updated_at
            FROM knowledge_collections
            WHERE id = 'default'
            "#,
            [],
            |row| {
                Ok(KnowledgeCollectionRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    retrieval_mode: row.get(3)?,
                    embedding_profile_id: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            },
        )
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn update_knowledge_collection_command(
    app: tauri::AppHandle,
    input: UpdateKnowledgeCollectionInput,
) -> Result<KnowledgeCollectionRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    update_knowledge_collection(&connection, input)
}

#[tauri::command]
fn delete_knowledge_collection_command(
    app: tauri::AppHandle,
    collection_id: String,
) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    delete_knowledge_collection(&connection, &collection_id)
}

#[tauri::command]
fn delete_knowledge_document_command(
    app: tauri::AppHandle,
    document_id: String,
) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    delete_knowledge_document(&connection, &document_id)
}

#[tauri::command]
fn import_knowledge_document_command(
    app: tauri::AppHandle,
    input: ImportKnowledgeDocumentInput,
) -> Result<KnowledgeDocumentRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    import_knowledge_document(&app, &connection, input)
}

#[tauri::command]
fn import_knowledge_document_pipeline_command(
    app: tauri::AppHandle,
    input: knowledge_pipeline::PipelineImportInput,
) -> Result<knowledge_pipeline::PipelineImportResult, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::create_pipeline_import(&app, &connection, input)
}

#[tauri::command]
fn load_knowledge_processing_jobs_command(
    app: tauri::AppHandle,
    document_id: Option<String>,
) -> Result<Vec<knowledge_pipeline::KnowledgeProcessingJobRecord>, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::list_processing_jobs(&connection, document_id)
}

#[tauri::command]
fn load_knowledge_processing_job_detail_command(
    app: tauri::AppHandle,
    job_id: String,
) -> Result<knowledge_pipeline::KnowledgeProcessingJobDetail, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::load_processing_job_detail(&connection, &job_id)
}

#[tauri::command]
fn pause_knowledge_processing_job_command(
    app: tauri::AppHandle,
    job_id: String,
) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::request_job_pause(&connection, &job_id)
}

#[tauri::command]
fn resume_knowledge_processing_job_command(
    app: tauri::AppHandle,
    job_id: String,
) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::request_job_resume(&connection, &job_id)
}

#[tauri::command]
fn cancel_knowledge_processing_job_command(
    app: tauri::AppHandle,
    job_id: String,
) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::request_job_cancel(&connection, &job_id)
}

#[tauri::command]
fn retry_knowledge_processing_job_command(
    app: tauri::AppHandle,
    job_id: String,
) -> Result<knowledge_pipeline::KnowledgeProcessingJobRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::retry_job(&connection, &job_id)
}

#[tauri::command]
fn reparse_knowledge_document_command(
    app: tauri::AppHandle,
    document_id: String,
) -> Result<knowledge_pipeline::KnowledgeProcessingJobRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::create_document_job(&connection, &document_id, "reparse")
}

#[tauri::command]
fn rechunk_knowledge_document_command(
    app: tauri::AppHandle,
    document_id: String,
) -> Result<knowledge_pipeline::KnowledgeProcessingJobRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::create_document_job(&connection, &document_id, "rechunk")
}

#[tauri::command]
fn revectorize_knowledge_document_command(
    app: tauri::AppHandle,
    document_id: String,
) -> Result<knowledge_pipeline::KnowledgeProcessingJobRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::create_document_job(&connection, &document_id, "revectorize")
}

#[tauri::command]
fn load_knowledge_pipeline_settings_command(
    app: tauri::AppHandle,
) -> Result<knowledge_pipeline::KnowledgePipelineSettings, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::load_pipeline_settings(&connection)
}

#[tauri::command]
fn save_knowledge_pipeline_settings_command(
    app: tauri::AppHandle,
    settings: knowledge_pipeline::KnowledgePipelineSettings,
) -> Result<knowledge_pipeline::KnowledgePipelineSettings, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::save_pipeline_settings(&connection, settings)
}

#[tauri::command]
fn cleanup_knowledge_processing_logs_command(app: tauri::AppHandle) -> Result<i64, String> {
    let connection = open_sqlite_connection(&app)?;
    knowledge_pipeline::cleanup_processing_logs(&connection)
}

#[tauri::command]
fn rebuild_knowledge_document_embeddings_command(
    app: tauri::AppHandle,
    input: RevectorizeKnowledgeDocumentInput,
) -> Result<KnowledgeDocumentRecord, String> {
    let connection = open_sqlite_connection(&app)?;
    rebuild_document_embeddings(&connection, &input.document_id)
}

#[tauri::command]
fn search_knowledge_chunks_command(
    app: tauri::AppHandle,
    input: SearchKnowledgeChunksInput,
) -> Result<Vec<SearchKnowledgeChunkResult>, String> {
    let connection = open_sqlite_connection(&app)?;
    search_knowledge_chunks(&connection, input)
}

fn migrate_legacy_chat_kv_to_structured(connection: &Connection) -> Result<(), String> {
    if has_structured_chat_storage(connection)? {
        return Ok(());
    }

    let assistants_json = read_kv(connection, "chat_assistants")?;
    let sessions_json = read_kv(connection, "chat_sessions")?;

    if assistants_json.is_none() && sessions_json.is_none() {
        return Ok(());
    }

    save_structured_chat_storage(
        connection,
        assistants_json.as_deref().unwrap_or("[]"),
        sessions_json.as_deref().unwrap_or("[]"),
    )
}

fn migrate_legacy_app_kv_to_structured(connection: &Connection) -> Result<(), String> {
    let known_keys = [
        "omni_theme_mode",
        "omni_basic_settings",
        "omni_main_view",
        "omni_compact_position",
        "omni_main_position",
        "omni_provider_configs",
        "omni_current_model",
        "omni_model_connection_status",
        "omni_compact_appearance",
        "omni_character_scale",
        "omni_character_model",
    ];

    for key in known_keys {
        if read_structured_app_value(connection, key)?.is_some() {
            continue;
        }
        if let Some(value) = read_kv(connection, key)? {
            write_structured_app_value(connection, key, &value)?;
        }
    }

    Ok(())
}

fn ensure_storage_migrations(connection: &Connection) -> Result<(), String> {
    migrate_legacy_chat_kv_to_structured(connection)?;
    migrate_legacy_app_kv_to_structured(connection)?;
    Ok(())
}

fn normalize_relative_path(input: &str) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(input);
    if candidate.is_absolute() {
        return Err("Only relative workspace paths are allowed".into());
    }

    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => normalized.push(part),
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err("Path escapes workspace root".into());
                }
            }
            _ => return Err("Unsupported path component".into()),
        }
    }

    Ok(normalized)
}

fn table_has_column(connection: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let sql = format!("PRAGMA table_info({table})");
    let mut stmt = connection.prepare(&sql).map_err(|err| err.to_string())?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    Ok(columns.iter().any(|item| item == column))
}

fn ensure_knowledge_schema(connection: &Connection) -> Result<(), String> {
    if !table_has_column(connection, "knowledge_chunks", "embedding_json")? {
        connection
            .execute(
                "ALTER TABLE knowledge_chunks ADD COLUMN embedding_json TEXT",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "tags_json")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "favorite")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "access_count")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "last_accessed_at")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN last_accessed_at INTEGER",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "title_hierarchy")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN title_hierarchy TEXT",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "stored_file_path")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN stored_file_path TEXT",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "mime_type")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN mime_type TEXT",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "file_extension")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN file_extension TEXT",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "preview_type")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN preview_type TEXT",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "thumbnail_data_url")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN thumbnail_data_url TEXT",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "file_hash")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN file_hash TEXT",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "file_size")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN file_size INTEGER",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "processing_status")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'searchable'",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "error_message")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN error_message TEXT",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "active_job_id")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN active_job_id TEXT",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "content_version")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN content_version INTEGER NOT NULL DEFAULT 1",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "parser_profile_id")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN parser_profile_id TEXT",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_documents", "last_processed_at")? {
        connection
            .execute(
                "ALTER TABLE knowledge_documents ADD COLUMN last_processed_at INTEGER",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_collections", "retrieval_mode")? {
        connection
            .execute(
                "ALTER TABLE knowledge_collections ADD COLUMN retrieval_mode TEXT NOT NULL DEFAULT 'hybrid'",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    if !table_has_column(connection, "knowledge_collections", "embedding_profile_id")? {
        connection
            .execute(
                "ALTER TABLE knowledge_collections ADD COLUMN embedding_profile_id TEXT",
                [],
            )
            .map_err(|err| err.to_string())?;
    }

    knowledge_pipeline::ensure_pipeline_schema(connection)?;
    ensure_knowledge_defaults(connection)?;

    Ok(())
}

fn collect_workspace_files(
    root: &Path,
    current: &Path,
    query: &str,
    limit: usize,
    acc: &mut Vec<WorkspaceFileEntry>,
) -> Result<(), String> {
    if acc.len() >= limit {
        return Ok(());
    }

    let entries = fs::read_dir(current).map_err(|err| err.to_string())?;
    for entry in entries {
        if acc.len() >= limit {
            break;
        }

        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.starts_with(".git") || file_name == "node_modules" || file_name == "dist" {
            continue;
        }

        let metadata = entry.metadata().map_err(|err| err.to_string())?;
        let relative = path
            .strip_prefix(root)
            .map_err(|err| err.to_string())?
            .to_string_lossy()
            .replace('\\', "/");

        if query.is_empty() || relative.to_lowercase().contains(query) {
            acc.push(WorkspaceFileEntry {
                path: relative.clone(),
                is_dir: metadata.is_dir(),
            });
        }

        if metadata.is_dir() {
            collect_workspace_files(root, &path, query, limit, acc)?;
        }
    }

    Ok(())
}

fn collect_workspace_matches(
    root: &Path,
    current: &Path,
    query: &str,
    limit: usize,
    acc: &mut Vec<WorkspaceSearchMatch>,
) -> Result<(), String> {
    if acc.len() >= limit {
        return Ok(());
    }

    let entries = fs::read_dir(current).map_err(|err| err.to_string())?;
    for entry in entries {
        if acc.len() >= limit {
            break;
        }

        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.starts_with(".git") || file_name == "node_modules" || file_name == "dist" {
            continue;
        }

        let metadata = entry.metadata().map_err(|err| err.to_string())?;
        if metadata.is_dir() {
            collect_workspace_matches(root, &path, query, limit, acc)?;
            continue;
        }

        let relative = path
            .strip_prefix(root)
            .map_err(|err| err.to_string())?
            .to_string_lossy()
            .replace('\\', "/");

        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        let content = String::from_utf8_lossy(&bytes);

        for (index, line) in content.lines().enumerate() {
            if acc.len() >= limit {
                break;
            }

            if line.to_lowercase().contains(query) {
                let preview = if line.chars().count() > 160 {
                    let clipped: String = line.chars().take(157).collect();
                    format!("{clipped}...")
                } else {
                    line.to_string()
                };

                acc.push(WorkspaceSearchMatch {
                    path: relative.clone(),
                    line_number: index + 1,
                    line_preview: preview,
                });
            }
        }
    }

    Ok(())
}

#[tauri::command]
fn list_workspace_files(
    query: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<WorkspaceFileEntry>, String> {
    let root = workspace_root()?;
    let normalized_query = query.unwrap_or_default().trim().to_lowercase();
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let mut results = Vec::new();
    collect_workspace_files(&root, &root, &normalized_query, limit, &mut results)?;
    Ok(results)
}

#[tauri::command]
fn read_workspace_file(path: String, max_chars: Option<usize>) -> Result<String, String> {
    let root = workspace_root()?;
    let relative = normalize_relative_path(&path)?;
    let full_path = root.join(relative);

    if !full_path.exists() {
        return Err(format!("File not found: {path}"));
    }
    if full_path.is_dir() {
        return Err(format!("Path is a directory: {path}"));
    }

    let bytes = fs::read(&full_path).map_err(|err| err.to_string())?;
    let content = String::from_utf8_lossy(&bytes).into_owned();
    let max_chars = max_chars.unwrap_or(8000).clamp(200, 20000);

    if content.chars().count() > max_chars {
        let preview: String = content.chars().take(max_chars).collect();
        return Ok(format!("{preview}\n\n[truncated]"));
    }

    Ok(content)
}

#[tauri::command]
fn search_workspace_files(
    query: String,
    limit: Option<usize>,
) -> Result<Vec<WorkspaceSearchMatch>, String> {
    let normalized_query = query.trim().to_lowercase();
    if normalized_query.is_empty() {
        return Err("Query cannot be empty".into());
    }

    let root = workspace_root()?;
    let limit = limit.unwrap_or(50).clamp(1, 200);
    let mut results = Vec::new();
    collect_workspace_matches(&root, &root, &normalized_query, limit, &mut results)?;
    Ok(results)
}

#[tauri::command]
fn load_chat_storage(
    app: tauri::AppHandle,
    legacy_assistants_json: Option<String>,
    legacy_sessions_json: Option<String>,
) -> Result<ChatStoragePayload, String> {
    let connection = open_sqlite_connection(&app)?;

    if has_structured_chat_storage(&connection)? {
        return load_structured_chat_storage(&connection);
    }

    let payload = ChatStoragePayload {
        assistants_json: legacy_assistants_json.filter(|value| !value.trim().is_empty()),
        sessions_json: legacy_sessions_json.filter(|value| !value.trim().is_empty()),
    };

    if payload.assistants_json.is_some() || payload.sessions_json.is_some() {
        save_structured_chat_storage(
            &connection,
            payload.assistants_json.as_deref().unwrap_or("[]"),
            payload.sessions_json.as_deref().unwrap_or("[]"),
        )?;
        return load_structured_chat_storage(&connection);
    }

    Ok(payload)
}

#[tauri::command]
fn save_chat_storage(
    app: tauri::AppHandle,
    assistants_json: String,
    sessions_json: String,
) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    save_structured_chat_storage(&connection, &assistants_json, &sessions_json)?;
    Ok(())
}

#[tauri::command]
fn load_manifest_storage_command(app: tauri::AppHandle) -> Result<ManifestStoragePayload, String> {
    let connection = open_sqlite_connection(&app)?;
    load_manifest_storage(&connection)
}

#[tauri::command]
fn save_manifest_storage_command(
    app: tauri::AppHandle,
    assistant_presets_json: Option<String>,
    tool_manifests_json: Option<String>,
    skill_manifests_json: Option<String>,
) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    save_manifest_storage(
        &connection,
        assistant_presets_json.as_deref(),
        tool_manifests_json.as_deref(),
        skill_manifests_json.as_deref(),
    )
}

#[tauri::command]
fn load_memory_storage_command(app: tauri::AppHandle) -> Result<MemoryStoragePayload, String> {
    let connection = open_sqlite_connection(&app)?;
    load_memory_storage(&connection)
}

#[tauri::command]
fn save_memory_storage_command(
    app: tauri::AppHandle,
    assistant_memories_json: Option<String>,
    user_preferences_json: Option<String>,
    session_summaries_json: Option<String>,
) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    save_memory_storage(
        &connection,
        assistant_memories_json.as_deref(),
        user_preferences_json.as_deref(),
        session_summaries_json.as_deref(),
    )
}

#[tauri::command]
fn load_automation_storage_command(
    app: tauri::AppHandle,
) -> Result<AutomationStoragePayload, String> {
    let connection = open_sqlite_connection(&app)?;
    load_automation_storage(&connection)
}

#[tauri::command]
fn save_automation_storage_command(
    app: tauri::AppHandle,
    scheduled_tasks_json: Option<String>,
) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    save_automation_storage(&connection, scheduled_tasks_json.as_deref())
}

#[tauri::command]
fn load_app_kv(
    app: tauri::AppHandle,
    keys: Vec<String>,
    legacy_entries: Option<HashMap<String, String>>,
) -> Result<AppStoragePayload, String> {
    let connection = open_sqlite_connection(&app)?;
    let mut entries = HashMap::new();
    let legacy_entries = legacy_entries.unwrap_or_default();

    for key in keys {
        let mut value = read_structured_app_value(&connection, &key)?;
        if value.is_none() {
            if let Some(legacy_value) = legacy_entries
                .get(&key)
                .filter(|value| !value.trim().is_empty())
            {
                write_structured_app_value(&connection, &key, legacy_value)?;
                value = Some(legacy_value.clone());
            }
        }

        if let Some(value) = value {
            entries.insert(key, value);
        }
    }

    Ok(AppStoragePayload { entries })
}

#[tauri::command]
fn save_app_kv(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    write_structured_app_value(&connection, &key, &value)
}

#[tauri::command]
fn remove_app_kv(app: tauri::AppHandle, key: String) -> Result<(), String> {
    let connection = open_sqlite_connection(&app)?;
    remove_structured_app_value(&connection, &key)?;
    connection
        .execute("DELETE FROM app_kv WHERE key = ?1", params![key])
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn show_main_window(app: &tauri::AppHandle) {
    let main_window = app.get_webview_window("main");
    let compact_window = app.get_webview_window("compact");

    if let Some(window) = main_window.as_ref() {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = window.emit("omni-focus-input", ());
        return;
    }

    if let Some(window) = compact_window.as_ref() {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed
                        && (shortcut.to_string() == "Ctrl+Shift+Space"
                            || shortcut.to_string() == "Ctrl+Alt+Space")
                    {
                        show_main_window(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            greet,
            load_workspace_pet_dir_command,
            load_codex_pet_packages,
            create_codex_pet_package,
            list_workspace_files,
            read_workspace_file,
            search_workspace_files,
            load_knowledge_library_command,
            load_knowledge_document_command,
            load_knowledge_document_file_command,
            create_knowledge_collection_command,
            ensure_default_knowledge_collection_command,
            update_knowledge_collection_command,
            delete_knowledge_collection_command,
            delete_knowledge_document_command,
            import_knowledge_document_command,
            import_knowledge_document_pipeline_command,
            load_knowledge_processing_jobs_command,
            load_knowledge_processing_job_detail_command,
            pause_knowledge_processing_job_command,
            resume_knowledge_processing_job_command,
            cancel_knowledge_processing_job_command,
            retry_knowledge_processing_job_command,
            reparse_knowledge_document_command,
            rechunk_knowledge_document_command,
            revectorize_knowledge_document_command,
            load_knowledge_pipeline_settings_command,
            save_knowledge_pipeline_settings_command,
            cleanup_knowledge_processing_logs_command,
            rebuild_knowledge_document_embeddings_command,
            search_knowledge_chunks_command,
            load_chat_storage,
            save_chat_storage,
            load_manifest_storage_command,
            save_manifest_storage_command,
            load_memory_storage_command,
            save_memory_storage_command,
            load_automation_storage_command,
            save_automation_storage_command,
            load_app_kv,
            save_app_kv,
            remove_app_kv
        ])
        .setup(|app| {
            use tauri_plugin_global_shortcut::GlobalShortcutExt;

            let show_hide = MenuItemBuilder::with_id("toggle", "打开主界面").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出 Omni").build(app)?;
            let tray_menu = MenuBuilder::new(app)
                .item(&show_hide)
                .separator()
                .item(&quit)
                .build()?;

            if let Some(tray_icon) = app.default_window_icon().cloned() {
                TrayIconBuilder::with_id("main")
                    .icon(tray_icon)
                    .tooltip("Omni 助手")
                    .menu(&tray_menu)
                    .show_menu_on_left_click(false)
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            show_main_window(&tray.app_handle());
                        }
                    })
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "toggle" => show_main_window(app),
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .build(app)?;
            } else {
                eprintln!("[Omni] 托盘图标不可用，已跳过托盘初始化");
            }

            let primary_shortcut = tauri_plugin_global_shortcut::Shortcut::new(
                Some(
                    tauri_plugin_global_shortcut::Modifiers::CONTROL
                        | tauri_plugin_global_shortcut::Modifiers::SHIFT,
                ),
                tauri_plugin_global_shortcut::Code::Space,
            );
            let fallback_shortcut = tauri_plugin_global_shortcut::Shortcut::new(
                Some(
                    tauri_plugin_global_shortcut::Modifiers::CONTROL
                        | tauri_plugin_global_shortcut::Modifiers::ALT,
                ),
                tauri_plugin_global_shortcut::Code::Space,
            );

            if app.global_shortcut().register(primary_shortcut).is_ok() {
                eprintln!("[Omni] 已注册全局快捷键 Ctrl+Shift+Space");
            } else if app.global_shortcut().register(fallback_shortcut).is_ok() {
                eprintln!("[Omni] Ctrl+Shift+Space 不可用，已回退到 Ctrl+Alt+Space");
            } else {
                eprintln!("[Omni] Ctrl+Shift+Space 和 Ctrl+Alt+Space 都注册失败");
            }

            let worker_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    if let Err(err) = knowledge_pipeline::run_pipeline_worker_tick(&worker_app) {
                        eprintln!("[Omni] knowledge pipeline worker error: {err}");
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(750)).await;
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("运行 Omni 时发生错误");
}
