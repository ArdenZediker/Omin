use regex::Regex;
use std::sync::OnceLock;

pub const DEFAULT_CHUNK_SIZE: usize = 512;
pub const DEFAULT_CHUNK_OVERLAP: usize = 80;

const ABSOLUTE_MAX_CHUNK_SIZE: usize = 7500;
const MAX_PROTECTED_UNIT_SIZE: usize = 7500;
const DEFAULT_SEPARATORS: [&str; 7] = ["\n\n", "\n", "。", "！", "？", ";", "；"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkSlice {
    pub content: String,
    pub title: Option<String>,
}

impl ChunkSlice {
    fn from_content(content: String, source_name: &str) -> Self {
        let title = derive_title(&content, source_name);
        Self {
            content,
            title: if title.is_empty() { None } else { Some(title) },
        }
    }

    fn with_title(mut self, title: Option<String>) -> Self {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StrategyTier {
    Heading,
    Heuristic,
    Legacy,
}

#[derive(Debug, Default, Clone)]
struct DocProfile {
    markdown_headings: [usize; 6],
    form_feeds: usize,
    chapter_markers: usize,
    all_caps: usize,
    visual_separators: usize,
    blank_bursts: usize,
}

impl DocProfile {
    fn heading_total(&self) -> usize {
        self.markdown_headings.iter().sum()
    }

    fn heuristic_total(&self) -> usize {
        self.form_feeds
            + self.chapter_markers
            + self.all_caps
            + self.visual_separators
            + self.blank_bursts
    }
}

#[derive(Debug, Clone, Copy)]
struct ByteSpan {
    start: usize,
    end: usize,
}

pub fn split_document_text(
    text: &str,
    source_name: &str,
    preview_type: Option<&str>,
    file_extension: Option<&str>,
    chunk_size: usize,
    chunk_overlap: usize,
) -> Vec<ChunkSlice> {
    let normalized = normalize_text(text);
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let chunk_size = chunk_size.max(1);
    let chunk_overlap = chunk_overlap.min(chunk_size.saturating_sub(1));
    let profile = profile_document(&normalized);
    let chain = resolve_strategy_chain(preview_type, file_extension, &profile);
    let total_chars = normalized.chars().count();

    for tier in chain {
        let chunks = match tier {
            StrategyTier::Heading => split_by_heading_strategy(
                &normalized,
                source_name,
                chunk_size,
                chunk_overlap,
                &profile,
            ),
            StrategyTier::Heuristic => {
                split_by_heuristic_strategy(&normalized, source_name, chunk_size, chunk_overlap)
            }
            StrategyTier::Legacy => {
                split_by_legacy_strategy(&normalized, source_name, chunk_size, chunk_overlap)
            }
        };

        if validate_chunks(&chunks, total_chars, chunk_size) {
            return chunks;
        }
    }

    split_by_legacy_strategy(&normalized, source_name, chunk_size, chunk_overlap)
}

fn resolve_strategy_chain(
    preview_type: Option<&str>,
    file_extension: Option<&str>,
    profile: &DocProfile,
) -> Vec<StrategyTier> {
    let preview = normalize_hint(preview_type);
    let extension = normalize_hint(file_extension);
    let heading_hint = matches!(preview.as_str(), "md" | "markdown")
        || matches!(extension.as_str(), "md" | "markdown");
    let heuristic_hint =
        matches!(preview.as_str(), "pdf" | "docx") || matches!(extension.as_str(), "pdf" | "docx");

    let heading_score = profile.heading_total();
    let heuristic_score = profile.heuristic_total();

    let selected = if heading_score > heuristic_score && heading_score > 0 {
        StrategyTier::Heading
    } else if heuristic_score > heading_score && heuristic_score > 0 {
        StrategyTier::Heuristic
    } else if heading_hint {
        StrategyTier::Heading
    } else if heuristic_hint {
        StrategyTier::Heuristic
    } else {
        StrategyTier::Legacy
    };

    match selected {
        StrategyTier::Legacy => vec![StrategyTier::Legacy],
        other => vec![other, StrategyTier::Legacy],
    }
}

fn split_by_heading_strategy(
    text: &str,
    source_name: &str,
    chunk_size: usize,
    chunk_overlap: usize,
    profile: &DocProfile,
) -> Vec<ChunkSlice> {
    let primary_level = dominant_heading_level(profile);
    if primary_level == 0 {
        return split_by_legacy_strategy(text, source_name, chunk_size, chunk_overlap);
    }

    let boundaries = find_heading_boundaries(text, primary_level);
    if boundaries.len() <= 2 {
        return split_by_legacy_strategy(text, source_name, chunk_size, chunk_overlap);
    }

    let mut out = Vec::new();
    for segment in split_by_boundaries(text, &boundaries) {
        if segment.trim().is_empty() {
            continue;
        }

        if rune_len(&segment) <= chunk_size {
            out.push(ChunkSlice::from_content(segment, source_name));
            continue;
        }

        let section_title = derive_section_title(&segment, source_name);
        let section_chunks =
            split_by_legacy_strategy(&segment, source_name, chunk_size, chunk_overlap);
        if section_chunks.len() <= 1 {
            out.extend(section_chunks);
        } else {
            out.extend(
                section_chunks
                    .into_iter()
                    .map(|chunk| chunk.with_title(Some(section_title.clone()))),
            );
        }
    }

    if out.is_empty() {
        split_by_legacy_strategy(text, source_name, chunk_size, chunk_overlap)
    } else {
        out
    }
}

fn split_by_heuristic_strategy(
    text: &str,
    source_name: &str,
    chunk_size: usize,
    chunk_overlap: usize,
) -> Vec<ChunkSlice> {
    let mut boundaries = find_heuristic_boundaries(text);
    if boundaries.len() <= 2 {
        return split_by_legacy_strategy(text, source_name, chunk_size, chunk_overlap);
    }

    boundaries.sort_unstable();
    boundaries.dedup();

    let segments = split_by_boundaries(text, &boundaries);
    if segments.len() <= 1 {
        return split_by_legacy_strategy(text, source_name, chunk_size, chunk_overlap);
    }

    let mut out = Vec::new();
    let mut current = String::new();

    for segment in segments {
        if segment.trim().is_empty() {
            continue;
        }

        let seg_len = rune_len(&segment);
        if seg_len > chunk_size {
            if !current.trim().is_empty() {
                out.push(ChunkSlice::from_content(
                    std::mem::take(&mut current),
                    source_name,
                ));
            }

            let block_title = derive_section_title(&segment, source_name);
            let block_chunks =
                split_by_legacy_strategy(&segment, source_name, chunk_size, chunk_overlap);
            if block_chunks.len() <= 1 {
                out.extend(block_chunks);
            } else {
                out.extend(
                    block_chunks
                        .into_iter()
                        .map(|chunk| chunk.with_title(Some(block_title.clone()))),
                );
            }
            continue;
        }

        if current.is_empty() {
            current.push_str(&segment);
            continue;
        }

        if rune_len(&current) + seg_len <= chunk_size {
            current.push_str(&segment);
        } else {
            let previous = std::mem::take(&mut current);
            let overlap = overlap_tail(&previous, chunk_overlap, chunk_size, seg_len);
            if !previous.trim().is_empty() {
                out.push(ChunkSlice::from_content(previous, source_name));
            }
            current = overlap;
            current.push_str(&segment);
        }
    }

    if !current.trim().is_empty() {
        out.push(ChunkSlice::from_content(current, source_name));
    }

    if out.is_empty() {
        split_by_legacy_strategy(text, source_name, chunk_size, chunk_overlap)
    } else {
        out
    }
}

fn split_by_legacy_strategy(
    text: &str,
    source_name: &str,
    chunk_size: usize,
    chunk_overlap: usize,
) -> Vec<ChunkSlice> {
    let normalized = normalize_text(text);
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let protected = protected_spans(&normalized);
    let units =
        build_units_with_protection(&normalized, &protected, &DEFAULT_SEPARATORS, chunk_size);
    let merged = merge_units(&units, chunk_size, chunk_overlap);

    if merged.is_empty() {
        return vec![ChunkSlice::from_content(trimmed.to_string(), source_name)];
    }

    merged
        .into_iter()
        .map(|content| ChunkSlice::from_content(content, source_name))
        .collect()
}

fn validate_chunks(chunks: &[ChunkSlice], total_chars: usize, chunk_size: usize) -> bool {
    if chunks.is_empty() {
        return false;
    }

    let mut tiny = 0usize;
    let mut total = 0usize;
    for chunk in chunks {
        let len = rune_len(&chunk.content);
        if len == 0 || len > ABSOLUTE_MAX_CHUNK_SIZE {
            return false;
        }
        total += len;
        if len < (chunk_size / 8).max(32) {
            tiny += 1;
        }
    }

    if total == 0 || total_chars == 0 {
        return false;
    }

    if chunks.len() >= 6 && tiny * 2 > chunks.len() {
        return false;
    }

    true
}

fn profile_document(text: &str) -> DocProfile {
    let mut profile = DocProfile::default();
    let mut blank_run = 0usize;
    let mut in_fence = false;

    for line in line_ranges(text) {
        let raw = &text[line.start..line.end];
        let trimmed = raw.trim();

        if raw.contains('\u{c}') {
            profile.form_feeds += raw.matches('\u{c}').count();
        }

        if trimmed.starts_with("```") {
            in_fence = !in_fence;
            blank_run = 0;
            continue;
        }

        if trimmed.is_empty() {
            blank_run += 1;
            if blank_run >= 3 {
                profile.blank_bursts += 1;
            }
            continue;
        }

        blank_run = 0;

        if in_fence {
            continue;
        }

        if let Some(level) = markdown_heading_level(trimmed) {
            if (1..=6).contains(&level) {
                profile.markdown_headings[level - 1] += 1;
            }
        }

        if is_chapter_marker(trimmed) {
            profile.chapter_markers += 1;
        }

        if is_all_caps_heading(trimmed) {
            profile.all_caps += 1;
        }

        if is_visual_separator(trimmed) {
            profile.visual_separators += 1;
        }
    }

    profile
}

fn dominant_heading_level(profile: &DocProfile) -> usize {
    let mut best_level = 0usize;
    let mut best_count = 0usize;

    for (index, count) in profile.markdown_headings.iter().enumerate() {
        if *count > best_count || (*count == best_count && *count > 0 && index + 1 < best_level) {
            best_level = index + 1;
            best_count = *count;
        }
    }

    best_level
}

fn find_heading_boundaries(text: &str, primary_level: usize) -> Vec<usize> {
    let mut bounds = vec![0usize];
    for line in line_ranges(text) {
        if line.start == 0 {
            continue;
        }
        let raw = &text[line.start..line.end];
        if let Some(level) = markdown_heading_level(raw.trim()) {
            if level <= primary_level {
                bounds.push(line.start);
            }
        }
    }

    bounds.push(text.len());
    bounds.sort_unstable();
    bounds.dedup();

    if let Some(spans) = protected_spans_if_needed(text) {
        drop_boundaries_inside_spans(bounds, &spans)
    } else {
        bounds
    }
}

fn find_heuristic_boundaries(text: &str) -> Vec<usize> {
    let mut bounds = vec![0usize];
    let mut blank_run = 0usize;
    let mut in_fence = false;

    for (idx, _) in text.match_indices('\u{c}') {
        bounds.push(idx + '\u{c}'.len_utf8());
    }

    for line in line_ranges(text) {
        let raw = &text[line.start..line.end];
        let trimmed = raw.trim();

        if trimmed.starts_with("```") {
            in_fence = !in_fence;
            blank_run = 0;
            continue;
        }

        if trimmed.is_empty() {
            blank_run += 1;
            if blank_run >= 3 {
                bounds.push(line.start);
            }
            continue;
        }

        blank_run = 0;

        if in_fence {
            continue;
        }

        if is_chapter_marker(trimmed)
            || is_visual_separator(trimmed)
            || is_all_caps_heading(trimmed)
        {
            bounds.push(line.start);
        }
    }

    bounds.push(text.len());
    bounds.sort_unstable();
    bounds.dedup();

    if let Some(spans) = protected_spans_if_needed(text) {
        drop_boundaries_inside_spans(bounds, &spans)
    } else {
        bounds
    }
}

fn split_by_boundaries(text: &str, boundaries: &[usize]) -> Vec<String> {
    if boundaries.len() <= 1 {
        return vec![text.to_string()];
    }

    let mut segments = Vec::new();
    for window in boundaries.windows(2) {
        let start = window[0].min(text.len());
        let end = window[1].min(text.len());
        if end <= start {
            continue;
        }
        let segment = &text[start..end];
        if !segment.is_empty() {
            segments.push(segment.to_string());
        }
    }
    segments
}

fn build_units_with_protection(
    text: &str,
    protected: &[ByteSpan],
    separators: &[&str],
    chunk_size: usize,
) -> Vec<String> {
    let mut units = Vec::new();
    let mut byte_pos = 0usize;

    for span in protected {
        if span.start > byte_pos {
            let pre = &text[byte_pos..span.start];
            units.extend(split_by_separators(pre, separators, chunk_size));
        }

        let protected_text = &text[span.start..span.end];
        if rune_len(protected_text) > MAX_PROTECTED_UNIT_SIZE {
            units.extend(split_long_unit(protected_text, MAX_PROTECTED_UNIT_SIZE));
        } else {
            units.push(protected_text.to_string());
        }

        byte_pos = span.end;
    }

    if byte_pos < text.len() {
        let rest = &text[byte_pos..];
        units.extend(split_by_separators(rest, separators, chunk_size));
    }

    units
}

fn split_by_separators(text: &str, separators: &[&str], chunk_size: usize) -> Vec<String> {
    if text.is_empty() || separators.is_empty() {
        return vec![text.to_string()];
    }

    if chunk_size > 0 && rune_len(text) <= chunk_size {
        return vec![text.to_string()];
    }

    for (index, separator) in separators.iter().enumerate() {
        if separator.is_empty() || !text.contains(separator) {
            continue;
        }

        let mut pieces = Vec::new();
        let mut last = 0usize;
        let mut found = false;
        while let Some(relative) = text[last..].find(separator) {
            let absolute = last + relative;
            if absolute > last {
                pieces.push(text[last..absolute].to_string());
            }
            pieces.push(separator.to_string());
            last = absolute + separator.len();
            found = true;
        }

        if !found {
            continue;
        }

        if last < text.len() {
            pieces.push(text[last..].to_string());
        }

        let remaining = &separators[index + 1..];
        let mut out = Vec::new();
        for piece in pieces {
            if piece.is_empty() {
                continue;
            }
            if chunk_size > 0 && rune_len(&piece) > chunk_size && !remaining.is_empty() {
                out.extend(split_by_separators(&piece, remaining, chunk_size));
            } else {
                out.push(piece);
            }
        }
        return out;
    }

    vec![text.to_string()]
}

fn split_long_unit(text: &str, max_chars: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return Vec::new();
    }

    let mut out = Vec::new();
    let mut start = 0usize;
    while start < chars.len() {
        let mut end = (start + max_chars).min(chars.len());
        if end < chars.len() {
            let lower = start + max_chars.saturating_sub(200);
            let lower = lower.min(end.saturating_sub(1));
            for index in (lower..end).rev() {
                if chars[index] == '\n' || chars[index] == ' ' {
                    end = index + 1;
                    break;
                }
            }
        }

        if end <= start {
            end = (start + max_chars).min(chars.len());
        }

        out.push(chars[start..end].iter().collect());
        start = end;
    }

    out
}

fn merge_units(units: &[String], chunk_size: usize, chunk_overlap: usize) -> Vec<String> {
    if units.is_empty() {
        return Vec::new();
    }

    let mut chunks = Vec::new();
    let mut current: Vec<String> = Vec::new();
    let mut current_len = 0usize;

    for unit in units {
        let unit_len = rune_len(unit);

        if unit_len > ABSOLUTE_MAX_CHUNK_SIZE {
            if !current.is_empty() {
                let built = build_chunk(&current);
                if !built.trim().is_empty() {
                    chunks.push(built);
                }
                current.clear();
                current_len = 0;
            }

            for split in split_long_unit(unit, ABSOLUTE_MAX_CHUNK_SIZE) {
                if !split.trim().is_empty() {
                    chunks.push(split);
                }
            }
            continue;
        }

        if current_len + unit_len > chunk_size && !current.is_empty() {
            let built = build_chunk(&current);
            if !built.trim().is_empty() {
                chunks.push(built);
            }

            let overlap = compute_overlap(&current, chunk_overlap, chunk_size, unit_len);
            current = overlap;
            current_len = rune_len(&build_chunk(&current));
        }

        current.push(unit.clone());
        current_len += unit_len;
    }

    if !current.is_empty() {
        let built = build_chunk(&current);
        if !built.trim().is_empty() {
            chunks.push(built);
        }
    }

    chunks
}

fn compute_overlap(
    current: &[String],
    chunk_overlap: usize,
    chunk_size: usize,
    next_len: usize,
) -> Vec<String> {
    if chunk_overlap == 0 || current.is_empty() {
        return Vec::new();
    }

    let mut overlap_len = 0usize;
    let mut start_idx = current.len();
    for index in (0..current.len()).rev() {
        let unit_len = rune_len(&current[index]);
        if overlap_len + unit_len > chunk_overlap {
            break;
        }
        if overlap_len + unit_len + next_len > chunk_size {
            break;
        }
        overlap_len += unit_len;
        start_idx = index;
    }

    while start_idx < current.len() {
        let unit = &current[start_idx];
        if unit.trim().is_empty() {
            overlap_len = overlap_len.saturating_sub(rune_len(unit));
            start_idx += 1;
        } else {
            break;
        }
    }

    current[start_idx..].to_vec()
}

fn build_chunk(units: &[String]) -> String {
    let mut out = String::new();
    for unit in units {
        out.push_str(unit);
    }
    out
}

fn overlap_tail(current: &str, chunk_overlap: usize, chunk_size: usize, next_len: usize) -> String {
    if chunk_overlap == 0 {
        return String::new();
    }

    let current_len = rune_len(current);
    if current_len == 0 {
        return String::new();
    }

    let max_tail = chunk_size.saturating_sub(next_len);
    if max_tail == 0 {
        return String::new();
    }

    let desired = chunk_overlap.min(current_len).min(max_tail);
    if desired == 0 {
        return String::new();
    }

    let chars: Vec<char> = current.chars().collect();
    let start = chars.len().saturating_sub(desired);
    let tail: String = chars[start..].iter().collect();
    if let Some(last_newline) = tail.rfind('\n') {
        let aligned = tail[last_newline + 1..].to_string();
        if !aligned.trim().is_empty() && rune_len(&aligned) <= max_tail {
            return aligned;
        }
    }

    if rune_len(&tail) <= max_tail {
        tail
    } else {
        let start = chars.len().saturating_sub(max_tail);
        chars[start..].iter().collect()
    }
}

fn derive_section_title(text: &str, source_name: &str) -> String {
    if let Some(title) = first_meaningful_line(text) {
        return title;
    }
    truncate_chars(source_name, 72)
}

fn derive_title(text: &str, source_name: &str) -> String {
    if let Some(title) = first_heading_line(text) {
        return title;
    }
    if let Some(title) = first_meaningful_line(text) {
        return title;
    }
    truncate_chars(source_name, 72)
}

fn first_heading_line(text: &str) -> Option<String> {
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(heading) = strip_markdown_heading(trimmed) {
            if !heading.is_empty() {
                return Some(truncate_chars(&heading, 72));
            }
        }
    }
    None
}

fn first_meaningful_line(text: &str) -> Option<String> {
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty()
            || is_separator_only(trimmed)
            || trimmed.starts_with("```")
            || looks_like_table_row(trimmed)
        {
            continue;
        }
        if let Some(heading) = strip_markdown_heading(trimmed) {
            if !heading.is_empty() {
                return Some(truncate_chars(&heading, 72));
            }
        }
        return Some(truncate_chars(trimmed, 72));
    }
    None
}

