use serde::Serialize;
use std::{
    fs,
    path::{Component, Path, PathBuf},
};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

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

#[tauri::command]
fn greet(name: &str) -> String {
    format!("你好，{}！欢迎使用 Omni AI 助手！", name)
}

fn workspace_root() -> Result<PathBuf, String> {
    std::env::current_dir().map_err(|err| err.to_string())
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
fn list_workspace_files(query: Option<String>, limit: Option<usize>) -> Result<Vec<WorkspaceFileEntry>, String> {
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
fn search_workspace_files(query: String, limit: Option<usize>) -> Result<Vec<WorkspaceSearchMatch>, String> {
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

fn toggle_main_window_visibility(app: &tauri::AppHandle) {
    let compact_window = app.get_webview_window("compact");
    let main_window = app.get_webview_window("main");

    if let Some(window) = compact_window.as_ref() {
        if window.is_visible().unwrap_or(false) {
            let _ = window.set_focus();
            return;
        }

        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    if let Some(window) = main_window.as_ref() {
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
                        && (shortcut.to_string() == "Alt+Space" || shortcut.to_string() == "Ctrl+Space")
                    {
                        toggle_main_window_visibility(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            greet,
            list_workspace_files,
            read_workspace_file,
            search_workspace_files
        ])
        .setup(|app| {
            use tauri_plugin_global_shortcut::GlobalShortcutExt;

            let show_hide = MenuItemBuilder::with_id("toggle", "显示 / 隐藏").build(app)?;
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
                            toggle_main_window_visibility(&tray.app_handle());
                        }
                    })
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "toggle" => toggle_main_window_visibility(app),
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .build(app)?;
            } else {
                eprintln!("[Omni] 托盘图标不可用，已跳过托盘初始化");
            }

            let alt_shortcut = tauri_plugin_global_shortcut::Shortcut::new(
                Some(tauri_plugin_global_shortcut::Modifiers::ALT),
                tauri_plugin_global_shortcut::Code::Space,
            );
            let ctrl_shortcut = tauri_plugin_global_shortcut::Shortcut::new(
                Some(tauri_plugin_global_shortcut::Modifiers::CONTROL),
                tauri_plugin_global_shortcut::Code::Space,
            );

            if app.global_shortcut().register(alt_shortcut).is_ok() {
                eprintln!("[Omni] 已注册全局快捷键 Alt+Space");
            } else if app.global_shortcut().register(ctrl_shortcut).is_ok() {
                eprintln!("[Omni] Alt+Space 不可用，已回退到 Ctrl+Space");
            } else {
                eprintln!("[Omni] Alt+Space 和 Ctrl+Space 都注册失败");
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("运行 Omni 时发生错误");
}
