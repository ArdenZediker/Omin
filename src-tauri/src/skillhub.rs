//! 由 lib.rs 拆分而来，逻辑保持不变。

use reqwest::blocking::Client as BlockingHttpClient;
use reqwest::Client as HttpClient;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::{
    cmp::Ordering,
    collections::HashMap,
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

use super::*;

// ---- SkillHub 技能安装（一切皆插件：从 SkillHub 实时安装 DSH 风格 SKILL.md 技能）----
#[derive(serde::Serialize)]
pub(crate) struct SkillhubInstallResult {
    pub(crate) slug: String,
    pub(crate) path: String,
    pub(crate) skill_md: String,
}

/// 安全地归一化 slug，避免路径穿越与非法文件名。
pub(crate) fn sanitize_skillhub_slug(slug: &str) -> String {
    slug.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == '/' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// 解析默认技能安装目录：DSH 兼容的 ~/.dsh/skills（可被 DeepSeek Harness 发现）。
pub(crate) fn default_skillhub_skills_dir() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "无法解析用户主目录".to_string())?;
    Ok(std::path::PathBuf::from(home)
        .join(".dsh")
        .join("skills"))
}

#[tauri::command]
pub(crate) async fn install_skillhub_skill(
    slug: String,
    skills_dir: Option<String>,
    api_base: Option<String>,
) -> Result<SkillhubInstallResult, String> {
    // 下载是阻塞网络 IO，必须在 spawn_blocking 中执行，否则会卡住 UI 线程
    tauri::async_runtime::spawn_blocking(move || -> Result<SkillhubInstallResult, String> {
        let base = api_base.unwrap_or_else(|| "https://api.skillhub.cn".to_string());
        let safe_slug = sanitize_skillhub_slug(&slug);
        if safe_slug.is_empty() {
            return Err("无效的技能 slug".to_string());
        }

        let dir = match skills_dir {
            Some(d) => std::path::PathBuf::from(d),
            None => default_skillhub_skills_dir()?,
        };
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建技能目录失败: {e}"))?;
        let target = dir.join(&safe_slug);

        let url = format!("{}/api/v1/download?slug={}&source=dsh", base, slug);
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(90))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client.get(&url).send().map_err(|e| format!("下载失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("SkillHub 下载接口返回 {}", resp.status()));
        }
        let bytes = resp
            .bytes()
            .map_err(|e| format!("读取下载内容失败: {e}"))?;

        if target.exists() {
            std::fs::remove_dir_all(&target).map_err(|e| format!("清理旧技能失败: {e}"))?;
        }
        std::fs::create_dir_all(&target).map_err(|e| format!("创建技能目录失败: {e}"))?;

        let reader = std::io::Cursor::new(bytes);
        let mut archive =
            zip::ZipArchive::new(reader).map_err(|e| format!("ZIP 解析失败: {e}"))?;
        for i in 0..archive.len() {
            let mut file = archive
                .by_index(i)
                .map_err(|e| format!("读取 ZIP 条目失败: {e}"))?;
            let Some(enclosed) = file.enclosed_name().map(|p| p.to_path_buf()) else {
                continue; // 跳过无法安全解析的路径
            };
            let out_path = target.join(&enclosed);
            if !out_path.starts_with(&target) {
                return Err("检测到 ZIP 路径穿越，已拒绝安装".to_string());
            }
            if file.is_dir() {
                std::fs::create_dir_all(&out_path).ok();
            } else {
                if let Some(parent) = out_path.parent() {
                    std::fs::create_dir_all(parent).ok();
                }
                let mut outfile =
                    std::fs::File::create(&out_path).map_err(|e| format!("写入文件失败: {e}"))?;
                std::io::copy(&mut file, &mut outfile).map_err(|e| format!("写入文件失败: {e}"))?;
            }
        }

        let skill_md_path = target.join("SKILL.md");
        if !skill_md_path.exists() {
            let _ = std::fs::remove_dir_all(&target);
            return Err("技能包缺少 SKILL.md，已拒绝安装".to_string());
        }
        let skill_md = std::fs::read_to_string(&skill_md_path)
            .map_err(|e| format!("读取 SKILL.md 失败: {e}"))?;

        Ok(SkillhubInstallResult {
            slug: safe_slug,
            path: target.to_string_lossy().to_string(),
            skill_md,
        })
    })
    .await
    .map_err(|e| format!("SkillHub 任务失败: {e}"))?
}

