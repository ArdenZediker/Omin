use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(windows)]
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;
use tauri_plugin_opener::OpenerExt;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceOpenApp {
    pub(crate) id: String,
    pub(crate) name: String,
}

#[derive(Clone, Debug)]
struct InstalledWorkspaceApp {
    id: String,
    name: String,
    launcher: WorkspaceLauncher,
    icon_source: Option<PathBuf>,
}

#[derive(Clone, Debug)]
enum WorkspaceLauncher {
    ShellOpen,
    Command {
        program: PathBuf,
        args: Vec<String>,
        env: Vec<(String, String)>,
        windows_hide: bool,
    },
}

#[cfg(windows)]
static WINDOWS_APPS_CACHE: OnceLock<Mutex<Option<Vec<InstalledWorkspaceApp>>>> = OnceLock::new();

impl InstalledWorkspaceApp {
    fn shell_open(id: &str, name: &str, icon_source: Option<PathBuf>) -> Self {
        Self {
            id: id.to_string(),
            name: name.to_string(),
            launcher: WorkspaceLauncher::ShellOpen,
            icon_source,
        }
    }
}

pub(crate) fn list_workspace_open_apps() -> Result<Vec<WorkspaceOpenApp>, String> {
    Ok(installed_workspace_apps()
        .into_iter()
        .map(|app| WorkspaceOpenApp {
            id: app.id,
            name: app.name,
        })
        .collect())
}

pub(crate) fn workspace_open_app_icon(app_id: &str) -> Result<Option<String>, String> {
    let Some(app) = installed_workspace_apps()
        .into_iter()
        .find(|app| app.id == app_id)
    else {
        return Ok(None);
    };
    let Some(source) = app.icon_source else {
        return Ok(None);
    };
    Ok(platform_app_icon(&source))
}

pub(crate) fn open_workspace_with(
    app: &tauri::AppHandle,
    path: &str,
    app_id: &str,
) -> Result<(), String> {
    let raw_path = path.trim();
    if raw_path.is_empty() {
        return Err("项目工作目录为空，无法打开".to_string());
    }
    let target = PathBuf::from(raw_path);
    if !target.is_absolute() {
        return Err(format!("项目工作目录不是绝对路径：{}", target.display()));
    }
    if !target.is_dir() {
        return Err(format!("项目工作目录不存在：{}", target.display()));
    }

    let requested_id = app_id.trim();
    let Some(installed) = installed_workspace_apps()
        .into_iter()
        .find(|candidate| candidate.id == requested_id)
    else {
        return Err(format!("当前电脑未安装或无法识别打开方式：{requested_id}"));
    };

    let result = match installed.launcher {
        WorkspaceLauncher::ShellOpen => open_in_shell(app, &target),
        WorkspaceLauncher::Command {
            program,
            args,
            env,
            windows_hide,
        } => launch_command(
            &installed.name,
            &program,
            &args,
            &env,
            windows_hide,
            &target,
        ),
    };
    #[cfg(windows)]
    if result.is_err() {
        invalidate_windows_apps_cache();
    }
    result
}

fn installed_workspace_apps() -> Vec<InstalledWorkspaceApp> {
    #[cfg(windows)]
    {
        return windows_installed_apps();
    }
    #[cfg(target_os = "macos")]
    {
        return macos_installed_apps();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        return linux_installed_apps();
    }
    #[allow(unreachable_code)]
    Vec::new()
}

