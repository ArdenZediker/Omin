use super::types::{ABSOLUTE_MAX_CHUNK_SIZE, ByteSpan, MAX_PROTECTED_UNIT_SIZE, rune_len};

pub(crate) fn build_units_with_protection(
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

pub(crate) fn split_by_separators(text: &str, separators: &[&str], chunk_size: usize) -> Vec<String> {
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

pub(crate) fn split_long_unit(text: &str, max_chars: usize) -> Vec<String> {
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

pub(crate) fn merge_units(units: &[String], chunk_size: usize, chunk_overlap: usize) -> Vec<String> {
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

pub(crate) fn compute_overlap(
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

pub(crate) fn build_chunk(units: &[String]) -> String {
    let mut out = String::new();
    for unit in units {
        out.push_str(unit);
    }
    out
}

pub(crate) fn overlap_tail(current: &str, chunk_overlap: usize, chunk_size: usize, next_len: usize) -> String {
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
