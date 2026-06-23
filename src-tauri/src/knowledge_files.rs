use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::Manager;

pub(crate) fn knowledge_files_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    let root = app_data_dir.join("knowledge_files");
    fs::create_dir_all(&root).map_err(|err| err.to_string())?;
    Ok(root)
}

pub(crate) fn sanitize_storage_file_name(value: &str) -> String {
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

pub(crate) fn file_extension_from_name(value: &str) -> Option<String> {
    Path::new(value)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.trim().to_lowercase())
        .filter(|ext| !ext.is_empty())
}

pub(crate) fn normalize_file_extension(
    extension: Option<String>,
    source_name: &str,
) -> Option<String> {
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

pub(crate) fn infer_preview_type(extension: Option<&str>, mime_type: Option<&str>) -> String {
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

    if matches!(
        extension.as_str(),
        "mp4" | "mov" | "webm" | "mkv" | "avi" | "m4v" | "mpeg" | "mpg"
    ) {
        return "video".to_string();
    }

    if matches!(
        extension.as_str(),
        "mp3" | "wav" | "m4a" | "aac" | "flac" | "ogg" | "oga"
    ) {
        return "audio".to_string();
    }

    if mime_type.starts_with("video/") {
        return "video".to_string();
    }

    if mime_type.starts_with("audio/") {
        return "audio".to_string();
    }

    if matches!(extension.as_str(), "doc" | "rtf") {
        return "unsupported".to_string();
    }

    "unsupported".to_string()
}

pub(crate) fn store_knowledge_document_bytes(
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

pub(crate) fn delete_stored_document_file(path: Option<&str>) {
    let Some(path) = path else {
        return;
    };

    let stored_path = PathBuf::from(path);
    if stored_path.is_file() {
        let _ = fs::remove_file(&stored_path);
    }

    if let Some(document_dir) = stored_path.parent() {
        remove_if_empty(document_dir);
        if let Some(collection_dir) = document_dir.parent() {
            remove_if_empty(collection_dir);
        }
    }
}

pub(crate) fn delete_stored_document_files(paths: &[Option<String>]) {
    for path in paths {
        delete_stored_document_file(path.as_deref());
    }
}

fn document_file_name(source_name: &str, document_id: &str) -> String {
    let base = sanitize_storage_file_name(source_name);
    if base == "document" {
        format!("{document_id}.bin")
    } else {
        base
    }
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