fn launch_command(
    display_name: &str,
    program: &Path,
    args: &[String],
    env: &[(String, String)],
    windows_hide: bool,
    target: &Path,
) -> Result<(), String> {
    let target_text = target.to_string_lossy();
    let mut command = Command::new(program);
    let mut used_path_token = false;
    for arg in args {
        if arg.contains("{path}") {
            used_path_token = true;
            command.arg(arg.replace("{path}", &target_text));
        } else {
            command.arg(arg);
        }
    }
    if !used_path_token {
        command.arg(target);
    }
    for (key, value) in env {
        command.env(key, value);
    }

    #[cfg(windows)]
    if windows_hide {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = windows_hide;

    let mut child = command.spawn().map_err(|error| {
        format!(
            "启动 {} 失败（{}）：{error}",
            display_name,
            program.display()
        )
    })?;

    // Match DSH's short launch watch: an application still running is launched,
    // while an immediate non-zero exit is surfaced instead of silently doing nothing.
    let deadline = Instant::now() + Duration::from_millis(600);
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => {
                return Err(format!(
                    "启动 {} 失败：程序提前退出（退出码 {}）",
                    display_name,
                    status.code().unwrap_or(-1)
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(error) => {
                return Err(format!("等待 {} 启动失败：{error}", display_name));
            }
        }
    }
    Ok(())
}

fn open_in_shell(app: &tauri::AppHandle, target: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        if open_windows_explorer(target).is_ok() {
            return Ok(());
        }
    }
    #[cfg(target_os = "macos")]
    {
        if Command::new("open")
            .arg(target)
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
        {
            return Ok(());
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if Command::new("xdg-open")
            .arg(target)
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
        {
            return Ok(());
        }
    }

    app.opener()
        .open_path(target.to_string_lossy().to_string(), None::<&str>)
        .map_err(|error| format!("打开项目目录失败：{error}"))
}

#[cfg(windows)]
fn open_windows_explorer(target: &Path) -> Result<(), String> {
    let encoded = windows_explorer_target(target)?;
    let status = Command::new("explorer.exe")
        .arg(encoded)
        .status()
        .map_err(|error| format!("启动文件资源管理器失败：{error}"))?;
    // Explorer exits 1 after handing the request to the already-running desktop process.
    if status.success() || status.code() == Some(1) {
        Ok(())
    } else {
        Err(format!(
            "启动文件资源管理器失败：explorer.exe 退出码 {}",
            status.code().unwrap_or(-1)
        ))
    }
}

#[cfg(windows)]
fn windows_explorer_target(target: &Path) -> Result<String, String> {
    let raw = target.to_string_lossy();
    let normalized = if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
        format!("//{}", unc.replace('\\', "/"))
    } else if let Some(verbatim) = raw.strip_prefix(r"\\?\") {
        verbatim.replace('\\', "/")
    } else {
        raw.replace('\\', "/")
    };

    let uri_prefix = if normalized.starts_with("//") {
        "file:".to_string()
    } else if normalized.as_bytes().get(1) == Some(&b':') {
        format!("file:///{}:", &normalized[..1])
    } else {
        return Err(format!("项目工作目录不是绝对路径：{}", target.display()));
    };
    let remainder = if uri_prefix == "file:" {
        normalized.as_str()
    } else {
        &normalized[2..]
    };

    let mut encoded = String::with_capacity(uri_prefix.len() + remainder.len());
    encoded.push_str(&uri_prefix);
    for character in remainder.chars() {
        match character {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '.' | '_' | '~' | '/' | ':' => {
                encoded.push(character)
            }
            ',' => encoded.push_str("%2C"),
            '=' => encoded.push_str("%3D"),
            other if !other.is_ascii() => encoded.push(other),
            other => {
                let mut bytes = [0_u8; 4];
                for byte in other.encode_utf8(&mut bytes).bytes() {
                    encoded.push('%');
                    encoded.push_str(&format!("{byte:02X}"));
                }
            }
        }
    }
    Ok(encoded)
}

#[cfg(windows)]
fn windows_installed_apps() -> Vec<InstalledWorkspaceApp> {
    let cache = WINDOWS_APPS_CACHE.get_or_init(|| Mutex::new(None));
    let mut cached = cache.lock().unwrap_or_else(|error| error.into_inner());
    if let Some(apps) = cached.as_ref() {
        return apps.clone();
    }

    let resolver = WindowsAppResolver::new();
    const IDS: &[&str] = &[
        "explorer",
        "cursor",
        "vscode",
        "vscodeinsiders",
        "windsurf",
        "sublimetext",
        "androidstudio",
        "intellij",
        "pycharm",
        "webstorm",
        "phpstorm",
        "goland",
        "rider",
        "rustrover",
        "fork",
        "github",
        "sublimemerge",
        "windowsterminal",
        "gitbash",
    ];
    let apps = IDS
        .iter()
        .filter_map(|id| resolver.resolve(id))
        .collect::<Vec<_>>();
    *cached = Some(apps.clone());
    apps
}

#[cfg(windows)]
fn invalidate_windows_apps_cache() {
    let cache = WINDOWS_APPS_CACHE.get_or_init(|| Mutex::new(None));
    *cache.lock().unwrap_or_else(|error| error.into_inner()) = None;
}

#[cfg(windows)]
struct WindowsAppResolver {
    registry: WindowsRegistryView,
}

#[cfg(windows)]
impl WindowsAppResolver {
    fn new() -> Self {
        Self {
            registry: read_windows_registry_view(),
        }
    }

    fn resolve(&self, id: &str) -> Option<InstalledWorkspaceApp> {
        let name = app_display_name(id);
        if id == "explorer" {
            let icon = std::env::var_os("SystemRoot")
                .map(PathBuf::from)
                .map(|root| root.join("explorer.exe"));
            return Some(InstalledWorkspaceApp::shell_open(id, name, icon));
        }
        if id == "github" {
            let (program, cli) = github_desktop_launcher()?;
            return Some(InstalledWorkspaceApp {
                id: id.to_string(),
                name: name.to_string(),
                launcher: WorkspaceLauncher::Command {
                    program: program.clone(),
                    args: vec![cli.to_string_lossy().to_string(), "open".to_string()],
                    env: vec![("ELECTRON_RUN_AS_NODE".to_string(), "1".to_string())],
                    windows_hide: true,
                },
                icon_source: Some(program),
            });
        }

        let program = match id {
            "cursor" => self
                .app_path("Cursor.exe")
                .or_else(|| self.install_record("Cursor", None))
                .or_else(|| local_app_data_file(r"Programs\cursor\Cursor.exe")),
            "vscode" => self
                .app_path("Code.exe")
                .or_else(|| self.install_record("Microsoft Visual Studio Code", Some("Code.exe")))
                .or_else(|| local_app_data_file(r"Programs\Microsoft VS Code\Code.exe"))
                .or_else(|| program_files_file(r"Microsoft VS Code\Code.exe")),
            "vscodeinsiders" => self
                .app_path("Code - Insiders.exe")
                .or_else(|| {
                    self.install_record(
                        "Microsoft Visual Studio Code Insiders",
                        Some("Code - Insiders.exe"),
                    )
                })
                .or_else(|| {
                    local_app_data_file(r"Programs\Microsoft VS Code Insiders\Code - Insiders.exe")
                }),
            "windsurf" => self
                .app_path("Windsurf.exe")
                .or_else(|| self.install_record("Windsurf", None))
                .or_else(|| local_app_data_file(r"Programs\Windsurf\Windsurf.exe")),
            "sublimetext" => self
                .app_path("sublime_text.exe")
                .or_else(|| self.install_record("Sublime Text", None))
                .or_else(|| program_files_file(r"Sublime Text\sublime_text.exe")),
            "androidstudio" => self
                .install_record("Android Studio", Some("bin/studio64.exe"))
                .or_else(|| program_files_file(r"Android\Android Studio\bin\studio64.exe")),
            "intellij" => self
                .jetbrains("IntelliJ IDEA", r"bin\idea64.exe")
                .or_else(|| self.install_record("IntelliJ IDEA", Some("bin/idea64.exe"))),
            "pycharm" => self
                .jetbrains("PyCharm", r"bin\pycharm64.exe")
                .or_else(|| self.install_record("PyCharm", Some("bin/pycharm64.exe"))),
            "webstorm" => self
                .jetbrains("WebStorm", r"bin\webstorm64.exe")
                .or_else(|| self.install_record("WebStorm", Some("bin/webstorm64.exe"))),
            "phpstorm" => self
                .jetbrains("PhpStorm", r"bin\phpstorm64.exe")
                .or_else(|| self.install_record("PhpStorm", Some("bin/phpstorm64.exe"))),
            "goland" => self
                .jetbrains("GoLand", r"bin\goland64.exe")
                .or_else(|| self.install_record("GoLand", Some("bin/goland64.exe"))),
            "rider" => self
                .jetbrains("Rider", r"bin\rider64.exe")
                .or_else(|| self.install_record("Rider", Some("bin/rider64.exe"))),
            "rustrover" => self
                .jetbrains("RustRover", r"bin\rustrover64.exe")
                .or_else(|| self.install_record("RustRover", Some("bin/rustrover64.exe"))),
            "fork" => self
                .install_record("Fork", None)
                .or_else(|| local_app_data_file(r"Fork\Fork.exe")),
            "sublimemerge" => self
                .app_path("sublime_merge.exe")
                .or_else(|| self.install_record("Sublime Merge", None))
                .or_else(|| program_files_file(r"Sublime Merge\sublime_merge.exe")),
            "windowsterminal" => find_on_path("wt.exe"),
            "gitbash" => self
                .install_record("Git version", Some("git-bash.exe"))
                .or_else(|| program_files_file(r"Git\git-bash.exe")),
            _ => None,
        }?;
        let args: &[&str] = match id {
            "windowsterminal" => &["-d"],
            "gitbash" => &["--cd={path}"],
            _ => &[],
        };

        Some(InstalledWorkspaceApp {
            id: id.to_string(),
            name: name.to_string(),
            launcher: WorkspaceLauncher::Command {
                program: program.clone(),
                args: args.iter().map(|value| value.to_string()).collect(),
                env: Vec::new(),
                windows_hide: false,
            },
            icon_source: Some(program),
        })
    }

    fn app_path(&self, executable: &str) -> Option<PathBuf> {
        self.registry
            .app_paths
            .get(&executable.to_ascii_lowercase())
            .map(PathBuf::from)
            .filter(|path| path.is_file())
    }

    fn install_record(&self, prefix: &str, relative: Option<&str>) -> Option<PathBuf> {
        for record in &self.registry.install_records {
            if !record.display_name.starts_with(prefix) {
                continue;
            }
            if let (Some(relative), Some(location)) = (relative, record.install_location.as_deref())
            {
                if let Some(expanded) = expand_windows_value(location) {
                    let candidate = PathBuf::from(expanded).join(relative);
                    if candidate.is_file() {
                        return Some(candidate);
                    }
                }
            }
            if let Some(icon) = record.display_icon.as_deref() {
                if let Some(executable) = executable_from_display_icon(icon) {
                    if executable.is_file() {
                        return Some(executable);
                    }
                }
            }
        }
        None
    }

    fn jetbrains(&self, prefix: &str, relative_launcher: &str) -> Option<PathBuf> {
        let root = std::env::var_os("ProgramFiles")
            .map(PathBuf::from)
            .map(|root| root.join("JetBrains"))?;
        let entries = std::fs::read_dir(root).ok()?;
        let mut versions = entries
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(prefix))
            .collect::<Vec<_>>();
        versions.sort_by(|left, right| {
            natural_version_cmp(
                &right.file_name().to_string_lossy(),
                &left.file_name().to_string_lossy(),
            )
        });
        versions.into_iter().find_map(|entry| {
            let candidate = entry.path().join(relative_launcher);
            candidate.is_file().then_some(candidate)
        })
    }
}

