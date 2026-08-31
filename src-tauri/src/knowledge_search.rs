//! 由 lib.rs 拆分而来，逻辑保持不变。

use rusqlite::{params, Connection, OptionalExtension};
use std::{
    cmp::Ordering,
    collections::HashMap,
};

// 显式导入 crate 根条目，不用 `use super::*`（避免吸回 `__cmd__*` 宏导致 E0255）。
use crate::{
    ensure_knowledge_defaults, normalize_knowledge_retrieval_mode, normalize_text_for_search,
    parse_tags_json, tokenize_search_query, KnowledgeChunkRecord, KnowledgeDocumentAssetRecord,
    SearchKnowledgeChunkResult, SearchKnowledgeChunksInput,
};

pub(crate) fn score_search_candidate(
    query: &str,
    query_terms: &[String],
    query_embedding: Option<&[f64]>,
    retrieval_mode: &str,
    candidate: &KnowledgeSearchCandidate,
) -> f64 {
    let mut score = 0.0;
    let haystack = normalize_text_for_search(&format!(
        "{} {} {} {} {} {}",
        candidate.source_name,
        candidate.source_path.as_deref().unwrap_or_default(),
        candidate.title_hierarchy.as_deref().unwrap_or_default(),
        candidate.title.as_deref().unwrap_or_default(),
        candidate.tags.join(" "),
        candidate.content
    ));

    if haystack.contains(query) {
        score += 8.0;
    }

    for term in query_terms {
        if haystack.contains(term) {
            score += 1.5;
        }
    }

    let allow_embedding = matches!(retrieval_mode, "hybrid" | "vector");
    if allow_embedding {
        if let Some(query_embedding) = query_embedding {
            if let Some(candidate_embedding) = candidate
                .embedding_json
                .as_deref()
                .and_then(parse_embedding_json)
            {
                score += cosine_similarity(query_embedding, &candidate_embedding) * 2.0;
            }
        }
    }

    if matches!(retrieval_mode, "vector") {
        score += 0.2;
    }

    if matches!(retrieval_mode, "keyword") {
        score += 0.1;
    }

    score
}

pub(crate) fn parse_embedding_json(value: &str) -> Option<Vec<f64>> {
    serde_json::from_str::<Vec<f64>>(value).ok()
}

pub(crate) fn cosine_similarity(left: &[f64], right: &[f64]) -> f64 {
    let len = left.len().min(right.len());
    if len == 0 {
        return 0.0;
    }

    let mut dot = 0.0;
    let mut left_norm = 0.0;
    let mut right_norm = 0.0;

    for index in 0..len {
        let l = left[index];
        let r = right[index];
        dot += l * r;
        left_norm += l * l;
        right_norm += r * r;
    }

    let denominator = left_norm.sqrt() * right_norm.sqrt();
    if denominator == 0.0 {
        0.0
    } else {
        dot / denominator
    }
}

pub(crate) struct KnowledgeSearchCandidate {
    pub(crate) chunk_id: String,
    pub(crate) document_id: String,
    pub(crate) collection_id: String,
    pub(crate) chunk_index: i64,
    pub(crate) title: Option<String>,
    pub(crate) content: String,
    pub(crate) chunk_type: Option<String>,
    pub(crate) parent_chunk_id: Option<String>,
    pub(crate) asset_id: Option<String>,
    pub(crate) image_info: Option<String>,
    pub(crate) embedding_json: Option<String>,
    pub(crate) embedding_model_key: Option<String>,
    pub(crate) created_at: i64,
    pub(crate) source_name: String,
    pub(crate) source_path: Option<String>,
    pub(crate) collection_name: String,
    pub(crate) retrieval_mode: String,
    pub(crate) tags: Vec<String>,
    pub(crate) favorite: bool,
    pub(crate) access_count: i64,
    pub(crate) last_accessed_at: Option<i64>,
    pub(crate) title_hierarchy: Option<String>,
}

pub(crate) fn build_chunk_record_from_candidate(candidate: &KnowledgeSearchCandidate) -> KnowledgeChunkRecord {
    KnowledgeChunkRecord {
        id: candidate.chunk_id.clone(),
        document_id: candidate.document_id.clone(),
        collection_id: candidate.collection_id.clone(),
        chunk_index: candidate.chunk_index,
        title: candidate.title.clone(),
        content: candidate.content.clone(),
        chunk_type: candidate.chunk_type.clone(),
        parent_chunk_id: candidate.parent_chunk_id.clone(),
        asset_id: candidate.asset_id.clone(),
        image_info: candidate.image_info.clone(),
        embedding_json: candidate.embedding_json.clone(),
        embedding_model_key: candidate.embedding_model_key.clone(),
        created_at: candidate.created_at,
    }
}

