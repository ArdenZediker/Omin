import type { ModelConfig } from "../adapters/types";

export function resolveAvailableModelId(
  candidateModelId: string | null | undefined,
  availableModels: ModelConfig[]
) {
  const normalized = candidateModelId?.trim() ?? "";
  if (!normalized) {
    return "";
  }

  return availableModels.some((model) => model.id === normalized) ? normalized : "";
}

export function resolveCurrentModelId(options: {
  savedModelId?: string | null;
  registryModelId?: string | null;
  availableModels: ModelConfig[];
}) {
  const savedModelId = resolveAvailableModelId(options.savedModelId, options.availableModels);
  if (savedModelId) {
    return savedModelId;
  }

  const registryModelId = resolveAvailableModelId(options.registryModelId, options.availableModels);
  if (registryModelId) {
    return registryModelId;
  }

  return options.availableModels[0]?.id ?? "";
}

export function resolveExecutionModelId(options: {
  assistantModelId?: string | null;
  currentModelId?: string | null;
  availableModels: ModelConfig[];
}) {
  const assistantModelId = resolveAvailableModelId(options.assistantModelId, options.availableModels);
  if (assistantModelId) {
    return assistantModelId;
  }

  const currentModelId = resolveAvailableModelId(options.currentModelId, options.availableModels);
  if (currentModelId) {
    return currentModelId;
  }

  return options.availableModels[0]?.id ?? "";
}
