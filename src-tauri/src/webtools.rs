//! 联网工具：web_search（聚合 DuckDuckGo + Bing 检索）与 web_fetch（网页抓取转纯文本）。
//!
//! 无第三方搜索 API 依赖：web_search 依次尝试 DuckDuckGo HTML/Lite 与 Bing/Bing-CN 端点解析，
//! web_fetch 用 reqwest 抓取后做轻量 HTML→文本转换（实体解码、去脚本样式、保留链接）。

use base64::Engine as _;
use regex::Regex;
use reqwest::Client;
use serde::Serialize;
use std::time::Duration;

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MAX_FETCH_BYTES: usize = 3 * 1024 * 1024;

fn http_client_with_timeout(timeout_secs: u64) -> Result<Client, String> {
    Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(timeout_secs))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("HTTP 客户端构建失败: {e}"))
}

fn http_client() -> Result<Client, String> {
    http_client_with_timeout(20)
}

// ---------- 数据结构 ----------

#[derive(Serialize, Debug)]
pub(crate) struct WebSearchResult {
    pub(crate) title: String,
    pub(crate) url: String,
    pub(crate) snippet: String,
}

#[derive(Serialize, Debug)]
pub(crate) struct WebFetchLink {
    pub(crate) url: String,
    pub(crate) text: String,
}

#[derive(Serialize, Debug)]
pub(crate) struct WebFetchResult {
    pub(crate) url: String,
    pub(crate) final_url: String,
    pub(crate) title: String,
    pub(crate) content_type: String,
    pub(crate) text: String,
    pub(crate) links: Vec<WebFetchLink>,
}

// ---------- 文本工具 ----------

/// 解码常见 HTML 实体（具名 + 十进制/十六进制数字实体）。
fn decode_entities(input: &str) -> String {
    if !input.contains('&') {
        return input.to_string();
    }
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'&' {
            if let Some(semi) = input[i..].find(';') {
                let entity = &input[i + 1..i + semi];
                let decoded = match entity {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    "nbsp" => Some('\u{00A0}'),
                    _ => {
                        let code = if let Some(hex) = entity
                            .strip_prefix("#x")
                            .or_else(|| entity.strip_prefix("#X"))
                        {
                            u32::from_str_radix(hex, 16).ok()
                        } else if let Some(dec) = entity.strip_prefix('#') {
                            dec.parse::<u32>().ok()
                        } else {
                            None
                        };
                        code.and_then(char::from_u32)
                    }
                };
                if let Some(ch) = decoded {
                    out.push(ch);
                    i += semi + 1;
                    continue;
                }
            }
        }
        // 逐字符推进（UTF-8 安全：直接克隆剩余切片的下一个 char）。
        let ch = input[i..].chars().next().unwrap_or('\u{FFFD}');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// 去掉残余标签并规范化空白。
fn clean_text(input: &str) -> String {
    let tag_re = Regex::new(r"<[^>]+>").expect("静态正则");
    let without_tags = tag_re.replace_all(input, " ");
    let decoded = decode_entities(&without_tags);
    let mut lines: Vec<String> = Vec::new();
    for line in decoded.split('\n') {
        let trimmed = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if trimmed.is_empty() {
            if lines.last().map(|l: &String| !l.is_empty()).unwrap_or(false) {
                lines.push(String::new());
            }
        } else {
            lines.push(trimmed);
        }
    }
    while lines.last().map(|l| l.is_empty()).unwrap_or(false) {
        lines.pop();
    }
    lines.join("\n")
}

/// 百分号解码（处理 uddg= 重定向参数）。
fn percent_decode(input: &str) -> String {
    let replaced = input.replace('+', " ");
    let bytes = replaced.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = &replaced[i + 1..i + 3];
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------- web_search ----------

/// 搜索后端枚举。按数组顺序依次尝试，首个非空结果即返回。
#[derive(Clone, Copy, Debug)]
enum SearchProvider {
    DuckDuckGoHtml,
    DuckDuckGoLite,
    BingGlobal,
    BingCn,
}

impl SearchProvider {
    fn label(self) -> &'static str {
        match self {
            SearchProvider::DuckDuckGoHtml => "DuckDuckGo HTML",
            SearchProvider::DuckDuckGoLite => "DuckDuckGo Lite",
            SearchProvider::BingGlobal => "Bing",
            SearchProvider::BingCn => "Bing CN",
        }
    }
}

/// 从 DDG 重定向链接中还原真实 URL（//duckduckgo.com/l/?uddg=<encoded>&rut=...）。
fn resolve_ddg_href(href: &str) -> String {
    let trimmed = href.trim();
    if let Some(pos) = trimmed.find("uddg=") {
        let encoded = &trimmed[pos + 5..];
        let end = encoded.find('&').unwrap_or(encoded.len());
        let decoded = percent_decode(&encoded[..end]);
        if decoded.starts_with("http") {
            return decoded;
        }
    }
    if trimmed.starts_with("//") {
        format!("https:{trimmed}")
    } else {
        trimmed.to_string()
    }
}

/// 从 Bing 重定向链接（/ck/a?...&u=a1<base64>）中还原真实 URL。
fn resolve_bing_url(href: &str) -> String {
    let trimmed = href.trim();
    if let Some(u_pos) = trimmed.find("u=a1") {
        let encoded = &trimmed[u_pos + 4..];
        let end = encoded.find('&').unwrap_or(encoded.len());
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&encoded[..end]) {
            if let Ok(url) = String::from_utf8(bytes) {
                if url.starts_with("http") {
                    return url;
                }
            }
        }
    }
    if trimmed.starts_with("//") {
        format!("https:{trimmed}")
    } else if trimmed.starts_with('/') {
        "https://www.bing.com".to_string() + trimmed
    } else {
        trimmed.to_string()
    }
}