#[tauri::command]
pub(crate) fn uninstall_skillhub_skill(slug: String, skills_dir: Option<String>) -> Result<(), String> {
    let dir = match skills_dir {
        Some(d) => std::path::PathBuf::from(d),
        None => default_skillhub_skills_dir()?,
    };
    let safe_slug = sanitize_skillhub_slug(&slug);
    let target = dir.join(&safe_slug);
    if target.exists() {
        std::fs::remove_dir_all(&target).map_err(|e| format!("卸载失败: {e}"))?;
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub(crate) struct SkillhubListSkillsResult {
    pub(crate) skills: Vec<serde_json::Value>,
}

#[derive(serde::Serialize)]
pub(crate) struct SkillhubCategoriesResult {
    pub(crate) categories: Vec<serde_json::Value>,
}

#[tauri::command]
pub(crate) async fn list_skillhub_skills(
    query: Option<String>,
    category: Option<String>,
    page: Option<u32>,
    limit: Option<u32>,
    sort_by: Option<String>,
    labels: Option<String>,
    source: Option<String>,
    api_base: Option<String>,
) -> Result<SkillhubListSkillsResult, String> {
    // 关键：这里必须用 spawn_blocking 把阻塞的 HTTP 请求挪出 UI 线程。
    // 同步命令 + reqwest::blocking 会直接卡住界面（滚动都动不了），滚动加载时尤其明显。
    tauri::async_runtime::spawn_blocking(move || -> Result<SkillhubListSkillsResult, String> {
        let base = api_base.unwrap_or_else(|| "https://api.skillhub.cn".to_string());
        let mut url = format!("{}/api/skills?limit={}", base, limit.unwrap_or(60));
        if let Some(q) = query.as_deref() {
            if !q.is_empty() {
                // 服务端真实搜索参数名为 keyword（不是 query）
                url.push_str(&format!("&keyword={}", q));
            }
        }
        if let Some(c) = category.as_deref() {
            if !c.is_empty() {
                url.push_str(&format!("&category={}", c));
            }
        }
        if let Some(p) = page {
            url.push_str(&format!("&page={}", p.max(1)));
        }
        if let Some(s) = sort_by.as_deref() {
            if !s.is_empty() {
                url.push_str(&format!("&sortBy={}", s));
            }
        }
        if let Some(l) = labels.as_deref() {
            if !l.is_empty() {
                // 服务端 label 过滤形如 labels=requires_api_key:true（冒号需 URL 编码）
                let encoded = l.replace(':', "%3A").replace(',', "%2C");
                url.push_str(&format!("&labels={}", encoded));
            }
        }
        if let Some(s) = source.as_deref() {
            if !s.is_empty() {
                url.push_str(&format!("&source={}", s));
            }
        }

        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client
            .get(&url)
            .send()
            .map_err(|e| format!("SkillHub 请求失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("SkillHub 接口返回 {}", resp.status()));
        }
        let json: serde_json::Value = resp.json().map_err(|e| format!("解析失败: {e}"))?;
        let skills = json
            .get("data")
            .and_then(|d| d.get("skills"))
            .and_then(|s| s.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(SkillhubListSkillsResult { skills })
    })
    .await
    .map_err(|e| format!("SkillHub 任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn list_skillhub_skill_categories(
    api_base: Option<String>,
) -> Result<SkillhubCategoriesResult, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<SkillhubCategoriesResult, String> {
        let base = api_base.unwrap_or_else(|| "https://api.skillhub.cn".to_string());
        let url = format!("{}/api/v1/categories", base);

        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client.get(&url).send().map_err(|e| format!("SkillHub 请求失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("SkillHub 接口返回 {}", resp.status()));
        }
        let json: serde_json::Value = resp.json().map_err(|e| format!("解析失败: {e}"))?;

        // /api/v1/categories 返回 { count, items: [{ key, name, nameEn, sortOrder, ... }] }
        // 按官方 sortOrder 排序后，把 name 作为 displayName 返回给前端。
        let mut items: Vec<serde_json::Value> = json
            .get("items")
            .and_then(|s| s.as_array())
            .cloned()
            .unwrap_or_default();
        items.sort_by(|a, b| {
            let ao = a.get("sortOrder").and_then(|v| v.as_i64()).unwrap_or(i64::MAX);
            let bo = b.get("sortOrder").and_then(|v| v.as_i64()).unwrap_or(i64::MAX);
            ao.cmp(&bo)
        });

        let categories: Vec<serde_json::Value> = items
            .into_iter()
            .map(|item| {
                let key = item.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let display_name = item
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&key)
                    .to_string();
                serde_json::json!({
                    "key": key,
                    "displayName": display_name
                })
            })
            .collect();
        Ok(SkillhubCategoriesResult { categories })
    })
    .await
    .map_err(|e| format!("SkillHub 任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn list_skillhub_plugin_categories(
    api_base: Option<String>,
) -> Result<SkillhubCategoriesResult, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<SkillhubCategoriesResult, String> {
        let base = api_base.unwrap_or_else(|| "https://api.skillhub.cn".to_string());
        let url = format!("{}/api/v1/plugins/categories", base);

        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client.get(&url).send().map_err(|e| format!("SkillHub 请求失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("SkillHub 接口返回 {}", resp.status()));
        }
        let json: serde_json::Value = resp.json().map_err(|e| format!("解析失败: {e}"))?;
        let items = json
            .get("items")
            .and_then(|s| s.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(SkillhubCategoriesResult { categories: items })
    })
    .await
    .map_err(|e| format!("SkillHub 任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn list_skillhub_plugins(
    query: Option<String>,
    category: Option<String>,
    limit: Option<u32>,
    api_base: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    // 同 list_skillhub_skills：阻塞 HTTP 请在 spawn_blocking 中执行，避免卡 UI
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<serde_json::Value>, String> {
        let base = api_base.unwrap_or_else(|| "https://api.skillhub.cn".to_string());
        let mut url = format!("{}/api/v1/plugins?limit={}", base, limit.unwrap_or(60));
        if let Some(c) = category {
            if c != "全部" {
                url.push_str(&format!("&category={}", c));
            }
        }

        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client.get(&url).send().map_err(|e| format!("SkillHub 请求失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("SkillHub 接口返回 {}", resp.status()));
        }
        let json: serde_json::Value = resp.json().map_err(|e| format!("解析失败: {e}"))?;
        let items = json
            .get("items")
            .and_then(|s| s.as_array())
            .cloned()
            .unwrap_or_default();

        let q = query.as_deref().unwrap_or("").trim().to_lowercase();
        if q.is_empty() {
            return Ok(items);
        }
        Ok(items
            .into_iter()
            .filter(|item| {
                let text = format!(
                    "{} {} {}",
                    item.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                    item.get("fullName").and_then(|v| v.as_str()).unwrap_or(""),
                    item.get("description").and_then(|v| v.as_str()).unwrap_or("")
                )
                .to_lowercase();
                text.contains(&q)
            })
            .collect())
    })
    .await
    .map_err(|e| format!("SkillHub 任务失败: {e}"))?
}
