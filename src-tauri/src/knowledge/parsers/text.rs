//! 纯文本 / Markdown / CSV / 代码类文档解析器（self-contained 实现）。
//!
//! 复杂格式（docx / pdf / 图片 / 音频）仍走 legacy 的 frontend-bridge 路径，
//! 后续可在此处新增对应 `DocumentParser` 实现，而无需改动核心管线。

use std::sync::Arc;

use crate::knowledge::contracts::{DocumentParser, ParseInput, ParsedDoc};

/// 处理文本与代码类文档的解析器。
pub struct TextDocumentParser;

impl DocumentParser for TextDocumentParser {
    fn supported_extensions(&self) -> &'static [&'static str] {
        &[
            "md", "markdown", "txt", "text", "log", "html", "htm", "xml", "yml", "yaml", "json",
            "csv", "tsv", "rs", "ts", "tsx", "js", "py", "go", "java", "c", "cpp", "sh", "toml",
            "sql",
        ]
    }

    fn parse(&self, input: &ParseInput) -> Result<ParsedDoc, String> {
        let ext = input
            .file_extension
            .as_deref()
            .unwrap_or_default()
            .trim_start_matches('.')
            .to_lowercase();
        let text = String::from_utf8_lossy(&input.bytes).to_string();
        let normalized_preview = input
            .preview_type
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(|v| v.to_lowercase());

        match ext.as_str() {
            "md" | "markdown" => Ok(ParsedDoc {
                content: text,
                preview_type: "markdown".into(),
                metadata_json: None,
            }),
            "csv" => Ok(ParsedDoc {
                content: csv_to_markdown(&text, ','),
                preview_type: "markdown".into(),
                metadata_json: None,
            }),
            "tsv" => Ok(ParsedDoc {
                content: csv_to_markdown(&text, '\t'),
                preview_type: "markdown".into(),
                metadata_json: None,
            }),
            _ => {
                let is_text_like = matches!(
                    ext.as_str(),
                    "txt" | "text" | "log" | "html" | "htm" | "xml" | "yml" | "yaml" | "json"
                        | "rs" | "ts" | "tsx" | "js" | "py" | "go" | "java" | "c" | "cpp" | "sh"
                        | "toml" | "sql"
                );
                if is_text_like {
                    let preview = if matches!(ext.as_str(), "html" | "htm" | "xml") {
                        "html"
                    } else {
                        "text"
                    };
                    Ok(ParsedDoc {
                        content: text,
                        preview_type: preview.into(),
                        metadata_json: None,
                    })
                } else {
                    // 未知扩展名：若前端已声明预览类型，则按占位处理
                    match normalized_preview.as_deref() {
                        Some("image") | Some("audio") => Ok(ParsedDoc {
                            content: text,
                            preview_type: normalized_preview.clone().unwrap(),
                            metadata_json: Some("{\"mode\":\"store_with_placeholder\"}".into()),
                        }),
                        _ => Err(format!(
                            "unsupported file extension .{ext}; original file has been stored"
                        )),
                    }
                }
            }
        }
    }
}

fn csv_to_markdown(text: &str, delimiter: char) -> String {
    let mut out = String::new();
    for line in text.lines() {
        let cells: Vec<&str> = line.split(delimiter).collect();
        if out.is_empty() {
            out.push('|');
            for c in &cells {
                out.push_str(c);
                out.push('|');
            }
            out.push('\n');
            out.push('|');
            for _ in &cells {
                out.push_str("---|");
            }
            out.push('\n');
        } else {
            out.push('|');
            for c in &cells {
                out.push_str(c);
                out.push('|');
            }
            out.push('\n');
        }
    }
    out
}

/// 构建默认文本解析器（注册表 / 编排器入口使用）。
pub fn default_text_parser() -> Arc<dyn DocumentParser> {
    Arc::new(TextDocumentParser)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(ext: &str, body: &str) -> ParseInput {
        ParseInput {
            source_name: "demo".into(),
            file_extension: Some(ext.into()),
            mime_type: None,
            preview_type: None,
            bytes: body.as_bytes().to_vec(),
            bridged_content: None,
        }
    }

    #[test]
    fn parses_markdown_as_markdown_preview() {
        let parser = TextDocumentParser;
        let doc = parser.parse(&input("md", "# Title\nhello")).unwrap();
        assert_eq!(doc.preview_type, "markdown");
        assert!(doc.content.contains("Title"));
    }

    #[test]
    fn parses_csv_into_markdown_table() {
        let parser = TextDocumentParser;
        let doc = parser.parse(&input("csv", "a,b\n1,2")).unwrap();
        assert_eq!(doc.preview_type, "markdown");
        assert!(doc.content.contains("|a|b|"));
        assert!(doc.content.contains("|---|---|"));
    }

    #[test]
    fn rejects_unknown_extension_without_preview() {
        let parser = TextDocumentParser;
        assert!(parser.parse(&input("xyz", "data")).is_err());
    }
}
