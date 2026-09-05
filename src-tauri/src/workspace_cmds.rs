
use crate::workspace_files;

#[tauri::command]
pub(crate) fn list_workspace_files(
    project_path: Option<String>,
    glob: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<workspace_files::WorkspaceFileEntry>, String> {
    workspace_files::list_files(project_path, glob, limit)
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

/// 读取文件原始字节（ArrayBuffer），供前端 file-viewer 预览器消费。
#[tauri::command]
pub(crate) fn read_file_bytes(
    project_path: Option<String>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let bytes = workspace_files::read_file_bytes(project_path, path)?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub(crate) fn copy_file_to_store(
    src: String,
    dst: String,
) -> Result<workspace_files::CopyFileResult, String> {
    workspace_files::copy_file_to_store(&src, &dst)
}

/// 前端从剪贴板粘贴非图片文件时，把二进制内容写到应用数据目录并返回绝对路径。
#[tauri::command]
pub(crate) fn write_pasted_attachment(
    app: tauri::AppHandle,
    name: String,
    bytes: Vec<u8>,
) -> Result<workspace_files::CopyFileResult, String> {
    workspace_files::write_pasted_attachment(&app, &name, &bytes)
}

#[tauri::command]
pub(crate) fn search_workspace_files(
    project_path: Option<String>,
    pattern: String,
    path: Option<String>,
    glob: Option<String>,
    literal: Option<bool>,
    ignore_case: Option<bool>,
    context: Option<usize>,
    limit: Option<usize>,
) -> Result<Vec<workspace_files::WorkspaceSearchMatch>, String> {
    workspace_files::search_files(project_path, pattern, path, glob, literal, ignore_case, context, limit)
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