fn parse_ddg_html(html: &str, limit: usize) -> Vec<WebSearchResult> {
    let link_re = Regex::new(
        r#"(?is)<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#,
    )
    .expect("静态正则");
    let snippet_re =
        Regex::new(r#"(?is)<(?:a|div)[^>]*class="[^"]*result__snippet[^"]*"[^>]*>(.*?)</(?:a|div)>"#)
            .expect("静态正则");
    let snippets: Vec<String> = snippet_re
        .captures_iter(html)
        .map(|c| clean_text(&c[1]))
        .collect();
    link_re
        .captures_iter(html)
        .enumerate()
        .take(limit)
        .map(|(idx, cap)| WebSearchResult {
            title: clean_text(&cap[2]),
            url: resolve_ddg_href(&cap[1]),
            snippet: snippets.get(idx).cloned().unwrap_or_default(),
        })
        .filter(|r| !r.title.is_empty() && r.url.starts_with("http"))
        .collect()
}

fn parse_ddg_lite(html: &str, limit: usize) -> Vec<WebSearchResult> {
    let link_re =
        Regex::new(r#"(?is)<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#)
            .expect("静态正则");
    let snippet_re =
        Regex::new(r#"(?is)<td[^>]*class="result-snippet"[^>]*>(.*?)</td>"#).expect("静态正则");
    let snippets: Vec<String> = snippet_re
        .captures_iter(html)
        .map(|c| clean_text(&c[1]))
        .collect();
    link_re
        .captures_iter(html)
        .enumerate()
        .take(limit)
        .map(|(idx, cap)| WebSearchResult {
            title: clean_text(&cap[2]),
            url: resolve_ddg_href(&cap[1]),
            snippet: snippets.get(idx).cloned().unwrap_or_default(),
        })
        .filter(|r| !r.title.is_empty() && r.url.starts_with("http"))
        .collect()
}

fn parse_bing_html(html: &str, limit: usize) -> Vec<WebSearchResult> {
    let item_re =
        Regex::new(r#"(?is)<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>(.*?)</li>"#).expect("静态正则");
    let link_re =
        Regex::new(r#"(?is)<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#).expect("静态正则");
    let snippet_re =
        Regex::new(r#"(?is)<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>(.*?)</div>"#)
            .expect("静态正则");
    let p_re = Regex::new(r#"(?is)<p[^>]*>(.*?)</p>"#).expect("静态正则");

    let mut results = Vec::new();
    for cap in item_re.captures_iter(html) {
        let item = &cap[1];
        // 跳过 Bing 内部搜索链接，取第一个有效结果链接。
        for link_cap in link_re.captures_iter(item) {
            let raw_url = link_cap[1].trim();
            if raw_url.starts_with("/search?q=")
                || raw_url.starts_with("https://www.bing.com/search?q=")
            {
                continue;
            }
            let url = resolve_bing_url(raw_url);
            let title = clean_text(&link_cap[2]);
            let snippet = snippet_re
                .captures(item)
                .and_then(|c| p_re.captures(&c[1]).map(|p| clean_text(&p[1])))
                .unwrap_or_default();
            if !title.is_empty() && url.starts_with("http") {
                results.push(WebSearchResult {
                    title,
                    url,
                    snippet,
                });
                break;
            }
        }
        if results.len() >= limit {
            break;
        }
    }
    results
}

async fn search_with_provider(
    provider: SearchProvider,
    client: &Client,
    query: &str,
    limit: usize,
) -> Result<Vec<WebSearchResult>, String> {
    let (resp, parser): (reqwest::Response, fn(&str, usize) -> Vec<WebSearchResult>) = match provider {
        SearchProvider::DuckDuckGoHtml => {
            let resp = client
                .post("https://html.duckduckgo.com/html/")
                .form(&[("q", query), ("b", "")])
                .send()
                .await
                .map_err(|e| format!("{} 请求失败: {e}", provider.label()))?;
            (resp, parse_ddg_html)
        }
        SearchProvider::DuckDuckGoLite => {
            let resp = client
                .get("https://lite.duckduckgo.com/lite/")
                .query(&[("q", query)])
                .send()
                .await
                .map_err(|e| format!("{} 请求失败: {e}", provider.label()))?;
            (resp, parse_ddg_lite)
        }
        SearchProvider::BingGlobal => {
            let resp = client
                .get("https://www.bing.com/search")
                .query(&[("q", query), ("setmkt", "en-US"), ("setlang", "en")])
                .header("Accept-Language", "zh-CN,zh;q=0.9,en-US,en;q=0.8")
                .send()
                .await
                .map_err(|e| format!("{} 请求失败: {e}", provider.label()))?;
            (resp, parse_bing_html)
        }
        SearchProvider::BingCn => {
            let resp = client
                .get("https://cn.bing.com/search")
                .query(&[("q", query), ("setmkt", "zh-CN"), ("setlang", "zh")])
                .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
                .send()
                .await
                .map_err(|e| format!("{} 请求失败: {e}", provider.label()))?;
            (resp, parse_bing_html)
        }
    };

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("{} HTTP {status}", provider.label()));
    }
    let body = resp
        .text()
        .await
        .map_err(|e| format!("{} 读取失败: {e}", provider.label()))?;
    let results = parser(&body, limit);
    if results.is_empty() {
        return Err(format!("{} 无结果或被反爬", provider.label()));
    }
    Ok(results)
}

/// 依次尝试多个搜索后端，首个返回非空结果即成功。
async fn multi_provider_search(query: &str, limit: usize) -> Result<Vec<WebSearchResult>, String> {
    // 搜索请求单独使用较短超时：某一后端被墙/不可达时不卡住整体流程。
    let client = http_client_with_timeout(10)?;
    let providers = [
        SearchProvider::DuckDuckGoHtml,
        SearchProvider::DuckDuckGoLite,
        SearchProvider::BingGlobal,
        SearchProvider::BingCn,
    ];
    let mut errors: Vec<String> = Vec::new();
    for provider in providers {
        match search_with_provider(provider, &client, query, limit).await {
            Ok(results) => return Ok(results),
            Err(e) => errors.push(e),
        }
    }
    Err(format!("所有搜索后端均不可用：{}", errors.join("；")))
}

#[tauri::command]
pub(crate) async fn web_search(
    query: String,
    limit: Option<usize>,
) -> Result<Vec<WebSearchResult>, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("搜索关键词不能为空".to_string());
    }
    let limit = limit.unwrap_or(8).clamp(1, 15);
    multi_provider_search(&query, limit).await
}

// ---------- web_fetch ----------

/// 提取 <title>（需在移除 head 之前调用）。
fn extract_title(html: &str) -> String {
    let re = Regex::new(r"(?is)<title[^>]*>(.*?)</title>").expect("静态正则");
    re.captures(html)
        .map(|c| clean_text(&c[1]))
        .unwrap_or_default()
}

/// 轻量 HTML→纯文本：去注释/脚本/样式，块级标签转换行，列表加圆点。
fn html_to_text(html: &str) -> String {
    let comment_re = Regex::new(r"(?s)<!--.*?-->").expect("静态正则");
    let block_re =
        Regex::new(r#"(?i)<br[^>]*>|</(p|div|li|tr|h[1-6]|section|article|blockquote|table|ul|ol)>"#)
            .expect("静态正则");
    let li_re = Regex::new(r"(?i)<li[^>]*>").expect("静态正则");
    // Rust regex 不支持反向引用，脚本类标签逐个构建移除正则（进程内缓存）。
    static HIDDEN_RES: std::sync::OnceLock<Vec<Regex>> = std::sync::OnceLock::new();
    let hidden_res = HIDDEN_RES.get_or_init(|| {
        ["script", "style", "noscript", "svg", "template"]
            .iter()
            .map(|tag| Regex::new(&format!(r"(?is)<{tag}[^>]*>.*?</{tag}>")).expect("静态正则"))
            .collect()
    });
    let tag_re = Regex::new(r"<[^>]+>").expect("静态正则");

    let stage1 = comment_re.replace_all(html, "");
    let mut stage2 = stage1.into_owned();
    for re in hidden_res {
        stage2 = re.replace_all(&stage2, "").into_owned();
    }
    let stage3 = block_re.replace_all(&stage2, "\n");
    let stage4 = li_re.replace_all(&stage3, "• ");
    // 内联标签（<b>/<span>/<a> 等）直接移除，不引入空格（避免拆散 CJK 文本）。
    let stage5 = tag_re.replace_all(&stage4, "");
    let decoded = decode_entities(&stage5);
    let mut lines: Vec<String> = Vec::new();
    for line in decoded.split('\n') {
        let trimmed = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if trimmed.is_empty() {
            if lines.last().map(|l: &String| !l.is_empty()).unwrap_or(false) {
                lines.push(String::new());
            }
        } else {
            lines.push(trimmed);
        }
    }
    while lines.last().map(|l| l.is_empty()).unwrap_or(false) {
        lines.pop();
    }
    lines.join("\n")
}

/// 抽取正文中的站外链接（绝对 URL，去重，cap 30 条）。
fn extract_links(html: &str) -> Vec<WebFetchLink> {
    let re = Regex::new(r#"(?is)<a\s[^>]*href="(https?://[^"\s]+)"[^>]*>(.*?)</a>"#).expect("静态正则");
    let mut seen = std::collections::HashSet::new();
    let mut links = Vec::new();
    for cap in re.captures_iter(html) {
        let url = decode_entities(&cap[1]).trim().to_string();
        let text = clean_text(&cap[2]);
        if url.is_empty() || !seen.insert(url.clone()) {
            continue;
        }
        links.push(WebFetchLink { url, text });
        if links.len() >= 30 {
            break;
        }
    }
    links
}

#[tauri::command]
pub(crate) async fn web_fetch(
    url: String,
    max_chars: Option<usize>,
) -> Result<WebFetchResult, String> {
    let url = url.trim().to_string();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("仅支持 http/https 链接".to_string());
    }
    let client = http_client()?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("抓取失败: {e}"))?;
    let final_url = resp.url().to_string();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("抓取失败：HTTP {status}（{final_url}）"));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("读取响应失败: {e}"))?;
    let slice = &bytes[..bytes.len().min(MAX_FETCH_BYTES)];
    let body = String::from_utf8_lossy(slice).into_owned();

    let lower_ct = content_type.to_lowercase();
    let (title, text, links) = if lower_ct.contains("html") {
        let title = extract_title(&body);
        let text = html_to_text(&body);
        let links = extract_links(&body);
        (title, text, links)
    } else {
        // 纯文本 / JSON / Markdown 等直接返回原文。
        (String::new(), body, Vec::new())
    };

    let max_chars = max_chars.unwrap_or(12000).clamp(200, 50_000);
    let mut text = text;
    if text.chars().count() > max_chars {
        text = text.chars().take(max_chars).collect();
        text.push_str("\n\n[内容已截断]");
    }

    Ok(WebFetchResult {
        url,
        final_url,
        title,
        content_type,
        text,
        links,
    })
}

// ---------- 单元测试 ----------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_entities_handles_named_and_numeric() {
        assert_eq!(decode_entities("a&amp;b&nbsp;&lt;x&gt;&#20013;&#x4E2D;"), "a&b\u{00A0}<x>中中");
    }

    #[test]
    fn resolve_ddg_redirect() {
        let href = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=abc";
        assert_eq!(resolve_ddg_href(href), "https://example.com/page");
    }

    #[test]
    fn parse_ddg_html_extracts_results() {
        let html = r#"
        <div class="result">
          <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdoc.rust-lang.org%2F">Rust <b>Doc</b></a>
          <div class="result__snippet">The <em>programming</em> language</div>
        </div>"#;
        let results = parse_ddg_html(html, 8);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].url, "https://doc.rust-lang.org/");
        assert_eq!(results[0].title, "Rust Doc");
        assert_eq!(results[0].snippet, "The programming language");
    }

    #[test]
    fn resolve_bing_redirect_decodes_base64() {
        // "https://example.com/" 的 base64 标准编码。
        let encoded = base64::engine::general_purpose::STANDARD.encode("https://example.com/");
        let href = format!("https://www.bing.com/ck/a?!&&p=xyz&u=a1{encoded}");
        assert_eq!(resolve_bing_url(&href), "https://example.com/");

        // 直接 URL 原样返回。
        assert_eq!(
            resolve_bing_url("https://doc.rust-lang.org/"),
            "https://doc.rust-lang.org/"
        );
    }

    #[test]
    fn parse_bing_html_extracts_results() {
        let html = r#"
        <ol id="b_results">
          <li class="b_algo">
            <h2><a href="https://doc.rust-lang.org/">Rust <strong>Doc</strong></a></h2>
            <div class="b_caption">
              <p>The <em>programming</em> language</p>
            </div>
          </li>
          <li class="b_algo">
            <h2><a href="/search?q=internal">Related</a></h2>
          </li>
        </ol>"#;
        let results = parse_bing_html(html, 8);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].url, "https://doc.rust-lang.org/");
        assert_eq!(results[0].title, "Rust Doc");
        assert_eq!(results[0].snippet, "The programming language");
    }

    #[test]
    fn html_to_text_strips_and_keeps_structure() {
        let html = r#"<html><head><title>T</title><script>var x=1;</script></head>
        <body><h1>标题</h1><p>第一段 <b>加粗</b>。</p><ul><li>甲</li><li>乙</li></ul></body></html>"#;
        let title = extract_title(html);
        assert_eq!(title, "T");
        let text = html_to_text(html);
        assert!(text.contains("标题"));
        assert!(text.contains("第一段 加粗。"));
        assert!(text.contains("• 甲"));
        assert!(!text.contains("var x=1"));
    }

    #[tokio::test]
    async fn web_fetch_rejects_non_http() {
        let err = web_fetch("ftp://example.com".into(), None).await.unwrap_err();
        assert!(err.contains("http"));
    }
}
