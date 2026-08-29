//! 切分器：`MarkdownHeadingChunker`，按 ATX 标题（`#`~`######`）把文档切成
//! 语义小节，每节一个 `ChunkSlice`，`title` 取标题文本。
//!
//! 相比 `LegacyChunker` 的启发式切分，按标题切分对 markdown/文档类资料更贴合
//! RAG 语义（一问通常命中某个小节），是"扩展点可插拔"的直接示范：
//! 新增一种切分策略只需实现 `Chunker` trait，无需触碰 5000+ 行的核心管线。

use std::sync::Arc;

use crate::knowledge::contracts::Chunker;
use crate::knowledge_chunker::ChunkSlice;

/// 按 markdown 标题切分的切分器。
pub struct MarkdownHeadingChunker;

impl Chunker for MarkdownHeadingChunker {
    fn strategy(&self) -> &'static str {
        "markdown-heading"
    }

    fn chunk(
        &self,
        content: &str,
        _source_name: &str,
    ) -> Result<Vec<ChunkSlice>, String> {
        if content.trim().is_empty() {
            return Ok(Vec::new());
        }

        let mut chunks: Vec<ChunkSlice> = Vec::new();
        // 当前小节的累积文本（含该小节标题行）。
        let mut current: Option<(Option<String>, String)> = None; // (title, body)

        let flush = |current: &mut Option<(Option<String>, String)>,
                     chunks: &mut Vec<ChunkSlice>| {
            if let Some((title, body)) = current.take() {
                let trimmed = body.trim();
                if !trimmed.is_empty() {
                    chunks.push(ChunkSlice {
                        content: trimmed.to_string(),
                        title,
                    });
                }
            }
        };

        for line in content.lines() {
            // 仅在行首即以 '#' 开头时视为 ATX 标题（缩进的不算，避免误判代码块内注释）。
            if line.starts_with('#') {
                let level = line.chars().take_while(|c| *c == '#').count();
                if level <= 6 {
                    let after = &line[level..]; // '#' 均为 ASCII，字节数==字符数，切片安全
                    if after.is_empty() || after.starts_with(' ') || after.starts_with('\t') {
                        let heading_text = after.trim().to_string();
                        // 新标题出现，先冲刷上一节。
                        flush(&mut current, &mut chunks);
                        // 小节内容以原始标题行起头，便于召回时保留上下文。
                        current = Some((Some(heading_text), line.to_string()));
                        continue;
                    }
                }
            }
            match current.as_mut() {
                Some((_, body)) => {
                    body.push('\n');
                    body.push_str(line);
                }
                None => {
                    // 首个标题之前的导言段落，title 留空。
                    let mut body = String::new();
                    body.push_str(line);
                    current = Some((None, body));
                }
            }
        }
        flush(&mut current, &mut chunks);

        Ok(chunks)
    }
}

/// 构建 markdown 标题切分器。
pub fn default_markdown_chunker() -> Arc<dyn Chunker> {
    Arc::new(MarkdownHeadingChunker)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_single_heading_section() {
        let c = MarkdownHeadingChunker;
        let out = c.chunk("# Title\nbody text", "doc.md").unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].title.as_deref(), Some("Title"));
        assert!(out[0].content.contains("body text"));
        assert!(out[0].content.starts_with("# Title"));
    }

    #[test]
    fn splits_multiple_headings_into_separate_chunks() {
        let c = MarkdownHeadingChunker;
        let md = "# A\nfoo\n## B\nbar\n# C\nbaz";
        let out = c.chunk(md, "doc.md").unwrap();
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].title.as_deref(), Some("A"));
        assert!(out[0].content.contains("foo"));
        assert_eq!(out[1].title.as_deref(), Some("B"));
        assert!(out[1].content.contains("bar"));
        assert_eq!(out[2].title.as_deref(), Some("C"));
        assert!(out[2].content.contains("baz"));
    }

    #[test]
    fn preamble_before_first_heading_has_no_title() {
        let c = MarkdownHeadingChunker;
        let md = "intro line\n# A\nbody";
        let out = c.chunk(md, "doc.md").unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].title, None);
        assert!(out[0].content.contains("intro line"));
        assert_eq!(out[1].title.as_deref(), Some("A"));
    }

    #[test]
    fn ignores_fake_headings_inside_code_blocks() {
        let c = MarkdownHeadingChunker;
        // 缩进的 '#' 不是标题（strip_prefix 在 trim_start 后不匹配）。
        let md = "    # not a heading\nreal text\n# Real\nbody";
        let out = c.chunk(md, "doc.md").unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].title, None);
        assert!(out[0].content.contains("# not a heading"));
        assert_eq!(out[1].title.as_deref(), Some("Real"));
    }

    #[test]
    fn empty_content_yields_no_chunks() {
        let c = MarkdownHeadingChunker;
        assert!(c.chunk("   \n\n  ", "doc.md").unwrap().is_empty());
    }
}