#[cfg(windows)]
#[derive(Debug, Default)]
struct WindowsRegistryView {
    app_paths: HashMap<String, String>,
    install_records: Vec<WindowsInstallRecord>,
}

#[cfg(windows)]
#[derive(Debug)]
struct WindowsInstallRecord {
    display_name: String,
    install_location: Option<String>,
    display_icon: Option<String>,
}

#[cfg(windows)]
fn read_windows_registry_view() -> WindowsRegistryView {
    let mut view = WindowsRegistryView::default();
    for root in [
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths",
        r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths",
    ] {
        let Some(dump) = registry_query(root) else {
            continue;
        };
        for (key, values) in parse_registry_dump(&dump) {
            let executable = key
                .rsplit('\\')
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase();
            let Some(target) = values.get("(default)").or_else(|| values.get("(Default)")) else {
                continue;
            };
            if !executable.ends_with(".exe") || view.app_paths.contains_key(&executable) {
                continue;
            }
            if let Some(expanded) = expand_windows_value(target) {
                view.app_paths.insert(executable, expanded);
            }
        }
    }

    for root in [
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    ] {
        let Some(dump) = registry_query(root) else {
            continue;
        };
        for values in parse_registry_dump(&dump).values() {
            let Some(display_name) = values.get("DisplayName") else {
                continue;
            };
            view.install_records.push(WindowsInstallRecord {
                display_name: display_name.clone(),
                install_location: values.get("InstallLocation").cloned(),
                display_icon: values.get("DisplayIcon").cloned(),
            });
        }
    }
    view
}

