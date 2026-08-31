//! CB Teams 套件市场接入（参考 CodeBuddy Teams Marketplace：
//! https://github.com/zhizhunbao/workbuddy/tree/main/plugins/marketplaces/cb_teams_marketplace ）。
//!
//! 套件（suite）= 一个包含多个 DSH 风格技能的插件包。清单来自仓库内的
//! .codebuddy-plugin/marketplace.json（27 个套件，含 skills[] 相对路径）。
//! 安装 = 一次性下载仓库 zip（codeload），抽取套件目录下的技能到本地技能目录
//! （与 SkillHub 相同的 ~/.dsh/skills 布局），并把每个 SKILL.md 原文返回给
//! 前端 parseSkillMarkdown 注册，复用「一切皆插件」的安装闭环。

/// marketplace.json 清单地址（可用 marketplace_url 参数覆盖以便测试）。
const DEFAULT_MARKETPLACE_URL: &str = "https://raw.githubusercontent.com/zhizhunbao/workbuddy/main/plugins/marketplaces/cb_teams_marketplace/.codebuddy-plugin/marketplace.json";

/// 仓库 zip 下载地址（codeload，单次请求拿全仓库，按前缀抽取套件子树）。
const DEFAULT_REPO_ZIP_URL: &str =
    "https://codeload.github.com/zhizhunbao/workbuddy/zip/refs/heads/main";

/// 市场在仓库内的子路径（zip 解包后先剥离 <repo-root>/ 前缀再匹配）。
const MARKETPLACE_SUBPATH: &str = "plugins/marketplaces/cb_teams_marketplace";

fn http_client(timeout_secs: u64) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn list_cbteams_suites(
    marketplace_url: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<serde_json::Value>, String> {
        let url = marketplace_url.unwrap_or_else(|| DEFAULT_MARKETPLACE_URL.to_string());
        let client = http_client(30)?;
        let resp = client
            .get(&url)
            .send()
            .map_err(|e| format!("清单下载失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("清单接口返回 {}", resp.status()));
        }
        let json: serde_json::Value = resp.json().map_err(|e| format!("清单解析失败: {e}"))?;
        let plugins = json
            .get("plugins")
            .and_then(|p| p.as_array())
            .cloned()
            .unwrap_or_default();

        // 归一化字段，避免前端对可选字段各自兜底。
        let suites: Vec<serde_json::Value> = plugins
            .into_iter()
            .map(|p| {
                let name = p
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let skills = p
                    .get("skills")
                    .and_then(|s| s.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str())
                            .filter(|s| !s.trim().is_empty())
                            .map(|s| s.trim_start_matches("./").to_string())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                serde_json::json!({
                    "name": name,
                    "description": p.get("description").and_then(|v| v.as_str()).unwrap_or(""),
                    "descriptionEn": p.get("description_en").and_then(|v| v.as_str()).unwrap_or(""),
                    "category": p.get("category").and_then(|v| v.as_str()).unwrap_or(""),
                    "version": p.get("version").and_then(|v| v.as_str()).unwrap_or(""),
                    "author": p.get("author").and_then(|a| a.get("name")).and_then(|v| v.as_str()).unwrap_or(""),
                    "homepage": p.get("homepage").and_then(|v| v.as_str()).unwrap_or(""),
                    "skills": skills,
                })
            })
            .filter(|s| {
                s.get("name")
                    .and_then(|v| v.as_str())
                    .map(|n| !n.is_empty())
                    .unwrap_or(false)
            })
            .collect();
        Ok(suites)
    })
    .await
    .map_err(|e| format!("套件清单任务失败: {e}"))?
}

#[derive(serde::Serialize)]
pub(crate) struct CbteamsSkillInstallResult {
    pub(crate) slug: String,
    pub(crate) path: String,
    pub(crate) skill_md: String,
}

