use super::types::{DocProfile, line_ranges};
use super::title::{
    is_all_caps_heading, is_chapter_marker, is_visual_separator, markdown_heading_level,
};
use super::protected::{drop_boundaries_inside_spans, protected_spans_if_needed};

pub(crate) fn profile_document(text: &str) -> DocProfile {
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

pub(crate) fn dominant_heading_level(profile: &DocProfile) -> usize {
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

pub(crate) fn find_heading_boundaries(text: &str, primary_level: usize) -> Vec<usize> {
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

pub(crate) fn find_heuristic_boundaries(text: &str) -> Vec<usize> {
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

pub(crate) fn split_by_boundaries(text: &str, boundaries: &[usize]) -> Vec<String> {
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