#[cfg(windows)]
fn registry_query(root: &str) -> Option<String> {
    let output = Command::new("reg.exe")
        .args(["query", root, "/s"])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(windows)]
fn parse_registry_dump(dump: &str) -> HashMap<String, HashMap<String, String>> {
    let value_pattern =
        regex::Regex::new(r"^\s+(.*?)\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)$").expect("registry regex");
    let mut keys = HashMap::new();
    let mut current_key: Option<String> = None;
    for line in dump.lines() {
        if line.starts_with("HK") {
            current_key = Some(line.trim().to_string());
            keys.entry(line.trim().to_string())
                .or_insert_with(HashMap::new);
            continue;
        }
        let Some(captures) = value_pattern.captures(line) else {
            continue;
        };
        let Some(key) = current_key.as_ref() else {
            continue;
        };
        let raw_name = captures
            .get(1)
            .map(|value| value.as_str())
            .unwrap_or_default();
        let name = if raw_name.starts_with('(') && raw_name.ends_with(')') {
            "(default)"
        } else {
            raw_name
        };
        let value = captures
            .get(3)
            .map(|value| value.as_str().trim().to_string())
            .unwrap_or_default();
        keys.entry(key.clone())
            .or_insert_with(HashMap::new)
            .insert(name.to_string(), value);
    }
    keys
}

