use super::title::derive_title;

#[derive(Debug, Clone)]
pub struct ChunkSlice {
    pub content: String,
    pub title: Option<String>,
}

impl ChunkSlice {
    pub(crate) fn from_content(content: String, source_name: &str) -> Self {
        let title = derive_title(&content, source_name);
        Self {
            content,
            title: if title.is_empty() { None } else { Some(title) },
        }
    }

    pub(crate) fn with_title(mut self, title: Option<String>) -> Self {
        if let Some(title) = title {
            self.title = if title.trim().is_empty() {
                None
            } else {
                Some(title)
            };
        }
        self
    }
}

pub(crate) enum StrategyTier {
    Heading,
    Heuristic,
    Legacy,
}

#[derive(Debug, Default, Clone)]
pub(crate) struct DocProfile {
    pub(crate) markdown_headings: [usize; 6],
    pub(crate) form_feeds: usize,
    pub(crate) chapter_markers: usize,
    pub(crate) all_caps: usize,
    pub(crate) visual_separators: usize,
    pub(crate) blank_bursts: usize,
}

impl DocProfile {
    pub(crate) fn heading_total(&self) -> usize {
        self.markdown_headings.iter().sum()
    }

    pub(crate) fn heuristic_total(&self) -> usize {
        self.form_feeds
            + self.chapter_markers
            + self.all_caps
            + self.visual_separators
            + self.blank_bursts
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ByteSpan {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct LineRange {
    pub start: usize,
    pub end: usize,
}

pub const DEFAULT_CHUNK_SIZE: usize = 512;
pub const DEFAULT_CHUNK_OVERLAP: usize = 80;

pub(crate) const ABSOLUTE_MAX_CHUNK_SIZE: usize = 7500;
pub(crate) const MAX_PROTECTED_UNIT_SIZE: usize = 7500;
pub(crate) const DEFAULT_SEPARATORS: [&str; 7] = ["\n\n", "\n", "。", "！", "？", ";", "；"];

pub(crate) fn rune_len(value: &str) -> usize {
    value.chars().count()
}

pub(crate) fn byte_index_for_rune(text: &str, rune_index: usize) -> usize {
    if rune_index == 0 {
        return 0;
    }

    let mut seen = 0usize;
    for (byte_index, _) in text.char_indices() {
        if seen == rune_index {
            return byte_index;
        }
        seen += 1;
    }

    text.len()
}

pub(crate) fn normalize_text(value: &str) -> String {
    value.replace("\r\n", "\n").replace('\r', "\n")
}

pub(crate) fn normalize_hint(value: Option<&str>) -> String {
    value.unwrap_or_default().trim().to_lowercase()
}

pub(crate) fn truncate_chars(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim();
    let count = rune_len(trimmed);
    if count <= max_chars {
        return trimmed.to_string();
    }

    let mut out = String::new();
    for ch in trimmed.chars().take(max_chars.saturating_sub(1)) {
        out.push(ch);
    }
    out.push_str("...");
    out
}

pub(crate) fn line_ranges(text: &str) -> Vec<LineRange> {
    let mut ranges = Vec::new();
    let mut start = 0usize;
    for (idx, ch) in text.char_indices() {
        if ch == '\n' {
            ranges.push(LineRange { start, end: idx });
            start = idx + 1;
        }
    }
    ranges.push(LineRange {
        start,
        end: text.len(),
    });
    ranges
}
