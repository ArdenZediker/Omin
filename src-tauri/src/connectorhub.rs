//! WorkBuddy 技能库外部服务接入型技能市场。
//!
//! 数据源：GitHub 仓库 zhizhunbao/workbuddy 的 skills-marketplace
//! （.codebuddy-skill/marketplace.json，90 个技能），其中「外部服务接入型」
//! 技能（腾讯文档/会议/COS、GitHub、Trello、Google 全家桶、邮件、MCP 管理等）
//! 本质上就是连接器：它们封装了外部服务的 CLI/OpenAPI/SDK 接入能力。
//!
//! 安装 = 下载仓库 zip（codeload），抽取 skills-marketplace/skills/<source>/
//! 子树到本地技能目录（与 SkillHub 同布局），返回 SKILL.md 原文供前端解析
//! 注册为 kind=connector 的插件，复用「一切皆插件」的安装闭环。

/// marketplace.json 清单地址（可用 marketplace_url 参数覆盖以便测试）。
const DEFAULT_MARKETPLACE_URL: &str = "https://raw.githubusercontent.com/zhizhunbao/workbuddy/main/skills-marketplace/.codebuddy-skill/marketplace.json";

/// 仓库 zip 下载地址（codeload，单次请求拿全仓库，按前缀抽取技能子树）。
const DEFAULT_REPO_ZIP_URL: &str =
    "https://codeload.github.com/zhizhunbao/workbuddy/zip/refs/heads/main";

/// 技能在市场内的子路径（zip 解包后先剥离 <repo-root>/ 前缀再匹配）。
const SKILLS_SUBPATH: &str = "skills-marketplace/skills";

fn http_client(timeout_secs: u64) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| e.to_string())
}

/// 列出 skills-marketplace 中的全部技能（归一化字段，供前端按白名单筛选
/// 出「外部服务接入型」作为连接器展示）。
#[tauri::command]
pub(crate) async fn list_connectorhub_skills(
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
        let skills = json
            .get("skills")
            .and_then(|s| s.as_array())
            .cloned()
            .unwrap_or_default();

        let items: Vec<serde_json::Value> = skills
            .into_iter()
            .map(|s| {
                serde_json::json!({
                    "name": s.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                    "source": s.get("source").and_then(|v| v.as_str()).unwrap_or(""),
                    "description": s.get("description").and_then(|v| v.as_str()).unwrap_or(""),
                    "descriptionZh": s.get("description_zh").and_then(|v| v.as_str()).unwrap_or(""),
                    "version": s.get("version").and_then(|v| v.as_str()).unwrap_or(""),
                })
            })
            .filter(|s| {
                s.get("source")
                    .and_then(|v| v.as_str())
                    .map(|n| !n.is_empty())
                    .unwrap_or(false)
            })
            .collect();
        Ok(items)
    })
    .await
    .map_err(|e| format!("技能清单任务失败: {e}"))?
}

#[derive(serde::Serialize)]
pub(crate) struct ConnectorhubSkillInstallResult {
    pub(crate) slug: String,
    pub(crate) path: String,
    pub(crate) skill_md: String,
}

/// 安装一个外部服务接入型技能：下载仓库 zip，抽取
/// skills-marketplace/skills/<source>/ 整个子树到技能目录。
/// 目录布局与 SkillHub 对齐：skills_dir/<source>/SKILL.md...
#[tauri::command]
pub(crate) async fn install_connectorhub_skill(
    source: String,
    skills_dir: Option<String>,
    repo_zip_url: Option<String>,
) -> Result<ConnectorhubSkillInstallResult, String> {
    tauri::async_runtime::spawn_blocking(
        move || -> Result<ConnectorhubSkillInstallResult, String> {
            let safe_source = crate::skillhub::sanitize_skillhub_slug(&source);
            if safe_source.is_empty() {
                return Err("无效的技能源名称".to_string());
            }
            // 清单里的 source 与磁盘目录大小写可能不一致，用小写前缀匹配。
            let source_prefix_lower =
                format!("{SKILLS_SUBPATH}/{}/", safe_source.to_lowercase());

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

            // 第一遍：收集该技能目录下要落地的 (条目索引, 目标路径)。
            struct Planned {
                index: usize,
                target: std::path::PathBuf,
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
                    .strip_prefix(&source_prefix_lower)
                    .map(|r| rel[rel.len() - r.len()..].to_string())
                else {
                    continue;
                };

                let target = dir.join(&safe_source).join(&rest);
                if !target.starts_with(&dir) {
                    return Err("检测到 ZIP 路径穿越，已拒绝安装".to_string());
                }
                planned.push(Planned { index: i, target });
            }

            if planned.is_empty() {
                return Err(format!("技能 {safe_source} 在仓库中不存在或没有可安装内容"));
            }

            // 清理重建：该技能目录整体重建，保证与远端一致。
            let root = dir.join(&safe_source);
            if root.exists() {
                std::fs::remove_dir_all(&root).map_err(|e| format!("清理旧技能失败: {e}"))?;
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

            // 技能根上的 SKILL.md 原文返回给前端解析。
            let skill_md_path = root.join("SKILL.md");
            let skill_md = std::fs::read_to_string(&skill_md_path)
                .map_err(|e| format!("读取 SKILL.md 失败: {e}"))?;
            Ok(ConnectorhubSkillInstallResult {
                slug: safe_source.clone(),
                path: root.to_string_lossy().to_string(),
                skill_md,
            })
        },
    )
    .await
    .map_err(|e| format!("技能安装任务失败: {e}"))?
}
