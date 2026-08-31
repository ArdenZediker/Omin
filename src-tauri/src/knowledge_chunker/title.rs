use super::types::{byte_index_for_rune, truncate_chars};

pub(crate) fn derive_section_title(text: &str, source_name: &str) -> String {
    if let Some(title) = first_meaningful_line(text) {
        return title;
    }
    truncate_chars(source_name, 72)
}

pub(crate) fn derive_title(text: &str, source_name: &str) -> String {
    if let Some(title) = first_heading_line(text) {
        return title;
    }
    if let Some(title) = first_meaningful_line(text) {
        return title;
    }
    truncate_chars(source_name, 72)
}

pub(crate) fn first_heading_line(text: &str) -> Option<String> {
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

pub(crate) fn first_meaningful_line(text: &str) -> Option<String> {
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

pub(crate) fn strip_markdown_heading(line: &str) -> Option<String> {
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

pub(crate) fn markdown_heading_level(line: &str) -> Option<usize> {
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

pub(crate) fn is_chapter_marker(line: &str) -> bool {
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

pub(crate) fn is_all_caps_heading(line: &str) -> bool {
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

pub(crate) fn is_visual_separator(line: &str) -> bool {
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

pub(crate) fn is_separator_only(line: &str) -> bool {
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

pub(crate) fn looks_like_table_row(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.starts_with('|') && trimmed.ends_with('|') && trimmed.matches('|').count() >= 2
}
