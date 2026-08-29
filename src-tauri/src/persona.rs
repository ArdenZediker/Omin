//! 个性化配置的本地 md 文件存储层。
//!
//! 设计参考 codex / Claude Code / deepseek-harness：把个人化信息存为一组
//! 纯文本 md 文件，而非数据库字段。好处是人和 AI 都能直接读写、可读可
//! diff、可进 git，并且对话中 AI 可以通过工具自主选择更新这些文件。
//!
//! 文件位于 `<data_root>/persona/` 目录下：
//!
//! 结构化字段（UI 卡片编辑、AI 工具写入）：
//! - `style.md`               -> 风格枚举 key（default / professional / ...）
//! - `user-name.md`           -> 对用户的称呼
//! - `assistant-name.md`      -> Omni 的名字
//! - `persona-description.md` -> 人设 / 人格描述
//! - `custom-instructions.md` -> 自定义指令
//! - `long-term-memory.md`    -> 长期记忆记录
//!
//! 指令文件（仿 codex 的 AGENTS.md 规范，人和 AI 都可自由编辑）：
//! - `AGENTS.md`              -> 规范化的自由格式指令文件，作为助手的行为约定
//! - `AGENTS.override.md`     -> 本地覆盖文件，存在且非空时优先于 `AGENTS.md`
//!
//! 指令文件受字节预算约束（`PERSONA_DOC_MAX_BYTES`），超出部分会被截断，
//! 与 codex 的 `project_doc_max_bytes` 行为一致。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::database::open_sqlite_connection;
use crate::storage::read_kv;
use crate::storage_paths::resolve_data_root;

const PERSONA_DIR_NAME: &str = "persona";
const LEGACY_APP_KV_KEY: &str = "omni_personalization";

const STYLE_FILE: &str = "style.md";
const USER_NAME_FILE: &str = "user-name.md";
const ASSISTANT_NAME_FILE: &str = "assistant-name.md";
const PERSONA_DESCRIPTION_FILE: &str = "persona-description.md";
const CUSTOM_INSTRUCTIONS_FILE: &str = "custom-instructions.md";
const LONG_TERM_MEMORY_FILE: &str = "long-term-memory.md";

/// 规范化的指令文件名（仿 codex / deepseek-harness 的 AGENTS.md 约定）。
const AGENTS_MD_FILE: &str = "AGENTS.md";
/// 本地覆盖指令文件，优先于 `AGENTS.md`。
const AGENTS_OVERRIDE_FILE: &str = "AGENTS.override.md";

/// 指令文件的字节预算上限，超出部分会被截断（仿 codex 的 `project_doc_max_bytes`）。
const PERSONA_DOC_MAX_BYTES: usize = 16_384;

const VALID_STYLES: &[&str] = &[
    "default",
    "professional",
    "friendly",
    "direct",
    "creative",
    "efficient",
    "snarky",
    "socratic",
];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PersonaConfigDto {
    #[serde(default)]
    pub(crate) style: String,
    #[serde(default)]
    pub(crate) custom_instruction: String,
    #[serde(default)]
    pub(crate) user_name: String,
    #[serde(default)]
    pub(crate) assistant_name: String,
    #[serde(default)]
    pub(crate) persona_description: String,
    #[serde(default)]
    pub(crate) long_term_memory: String,
    /// 来自 `AGENTS.md` / `AGENTS.override.md` 的自由格式指令内容。
    #[serde(default)]
    pub(crate) agents_md: String,
}

pub(crate) fn persona_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = resolve_data_root(app)?;
    Ok(root.join(PERSONA_DIR_NAME))
}

fn read_field(dir: &Path, file_name: &str) -> String {
    let path = dir.join(file_name);
    match fs::read_to_string(&path) {
        Ok(content) => content.trim().to_string(),
        Err(_) => String::new(),
    }
}

fn write_field(dir: &Path, file_name: &str, content: &str) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    let path = dir.join(file_name);
    fs::write(&path, content.trim()).map_err(|err| err.to_string())?;
    Ok(())
}

fn normalize_style(raw: &str) -> String {
    let value = raw.trim();
    if VALID_STYLES.contains(&value) {
        return value.to_string();
    }
    "default".to_string()
}