#[cfg(windows)]
fn expand_windows_value(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_matches('"');
    let mut expanded = String::with_capacity(trimmed.len());
    let mut rest = trimmed;
    while let Some(start) = rest.find('%') {
        expanded.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('%') else {
            return None;
        };
        let variable = &after[..end];
        let value = std::env::var(variable).ok()?;
        expanded.push_str(&value);
        rest = &after[end + 1..];
    }
    expanded.push_str(rest);
    Some(expanded)
}

#[cfg(windows)]
fn executable_from_display_icon(value: &str) -> Option<PathBuf> {
    let trimmed = value.trim().trim_matches('"');
    let without_index = trimmed.split_once(',').map_or(trimmed, |(path, index)| {
        if index.parse::<i32>().is_ok() {
            path.trim().trim_matches('"')
        } else {
            trimmed
        }
    });
    let expanded = expand_windows_value(without_index)?;
    expanded
        .to_ascii_lowercase()
        .ends_with(".exe")
        .then(|| PathBuf::from(expanded))
}

#[cfg(windows)]
fn local_app_data_file(relative: &str) -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|root| root.join(relative))
        .filter(|path| path.is_file())
}

#[cfg(windows)]
fn program_files_file(relative: &str) -> Option<PathBuf> {
    std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .map(|root| root.join(relative))
        .filter(|path| path.is_file())
}

#[cfg(windows)]
fn find_on_path(file_name: &str) -> Option<PathBuf> {
    let path_value = std::env::var_os("PATH")?;
    std::env::split_paths(&path_value)
        .map(|directory| directory.join(file_name))
        .find(|candidate| candidate.is_file())
}

#[cfg(windows)]
fn github_desktop_launcher() -> Option<(PathBuf, PathBuf)> {
    let root = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|root| root.join("GitHubDesktop"))?;
    let mut versions = std::fs::read_dir(root)
        .ok()?
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("app-"))
        .collect::<Vec<_>>();
    versions.sort_by(|left, right| {
        natural_version_cmp(
            &right.file_name().to_string_lossy(),
            &left.file_name().to_string_lossy(),
        )
    });
    versions.into_iter().find_map(|entry| {
        let directory = entry.path();
        let executable = directory.join("GitHubDesktop.exe");
        let cli = directory.join(r"resources\app\cli.js");
        (executable.is_file() && cli.is_file()).then_some((executable, cli))
    })
}

