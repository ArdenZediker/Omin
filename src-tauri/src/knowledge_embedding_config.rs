//! 由 lib.rs 拆分而来，逻辑保持不变。

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value as JsonValue;

// 显式导入 crate 根条目，而不是 `use super::*`：
// `use super::*` 会把 crate 根的一堆名字（含 trait 的隐式可见性）整体吸进来，
// 与 lib.rs 的 `use 本模块::*;` 形成回环，也让依赖关系变得不可见。
use crate::{
    read_kv, write_kv, EmptyFallback, KNOWLEDGE_EMBEDDING_CONFIG_KEY,
    KNOWLEDGE_MULTIMODAL_CONFIG_KEY, KnowledgeCollectionAudioMultimodalConfigRecord,
    KnowledgeCollectionImageMultimodalConfigRecord, KnowledgeCollectionMultimodalConfigRecord,
    KnowledgeEmbeddingConfigRecord, KnowledgeEmbeddingModelConfigRecord,
    KnowledgeMultimodalConfigRecord, KnowledgeMultimodalModelConfigRecord,
};

pub(crate) const OPENAI_COMPATIBLE_EMBEDDING_PROVIDERS: [&str; 6] = [
    "openai",
    "openrouter",
    "moonshot",
    "siliconflow",
    "dashscope",
    "zhipu",
];

pub(crate) const DEFAULT_EMBEDDING_MODEL: &str = "text-embedding-3-small";
pub(crate) const DEFAULT_BASE_URL_FALLBACK: &str = "https://api.openai.com/v1";
pub(crate) const EMBEDDING_BATCH_SIZE: usize = 8;

pub(crate) fn provider_supports_embeddings(provider: &str) -> bool {
    OPENAI_COMPATIBLE_EMBEDDING_PROVIDERS.contains(&provider)
}

pub(crate) fn fingerprint_text(value: &str) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

impl Default for KnowledgeCollectionMultimodalConfigRecord {
    fn default() -> Self {
        Self {
            enabled: false,
            merge_mode: "append".to_string(),
            image: KnowledgeCollectionImageMultimodalConfigRecord {
                enabled: false,
                model_id: None,
                extract_text: true,
                generate_summary: true,
            },
            audio: KnowledgeCollectionAudioMultimodalConfigRecord {
                enabled: false,
                model_id: None,
                keep_transcript: true,
                generate_summary: true,
            },
        }
    }
}

pub(crate) fn default_knowledge_embedding_config() -> KnowledgeEmbeddingConfigRecord {
    KnowledgeEmbeddingConfigRecord {
        enabled: false,
        active_model_id: format!("openai:{DEFAULT_EMBEDDING_MODEL}:0"),
        models: vec![KnowledgeEmbeddingModelConfigRecord {
            id: format!("openai:{DEFAULT_EMBEDDING_MODEL}:0"),
            name: "默认向量模型".to_string(),
            provider: "openai".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            model: DEFAULT_EMBEDDING_MODEL.to_string(),
            api_key: String::new(),
        }],
    }
}

pub(crate) fn default_knowledge_multimodal_config() -> KnowledgeMultimodalConfigRecord {
    KnowledgeMultimodalConfigRecord {
        enabled: false,
        active_image_model_id: Some("image:default".to_string()),
        active_audio_model_id: Some("audio:default".to_string()),
        models: vec![
            KnowledgeMultimodalModelConfigRecord {
                id: "image:default".to_string(),
                name: "Default Image Multimodal Model".to_string(),
                capability: "image".to_string(),
                provider: "openai".to_string(),
                base_url: DEFAULT_BASE_URL_FALLBACK.to_string(),
                model: "gpt-4.1-mini".to_string(),
                api_key: String::new(),
            },
            KnowledgeMultimodalModelConfigRecord {
                id: "audio:default".to_string(),
                name: "Default Audio Multimodal Model".to_string(),
                capability: "audio".to_string(),
                provider: "openai".to_string(),
                base_url: DEFAULT_BASE_URL_FALLBACK.to_string(),
                model: "gpt-4o-mini-transcribe".to_string(),
                api_key: String::new(),
            },
        ],
    }
}

