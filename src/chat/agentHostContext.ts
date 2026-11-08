import { invoke } from "@tauri-apps/api/core";
import type { ChatToolParam, Message } from "../adapters/types";
import type { KnowledgeContextResult } from "./knowledgeTypes";
import { buildKnowledgeContextBlock } from "./knowledgeContext";
import { buildOmniSystemPrompt } from "./promptModules";
import { assembleSkillCatalog, buildEnabledSkillPrompts } from "./skillCatalog";
import { loadPersonaConfig } from "./storage";
import type {
  ChatStep,
  Project,
  ProjectMemoryRecord,
  SessionSummaryRecord,
} from "./types";

export interface AgentHostContextOptions {
  model: string;
  messages: Message[];
  baseSystemPrompt?: string;
  project?: Project | null;
  relatedContext?: {
    memories?: ProjectMemoryRecord[];
    summaries?: SessionSummaryRecord[];
  };
  enabledToolNames?: string[];
  enabledToolDescriptions?: Record<string, string>;
  enabledSkillIds?: string[];
  knowledgeCollectionId?: string | null;
  tools?: ChatToolParam[];
  signal?: AbortSignal;
}

export interface AgentHostContext {
  system?: string;
  knowledgeContext: KnowledgeContextResult | null;
  steps: ChatStep[];
}

/**
 * Builds the same durable context that the legacy engine sends before a turn.
 * The Host owns the ReAct loop, while Omni remains the source of project
 * instructions, persona, memory, skills, and local RAG.
 */
export async function buildAgentHostContext(
  options: AgentHostContextOptions,
): Promise<AgentHostContext> {
  const signal = options.signal;
  signal?.throwIfAborted();

  const knowledgeContext = await buildKnowledgeContextBlock({
    model: options.model,
    messages: options.messages,
    knowledgeCollectionId: options.knowledgeCollectionId,
    signal,
  });
  signal?.throwIfAborted();

  const steps: ChatStep[] = [];
  if (
    knowledgeContext
    && (knowledgeContext.sources.length > 0 || knowledgeContext.documentInventory)
  ) {
    steps.push({
      type: "action",
      label: "检索",
      title: "Knowledge Search",
      icon: "Search",
      detail: knowledgeContext.documentInventory
        ? `「${knowledgeContext.query}」读取了「${knowledgeContext.documentInventory.collectionName}」文件目录，共 ${knowledgeContext.documentInventory.documents.length} 个文件`
        : `「${knowledgeContext.query}」命中 ${knowledgeContext.sources.length} 条知识片段`,
    });
  }

  const projectAgentsMd = options.project?.workspacePath
    ? await invoke<string>("read_project_agents_md", {
        projectPath: options.project.workspacePath,
      }).catch(() => "")
    : "";
  const persona = await loadPersonaConfig();
  const skillCatalog = assembleSkillCatalog({
    project: options.project,
    expertSkillIds: options.enabledSkillIds,
  });
  const arrangedPrompt = buildOmniSystemPrompt({
    project: options.project,
    baseSystemPrompt: options.baseSystemPrompt,
    messages: options.messages,
    relatedContext: options.relatedContext,
    knowledgeContext,
    enabledToolNames: options.enabledToolNames,
    enabledToolDescriptions: options.enabledToolDescriptions,
    includeMemoryExtraction: true,
    includeSummaryExtraction: true,
    includeToolProtocol: false,
    persona,
    projectAgentsMd,
    // The current native Host catalog does not expose use_skill yet, so skill
    // bodies must remain inline instead of promising an unavailable loader.
    enabledSkillPrompts: buildEnabledSkillPrompts(skillCatalog, false),
  });
  const system = [arrangedPrompt, knowledgeContext?.block]
    .filter((part): part is string => Boolean(part?.trim()))
    .join("\n\n");

  return {
    ...(system ? { system } : {}),
    knowledgeContext,
    steps,
  };
}