fn natural_version_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    fn next_chunk<'a>(value: &'a str, index: &mut usize, numeric: bool) -> &'a str {
        let start = *index;
        while *index < value.len() {
            let character = value[*index..].chars().next().unwrap_or_default();
            if character.is_ascii_digit() != numeric {
                break;
            }
            *index += character.len_utf8();
        }
        &value[start..*index]
    }

    let mut left_index = 0;
    let mut right_index = 0;
    let mut numeric = false;
    loop {
        let left_chunk = next_chunk(left, &mut left_index, numeric);
        let right_chunk = next_chunk(right, &mut right_index, numeric);
        let ordering = if numeric {
            let left_number = left_chunk.parse::<u128>().unwrap_or(0);
            let right_number = right_chunk.parse::<u128>().unwrap_or(0);
            left_number.cmp(&right_number)
        } else {
            left_chunk.cmp(right_chunk)
        };
        if ordering != std::cmp::Ordering::Equal {
            return ordering;
        }
        if left_index >= left.len() && right_index >= right.len() {
            return std::cmp::Ordering::Equal;
        }
        numeric = !numeric;
    }
}

#[cfg(target_os = "macos")]
fn macos_installed_apps() -> Vec<InstalledWorkspaceApp> {
    let roots = [
        PathBuf::from("/Applications"),
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|home| home.join("Applications"))
            .unwrap_or_else(|| PathBuf::from("/Applications")),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/System/Applications/Utilities"),
    ];
    let definitions: &[(&str, &[&str])] = &[
        ("finder", &[]),
        ("cursor", &["Cursor.app"]),
        ("vscode", &["Visual Studio Code.app"]),
        ("vscodeinsiders", &["Visual Studio Code - Insiders.app"]),
        ("windsurf", &["Windsurf.app"]),
        ("zed", &["Zed.app", "Zed Preview.app"]),
        ("sublimetext", &["Sublime Text.app"]),
        ("xcode", &["Xcode.app"]),
        ("androidstudio", &["Android Studio.app"]),
        (
            "intellij",
            &[
                "IntelliJ IDEA.app",
                "IntelliJ IDEA Ultimate.app",
                "IntelliJ IDEA CE.app",
            ],
        ),
        (
            "pycharm",
            &[
                "PyCharm.app",
                "PyCharm Professional.app",
                "PyCharm CE.app",
                "PyCharm Community.app",
            ],
        ),
        ("webstorm", &["WebStorm.app"]),
        ("phpstorm", &["PhpStorm.app"]),
        ("goland", &["GoLand.app"]),
        ("rider", &["Rider.app", "JetBrains Rider.app"]),
        ("rustrover", &["RustRover.app"]),
        ("fork", &["Fork.app"]),
        ("sourcetree", &["Sourcetree.app"]),
        ("github", &["GitHub Desktop.app"]),
        ("tower", &["Tower.app"]),
        ("gitkraken", &["GitKraken.app"]),
        ("smartgit", &["SmartGit.app"]),
        ("sublimemerge", &["Sublime Merge.app"]),
        ("ghostty", &["Ghostty.app"]),
        ("warp", &["Warp.app"]),
        ("iterm", &["iTerm.app"]),
        ("kitty", &["kitty.app"]),
        ("terminal", &["Terminal.app"]),
    ];
    definitions
        .iter()
        .filter_map(|(id, bundles)| {
            let name = app_display_name(id);
            if *id == "finder" {
                return Some(InstalledWorkspaceApp::shell_open(id, name, None));
            }
            let bundle = roots
                .iter()
                .flat_map(|root| bundles.iter().map(move |bundle| root.join(bundle)))
                .find(|candidate| candidate.is_dir())?;
            Some(InstalledWorkspaceApp {
                id: id.to_string(),
                name: name.to_string(),
                launcher: WorkspaceLauncher::Command {
                    program: PathBuf::from("open"),
                    args: vec!["-a".to_string(), bundle.to_string_lossy().to_string()],
                    env: Vec::new(),
                    windows_hide: false,
                },
                icon_source: Some(bundle),
            })
        })
        .collect()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn linux_installed_apps() -> Vec<InstalledWorkspaceApp> {
    let definitions: &[(&str, &[&str], &[&str])] = &[
        ("filemanager", &["xdg-open"], &[]),
        ("cursor", &["cursor"], &[]),
        ("vscode", &["code"], &[]),
        ("vscodeinsiders", &["code-insiders"], &[]),
        ("windsurf", &["windsurf"], &[]),
        ("zed", &["zed"], &[]),
        ("sublimetext", &["subl"], &[]),
        ("androidstudio", &["studio"], &[]),
        ("intellij", &["idea"], &[]),
        ("pycharm", &["pycharm"], &[]),
        ("webstorm", &["webstorm"], &[]),
        ("phpstorm", &["phpstorm"], &[]),
        ("goland", &["goland"], &[]),
        ("rider", &["rider"], &[]),
        ("rustrover", &["rustrover"], &[]),
        ("sublimemerge", &["smerge"], &[]),
        ("ghostty", &["ghostty"], &["--working-directory={path}"]),
        ("kitty", &["kitty"], &["--directory"]),
        (
            "gnometerminal",
            &["gnome-terminal"],
            &["--working-directory={path}"],
        ),
        ("konsole", &["konsole"], &["--workdir"]),
    ];
    definitions
        .iter()
        .filter_map(|(id, commands, args)| {
            let name = app_display_name(id);
            if *id == "filemanager" {
                return Some(InstalledWorkspaceApp::shell_open(id, name, None));
            }
            let program = commands
                .iter()
                .find_map(|command| find_command_on_path(command))?;
            Some(InstalledWorkspaceApp {
                id: id.to_string(),
                name: name.to_string(),
                launcher: WorkspaceLauncher::Command {
                    program: program.clone(),
                    args: args.iter().map(|value| value.to_string()).collect(),
                    env: Vec::new(),
                    windows_hide: false,
                },
                icon_source: None,
            })
        })
        .collect()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn find_command_on_path(command: &str) -> Option<PathBuf> {
    let path_value = std::env::var_os("PATH")?;
    std::env::split_paths(&path_value)
        .map(|directory| directory.join(command))
        .find(|candidate| candidate.is_file())
}

fn app_display_name(id: &str) -> &'static str {
    match id {
        "explorer" => "文件资源管理器",
        "finder" => "访达",
        "filemanager" => "文件管理器",
        "cursor" => "Cursor",
        "vscode" => "VS Code",
        "vscodeinsiders" => "VS Code Insiders",
        "windsurf" => "Windsurf",
        "zed" => "Zed",
        "sublimetext" => "Sublime Text",
        "xcode" => "Xcode",
        "androidstudio" => "Android Studio",
        "intellij" => "IntelliJ IDEA",
        "pycharm" => "PyCharm",
        "webstorm" => "WebStorm",
        "phpstorm" => "PhpStorm",
        "goland" => "GoLand",
        "rider" => "Rider",
        "rustrover" => "RustRover",
        "fork" => "Fork",
        "sourcetree" => "Sourcetree",
        "github" => "GitHub Desktop",
        "tower" => "Tower",
        "gitkraken" => "GitKraken",
        "smartgit" => "SmartGit",
        "sublimemerge" => "Sublime Merge",
        "ghostty" => "Ghostty",
        "warp" => "Warp",
        "iterm" => "iTerm2",
        "kitty" => "kitty",
        "terminal" => "终端",
        "windowsterminal" => "Windows Terminal",
        "gitbash" => "Git Bash",
        "gnometerminal" => "GNOME Terminal",
        "konsole" => "Konsole",
        _ => "打开方式",
    }
}