pub(crate) fn load_chunk_record_by_id(
    connection: &Connection,
    chunk_id: &str,
) -> Result<Option<KnowledgeChunkRecord>, String> {
    connection
        .query_row(
            r#"
            SELECT id, document_id, collection_id, chunk_index, title, content, chunk_type, parent_chunk_id,
                   asset_id, image_info, embedding_json, embedding_model_key, created_at
            FROM knowledge_chunks
            WHERE id = ?1
            "#,
            params![chunk_id],
            |row| {
                Ok(KnowledgeChunkRecord {
                    id: row.get(0)?,
                    document_id: row.get(1)?,
                    collection_id: row.get(2)?,
                    chunk_index: row.get(3)?,
                    title: row.get(4)?,
                    content: row.get(5)?,
                    chunk_type: row.get(6)?,
                    parent_chunk_id: row.get(7)?,
                    asset_id: row.get(8)?,
                    image_info: row.get(9)?,
                    embedding_json: row.get(10)?,
                    embedding_model_key: row.get(11)?,
                    created_at: row.get(12)?,
                })
            },
        )
        .optional()
        .map_err(|err| err.to_string())
}

pub(crate) fn load_asset_record_by_id(
    connection: &Connection,
    asset_id: &str,
) -> Result<Option<KnowledgeDocumentAssetRecord>, String> {
    connection
        .query_row(
            r#"
            SELECT id, document_id, collection_id, asset_kind, source_name, stored_file_path, mime_type,
                   file_extension, preview_type, thumbnail_data_url, ocr_text, caption_text,
                   content_preview, page_index, asset_index, metadata_json, created_at, updated_at
            FROM knowledge_document_assets
            WHERE id = ?1
            "#,
            params![asset_id],
            |row| {
                Ok(KnowledgeDocumentAssetRecord {
                    id: row.get(0)?,
                    document_id: row.get(1)?,
                    collection_id: row.get(2)?,
                    asset_kind: row.get(3)?,
                    source_name: row.get(4)?,
                    stored_file_path: row.get(5)?,
                    mime_type: row.get(6)?,
                    file_extension: row.get(7)?,
                    preview_type: row.get(8)?,
                    thumbnail_data_url: row.get(9)?,
                    ocr_text: row.get(10)?,
                    caption_text: row.get(11)?,
                    content_preview: row.get(12)?,
                    page_index: row.get(13)?,
                    asset_index: row.get(14)?,
                    metadata_json: row.get(15)?,
                    created_at: row.get(16)?,
                    updated_at: row.get(17)?,
                })
            },
        )
        .optional()
        .map_err(|err| err.to_string())
}

pub(crate) fn resolve_search_display_chunk(
    connection: &Connection,
    candidate: &KnowledgeSearchCandidate,
) -> Result<
    (
        KnowledgeChunkRecord,
        Option<KnowledgeChunkRecord>,
        Option<KnowledgeDocumentAssetRecord>,
    ),
    String,
> {
    let matched_chunk = build_chunk_record_from_candidate(candidate);
    let matched_asset = candidate
        .asset_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(|asset_id| load_asset_record_by_id(connection, asset_id))
        .transpose()?
        .flatten();

    if matches!(
        candidate.chunk_type.as_deref(),
        Some("image_ocr" | "image_caption")
    ) {
        if let Some(parent_chunk_id) = candidate
            .parent_chunk_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            if let Some(parent_chunk) = load_chunk_record_by_id(connection, parent_chunk_id)? {
                return Ok((parent_chunk, Some(matched_chunk), matched_asset));
            }
        }
    }

    Ok((matched_chunk.clone(), Some(matched_chunk), matched_asset))
}