fn strip_markdown_heading(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    let hash_count = trimmed.chars().take_while(|c| *c == '#').count();
    if hash_count == 0 || hash_count > 6 {
        return None;
    }
    let rest = trimmed[hash_count..].trim_start();
    if rest.is_empty() {
        None
    } else {
        Some(rest.to_string())
    }
}

fn markdown_heading_level(line: &str) -> Option<usize> {
    let trimmed = line.trim_start();
    let hash_count = trimmed.chars().take_while(|c| *c == '#').count();
    if hash_count == 0 || hash_count > 6 {
        return None;
    }
    let rest = trimmed[hash_count..].trim_start();
    if rest.is_empty() {
        None
    } else {
        Some(hash_count)
    }
}

fn is_chapter_marker(line: &str) -> bool {
    let lower = line.to_lowercase();
    let patterns = [
        "chapter ",
        "chap. ",
        "section ",
        "part ",
        "book ",
        "appendix ",
        "kapitel ",
        "abschnitt ",
        "teil ",
    ];

    for prefix in patterns {
        if lower.starts_with(prefix) {
            let rest = lower[prefix.len()..].trim_start();
            if rest
                .chars()
                .next()
                .map(|c| c.is_ascii_digit())
                .unwrap_or(false)
            {
                return true;
            }
        }
    }

    let trimmed = line.trim_start();
    if trimmed.starts_with("第") && trimmed.chars().any(|c| "章节篇部分卷回".contains(c)) {
        return true;
    }

    let mut digits = 0usize;
    for ch in trimmed.chars() {
        if ch.is_ascii_digit() || ch == '.' {
            digits += 1;
        } else {
            break;
        }
    }
    if digits > 0 {
        let rest = trimmed[byte_index_for_rune(trimmed, digits)..].trim_start();
        if !rest.is_empty() {
            return true;
        }
    }

    false
}