fn platform_app_icon(source: &Path) -> Option<String> {
    #[cfg(windows)]
    {
        return windows_app_icon(source);
    }
    #[cfg(target_os = "macos")]
    {
        return macos_app_icon(source);
    }
    #[allow(unreachable_code)]
    None
}

#[cfg(windows)]
fn windows_app_icon(source: &Path) -> Option<String> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const ICON_SCRIPT: &str = r#"param([string]$Source, [string]$Target)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($Source)
if ($null -eq $icon) { exit 1 }
$bitmap = $icon.ToBitmap()
$bitmap.Save($Target, [System.Drawing.Imaging.ImageFormat]::Png)
"#;

    let directory = std::env::temp_dir().join(format!("omni-app-icon-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).ok()?;
    let script = directory.join("extract-icon.ps1");
    let output = directory.join("icon.png");
    std::fs::write(&script, ICON_SCRIPT).ok()?;

    let powershell = PathBuf::from(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe");
    let status = Command::new(if powershell.is_file() {
        powershell.as_os_str()
    } else {
        std::ffi::OsStr::new("powershell.exe")
    })
    .args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
    ])
    .arg(&script)
    .arg(source)
    .arg(&output)
    .creation_flags(CREATE_NO_WINDOW)
    .status();
    let bytes = status
        .ok()
        .filter(|status| status.success())
        .and_then(|_| std::fs::read(&output).ok());
    let _ = std::fs::remove_dir_all(&directory);
    bytes.map(|bytes| {
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    })
}

