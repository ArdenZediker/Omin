use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

mod codex_pets;
mod database;
mod knowledge_chunker;
mod knowledge_embedded_images;
mod knowledge_files;
mod knowledge_pipeline;
mod knowledge;
mod backup;
mod knowledge_schema;
mod persona;
mod storage;
mod storage_paths;
mod workspace_files;
mod knowledge_embedding_config;
mod knowledge_embedding_batch;
mod knowledge_search;
mod skillhub;
mod webtools;
mod gittools;
mod office_export;
mod connectorhub;
mod mcp;

// 从 lib.rs 拆分出去的四个模块，用私有 glob 取回其中的函数与类型。
// 这些模块内部**不要**写 `use super::*`：那会把 crate 根的 `__cmd__*` 宏吸进模块，
// 再通过下面的 glob 拉回 lib.rs，与本地定义撞成 E0255。各模块改为显式 `use crate::...`。
use knowledge_embedding_batch::*;
use knowledge_embedding_config::*;
use knowledge_search::*;
use skillhub::*;
use webtools::*;
use gittools::*;
use office_export::*;
use connectorhub::*;
use mcp::*;

// 需要被其它模块以 `crate::X` 引用的条目，改为显式重导出（显式重导出不会牵扯宏命名空间）。
pub(crate) use knowledge_embedding_config::{
    find_exact_usable_knowledge_multimodal_model, load_knowledge_collection_multimodal_config,
    load_knowledge_multimodal_config, validate_knowledge_multimodal_upload,
};


pub(crate) use database::open_sqlite_connection;
pub(crate) use knowledge_files::{
    delete_stored_document_file, delete_stored_document_files, infer_preview_type,
    normalize_file_extension, store_knowledge_document_bytes,
};
pub(crate) use knowledge_schema::ensure_knowledge_defaults;
#[cfg(test)]
pub(crate) use knowledge_schema::ensure_knowledge_schema;
#[cfg(test)]
pub(crate) use knowledge_schema::table_has_column;
pub(crate) use storage::{
    delete_project_by_id, delete_chat_session_by_id, has_structured_chat_storage,
    load_automation_storage, load_manifest_storage,
    load_memory_storage, load_structured_chat_storage, read_kv, read_structured_app_value,
    remove_structured_app_value, save_automation_storage, save_manifest_storage,
    save_memory_storage, save_structured_chat_storage, write_kv, write_structured_app_value,
    AutomationStoragePayload, ChatStoragePayload, ManifestStoragePayload, MemoryStoragePayload,
    KNOWLEDGE_EMBEDDING_CONFIG_KEY, KNOWLEDGE_MULTIMODAL_CONFIG_KEY,
};

// 从 lib.rs 拆分出的命令模块（私有 fn + 显式 `use crate::...`），沿用私有 glob 模式避免 E0255。
mod codex_pet_cmds;
mod knowledge_cmds;
mod workspace_cmds;
mod storage_cmds;
mod persona_cmds;