pub(crate) fn search_knowledge_chunks(
    connection: &Connection,
    input: SearchKnowledgeChunksInput,
) -> Result<Vec<SearchKnowledgeChunkResult>, String> {
    let query = normalize_text_for_search(&input.query);
    if query.is_empty() {
        return Ok(Vec::new());
    }

    ensure_knowledge_defaults(connection)?;
    let query_terms = tokenize_search_query(&query);
    let normalized_query = if query_terms.is_empty() {
        query.clone()
    } else {
        query_terms.join(" ")
    };
    let limit = input.limit.unwrap_or(10).clamp(1, 50);
    let query_model_key = input
        .query_embedding_model_key
        .as_deref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let collection_filter = input.collection_id.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });
    let query_embedding = input.query_embedding;
    let mut stmt = connection
        .prepare(
            r#"
            SELECT
              c.id,
              c.document_id,
              c.collection_id,
              c.chunk_index,
              c.title,
              c.content,
              c.chunk_type,
              c.parent_chunk_id,
              c.asset_id,
              c.image_info,
              c.embedding_json,
              c.embedding_model_key,
              c.created_at,
              d.source_name,
              d.source_path,
              d.tags_json,
              d.favorite,
              d.access_count,
              d.last_accessed_at,
              d.title_hierarchy,
              k.name,
              k.retrieval_mode
            FROM knowledge_chunks c
            JOIN knowledge_documents d ON d.id = c.document_id
            JOIN knowledge_collections k ON k.id = c.collection_id
            "#,
        )
        .map_err(|err| err.to_string())?;

    let candidates = stmt
        .query_map([], |row| {
            let tags_json: String = row.get(15)?;
            Ok(KnowledgeSearchCandidate {
                chunk_id: row.get(0)?,
                document_id: row.get(1)?,
                collection_id: row.get(2)?,
                chunk_index: row.get(3)?,
                title: row.get(4)?,
                content: row.get(5)?,
                chunk_type: row.get(6)?,
                parent_chunk_id: row.get(7)?,
                asset_id: row.get(8)?,
                image_info: row.get(9)?,
                embedding_json: row.get(10)?,
                embedding_model_key: row.get(11)?,
                created_at: row.get(12)?,
                source_name: row.get(13)?,
                source_path: row.get(14)?,
                tags: parse_tags_json(&tags_json),
                favorite: row.get::<_, i64>(16)? != 0,
                access_count: row.get(17)?,
                last_accessed_at: row.get(18)?,
                title_hierarchy: row.get(19)?,
                collection_name: row.get(20)?,
                retrieval_mode: row.get(21)?,
            })
        })
        .map_err(|err| err.to_string())?
        .filter_map(|row| row.ok())
        .filter(|candidate| {
            collection_filter
                .as_ref()
                .map(|collection_id| &candidate.collection_id == collection_id)
                .unwrap_or(true)
        })
        .collect::<Vec<_>>();

    let mut scored = Vec::new();
    for candidate in candidates {
        let retrieval_mode = normalize_knowledge_retrieval_mode(candidate.retrieval_mode.as_str());
        let embedding_matches = query_model_key
            .as_deref()
            .map(|model_key| {
                candidate
                    .embedding_model_key
                    .as_deref()
                    .map(|value| value == model_key)
                    .unwrap_or(false)
            })
            .unwrap_or(true);
        if !embedding_matches {
            continue;
        }

        let effective_embedding = if matches!(retrieval_mode.as_str(), "hybrid" | "vector") {
            query_embedding.as_deref()
        } else {
            None
        };
        let score = score_search_candidate(
            &normalized_query,
            &query_terms,
            effective_embedding,
            &retrieval_mode,
            &candidate,
        );
        if score <= 0.0
            && !normalize_text_for_search(&candidate.content).contains(&normalized_query)
        {
            continue;
        }

        scored.push((score, candidate));
    }

    scored.sort_by(|left, right| {
        right
            .0
            .partial_cmp(&left.0)
            .unwrap_or(Ordering::Equal)
            .then_with(|| right.1.access_count.cmp(&left.1.access_count))
            .then_with(|| left.1.created_at.cmp(&right.1.created_at))
    });

    let mut deduped_by_display: HashMap<String, SearchKnowledgeChunkResult> = HashMap::new();
    for (score, candidate) in scored {
        let (display_chunk, matched_chunk, matched_asset) =
            resolve_search_display_chunk(connection, &candidate)?;
        let display_chunk_id = display_chunk.id.clone();
        let next_result = SearchKnowledgeChunkResult {
            chunk: display_chunk.clone(),
            matched_chunk,
            display_chunk: Some(display_chunk.clone()),
            matched_chunk_type: candidate.chunk_type.clone(),
            parent_chunk_id: candidate.parent_chunk_id.clone(),
            image_info: candidate.image_info.clone(),
            matched_asset,
            score,
            source_name: candidate.source_name.clone(),
            source_path: candidate.source_path.clone(),
            collection_name: candidate.collection_name.clone(),
            tags: candidate.tags.clone(),
            favorite: candidate.favorite,
            access_count: candidate.access_count,
            last_accessed_at: candidate.last_accessed_at,
            title_hierarchy: candidate.title_hierarchy.clone(),
        };

        match deduped_by_display.get(&display_chunk_id) {
            Some(existing) if existing.score >= score => {}
            _ => {
                deduped_by_display.insert(display_chunk_id, next_result);
            }
        }
    }

    let mut results = deduped_by_display
        .into_values()
        .collect::<Vec<SearchKnowledgeChunkResult>>();
    results.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(Ordering::Equal)
            .then_with(|| right.access_count.cmp(&left.access_count))
            .then_with(|| left.chunk.created_at.cmp(&right.chunk.created_at))
    });
    results.truncate(limit);
    Ok(results)
}