fn is_all_caps_heading(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.len() < 3 {
        return false;
    }

    let letters: Vec<char> = trimmed.chars().filter(|c| c.is_alphabetic()).collect();
    if letters.is_empty() {
        return false;
    }

    if letters.iter().any(|c| c.is_lowercase()) {
        return false;
    }

    trimmed.chars().any(|c| c.is_alphabetic())
}

fn is_visual_separator(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.len() < 3 {
        return false;
    }

    if trimmed.chars().all(|c| c.is_whitespace()) {
        return false;
    }

    if trimmed
        .chars()
        .all(|c| matches!(c, '-' | '=' | '_' | '*' | '~' | '─' | '—' | '•' | '·' | '.'))
    {
        return true;
    }

    let mut chars = trimmed.chars();
    let first = match chars.next() {
        Some(ch) => ch,
        None => return false,
    };

    if first.is_alphanumeric() {
        return false;
    }

    trimmed.chars().all(|c| c == first)
}

fn is_separator_only(line: &str) -> bool {
    line.chars().all(|c| {
        matches!(
            c,
            '\n' | '\r'
                | '\t'
                | ' '
                | '。'
                | '！'
                | '？'
                | '.'
                | '!'
                | '?'
                | ';'
                | '；'
                | ':'
                | '：'
                | ','
                | '，'
        )
    })
}