use codex_pet_cmds::*;
use knowledge_cmds::*;
use workspace_cmds::*;
use storage_cmds::*;
use persona_cmds::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppStoragePayload {
    pub(crate) entries: HashMap<String, String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeCollectionRecord {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) retrieval_mode: String,
    pub(crate) embedding_profile_id: Option<String>,
    pub(crate) multimodal_config_json: Option<String>,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeDocumentRecord {
    pub(crate) id: String,
    pub(crate) collection_id: String,
    pub(crate) source_name: String,
    pub(crate) source_path: Option<String>,
    pub(crate) stored_file_path: Option<String>,
    pub(crate) mime_type: Option<String>,
    pub(crate) file_extension: Option<String>,
    pub(crate) preview_type: Option<String>,
    pub(crate) content: Option<String>,
    pub(crate) content_preview: String,
    pub(crate) thumbnail_data_url: Option<String>,
    pub(crate) file_hash: Option<String>,
    pub(crate) file_size: Option<i64>,
    pub(crate) processing_status: Option<String>,
    pub(crate) error_message: Option<String>,
    pub(crate) active_job_id: Option<String>,
    pub(crate) content_version: Option<i64>,
    pub(crate) parser_profile_id: Option<String>,
    pub(crate) last_processed_at: Option<i64>,
    pub(crate) chunk_count: i64,
    pub(crate) vectorized_chunk_count: i64,
    pub(crate) vectorization_state: String,
    pub(crate) tags: Vec<String>,
    pub(crate) favorite: bool,
    pub(crate) access_count: i64,
    pub(crate) last_accessed_at: Option<i64>,
    pub(crate) title_hierarchy: Option<String>,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeDocumentAssetRecord {
    pub(crate) id: String,
    pub(crate) document_id: String,
    pub(crate) collection_id: String,
    pub(crate) asset_kind: String,
    pub(crate) source_name: String,
    pub(crate) stored_file_path: String,
    pub(crate) mime_type: Option<String>,
    pub(crate) file_extension: Option<String>,
    pub(crate) preview_type: String,
    pub(crate) thumbnail_data_url: Option<String>,
    pub(crate) ocr_text: Option<String>,
    pub(crate) caption_text: Option<String>,
    pub(crate) content_preview: String,
    pub(crate) page_index: Option<i64>,
    pub(crate) asset_index: i64,
    pub(crate) metadata_json: Option<String>,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeChunkImageInfoRecord {
    pub(crate) asset_id: String,
    pub(crate) source_name: String,
    pub(crate) page_index: Option<i64>,
    pub(crate) asset_index: i64,
    pub(crate) original_markdown: Option<String>,
    pub(crate) thumbnail_data_url: Option<String>,
    pub(crate) ocr_text: Option<String>,
    pub(crate) caption_text: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeChunkRecord {
    pub(crate) id: String,
    pub(crate) document_id: String,
    pub(crate) collection_id: String,
    pub(crate) chunk_index: i64,
    pub(crate) title: Option<String>,
    pub(crate) content: String,
    pub(crate) chunk_type: Option<String>,
    pub(crate) parent_chunk_id: Option<String>,
    pub(crate) asset_id: Option<String>,
    pub(crate) image_info: Option<String>,
    pub(crate) embedding_json: Option<String>,
    pub(crate) embedding_model_key: Option<String>,
    pub(crate) created_at: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeLibraryPayload {
    pub(crate) collections: Vec<KnowledgeCollectionRecord>,
    pub(crate) documents: Vec<KnowledgeDocumentRecord>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeDocumentDetailPayload {
    pub(crate) document: KnowledgeDocumentRecord,
    pub(crate) assets: Vec<KnowledgeDocumentAssetRecord>,
    pub(crate) chunks: Vec<KnowledgeChunkRecord>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportKnowledgeDocumentInput {
    pub(crate) collection_id: Option<String>,
    pub(crate) source_name: String,
    pub(crate) source_path: Option<String>,
    pub(crate) content: String,
    pub(crate) content_bytes: Option<Vec<u8>>,
    pub(crate) mime_type: Option<String>,
    pub(crate) file_extension: Option<String>,
    pub(crate) preview_type: Option<String>,
    pub(crate) thumbnail_data_url: Option<String>,
    pub(crate) tags: Option<Vec<String>>,
    pub(crate) title_hierarchy: Option<String>,
    pub(crate) favorite: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateKnowledgeCollectionInput {
    pub(crate) collection_id: String,
    pub(crate) name: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) retrieval_mode: Option<String>,
    pub(crate) multimodal_config_json: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeEmbeddingModelConfigRecord {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) provider: String,
    pub(crate) base_url: String,
    pub(crate) model: String,
    pub(crate) api_key: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeEmbeddingConfigRecord {
    pub(crate) enabled: bool,
    pub(crate) active_model_id: String,
    pub(crate) models: Vec<KnowledgeEmbeddingModelConfigRecord>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeMultimodalModelConfigRecord {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) capability: String,
    pub(crate) provider: String,
    pub(crate) base_url: String,
    pub(crate) model: String,
    pub(crate) api_key: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeMultimodalConfigRecord {
    pub(crate) enabled: bool,
    pub(crate) active_image_model_id: Option<String>,
    pub(crate) active_audio_model_id: Option<String>,
    pub(crate) models: Vec<KnowledgeMultimodalModelConfigRecord>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct KnowledgeCollectionImageMultimodalConfigRecord {
    pub(crate) enabled: bool,
    pub(crate) model_id: Option<String>,
    pub(crate) extract_text: bool,
    pub(crate) generate_summary: bool,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct KnowledgeCollectionAudioMultimodalConfigRecord {
    pub(crate) enabled: bool,
    pub(crate) model_id: Option<String>,
    pub(crate) keep_transcript: bool,
    pub(crate) generate_summary: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeCollectionMultimodalConfigRecord {
    pub(crate) enabled: bool,
    pub(crate) merge_mode: String,
    pub(crate) image: KnowledgeCollectionImageMultimodalConfigRecord,
    pub(crate) audio: KnowledgeCollectionAudioMultimodalConfigRecord,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchKnowledgeChunksInput {
    pub(crate) query: String,
    pub(crate) limit: Option<usize>,
    pub(crate) collection_id: Option<String>,
    pub(crate) query_embedding: Option<Vec<f64>>,
    pub(crate) query_embedding_model_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RevectorizeKnowledgeDocumentInput {
    pub(crate) document_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoadKnowledgeDocumentInput {
    pub(crate) document_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoadKnowledgeDocumentFileInput {
    pub(crate) document_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeDocumentBinaryPayload {
    pub(crate) bytes: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchKnowledgeChunkResult {
    pub(crate) chunk: KnowledgeChunkRecord,
    pub(crate) matched_chunk: Option<KnowledgeChunkRecord>,
    pub(crate) display_chunk: Option<KnowledgeChunkRecord>,
    pub(crate) matched_chunk_type: Option<String>,
    pub(crate) parent_chunk_id: Option<String>,
    pub(crate) image_info: Option<String>,
    pub(crate) matched_asset: Option<KnowledgeDocumentAssetRecord>,
    pub(crate) score: f64,
    pub(crate) source_name: String,
    pub(crate) source_path: Option<String>,
    pub(crate) collection_name: String,
    pub(crate) tags: Vec<String>,
    pub(crate) favorite: bool,
    pub(crate) access_count: i64,
    pub(crate) last_accessed_at: Option<i64>,
    pub(crate) title_hierarchy: Option<String>,
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("你好，{}！欢迎使用 Omni AI 助手！", name)
}

pub(crate) fn workspace_root() -> Result<PathBuf, String> {
    let current_dir = std::env::current_dir().map_err(|err| err.to_string())?;
    if current_dir.file_name().and_then(|name| name.to_str()) == Some("src-tauri") {
        return current_dir
            .parent()
            .map(PathBuf::from)
            .ok_or_else(|| "Unable to resolve workspace root".to_string());
    }
    Ok(current_dir)
}

pub(crate) fn current_timestamp_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn normalize_knowledge_collection_id(value: Option<String>) -> String {
    value
        .unwrap_or_default()
        .trim()
        .to_string()
        .if_empty_then("")
}

pub(crate) fn derive_vectorization_state(chunk_count: i64, vectorized_chunk_count: i64) -> String {
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

pub(crate) fn count_vectorized_chunks(chunks: &[Option<String>]) -> i64 {
    chunks.iter().filter(|value| value.is_some()).count() as i64
}

pub(crate) fn normalize_knowledge_retrieval_mode(_value: &str) -> String {
    "hybrid".to_string()
}

pub(crate) trait EmptyFallback {
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

pub(crate) fn normalize_text_for_search(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .to_lowercase()
}

pub(crate) fn tokenize_search_query(value: &str) -> Vec<String> {
    normalize_text_for_search(value)
        .split(|character: char| !character.is_alphanumeric())
        .map(str::trim)
        .filter(|term| !term.is_empty())
        .map(ToString::to_string)
        .collect()
}

pub(crate) fn preview_text(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim();
    let count = trimmed.chars().count();
    if count <= max_chars {
        return trimmed.to_string();
    }
    let clipped: String = trimmed.chars().take(max_chars.saturating_sub(3)).collect();
    format!("{clipped}...")
}

pub(crate) fn parse_tags_json(value: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(value).unwrap_or_default()
}

pub(crate) fn collection_exists(connection: &Connection, collection_id: &str) -> Result<bool, String> {
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(1) FROM knowledge_collections WHERE id = ?1",
            params![collection_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    Ok(count > 0)
}

pub(crate) fn show_main_window(app: &tauri::AppHandle) {
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
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            load_workspace_pet_dir_command,
            load_codex_pet_packages,
            import_codex_pet_package,
            list_workspace_files,
            read_workspace_file,
            search_workspace_files,
            read_project_agents_md,
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
            load_knowledge_processing_status_summary_command,
            load_failed_knowledge_processing_jobs_command,
            retry_failed_knowledge_processing_jobs_command,
            load_knowledge_processing_dead_letters_command,
            replay_knowledge_processing_dead_letters_command,
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
            load_knowledge_multimodal_config_command,
            save_knowledge_multimodal_config_command,
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
            remove_app_kv,
            delete_chat_session,
            delete_project,
            get_data_root_info,
            set_data_root,
            reset_data_root,
            open_data_dir,
            export_data_backup,
            import_data_backup,
            read_persona_files,
            write_persona_file,
            install_skillhub_skill,
            uninstall_skillhub_skill,
            list_skillhub_skills,
            list_skillhub_plugins,
            list_skillhub_skill_categories,
            list_skillhub_plugin_categories,
            list_skillhub_skillsets,
            get_skillhub_skillset,
            batch_skillhub_skills,
            install_skillhub_meta_skill,
            install_local_skill,
            web_search,
            web_fetch,
            git_info,
            git_commit,
            git_pr,
            export_docx,
            export_xlsx,
            export_pptx,
            path_exists,
            list_connectorhub_skills,
            install_connectorhub_skill,
            start_mcp_server,
            stop_mcp_server,
            list_mcp_tools,
            call_mcp_tool,
            read_mcp_stderr
        ])
        .setup(|app| {
            let show_hide = MenuItemBuilder::with_id("toggle", "打开主界面").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出 Omni").build(app)?;
            let tray_menu = MenuBuilder::new(app)
                .item(&show_hide)
                .separator()
                .item(&quit)
                .build()?;

            if !cfg!(debug_assertions) || std::env::var_os("OMNI_ENABLE_TRAY").is_some() {
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
            } else {
                eprintln!("[Omni] tray disabled in debug mode");
            }

            if !cfg!(debug_assertions) || std::env::var_os("OMNI_ENABLE_KNOWLEDGE_WORKER").is_some() {
                let worker_app = app.handle().clone();
                std::thread::spawn(move || loop {
                    if let Err(err) = knowledge_pipeline::run_pipeline_worker_tick(&worker_app) {
                        eprintln!("[Omni] knowledge pipeline worker error: {err}");
                    }
                    std::thread::sleep(std::time::Duration::from_millis(750));
                });
            } else {
                eprintln!("[Omni] knowledge pipeline worker disabled in debug mode");
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("运行 Omni 时发生错误");
}
