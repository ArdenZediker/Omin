// Omni - Rust 后端
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("你好，{}！欢迎使用 Omni AI 助手！", name)
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
                        && (shortcut.to_string() == "Alt+Space"
                            || shortcut.to_string() == "Ctrl+Space")
                    {
                        toggle_main_window_visibility(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![greet])
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
