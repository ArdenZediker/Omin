//! 多模态富化：图片理解与音频转写的模型调用与结果拼装。
//!
//! 由 knowledge_pipeline 单文件拆分而来，保持逻辑不变。

use crate::{
    find_exact_usable_knowledge_multimodal_model, infer_preview_type,
    load_knowledge_collection_multimodal_config, load_knowledge_multimodal_config,
    validate_knowledge_multimodal_upload, KnowledgeCollectionMultimodalConfigRecord,
    KnowledgeMultimodalModelConfigRecord,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use regex::Regex;
use reqwest::blocking::{multipart, Client as BlockingHttpClient};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
    time::{SystemTime, UNIX_EPOCH},
};

use super::*;

pub(crate) fn format_image_placeholder(source_name: &str, mime_type: Option<&str>) -> String {
    let mime_line = mime_type
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("未知");
    format!(
        "图片文件\n文件名: {source_name}\nMIME 类型: {mime_line}\n原始引用: ![{source_name}]({source_name})"
    )
}

pub(crate) fn format_audio_placeholder(source_name: &str, mime_type: Option<&str>) -> String {
    let mime_line = mime_type
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("未知");
    format!("音频文件\n文件名: {source_name}\nMIME 类型: {mime_line}")
}

pub(crate) fn merge_multimodal_content(base: &str, multimodal: &str) -> String {
    let base = base.trim();
    let multimodal = multimodal.trim();
    if base.is_empty() {
        return multimodal.to_string();
    }
    if multimodal.is_empty() {
        return base.to_string();
    }

    format!("{base}\n\n--- 多模态分析 ---\n{multimodal}")
}

pub(crate) fn format_image_enrichment(
    source_name: &str,
    mime_type: Option<&str>,
    ocr_text: Option<&str>,
    summary: Option<&str>,
) -> String {
    let mut sections = vec![format!("图片分析结果：{source_name}")];
    if let Some(mime_type) = mime_type.map(str::trim).filter(|value| !value.is_empty()) {
        sections.push(format!("MIME 类型: {mime_type}"));
    }
    sections.push(String::new());
    sections.push("图片文字提取：".to_string());
    sections.push(
        normalize_optional_text(ocr_text).unwrap_or_else(|| "未识别到可用文字内容。".to_string()),
    );
    sections.push(String::new());
    sections.push("图片摘要：".to_string());
    sections
        .push(normalize_optional_text(summary).unwrap_or_else(|| "未生成图片摘要。".to_string()));
    sections.join("\n")
}

pub(crate) fn format_audio_enrichment(
    source_name: &str,
    mime_type: Option<&str>,
    transcript: Option<&str>,
    summary: Option<&str>,
    keep_transcript: bool,
) -> String {
    let mut sections = vec![format!("音频分析结果：{source_name}")];
    if let Some(mime_type) = mime_type.map(str::trim).filter(|value| !value.is_empty()) {
        sections.push(format!("MIME 类型: {mime_type}"));
    }

    if keep_transcript {
        sections.push(String::new());
        sections.push("音频转写：".to_string());
        sections.push(
            normalize_optional_text(transcript)
                .unwrap_or_else(|| "未检测到清晰可用的语音内容。".to_string()),
        );
    }

    if let Some(summary) = normalize_optional_text(summary) {
        sections.push(String::new());
        sections.push("音频摘要：".to_string());
        sections.push(summary);
    }

    if sections.len() <= 2 {
        sections.push(String::new());
        sections.push("未生成额外的多模态音频文本。".to_string());
    }

    sections.join("\n")
}

pub(crate) fn extract_tagged_block(content: &str, tag_name: &str) -> Option<String> {
    let start_tag = format!("<{tag_name}>");
    let end_tag = format!("</{tag_name}>");
    let start_index = content.find(&start_tag)? + start_tag.len();
    let end_index = content[start_index..].find(&end_tag)? + start_index;
    normalize_optional_text(Some(&content[start_index..end_index]))
}