pub(crate) fn normalize_multimodal_capability(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "audio" => "audio".to_string(),
        _ => "image".to_string(),
    }
}

pub(crate) fn normalize_knowledge_embedding_config_record(
    input: KnowledgeEmbeddingConfigRecord,
) -> KnowledgeEmbeddingConfigRecord {
    let default_model_id = input
        .active_model_id
        .trim()
        .to_string()
        .if_empty_then(&format!("openai:{DEFAULT_EMBEDDING_MODEL}:0"));
    let mut seen_ids = std::collections::HashSet::new();
    let mut models = Vec::new();
    for (index, model) in input.models.into_iter().enumerate() {
        let provider = if provider_supports_embeddings(&model.provider) {
            model.provider.trim().to_string()
        } else {
            "openai".to_string()
        };
        let raw_model = model.model.trim();
        let model_value = if raw_model.is_empty() {
            DEFAULT_EMBEDDING_MODEL.to_string()
        } else {
            raw_model.to_string()
        };
        let model_name = model.name.trim().to_string();
        let model_id = if model.id.trim().is_empty() {
            format!("{provider}:{model_value}:{index}")
        } else {
            model.id.trim().to_string()
        };
        let base_url = {
            let trimmed = model.base_url.trim();
            if trimmed.is_empty() {
                DEFAULT_BASE_URL_FALLBACK.to_string()
            } else {
                trimmed.to_string()
            }
        };
        let unique_id = if seen_ids.contains(&model_id) {
            format!("{model_id}-{index}")
        } else {
            model_id
        };
        seen_ids.insert(unique_id.clone());
        models.push(KnowledgeEmbeddingModelConfigRecord {
            id: unique_id,
            name: if model_name.is_empty() {
                model_value.clone()
            } else {
                model_name
            },
            provider,
            base_url,
            model: model_value,
            api_key: model.api_key.trim().to_string(),
        });
    }

    if models.is_empty() {
        models = vec![KnowledgeEmbeddingModelConfigRecord {
            id: default_model_id.clone(),
            name: "默认向量模型".to_string(),
            provider: "openai".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            model: DEFAULT_EMBEDDING_MODEL.to_string(),
            api_key: String::new(),
        }];
    }

    let active_model_id = if models.iter().any(|model| model.id == input.active_model_id) {
        input.active_model_id
    } else {
        default_model_id.clone()
    };

    KnowledgeEmbeddingConfigRecord {
        enabled: input.enabled,
        active_model_id,
        models,
    }
}

pub(crate) fn normalize_knowledge_multimodal_config_record(
    input: KnowledgeMultimodalConfigRecord,
) -> KnowledgeMultimodalConfigRecord {
    let default = default_knowledge_multimodal_config();
    let mut seen_ids = std::collections::HashSet::new();
    let mut models = Vec::new();

    for (index, model) in input.models.into_iter().enumerate() {
        let capability = normalize_multimodal_capability(&model.capability);
        let provider = if provider_supports_embeddings(&model.provider) {
            model.provider.trim().to_string()
        } else {
            "openai".to_string()
        };
        let model_value = model
            .model
            .trim()
            .to_string()
            .if_empty_then(match capability.as_str() {
                "audio" => "gpt-4o-mini-transcribe",
                _ => "gpt-4.1-mini",
            });
        let model_id = model
            .id
            .trim()
            .to_string()
            .if_empty_then(&format!("{capability}:{model_value}:{index}"));
        let unique_id = if seen_ids.contains(&model_id) {
            format!("{model_id}-{index}")
        } else {
            model_id
        };
        seen_ids.insert(unique_id.clone());
        models.push(KnowledgeMultimodalModelConfigRecord {
            id: unique_id,
            name: model.name.trim().to_string().if_empty_then(&model_value),
            capability,
            provider,
            base_url: model
                .base_url
                .trim()
                .to_string()
                .if_empty_then(DEFAULT_BASE_URL_FALLBACK),
            model: model_value,
            api_key: model.api_key.trim().to_string(),
        });
    }

    if models.is_empty() {
        models = default.models;
    }

    let active_image_model_id = input
        .active_image_model_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .filter(|id| {
            models
                .iter()
                .any(|model| model.capability == "image" && model.id == *id)
        })
        .or_else(|| {
            models
                .iter()
                .find(|model| model.capability == "image")
                .map(|model| model.id.clone())
        });
    let active_audio_model_id = input
        .active_audio_model_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .filter(|id| {
            models
                .iter()
                .any(|model| model.capability == "audio" && model.id == *id)
        })
        .or_else(|| {
            models
                .iter()
                .find(|model| model.capability == "audio")
                .map(|model| model.id.clone())
        });

    KnowledgeMultimodalConfigRecord {
        enabled: input.enabled,
        active_image_model_id,
        active_audio_model_id,
        models,
    }
}

