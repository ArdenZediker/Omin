//! 切分器路由：按文件扩展名选择具体策略。
//!
//! 这是 trait 可组合性的直接示范——`RouterChunker` 本身不实现切分逻辑，
//! 而是把请求委派给内部的具体 `Chunker`。新增一种"按 X 路由"的规则，
//! 或新增一种具体切分器，都无需改动核心管线。

use std::path::Path;
use std::sync::Arc;

use crate::knowledge::contracts::Chunker;
use crate::knowledge_chunker::ChunkSlice;

/// 按扩展名路由的切分器。
pub struct RouterChunker {
    markdown: Arc<dyn Chunker>,
    fallback: Arc<dyn Chunker>,
}

impl RouterChunker {
    pub fn new(markdown: Arc<dyn Chunker>, fallback: Arc<dyn Chunker>) -> Self {
        Self { markdown, fallback }
    }
}

impl Chunker for RouterChunker {
    fn strategy(&self) -> &'static str {
        "router"
    }

    fn chunk(
        &self,
        content: &str,
        source_name: &str,
    ) -> Result<Vec<ChunkSlice>, String> {
        let ext = Path::new(source_name)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext == "md" || ext == "markdown" {
            self.markdown.chunk(content, source_name)
        } else {
            self.fallback.chunk(content, source_name)
        }
    }
}
