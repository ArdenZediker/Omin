import type { KnowledgeCollection } from "../../chat/knowledgeTypes";
import {
  getDefaultCollectionMultimodalConfig,
  type KnowledgeCollectionMultimodalConfig,
  type KnowledgeMultimodalConfig,
} from "../../chat/knowledgeMultimodal";
import { getPreviewKindFromFile } from "./knowledgeViewHelpers";

/** 知识库设置弹窗的编辑草稿。 */
export type CollectionSettingsDraft = {
  id: string;
  name: string;
  description: string;
  retrievalMode: string;
  multimodalConfig: KnowledgeCollectionMultimodalConfig;
};

/**
 * 判断全局多模态配置里是否存在「真正可用」的模型。
 *
 * 可用 = 已启用总开关 + 能力匹配 + baseUrl / model / apiKey 三者都非空，
 * 缺任意一项都会在实际调用时失败，因此这里提前判定为不可用。
 */
export function hasUsableKnowledgeMultimodalModel(
  config: KnowledgeMultimodalConfig,
  capability: "image" | "audio",
  modelId: string,
) {
  const normalizedModelId = modelId.trim();
  if (!config.enabled || !normalizedModelId) {
    return false;
  }

  return config.models.some(
    (model) =>
      model.id === normalizedModelId &&
      model.capability === capability &&
      model.baseUrl.trim() &&
      model.model.trim() &&
      model.apiKey.trim(),
  );
}

/**
 * 把知识库级多模态配置补全为完整结构。
 *
 * 历史数据可能缺字段或为 null，统一以默认值兜底；mergeMode 目前固定为 append。
 */
export function normalizeCollectionMultimodalConfig(
  config?: KnowledgeCollection["multimodalConfig"] | null,
): KnowledgeCollectionMultimodalConfig {
  const defaults = getDefaultCollectionMultimodalConfig();
  return {
    ...defaults,
    ...config,
    image: {
      ...defaults.image,
      ...(config?.image ?? {}),
    },
    audio: {
      ...defaults.audio,
      ...(config?.audio ?? {}),
    },
    mergeMode: "append",
  };
}

/**
 * 上传前的多模态可用性拦截。
 *
 * 返回非 null 字符串表示应阻止上传并把该文案提示给用户；返回 null 表示放行。
 * 之所以在上传前拦截，是因为图片/音频进入流水线后才失败会留下一堆死信任务。
 */
export function getKnowledgeUploadBlockMessage(
  file: File,
  collection: KnowledgeCollection,
  globalMultimodalConfig: KnowledgeMultimodalConfig,
) {
  const previewKind = getPreviewKindFromFile(file);
  const collectionMultimodalConfig = normalizeCollectionMultimodalConfig(collection.multimodalConfig);

  if (previewKind === "video") {
    return "已阻止本次上传：当前版本暂不支持视频上传到知识库，请先移除视频文件后再上传。";
  }

  if (previewKind !== "image" && previewKind !== "audio") {
    return null;
  }

  const label = previewKind === "image" ? "图片" : "音频";
  const capabilityConfig =
    previewKind === "image" ? collectionMultimodalConfig.image : collectionMultimodalConfig.audio;

  if (!collectionMultimodalConfig.enabled) {
    return `已阻止本次上传：当前知识库未开启多模态分析，请先到知识库设置 -> 多模态中启用并配置${label}模型后再上传${label}。`;
  }

  if (!capabilityConfig.enabled) {
    return `已阻止本次上传：当前知识库未开启${label}多模态分析，请先到知识库设置 -> 多模态中开启并配置${label}模型后再上传${label}。`;
  }

  if (!capabilityConfig.modelId.trim()) {
    return `已阻止本次上传：当前知识库尚未选择${label}模型，请先到知识库设置 -> 多模态中完成${label}模型配置后再上传${label}。`;
  }

  if (!hasUsableKnowledgeMultimodalModel(globalMultimodalConfig, previewKind, capabilityConfig.modelId)) {
    return `已阻止本次上传：当前知识库缺少可用的${label}多模态模型，请先到设置 -> 模型配置 -> 多模态中补充可用模型，并确认知识库设置里已选中对应${label}模型后再上传。`;
  }

  return null;
}

/** 由知识库实体生成设置弹窗的初始草稿。 */
export function createCollectionSettingsDraft(collection: KnowledgeCollection): CollectionSettingsDraft {
  return {
    id: collection.id,
    name: collection.name,
    description: collection.description,
    retrievalMode: collection.retrievalMode ?? "hybrid",
    multimodalConfig: normalizeCollectionMultimodalConfig(collection.multimodalConfig),
  };
}
