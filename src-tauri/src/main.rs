// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
fn restore_macos_path() {
    use std::process::Command;

    let shell = std::env::var("SHELL")
        .ok()
        .filter(|value| std::path::Path::new(value).is_file())
        .unwrap_or_else(|| "/bin/zsh".to_string());
    let output = Command::new(shell)
        .args(["-ilc", "printf '\n__OMNI_PATH__%s\n' \"$PATH\""])
        .env("DISABLE_AUTO_UPDATE", "true")
        .output();
    if let Ok(output) = output {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(path) = stdout
                .rsplit_once("__OMNI_PATH__")
                .map(|(_, value)| value.lines().next().unwrap_or("").trim())
                .filter(|value| !value.is_empty())
            {
                std::env::set_var("PATH", path);
            }
        }
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    restore_macos_path();
    omni_lib::run()
}