fn looks_like_table_row(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.starts_with('|') && trimmed.ends_with('|') && trimmed.matches('|').count() >= 2
}

fn normalize_hint(value: Option<&str>) -> String {
    value.unwrap_or_default().trim().to_lowercase()
}

fn normalize_text(value: &str) -> String {
    value.replace("\r\n", "\n").replace('\r', "\n")
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
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

fn rune_len(value: &str) -> usize {
    value.chars().count()
}

fn byte_index_for_rune(text: &str, rune_index: usize) -> usize {
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

fn line_ranges(text: &str) -> Vec<LineRange> {
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

#[derive(Debug, Clone, Copy)]
struct LineRange {
    start: usize,
    end: usize,
}

fn protected_spans_if_needed(text: &str) -> Option<Vec<ByteSpan>> {
    let spans = protected_spans(text);
    if spans.is_empty() {
        None
    } else {
        Some(spans)
    }
}

fn drop_boundaries_inside_spans(boundaries: Vec<usize>, spans: &[ByteSpan]) -> Vec<usize> {
    if spans.is_empty() {
        return boundaries;
    }

    let mut out = Vec::with_capacity(boundaries.len());
    'outer: for boundary in boundaries {
        for span in spans {
            if boundary > span.start && boundary < span.end {
                continue 'outer;
            }
        }
        out.push(boundary);
    }
    out
}

fn protected_spans(text: &str) -> Vec<ByteSpan> {
    let mut spans = Vec::new();
    for regex in protected_patterns() {
        for mat in regex.find_iter(text) {
            if mat.end() > mat.start() {
                spans.push(ByteSpan {
                    start: mat.start(),
                    end: mat.end(),
                });
            }
        }
    }

    if spans.is_empty() {
        return spans;
    }

    spans.sort_by(|left, right| {
        left.start
            .cmp(&right.start)
            .then_with(|| (right.end - right.start).cmp(&(left.end - left.start)))
    });

    let mut deduped = Vec::new();
    let mut last_end = 0usize;
    for span in spans {
        if span.start >= last_end {
            last_end = span.end;
            deduped.push(span);
        }
    }

    deduped
}

fn protected_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS
        .get_or_init(|| {
            vec![
                Regex::new(r"(?s)\$\$.*?\$\$").expect("valid latex pattern"),
                Regex::new(r"!\[[^\]]*\]\([^)]+\)").expect("valid markdown image pattern"),
                Regex::new(r"\[[^\]]*\]\([^)]+\)").expect("valid markdown link pattern"),
                Regex::new(r"(?m)^[ ]*(?:\|[^|\n]*)+\|\n\s*(?:\|\s*:?-{3,}:?\s*)+\|?\n")
                    .expect("valid table header pattern"),
                Regex::new(r"(?m)^[ ]*(?:\|[^|\n]*)+\|\n").expect("valid table row pattern"),
                Regex::new(r"(?s)```(?:\w+)?\n.*?```").expect("valid fenced code pattern"),
            ]
        })
        .as_slice()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heading_strategy_uses_section_titles() {
        let text = "# Intro\nFirst paragraph.\n\n## Deep\nMore text.\n\n# Next\nFinal.";
        let chunks = split_document_text(text, "sample.md", Some("markdown"), Some("md"), 512, 80);
        assert!(!chunks.is_empty());
        assert!(chunks
            .iter()
            .any(|chunk| chunk.title.as_deref() == Some("Intro")));
        assert!(chunks.iter().any(|chunk| chunk.content.contains("Final.")));
    }

    #[test]
    fn legacy_keeps_code_blocks_atomic_when_possible() {
        let text = "Intro\n\n```rust\nfn main() {}\n```\n\nTail";
        let chunks = split_document_text(text, "sample.txt", Some("text"), Some("txt"), 64, 16);
        let code_chunks = chunks
            .iter()
            .filter(|chunk| chunk.content.contains("fn main()"))
            .count();
        assert_eq!(code_chunks, 1);
    }

    #[test]
    fn heuristic_strategy_splits_on_form_feed() {
        let text = "Page 1\n\u{c}\nPage 2\n\u{c}\nPage 3";
        let chunks = split_document_text(text, "report.pdf", Some("pdf"), Some("pdf"), 10, 2);
        assert!(chunks.len() >= 2);
    }
}
