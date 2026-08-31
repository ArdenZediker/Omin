use super::types::{
    ABSOLUTE_MAX_CHUNK_SIZE, ChunkSlice, DEFAULT_SEPARATORS, DocProfile, normalize_text, rune_len,
};
use super::profile::{
    dominant_heading_level, find_heading_boundaries, find_heuristic_boundaries, split_by_boundaries,
};
use super::units::{build_units_with_protection, merge_units, overlap_tail};
use super::title::derive_section_title;
use super::protected::protected_spans;

pub(crate) fn split_by_heading_strategy(
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

pub(crate) fn split_by_heuristic_strategy(
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

pub(crate) fn split_by_legacy_strategy(
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

pub(crate) fn validate_chunks(chunks: &[ChunkSlice], total_chars: usize, chunk_size: usize) -> bool {
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
