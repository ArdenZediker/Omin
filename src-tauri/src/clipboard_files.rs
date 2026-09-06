// 系统级文件剪贴板：把「文字 + 文件列表 + base64 图片」一起放进剪贴板。
// 这样用户「复制消息」后，既能在文本编辑器里粘贴出文字，
// 也能在文件管理器里 Ctrl+V 直接粘贴出文件（CF_HDROP / NSFilenamesPboardType）。
//
// 复用 arboard（已作为 tauri-plugin-clipboard-manager 的传递依赖引入）：
// set().text() 会清空并写入文本；set().file_list() 用 SetClipboardData(CF_HDROP) 直接追加文件格式、不清空，
// 因此「先 text 后 file_list」可让文字与文件同时存在于剪贴板。
//
// base64 图片（消息内联图）不是真实文件，本命令把它们解码后写入应用数据目录下的
// clipboard_cache 子目录（不会被系统临时清理误删），再把生成的路径并入文件列表。

use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use tauri::Manager;
use serde::Deserialize;

/// 前端传来的内联图片（base64 DataURL）。
#[derive(Deserialize)]
pub struct ClipboardImage {
  pub name: Option<String>,
  pub src: String,
}

/// 从 data URL 前缀推断图片扩展名（缺省 png）。
fn image_ext_from_data_url(src: &str) -> &str {
  let prefix = src
    .split(';')
    .next()
    .unwrap_or("")
    .trim_start_matches("data:")
    .trim_start_matches("image/");
  match prefix {
    "png" => "png",
    "jpeg" | "jpg" => "jpg",
    "webp" => "webp",
    "gif" => "gif",
    "bmp" => "bmp",
    _ => "png",
  }
}

/// 把文件名清洗成安全的单一文件名片段（去路径、去非法字符）。
fn sanitize_file_stem(name: &str) -> String {
  let cleaned: String = name
    .chars()
    .filter(|c| !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\r' | '\n' | '\t'))
    .collect();
  let cleaned = cleaned.trim().trim_end_matches('.').to_string();
  if cleaned.is_empty() {
    "image".to_string()
  } else {
    cleaned
  }
}

#[tauri::command]
pub fn write_clipboard_with_files(
  app: tauri::AppHandle,
  text: String,
  paths: Vec<String>,
  images: Vec<ClipboardImage>,
) -> Result<(), String> {
  let mut all_files: Vec<PathBuf> = paths
    .into_iter()
    .map(PathBuf::from)
    .filter(|path| path.exists())
    .collect();

  // base64 图片解码落盘到应用数据目录的 clipboard_cache（稳定、不随系统临时清理丢失）
  if !images.is_empty() {
    let base = app
      .path()
      .app_data_dir()
      .map_err(|err| format!("获取应用数据目录失败: {err}"))?;
    let cache_dir = base.join("clipboard_cache");
    std::fs::create_dir_all(&cache_dir).map_err(|err| format!("创建剪贴板缓存目录失败: {err}"))?;

    for image in images {
      let src = image.src.trim();
      let b64 = match src.find("base64,") {
        Some(idx) => &src[idx + "base64,".len()..],
        None => src,
      };
      let bytes = BASE64_STANDARD
        .decode(b64.replace('\n', "").replace('\r', "").replace(' ', ""))
        .map_err(|err| format!("解码图片 base64 失败: {err}"))?;

      let ext = image_ext_from_data_url(src);
      let stem = sanitize_file_stem(image.name.as_deref().unwrap_or("image"));
      let file_name = format!("{stem}.{ext}");
      let path = cache_dir.join(file_name);
      std::fs::write(&path, &bytes).map_err(|err| format!("写入剪贴板图片失败: {err}"))?;
      all_files.push(path);
    }
  }

  let mut clipboard = arboard::Clipboard::new().map_err(|err| format!("打开剪贴板失败: {err}"))?;

  if !text.is_empty() {
    clipboard
      .set()
      .text(text.as_str())
      .map_err(|err| format!("写入剪贴板文本失败: {err}"))?;
  }

  if !all_files.is_empty() {
    clipboard
      .set()
      .file_list(&all_files)
      .map_err(|err| format!("写入剪贴板文件失败: {err}"))?;
  }

  Ok(())
}
