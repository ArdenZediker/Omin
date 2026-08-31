pub mod types;
pub(crate) mod profile;
pub(crate) mod strategy;
pub(crate) mod units;
pub(crate) mod title;
pub(crate) mod protected;

pub use self::types::ChunkSlice;
pub use self::types::DEFAULT_CHUNK_SIZE;
pub use self::types::DEFAULT_CHUNK_OVERLAP;

use self::profile::profile_document;
use self::strategy::{
    split_by_heading_strategy, split_by_heuristic_strategy, split_by_legacy_strategy,
    validate_chunks,
};
use self::types::{normalize_hint, normalize_text, DocProfile, StrategyTier};

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

pub(crate) fn resolve_strategy_chain(
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
