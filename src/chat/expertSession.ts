import type { PluginManifest } from "../plugins/types";
import type { ChatSession } from "./types";

export type ExpertSessionBinding = NonNullable<ChatSession["expertBinding"]>;

/** 固化专家首次召唤时的配置，避免插件随后升级或删除改变既有会话行为。 */
export function createExpertSessionBinding(manifest: PluginManifest): ExpertSessionBinding | null {
  if (manifest.kind !== "expert") return null;
  return {
    id: manifest.id,
    name: manifest.name,
    ...(manifest.templatePrompt ? { templatePrompt: manifest.templatePrompt } : {}),
    ...(manifest.instruction ? { instruction: manifest.instruction } : {}),
    ...(manifest.defaultToolIds ? { defaultToolIds: [...manifest.defaultToolIds] } : {}),
    ...(manifest.defaultSkillIds ? { defaultSkillIds: [...manifest.defaultSkillIds] } : {}),
    ...(manifest.defaultMcpConnectorIds ? { defaultMcpConnectorIds: [...manifest.defaultMcpConnectorIds] } : {}),
  };
}
