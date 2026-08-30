import { invoke } from "@tauri-apps/api/core";
import type {
  DeadLetterQueryInput,
  DeadLetterQueryResult,
  KnowledgeCollection,
  KnowledgeDocumentBinaryPayload,
  KnowledgeDocumentDetail,
  KnowledgeLibraryPayload,
  KnowledgePipelineSettings,
  KnowledgeProcessingStatusSummary,
} from "../../chat/knowledgeTypes";
import type { KnowledgeCollectionMultimodalConfig } from "../../chat/knowledgeMultimodal";
import { normalizeCollectionMultimodalConfig } from "./knowledgeCollectionConfig";

/**
 * 加载整个知识库列表。
 *
 * 后端可能只回 multimodalConfigJson 字符串（老数据），这里统一解析并补全为对象；
 * JSON 损坏时退回默认配置，不让一条坏记录拖垮整个列表。
 */
export async function loadKnowledgeLibrary() {
  const payload = await invoke<
    Omit<KnowledgeLibraryPayload, "collections"> & {
      collections: Array<KnowledgeCollection & { multimodalConfigJson?: string | null }>;
    }
  >("load_knowledge_library_command");

  return {
    ...payload,
    collections: payload.collections.map((collection) => {
      const parsed =
        collection.multimodalConfig ??
        (() => {
          const raw = collection.multimodalConfigJson;
          if (!raw) {
            return null;
          }
          try {
            return normalizeCollectionMultimodalConfig(
              JSON.parse(raw) as KnowledgeCollectionMultimodalConfig,
            );
          } catch {
            return normalizeCollectionMultimodalConfig();
          }
        })();

      return {
        ...collection,
        multimodalConfig: parsed
          ? normalizeCollectionMultimodalConfig(parsed)
          : normalizeCollectionMultimodalConfig(),
      };
    }),
  };
}

/** 读取单个文档详情（含分块与处理状态）。 */
export async function loadKnowledgeDocumentDetail(documentId: string) {
  return invoke<KnowledgeDocumentDetail>("load_knowledge_document_command", {
    input: { documentId },
  });
}

/** 读取文档原始二进制（用于 PDF / DOCX / 图片预览）。 */
export async function loadKnowledgeDocumentBinary(documentId: string) {
  return invoke<KnowledgeDocumentBinaryPayload>("load_knowledge_document_file_command", {
    input: { documentId },
  });
}

/** 读取处理状态汇总；collectionId 为空表示全库统计。 */
export async function loadKnowledgeProcessingStatusSummary(collectionId?: string | null) {
  return invoke<KnowledgeProcessingStatusSummary>("load_knowledge_processing_status_summary_command", {
    collectionId: collectionId ?? null,
  });
}

/** 读取知识库流水线设置。 */
export async function loadKnowledgePipelineSettings() {
  return invoke<KnowledgePipelineSettings>("load_knowledge_pipeline_settings_command");
}

/** 保存知识库流水线设置，返回后端归一化后的结果。 */
export async function saveKnowledgePipelineSettings(settings: KnowledgePipelineSettings) {
  return invoke<KnowledgePipelineSettings>("save_knowledge_pipeline_settings_command", { settings });
}

/** 分页查询处理失败的死信任务。 */
export async function loadKnowledgeProcessingDeadLetters(input: DeadLetterQueryInput) {
  return invoke<DeadLetterQueryResult>("load_knowledge_processing_dead_letters_command", { input });
}