pub(crate) fn normalize_collection_multimodal_flag_model(model_id: Option<String>) -> Option<String> {
    model_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(crate) fn normalize_knowledge_collection_multimodal_config_record(
    input: KnowledgeCollectionMultimodalConfigRecord,
) -> KnowledgeCollectionMultimodalConfigRecord {
    let default = KnowledgeCollectionMultimodalConfigRecord::default();
    KnowledgeCollectionMultimodalConfigRecord {
        enabled: input.enabled,
        merge_mode: match input.merge_mode.trim().to_lowercase().as_str() {
            "append" => "append".to_string(),
            _ => default.merge_mode,
        },
        image: KnowledgeCollectionImageMultimodalConfigRecord {
            enabled: input.image.enabled,
            model_id: normalize_collection_multimodal_flag_model(input.image.model_id),
            extract_text: input.image.extract_text,
            generate_summary: input.image.generate_summary,
        },
        audio: KnowledgeCollectionAudioMultimodalConfigRecord {
            enabled: input.audio.enabled,
            model_id: normalize_collection_multimodal_flag_model(input.audio.model_id),
            keep_transcript: input.audio.keep_transcript,
            generate_summary: input.audio.generate_summary,
        },
    }
}

pub(crate) fn normalize_collection_multimodal_config_json_for_storage(
    raw: Option<String>,
) -> Result<Option<String>, String> {
    let Some(value) = raw.map(|item| item.trim().to_string()) else {
        return Ok(None);
    };
    if value.is_empty() {
        return Ok(None);
    }

    let parsed = serde_json::from_str::<KnowledgeCollectionMultimodalConfigRecord>(&value)
        .map_err(|err| err.to_string())?;
    let normalized = normalize_knowledge_collection_multimodal_config_record(parsed);
    serde_json::to_string(&normalized)
        .map(Some)
        .map_err(|err| err.to_string())
}

pub(crate) fn parse_knowledge_collection_multimodal_config_json(
    raw: Option<&str>,
) -> KnowledgeCollectionMultimodalConfigRecord {
    raw.and_then(|value| {
        serde_json::from_str::<KnowledgeCollectionMultimodalConfigRecord>(value).ok()
    })
    .map(normalize_knowledge_collection_multimodal_config_record)
    .unwrap_or_default()
}

pub(crate) fn load_knowledge_embedding_config(
    connection: &Connection,
) -> Result<KnowledgeEmbeddingConfigRecord, String> {
    let raw = read_kv(connection, KNOWLEDGE_EMBEDDING_CONFIG_KEY)?;
    match raw {
        Some(value) => match serde_json::from_str::<KnowledgeEmbeddingConfigRecord>(&value) {
            Ok(parsed) => Ok(normalize_knowledge_embedding_config_record(parsed)),
            Err(_) => load_legacy_knowledge_embedding_config(connection)
                .map(|value| value.unwrap_or_else(default_knowledge_embedding_config)),
        },
        None => Ok(default_knowledge_embedding_config()),
    }
}

pub(crate) fn load_knowledge_multimodal_config(
    connection: &Connection,
) -> Result<KnowledgeMultimodalConfigRecord, String> {
    let raw = read_kv(connection, KNOWLEDGE_MULTIMODAL_CONFIG_KEY)?;
    match raw {
        Some(value) => serde_json::from_str::<KnowledgeMultimodalConfigRecord>(&value)
            .map(normalize_knowledge_multimodal_config_record)
            .map_err(|err| err.to_string()),
        None => Ok(default_knowledge_multimodal_config()),
    }
}

pub(crate) fn save_knowledge_multimodal_config(
    connection: &Connection,
    config: KnowledgeMultimodalConfigRecord,
) -> Result<KnowledgeMultimodalConfigRecord, String> {
    let normalized = normalize_knowledge_multimodal_config_record(config);
    let json = serde_json::to_string(&normalized).map_err(|err| err.to_string())?;
    write_kv(connection, KNOWLEDGE_MULTIMODAL_CONFIG_KEY, &json)?;
    Ok(normalized)
}

pub(crate) fn load_knowledge_collection_multimodal_config(
    connection: &Connection,
    collection_id: &str,
) -> Result<KnowledgeCollectionMultimodalConfigRecord, String> {
    let raw = connection
        .query_row(
            "SELECT multimodal_config_json FROM knowledge_collections WHERE id = ?1",
            params![collection_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .flatten();
    Ok(parse_knowledge_collection_multimodal_config_json(
        raw.as_deref(),
    ))
}

pub(crate) fn is_usable_knowledge_multimodal_model(
    model: &KnowledgeMultimodalModelConfigRecord,
    capability: &str,
) -> bool {
    model.capability == capability
        && !model.api_key.trim().is_empty()
        && !model.base_url.trim().is_empty()
        && !model.model.trim().is_empty()
        && provider_supports_embeddings(&model.provider)
}

pub(crate) fn find_exact_usable_knowledge_multimodal_model(
    config: &KnowledgeMultimodalConfigRecord,
    capability: &str,
    required_model_id: &str,
) -> Option<KnowledgeMultimodalModelConfigRecord> {
    if !config.enabled {
        return None;
    }

    let capability = normalize_multimodal_capability(capability);
    let required_model_id = required_model_id.trim();
    if required_model_id.is_empty() {
        return None;
    }

    config
        .models
        .iter()
        .find(|model| {
            model.id == required_model_id
                && is_usable_knowledge_multimodal_model(model, &capability)
        })
        .cloned()
}

pub(crate) fn validate_knowledge_multimodal_upload(
    connection: &Connection,
    collection_id: &str,
    preview_type: &str,
) -> Result<(), String> {
    let normalized_preview_type = preview_type.trim().to_lowercase();
    if normalized_preview_type == "video" {
        return Err(
            "已阻止本次上传：当前版本暂不支持视频上传到知识库，请先移除视频文件后再上传。"
                .to_string(),
        );
    }

    let capability = match normalized_preview_type.as_str() {
        "image" => "image",
        "audio" => "audio",
        _ => return Ok(()),
    };
    let label = if capability == "image" {
        "图片"
    } else {
        "音频"
    };

    let collection_config = load_knowledge_collection_multimodal_config(connection, collection_id)?;
    if !collection_config.enabled {
        return Err(format!(
            "已阻止本次上传：当前知识库未开启多模态分析，请先到知识库设置 -> 多模态中启用并配置{label}模型后再上传{label}。"
        ));
    }

    let selected_model_id = if capability == "image" {
        if !collection_config.image.enabled {
            return Err(format!(
                "已阻止本次上传：当前知识库未开启{label}多模态分析，请先到知识库设置 -> 多模态中开启并配置{label}模型后再上传{label}。"
            ));
        }
        collection_config.image.model_id.as_deref()
    } else {
        if !collection_config.audio.enabled {
            return Err(format!(
                "已阻止本次上传：当前知识库未开启{label}多模态分析，请先到知识库设置 -> 多模态中开启并配置{label}模型后再上传{label}。"
            ));
        }
        collection_config.audio.model_id.as_deref()
    };

    let selected_model_id = selected_model_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            format!(
                "已阻止本次上传：当前知识库尚未选择{label}模型，请先到知识库设置 -> 多模态中完成{label}模型配置后再上传{label}。"
            )
        })?;

    let global_config = load_knowledge_multimodal_config(connection)?;
    if find_exact_usable_knowledge_multimodal_model(&global_config, capability, selected_model_id)
        .is_none()
    {
        return Err(format!(
            "已阻止本次上传：当前知识库缺少可用的{label}多模态模型，请先到设置 -> 模型配置 -> 多模态中补充可用模型，并确认知识库设置里已选中对应{label}模型后再上传。"
        ));
    }

    Ok(())
}

pub(crate) fn load_knowledge_embedding_active_model(
    connection: &Connection,
) -> Result<
    Option<(
        KnowledgeEmbeddingConfigRecord,
        KnowledgeEmbeddingModelConfigRecord,
    )>,
    String,
> {
    let config = load_knowledge_embedding_config(connection)?;
    if !config.enabled {
        return Ok(None);
    }

    let active = config
        .models
        .iter()
        .find(|model| model.id == config.active_model_id)
        .cloned()
        .or_else(|| config.models.first().cloned())
        .filter(|model| {
            !model.api_key.trim().is_empty() && provider_supports_embeddings(&model.provider)
        });

    Ok(active.map(|model| (config, model)))
}

pub(crate) fn load_legacy_knowledge_embedding_config(
    connection: &Connection,
) -> Result<Option<KnowledgeEmbeddingConfigRecord>, String> {
    let raw = read_kv(connection, KNOWLEDGE_EMBEDDING_CONFIG_KEY)?;
    let Some(value) = raw else {
        return Ok(None);
    };

    let parsed: JsonValue = serde_json::from_str(&value).map_err(|err| err.to_string())?;
    let Some(object) = parsed.as_object() else {
        return Ok(None);
    };

    let enabled = object
        .get("enabled")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    let active_model_id = object
        .get("activeModelId")
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .to_string();
    let api_key = object
        .get("apiKey")
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .to_string();

    let models = object
        .get("models")
        .and_then(JsonValue::as_array)
        .map(|entries| {
            entries
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    let model = item.as_object();
                    let model_name = model
                        .and_then(|value| value.get("name"))
                        .and_then(JsonValue::as_str)
                        .unwrap_or("")
                        .to_string();
                    let model_provider = model
                        .and_then(|value| value.get("provider"))
                        .and_then(JsonValue::as_str)
                        .unwrap_or("openai")
                        .to_string();
                    let model_base_url = model
                        .and_then(|value| value.get("baseUrl"))
                        .and_then(JsonValue::as_str)
                        .unwrap_or("https://api.openai.com/v1")
                        .to_string();
                    let model_id = model
                        .and_then(|value| value.get("id"))
                        .and_then(JsonValue::as_str)
                        .unwrap_or("")
                        .to_string();
                    let model_value = model
                        .and_then(|value| value.get("model"))
                        .and_then(JsonValue::as_str)
                        .unwrap_or(DEFAULT_EMBEDDING_MODEL)
                        .to_string();
                    let model_api_key = model
                        .and_then(|value| value.get("apiKey"))
                        .and_then(JsonValue::as_str)
                        .unwrap_or("")
                        .to_string();

                    KnowledgeEmbeddingModelConfigRecord {
                        id: if model_id.is_empty() {
                            format!("{}:{}:{}", model_provider, model_value, index)
                        } else {
                            model_id
                        },
                        name: if model_name.is_empty() {
                            model_value.clone()
                        } else {
                            model_name
                        },
                        provider: model_provider,
                        base_url: model_base_url,
                        model: model_value,
                        api_key: if model_api_key.is_empty() {
                            api_key.clone()
                        } else {
                            model_api_key
                        },
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(Some(normalize_knowledge_embedding_config_record(
        KnowledgeEmbeddingConfigRecord {
            enabled,
            active_model_id,
            models,
        },
    )))
}
