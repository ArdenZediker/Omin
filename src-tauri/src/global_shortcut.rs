//! 全局快捷键（OS 级）注册。
//!
//! 只有真正需要「应用未聚焦时也能触发」的动作才走这里——目前仅 `openMainShortcut`（唤起主界面）。
//! 窗口内快捷键仍由前端 DOM keydown 处理（见 `src/app/shortcuts.ts` 的分类器），
//! 两者以「全局是否注册成功」为界：注册成功则 DOM 不再响应同一按键，避免一次按键触发两次。
//!
//! 前端存储的写法（如 `Ctrl+Shift+Space`）与 `global-hotkey` 解析器有两处差异：
//! - 解析器不识别 `Meta`，只认 `Super` / `Command` / `Cmd`；
//! - 解析器对键名大小写不敏感，但历史数据里空格键被写成单个空格（`Ctrl+Shift+ `）。
//! 因此这里做一次规范化翻译，而不是让两端各自妥协。

use tauri::{AppHandle, Runtime};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

/// 前端「未设置」哨兵值，与 `src/app/constants.ts` 的 UNSET_SHORTCUT 保持一致。
const UNSET_SHORTCUT: &str = "未设置";

/// 仅作修饰键使用的 token；用来判断一个组合里是否存在真正的“主键”。
const MODIFIER_TOKENS: [&str; 8] = [
    "CTRL",
    "CONTROL",
    "SHIFT",
    "ALT",
    "OPTION",
    "SUPER",
    "COMMAND",
    "CMD",
];

/// 把前端快捷键串翻译成 `global-hotkey` 可解析的规范形式。
///
/// 返回 `None` 表示「不注册」：空值、未设置、或只有修饰键而没有主键（如 `Ctrl+Shift`），
/// 这些情况下注册必然失败，不如直接视为未绑定。
fn to_hotkey_spec(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == UNSET_SHORTCUT {
        return None;
    }

    let mut has_main_key = false;
    let mut tokens: Vec<String> = Vec::new();
    for token in trimmed.split('+') {
        let token = token.trim();
        let normalized = match token {
            // 解析器只认 Super / Command / Cmd，不认 Meta。
            "Meta" | "meta" => "Super",
            // 兼容历史数据：早期把空格键写成单个空格，trim 后被 split 成空串。
            "" => "Space",
            other => other,
        };
        if !MODIFIER_TOKENS.contains(&normalized.to_ascii_uppercase().as_str()) {
            has_main_key = true;
        }
        tokens.push(normalized.to_string());
    }

    if !has_main_key {
        return None;
    }
    Some(tokens.join("+"))
}

/// 重新注册「唤起主界面」的全局快捷键。
///
/// 先 `unregister_all()` 再注册：设置变更时旧绑定必须移除，否则会残留多个热键；
/// 且同一组合键重复注册会直接报错。
/// 传入 `None` / 空串 / 未设置 表示仅解绑、不注册新热键。
///
/// 注册失败（最常见原因是组合键已被其它程序占用）会以 `Err` 返回，
/// 前端据此回落到 DOM 监听——即「仅窗口聚焦时生效」，而不是静默失效。
#[tauri::command]
pub fn register_open_main_shortcut<R: Runtime>(
    app: AppHandle<R>,
    shortcut: Option<String>,
) -> Result<(), String> {
    let manager = app.global_shortcut();
    let _ = manager.unregister_all();

    let Some(spec) = shortcut.as_deref().and_then(to_hotkey_spec) else {
        return Ok(());
    };

    manager
        .register(spec.as_str())
        .map_err(|err| format!("全局快捷键注册失败：{err}（可能已被其它程序占用）"))
}

#[cfg(test)]
mod tests {
    use super::to_hotkey_spec;

    #[test]
    fn rejects_unset_and_empty() {
        assert_eq!(to_hotkey_spec(""), None);
        assert_eq!(to_hotkey_spec("   "), None);
        assert_eq!(to_hotkey_spec("未设置"), None);
    }

    #[test]
    fn rejects_modifier_only_chord() {
        // 只有修饰键没有主键，解析器必然报错，直接判定为未绑定。
        assert_eq!(to_hotkey_spec("Ctrl+Shift"), None);
    }

    #[test]
    fn maps_meta_to_super() {
        assert_eq!(to_hotkey_spec("Meta+Space").as_deref(), Some("Super+Space"));
    }

    #[test]
    fn repairs_legacy_space_key() {
        // 历史数据里 Ctrl+Shift+空格 被存成 "Ctrl+Shift+ "。
        assert_eq!(
            to_hotkey_spec("Ctrl+Shift+ ").as_deref(),
            Some("Ctrl+Shift+Space")
        );
    }

    #[test]
    fn keeps_normal_spec_untouched() {
        assert_eq!(
            to_hotkey_spec("Ctrl+Shift+Space").as_deref(),
            Some("Ctrl+Shift+Space")
        );
        assert_eq!(
            to_hotkey_spec("Alt+F4").as_deref(),
            Some("Alt+F4")
        );
    }
}
