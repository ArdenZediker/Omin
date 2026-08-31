use regex::Regex;
use std::sync::OnceLock;

use super::types::ByteSpan;

pub(crate) fn protected_spans_if_needed(text: &str) -> Option<Vec<ByteSpan>> {
    let spans = protected_spans(text);
    if spans.is_empty() {
        None
    } else {
        Some(spans)
    }
}

pub(crate) fn drop_boundaries_inside_spans(boundaries: Vec<usize>, spans: &[ByteSpan]) -> Vec<usize> {
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

pub(crate) fn protected_spans(text: &str) -> Vec<ByteSpan> {
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

pub(crate) fn protected_patterns() -> &'static [Regex] {
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