#[cfg(target_os = "macos")]
fn macos_app_icon(source: &Path) -> Option<String> {
    const SCRIPT: &str = r#"
ObjC.import('AppKit');
function run(argv) {
  var icon = $.NSWorkspace.sharedWorkspace.iconForFile(argv[0]);
  var thumbnail = $.NSImage.alloc.initWithSize($.NSMakeSize(32, 32));
  thumbnail.lockFocus;
  icon.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, 32, 32), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
  thumbnail.unlockFocus;
  var bitmap = $.NSBitmapImageRep.imageRepWithData(thumbnail.TIFFRepresentation);
  var png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
  return png.isNil() ? '' : 'data:image/png;base64,' + ObjC.unwrap(png.base64EncodedStringWithOptions(0));
}
"#;
    let output = Command::new("osascript")
        .args(["-l", "JavaScript", "-e", SCRIPT])
        .arg(source)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let icon = String::from_utf8_lossy(&output.stdout).trim().to_string();
    icon.starts_with("data:image/png;base64,").then_some(icon)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn substitutes_the_workspace_path_token() {
        let target = Path::new(r"D:\Code\Omni Product");
        let args = [String::from("--cd={path}")];
        let expanded = args
            .iter()
            .map(|arg| arg.replace("{path}", &target.to_string_lossy()))
            .collect::<Vec<_>>();
        assert_eq!(expanded, vec![r"--cd=D:\Code\Omni Product"]);
    }

    #[test]
    fn natural_version_sort_handles_jetbrains_versions() {
        assert_eq!(
            natural_version_cmp("2026.1.10", "2026.1.9"),
            std::cmp::Ordering::Greater
        );
        assert_eq!(
            natural_version_cmp("2025.3", "2026.1"),
            std::cmp::Ordering::Less
        );
    }

    #[cfg(windows)]
    #[test]
    fn explorer_target_encodes_uri_separators_but_keeps_unicode() {
        let target = Path::new(r"D:\项目,Omni=Alpha\工作区");
        assert_eq!(
            windows_explorer_target(target).unwrap(),
            "file:///D:/项目%2COmni%3DAlpha/工作区"
        );
    }

    #[cfg(windows)]
    #[test]
    fn parses_registry_sz_and_expand_sz_values() {
        let dump = r#"HKEY_CURRENT_USER\Software\Test
    DisplayName    REG_SZ    IntelliJ IDEA 2026.1.3
    InstallLocation    REG_EXPAND_SZ    D:\Dev_tools\IntelliJ IDEA 2026.1.3

HKEY_CURRENT_USER\Software\Test\Code.exe
    (Default)    REG_SZ    D:\Dev_tools\Microsoft VS Code\Code.exe
"#;
        let parsed = parse_registry_dump(dump);
        let record = parsed.get(r"HKEY_CURRENT_USER\Software\Test").unwrap();
        assert_eq!(
            record.get("DisplayName").map(String::as_str),
            Some("IntelliJ IDEA 2026.1.3")
        );
        assert_eq!(
            parsed
                .get(r"HKEY_CURRENT_USER\Software\Test\Code.exe")
                .and_then(|values| values.get("(default)"))
                .map(String::as_str),
            Some(r"D:\Dev_tools\Microsoft VS Code\Code.exe")
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_catalog_always_keeps_the_explorer_fallback() {
        let apps = windows_installed_apps();
        eprintln!(
            "detected workspace apps: {}",
            apps.iter()
                .map(|app| format!("{}={}", app.id, app.name))
                .collect::<Vec<_>>()
                .join(", ")
        );
        assert_eq!(apps.first().map(|app| app.id.as_str()), Some("explorer"));
        if let Some(source) = apps
            .iter()
            .find(|app| app.id == "vscode")
            .and_then(|app| app.icon_source.as_deref())
        {
            let icon = windows_app_icon(source).expect("VS Code icon should be extractable");
            assert!(icon.starts_with("data:image/png;base64,"));
        }
    }
}