/// 安装一个套件：下载仓库 zip，抽取该套件目录下所有含 SKILL.md 的技能目录。
/// 目录布局与 SkillHub 对齐：skills_dir/<skill-slug>/SKILL.md...，
/// 套件根目录自身的 SKILL.md 落为 skills_dir/<suite>/。
#[tauri::command]
pub(crate) async fn install_cbteams_suite(
    name: String,
    skills_dir: Option<String>,
    repo_zip_url: Option<String>,
) -> Result<Vec<CbteamsSkillInstallResult>, String> {
    tauri::async_runtime::spawn_blocking(
        move || -> Result<Vec<CbteamsSkillInstallResult>, String> {
            let safe_name = crate::skillhub::sanitize_skillhub_slug(&name);
            if safe_name.is_empty() {
                return Err("无效的套件名".to_string());
            }
            // 清单里的 name 与磁盘目录可能大小写不一致，用小写前缀匹配。
            let suite_prefix_lower =
                format!("{MARKETPLACE_SUBPATH}/plugins/{}/", safe_name.to_lowercase());

            let dir = match skills_dir {
                Some(d) => std::path::PathBuf::from(d),
                None => crate::skillhub::default_skillhub_skills_dir()?,
            };
            std::fs::create_dir_all(&dir).map_err(|e| format!("创建技能目录失败: {e}"))?;

            let url = repo_zip_url.unwrap_or_else(|| DEFAULT_REPO_ZIP_URL.to_string());
            let client = http_client(300)?;
            let resp = client
                .get(&url)
                .send()
                .map_err(|e| format!("仓库下载失败: {e}"))?;
            if !resp.status().is_success() {
                return Err(format!("仓库下载接口返回 {}", resp.status()));
            }
            let bytes = resp
                .bytes()
                .map_err(|e| format!("读取仓库内容失败: {e}"))?;

            let reader = std::io::Cursor::new(bytes);
            let mut archive =
                zip::ZipArchive::new(reader).map_err(|e| format!("ZIP 解析失败: {e}"))?;

            // 把 zip 里的路径归一为 <repo-root> 之后的部分（正斜杠）。
            let rel_path = |enclosed: &std::path::Path| -> String {
                let mut it = enclosed.iter();
                it.next(); // 剥离 zip 顶层仓库根（workbuddy-main/ 之类）
            let rel: std::path::PathBuf = it.collect();
                rel.to_string_lossy().replace('\\', "/")
            };

            // 第一遍：收集该套件下要落地的 (条目索引, rest 相对路径, 目标路径, 技能 slug)。
            // 目标布局：skills/<skill>/... → skills_dir/<skill>/...；
            // 其余（套件根 SKILL.md、agents/、rules/ 等）→ skills_dir/<suite>/...
            struct Planned {
                index: usize,
                rest: String,
                target: std::path::PathBuf,
                slug: String,
                is_root_skill: bool,
            }
            let mut planned: Vec<Planned> = Vec::new();
            for i in 0..archive.len() {
                let file = archive
                    .by_index(i)
                    .map_err(|e| format!("读取 ZIP 条目失败: {e}"))?;
                if file.is_dir() {
                    continue;
                }
                let Some(enclosed) = file.enclosed_name().map(|p| p.to_path_buf()) else {
                    continue;
                };
                let rel = rel_path(&enclosed);
                let Some(rest) = rel
                    .to_lowercase()
                    .strip_prefix(&suite_prefix_lower)
                    .map(|r| rel[rel.len() - r.len()..].to_string())
                else {
                    continue;
                };

                let (target, slug, is_root_skill) = if let Some(inner) = rest.strip_prefix("skills/")
                {
                    let mut segs = inner.split('/');
                    let skill = segs.next().unwrap_or("");
                    if skill.is_empty() {
                        continue;
                    }
                    let skill_slug = crate::skillhub::sanitize_skillhub_slug(skill);
                    let tail: std::path::PathBuf = segs.collect();
                    (
                        dir.join(&skill_slug).join(tail),
                        skill_slug,
                        inner.split('/').count() == 2, // skills/<skill>/SKILL.md 才是技能根
                    )
                } else {
                    (
                        dir.join(&safe_name).join(&rest),
                        safe_name.clone(),
                        !rest.contains('/'), // 套件根目录的 SKILL.md
                    )
                };
                if !target.starts_with(&dir) {
                    return Err("检测到 ZIP 路径穿越，已拒绝安装".to_string());
                }
                planned.push(Planned {
                    index: i,
                    rest,
                    target,
                    slug,
                    is_root_skill,
                });
            }

            if planned.is_empty() {
                return Err(format!("套件 {safe_name} 在仓库中不存在或没有可安装内容"));
            }

            // 清理重建：套件根目录 + 所有涉及的技能目录
            let mut roots: Vec<std::path::PathBuf> = vec![dir.join(&safe_name)];
            for p in &planned {
                if p.rest.starts_with("skills/") {
                    let root = dir.join(&p.slug);
                    if !roots.contains(&root) {
                        roots.push(root);
                    }
                }
            }
            for root in &roots {
                if root.exists() {
                    std::fs::remove_dir_all(root).map_err(|e| format!("清理旧技能失败: {e}"))?;
                }
            }

            // 第二遍：按索引写出文件内容
            for p in &planned {
                let mut file = archive
                    .by_index(p.index)
                    .map_err(|e| format!("读取 ZIP 条目失败: {e}"))?;
                if let Some(parent) = p.target.parent() {
                    std::fs::create_dir_all(parent).ok();
                }
                let mut outfile = std::fs::File::create(&p.target)
                    .map_err(|e| format!("写入文件失败: {e}"))?;
                std::io::copy(&mut file, &mut outfile)
                    .map_err(|e| format!("写入文件失败: {e}"))?;
            }

            // 收集安装结果：每个技能目录根上的 SKILL.md
            let mut results: Vec<CbteamsSkillInstallResult> = Vec::new();
            let mut seen_slugs: Vec<String> = Vec::new();
            for p in &planned {
                let is_skill_md = p
                    .rest
                    .rsplit('/')
                    .next()
                    .map(|f| f.eq_ignore_ascii_case("SKILL.md"))
                    .unwrap_or(false);
                if !(is_skill_md && p.is_root_skill) {
                    continue;
                }
                if p.slug.is_empty() || seen_slugs.contains(&p.slug) {
                    continue;
                }
                let skill_md = std::fs::read_to_string(&p.target)
                    .map_err(|e| format!("读取 SKILL.md 失败: {e}"))?;
                seen_slugs.push(p.slug.clone());
                results.push(CbteamsSkillInstallResult {
                    slug: p.slug.clone(),
                    path: p
                        .target
                        .parent()
                        .unwrap_or(&p.target)
                        .to_string_lossy()
                        .to_string(),
                    skill_md,
                });
            }

            if results.is_empty() {
                return Err(format!("套件 {safe_name} 内没有找到任何 SKILL.md，已拒绝安装"));
            }
            Ok(results)
        },
    )
    .await
    .map_err(|e| format!("套件安装任务失败: {e}"))?
}
