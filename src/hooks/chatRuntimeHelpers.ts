import { emit, emitTo } from "@tauri-apps/api/event";
import { getToolManifestById } from "../config/manifests/tools";
import type { Message } from "../adapters/types";
import type { Project } from "../chat/types";
import type { PetThoughtState } from "../app/types";

export type SessionLite = {
  id: string;
  projectId?: string;
  title: string;
  messages: Message[];
};

export function resolveEnabledToolNames(project: Project | null) {
  if (!project) {
    return { toolNames: [], toolDescriptions: {} };
  }
  const toolNames: string[] = [];
  const toolDescriptions: Record<string, string> = {};
  for (const toolId of new Set(project.allowedToolIds)) {
    const manifest = getToolManifestById(toolId);
    if (!manifest?.title) continue;
    toolNames.push(manifest.title);
    // 仿 deepseek「插件自带指令」：优先使用 manifest 的声明式提示贡献。
    const contribution = manifest.promptContribution ?? manifest.description;
    if (contribution) {
      toolDescriptions[manifest.title] = contribution;
    }
  }
  return { toolNames, toolDescriptions };
}

export const SILENT_LOCAL_TOOL_IDS = new Set([
  "model",
  "pet",
]);

export const PET_THOUGHT_QUEUE_LIMIT = 12;
export const PET_THOUGHT_DISMISS_DELAY_MS = 900;

export type PetThoughtSyncRequestPayload = {
  requesterLabel?: string;
  requestId?: string;
};

export type PetThoughtSyncResponsePayload = {
  requestId?: string;
  queue: PetThoughtState[];
  currentThought: PetThoughtState | null;
};

export function createPreviewThrottler(intervalMs: number, update: () => void) {
  let lastUpdateAt = 0;
  return (force = false) => {
    const now = performance.now();
    if (!force && now - lastUpdateAt < intervalMs) {
      return;
    }
    lastUpdateAt = now;
    update();
  };
}

export function canUseTauriEvents() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function safelyEmitPetThoughtEvent(event: string, payload: unknown) {
  if (!canUseTauriEvents()) {
    return;
  }

  try {
    void emit(event, payload).catch(() => undefined);
  } catch {
    // Pet bubble sync must never interrupt the model response stream.
  }
}

export function safelyEmitPetThoughtEventTo(windowLabel: string, event: string, payload: unknown) {
  if (!canUseTauriEvents()) {
    return;
  }

  try {
    void emitTo(windowLabel, event, payload).catch(() => undefined);
  } catch {
    // A missing/closing auxiliary window should not affect chat execution.
  }
}