pub(crate) fn extract_chat_completion_text(payload: &JsonValue) -> Option<String> {
    let choices = payload.get("choices")?.as_array()?;
    let message = choices.first()?.get("message")?;
    match message.get("content")? {
        JsonValue::String(value) => normalize_optional_text(Some(value)),
        JsonValue::Array(parts) => {
            let text = parts
                .iter()
                .filter_map(|part| part.get("text").and_then(JsonValue::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            normalize_optional_text(Some(text.as_str()))
        }
        _ => None,
    }
}

pub(crate) fn build_multimodal_http_client() -> Result<BlockingHttpClient, String> {
    BlockingHttpClient::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|err| err.to_string())
}

pub(crate) fn request_chat_completion(
    client: &BlockingHttpClient,
    model: &KnowledgeMultimodalModelConfigRecord,
    request_body: &JsonValue,
) -> Result<String, String> {
    let response = client
        .post(format!(
            "{}/chat/completions",
            model.base_url.trim_end_matches('/')
        ))
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", model.api_key.trim()))
        .json(request_body)
        .send()
        .map_err(|err| err.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(format!("chat completion request failed ({status}): {body}"));
    }

    let payload: JsonValue = response.json().map_err(|err| err.to_string())?;
    extract_chat_completion_text(&payload)
        .ok_or_else(|| "chat completion response did not contain message content".to_string())
}

pub(crate) fn request_audio_transcription(
    client: &BlockingHttpClient,
    model: &KnowledgeMultimodalModelConfigRecord,
    source_name: &str,
    mime_type: Option<&str>,
    bytes: &[u8],
) -> Result<String, String> {
    let file_name = source_name.to_string();
    let file_part =
        if let Some(mime_type) = mime_type.map(str::trim).filter(|value| !value.is_empty()) {
            match multipart::Part::bytes(bytes.to_vec())
                .file_name(file_name.clone())
                .mime_str(mime_type)
            {
                Ok(part) => part,
                Err(_) => multipart::Part::bytes(bytes.to_vec()).file_name(file_name),
            }
        } else {
            multipart::Part::bytes(bytes.to_vec()).file_name(file_name)
        };

    let form = multipart::Form::new()
        .text("model", model.model.clone())
        .part("file", file_part);

    let response = client
        .post(format!(
            "{}/audio/transcriptions",
            model.base_url.trim_end_matches('/')
        ))
        .header("Authorization", format!("Bearer {}", model.api_key.trim()))
        .multipart(form)
        .send()
        .map_err(|err| err.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(format!(
            "audio transcription request failed ({status}): {body}"
        ));
    }

    let body = response.text().map_err(|err| err.to_string())?;
    if let Ok(payload) = serde_json::from_str::<JsonValue>(&body) {
        if let Some(text) = payload.get("text").and_then(JsonValue::as_str) {
            return Ok(text.trim().to_string());
        }
        if let Some(text) = payload.get("transcript").and_then(JsonValue::as_str) {
            return Ok(text.trim().to_string());
        }
        if let Some(text) = payload
            .get("data")
            .and_then(|value| value.get("text"))
            .and_then(JsonValue::as_str)
        {
            return Ok(text.trim().to_string());
        }
    }

    Ok(body.trim().to_string())
}

pub(crate) fn resolve_collection_multimodal_config(
    connection: &Connection,
    collection_id: &str,
) -> Result<KnowledgeCollectionMultimodalConfigRecord, String> {
    load_knowledge_collection_multimodal_config(connection, collection_id)
}

pub(crate) fn resolve_multimodal_model(
    connection: &Connection,
    model_id: &str,
    capability: &str,
) -> Result<KnowledgeMultimodalModelConfigRecord, String> {
    let global_config = load_knowledge_multimodal_config(connection)?;
    find_exact_usable_knowledge_multimodal_model(&global_config, capability, model_id)
        .ok_or_else(|| format!("no usable {capability} multimodal model found for id: {model_id}"))
}

pub(crate) fn enrich_image_document(
    document: &PipelineDocumentSource,
    bytes: &[u8],
    model: &KnowledgeMultimodalModelConfigRecord,
    config: &KnowledgeCollectionMultimodalConfigRecord,
) -> Result<EnrichmentOutput, String> {
    if !config.image.extract_text && !config.image.generate_summary {
        return Ok(EnrichmentOutput::default());
    }

    let mime_type = document
        .mime_type
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| infer_fallback_mime_type("image", document.file_extension.as_deref()));
    let data_url = format!("data:{mime_type};base64,{}", BASE64_STANDARD.encode(bytes));
    let prompt = format!(
        "你正在为知识库准备一段可用于中文检索的图片分析文本，文件名是“{}”。\n\
请只返回 XML，格式必须严格如下：\n\
<result>\n<ocr>...</ocr>\n<summary>...</summary>\n</result>\n\
要求：\n\
- `<ocr>` 中输出适合中文向量检索的文字内容。如果图片原文不是中文，请优先输出中文整理版，必要时保留关键原文术语。\n\
- `<summary>` 中输出中文摘要，简洁描述图片中的关键信息、结构、主题和可检索要点。\n\
- 如果某一项未启用或没有结果，请返回空标签。\n\
- 不要输出 Markdown 代码块、解释或额外说明。\n\
- 是否需要 OCR：{}\n\
- 是否需要摘要：{}",
        document.source_name,
        if config.image.extract_text { "是" } else { "否" },
        if config.image.generate_summary { "是" } else { "否" }
    );
    let request_body = serde_json::json!({
        "model": model.model,
        "temperature": 0.1,
        "messages": [
            {
                "role": "system",
                "content": "你负责生成适合中文知识库检索的图片 OCR 文本和图片摘要。"
            },
            {
                "role": "user",
                "content": [
                    { "type": "text", "text": prompt },
                    { "type": "image_url", "image_url": { "url": data_url } }
                ]
            }
        ]
    });

    let client = build_multimodal_http_client()?;
    let raw_text = request_chat_completion(&client, model, &request_body)?;
    let mut ocr_text = if config.image.extract_text {
        extract_tagged_block(&raw_text, "ocr")
    } else {
        None
    };
    let mut summary = if config.image.generate_summary {
        extract_tagged_block(&raw_text, "summary")
    } else {
        None
    };
    if ocr_text.is_none() && summary.is_none() {
        if config.image.generate_summary {
            summary = normalize_optional_text(Some(raw_text.as_str()));
        } else if config.image.extract_text {
            ocr_text = normalize_optional_text(Some(raw_text.as_str()));
        }
    }

    Ok(EnrichmentOutput {
        content: Some(format_image_enrichment(
            &document.source_name,
            Some(mime_type),
            ocr_text.as_deref(),
            summary.as_deref(),
        )),
        warning: None,
        ocr_text,
        summary,
    })
}