/// 读取指令文件（`AGENTS.md` 或 `AGENTS.override.md`），并按字节预算截断。
/// 仿 codex 的 `project_doc_max_bytes`：超出预算的内容会被裁掉，避免无限膨胀上下文。
fn read_agent_doc(dir: &Path, file_name: &str) -> String {
    let path = dir.join(file_name);
    let data = match fs::read(&path) {
        Ok(data) => data,
        Err(_) => return String::new(),
    };
    if data.len() > PERSONA_DOC_MAX_BYTES {
        eprintln!(
            "[omni] persona instruction doc {} exceeds {} bytes; truncating",
            path.display(),
            PERSONA_DOC_MAX_BYTES
        );
    }
    let limit = data.len().min(PERSONA_DOC_MAX_BYTES);
    String::from_utf8_lossy(&data[..limit]).trim().to_string()
}

/// 首次迁移：如果 persona 目录为空，且旧 app_kv 里存在个性化配置，
/// 则把它拆成 md 文件，保证已有用户数据不丢失。
fn migrate_from_legacy(app: &tauri::AppHandle, dir: &Path) -> Result<(), String> {
    let connection = open_sqlite_connection(app)?;
    let legacy = match read_kv(&connection, LEGACY_APP_KV_KEY)? {
        Some(value) => value,
        None => return Ok(()),
    };

    let parsed: PersonaConfigDto = match serde_json::from_str(&legacy) {
        Ok(parsed) => parsed,
        Err(_) => return Ok(()),
    };

    fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    write_field(dir, STYLE_FILE, &normalize_style(&parsed.style))?;
    write_field(dir, USER_NAME_FILE, &parsed.user_name)?;
    write_field(dir, ASSISTANT_NAME_FILE, &parsed.assistant_name)?;
    write_field(dir, PERSONA_DESCRIPTION_FILE, &parsed.persona_description)?;
    write_field(dir, CUSTOM_INSTRUCTIONS_FILE, &parsed.custom_instruction)?;
    write_field(dir, LONG_TERM_MEMORY_FILE, &parsed.long_term_memory)?;

    // 迁移完成后清理旧字段，避免下次又覆盖 md。
    let _ = connection.execute(
        "DELETE FROM app_kv WHERE key = ?1",
        [LEGACY_APP_KV_KEY],
    );
    Ok(())
}

pub(crate) fn read_persona_files(app: &tauri::AppHandle) -> Result<PersonaConfigDto, String> {
    let dir = persona_dir(app)?;
    if !dir.exists() || fs::read_dir(&dir).map(|mut it| it.next().is_none()).unwrap_or(true) {
        migrate_from_legacy(app, &dir)?;
    }

    let mut config = PersonaConfigDto::default();
    config.style = normalize_style(&read_field(&dir, STYLE_FILE));
    config.user_name = read_field(&dir, USER_NAME_FILE);
    config.assistant_name = read_field(&dir, ASSISTANT_NAME_FILE);
    config.persona_description = read_field(&dir, PERSONA_DESCRIPTION_FILE);
    config.custom_instruction = read_field(&dir, CUSTOM_INSTRUCTIONS_FILE);
    config.long_term_memory = read_field(&dir, LONG_TERM_MEMORY_FILE);
    // AGENTS.override.md 优先于 AGENTS.md（仿 codex 的本地覆盖约定）。
    let override_doc = read_agent_doc(&dir, AGENTS_OVERRIDE_FILE);
    config.agents_md = if !override_doc.trim().is_empty() {
        override_doc
    } else {
        read_agent_doc(&dir, AGENTS_MD_FILE)
    };
    Ok(config)
}

pub(crate) fn write_persona_file(
    app: &tauri::AppHandle,
    key: String,
    content: String,
) -> Result<(), String> {
    let dir = persona_dir(app)?;
    match key.as_str() {
        "style" => write_field(&dir, STYLE_FILE, &normalize_style(&content)),
        "userName" => write_field(&dir, USER_NAME_FILE, &content),
        "assistantName" => write_field(&dir, ASSISTANT_NAME_FILE, &content),
        "personaDescription" => write_field(&dir, PERSONA_DESCRIPTION_FILE, &content),
        "customInstruction" => write_field(&dir, CUSTOM_INSTRUCTIONS_FILE, &content),
        "longTermMemory" => write_field(&dir, LONG_TERM_MEMORY_FILE, &content),
        "agentsMd" => write_field(&dir, AGENTS_MD_FILE, &content),
        _ => Err(format!("未知的个性化字段：{key}")),
    }
}
