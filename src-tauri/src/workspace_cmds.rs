
use crate::workspace_files;

#[tauri::command]
pub(crate) fn list_workspace_files(
    project_path: Option<String>,
    query: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<workspace_files::WorkspaceFileEntry>, String> {
    workspace_files::list_files(project_path, query, limit)
}

#[tauri::command]
pub(crate) fn read_workspace_file(
    project_path: Option<String>,
    path: String,
    max_chars: Option<usize>,
    offset_chars: Option<usize>,
    limit_chars: Option<usize>,
) -> Result<workspace_files::ReadFileResult, String> {
    workspace_files::read_file(project_path, path, max_chars, offset_chars, limit_chars)
}

#[tauri::command]
pub(crate) fn search_workspace_files(
    project_path: Option<String>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<workspace_files::WorkspaceSearchMatch>, String> {
    workspace_files::search_files(project_path, query, limit)
}

#[tauri::command]
pub(crate) fn read_project_agents_md(project_path: Option<String>) -> String {
    let raw = match project_path {
        Some(value) => value.trim().to_string(),
        None => return String::new(),
    };
    if raw.is_empty() {
        return String::new();
    }
    let root = std::path::Path::new(&raw);
    let override_md = root.join("AGENTS.override.md");
    if override_md.exists() {
        return std::fs::read_to_string(&override_md).unwrap_or_default();
    }
    let agents_md = root.join("AGENTS.md");
    if agents_md.exists() {
        return std::fs::read_to_string(&agents_md).unwrap_or_default();
    }
    String::new()
}