pub(crate) fn summarize_audio_transcript(
    client: &BlockingHttpClient,
    model: &KnowledgeMultimodalModelConfigRecord,
    source_name: &str,
    transcript: &str,
) -> Result<String, String> {
    let prompt = format!(
        "请基于音频文件“{source_name}”的转写内容，生成一段适合中文知识库检索的摘要。\n\
要求：\n\
- 使用中文输出。\n\
- 保留重要的人名、地名、数字、日期、结论和决策。\n\
- 用 3 到 6 句话概括。\n\
- 只返回纯文本，不要加标题或 Markdown。\n\n转写内容：\n{transcript}"
    );
    let request_body = serde_json::json!({
        "model": model.model,
        "temperature": 0.1,
        "messages": [
            {
                "role": "system",
                "content": "你负责把音频转写整理成适合中文知识库检索的精炼摘要。"
            },
            {
                "role": "user",
                "content": prompt
            }
        ]
    });

    request_chat_completion(client, model, &request_body)
}

pub(crate) fn enrich_audio_document(
    document: &PipelineDocumentSource,
    bytes: &[u8],
    model: &KnowledgeMultimodalModelConfigRecord,
    config: &KnowledgeCollectionMultimodalConfigRecord,
) -> Result<EnrichmentOutput, String> {
    if !config.audio.keep_transcript && !config.audio.generate_summary {
        return Ok(EnrichmentOutput::default());
    }

    let mime_type = document
        .mime_type
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| infer_fallback_mime_type("audio", document.file_extension.as_deref()));
    let client = build_multimodal_http_client()?;
    let transcript = request_audio_transcription(
        &client,
        model,
        &document.source_name,
        Some(mime_type),
        bytes,
    )?;

    let mut warning = None;
    let summary = if config.audio.generate_summary && !transcript.trim().is_empty() {
        match summarize_audio_transcript(&client, model, &document.source_name, &transcript) {
            Ok(summary) => normalize_optional_text(Some(summary.as_str())),
            Err(err) => {
                warning = Some(format!("音频摘要生成失败：{err}"));
                None
            }
        }
    } else {
        None
    };

    Ok(EnrichmentOutput {
        content: Some(format_audio_enrichment(
            &document.source_name,
            Some(mime_type),
            Some(transcript.as_str()),
            summary.as_deref(),
            config.audio.keep_transcript,
        )),
        warning,
        ocr_text: None,
        summary: None,
    })
}
