// 系统级文件剪贴板：把「文字 + 文件列表」一起放进剪贴板。
// 这样用户「复制消息」后，既能在文本编辑器里粘贴出文字，
// 也能在文件管理器里 Ctrl+V 直接粘贴出文件（CF_HDROP / NSFilenamesPboardType）。
//
// 复用 arboard（已作为 tauri-plugin-clipboard-manager 的传递依赖引入）：
// set().text() 会清空并写入文本；set().file_list() 用 SetClipboardData(CF_HDROP) 直接追加文件格式、不清空，
// 因此「先 text 后 file_list」可让文字与文件同时存在于剪贴板。

use std::path::PathBuf;

#[tauri::command]
pub fn write_clipboard_with_files(text: String, paths: Vec<String>) -> Result<(), String> {
  let valid_paths: Vec<PathBuf> = paths
    .into_iter()
    .map(PathBuf::from)
    .filter(|path| path.exists())
    .collect();

  let mut clipboard = arboard::Clipboard::new().map_err(|err| format!("打开剪贴板失败: {err}"))?;

  if !text.is_empty() {
    clipboard
      .set()
      .text(text.as_str())
      .map_err(|err| format!("写入剪贴板文本失败: {err}"))?;
  }

  if !valid_paths.is_empty() {
    clipboard
      .set()
      .file_list(&valid_paths)
      .map_err(|err| format!("写入剪贴板文件失败: {err}"))?;
  }

  Ok(())
}
