import { modelRegistry } from "../adapters/registry";
import type { ChatToolCall, ChatToolParam, Message } from "../adapters/types";
import { invoke } from "@tauri-apps/api/core";
import { getUsagePreferences, loadPersonaConfig } from "./storage";
import type { ChatExecutionResult } from "./types";
import { buildKnowledgeContextBlock } from "./knowledgeContext";
import { buildOmniSystemPrompt } from "./promptModules";
import { parseOmniStructuredOutput } from "./structuredOutput";
import type { ProjectMemoryRecord, Project, SessionSummaryRecord } from "./types";

const DEFAULT_SYSTEM_PROMPT =
  "You are Omni, a helpful, knowledgeable AI project. Be concise and clear. Use markdown when useful.";

/** 单轮对话中模型可发起的最大工具调用轮数（防止死循环）。 */
const MAX_TOOL_ROUNDS = 6;

const MODEL_PRICING_USD_PER_1K: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 0.005, output: 0.015 },
  "gpt-4o-mini": { input: 0.00015, output: 0.0006 },
  "o1": { input: 0.015, output: 0.06 },
  "o3-mini": { input: 0.0011, output: 0.0044 },
  "claude-sonnet-4-20250514": { input: 0.003, output: 0.015 },
  "claude-opus-4-20250514": { input: 0.015, output: 0.075 },
  "gemini-2.5-pro": { input: 0.00125, output: 0.01 },
  "gemini-2.5-flash": { input: 0.0003, output: 0.0025 },
  "deepseek-chat": { input: 0.00027, output: 0.0011 },
  "deepseek-reasoner": { input: 0.00055, output: 0.00219 },
};

function estimateTokens(text: string) {
  const normalized = text.trim();
  if (!normalized) return 0;
  return Math.max(1, Math.ceil(normalized.length / 4));
}

function estimatePromptTokens(messages: Message[]) {
  return messages.reduce((total, message) => {
    const imageTokens = (message.images?.length ?? 0) * 256;
    return total + estimateTokens(message.content) + imageTokens;
  }, 0);
}

function estimateCost(model: string, promptTokens: number, completionTokens: number) {
  const pricing = MODEL_PRICING_USD_PER_1K[model];
  if (!pricing) return 0;
  return (promptTokens / 1000) * pricing.input + (completionTokens / 1000) * pricing.output;
}

function shouldSkipKnowledgeContext(messages: Message[]) {
  const latestUser = [...messages].reverse().find((message) => message.role === "user")?.content?.trim().toLowerCase() ?? "";
  if (!latestUser) return false;
  if (latestUser.length <= 8) {
    return true;
  }
  // Keep greeting turns lightweight and avoid pulling unrelated knowledge chunks.
  return /^(hi|hello|hey|你好|您好|在吗|在嘛|嗨|哈喽|早上好|下午好|晚上好)[!?。,.！]*$/.test(latestUser);
}

/**
 * 工具调用循环：模型发起 tool_calls → 执行 → 结果作为 tool 消息回填 → 再次请求，
 * 直到模型给出最终文本回复或超出轮数上限。全程非流式（流式 tool_calls 解析复杂且不稳定）。
 */
async function runToolLoop(options: {
  model: string;
  requestMessages: Message[];
  temperature?: number;
  maxTokens?: number;
  tools: ChatToolParam[];
  signal?: AbortSignal;
  executeToolCall: (toolCall: ChatToolCall) => Promise<string>;
}): Promise<{ content: string; model: string; roundTripMessages: Message[] }> {
  const { model, requestMessages, temperature, maxTokens, tools, signal, executeToolCall } = options;
  let workingMessages = [...requestMessages];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (signal?.aborted) {
      throw new DOMException("Request aborted", "AbortError");
    }
    const response = await modelRegistry.chat({
      messages: workingMessages,
      model,
      temperature,
      maxTokens,
      stream: false,
      tools,
    });

    if (!response.toolCalls || response.toolCalls.length === 0) {
      return {
        content: response.content ?? "",
        model: response.model,
        roundTripMessages: workingMessages,
      };
    }

    const assistantMsg: Message = {
      role: "assistant",
      content: response.content ?? "",
      toolCalls: response.toolCalls,
    };
    const toolMessages: Message[] = [];
    for (const toolCall of response.toolCalls) {
      let result: string;
      try {
        result = await executeToolCall(toolCall);
      } catch (error) {
        result = `工具执行失败：${error instanceof Error ? error.message : String(error)}`;
      }
      toolMessages.push({
        role: "tool",
        content: result,
        toolCallId: toolCall.id,
        toolCallName: toolCall.name,
      });
    }
    workingMessages = [...workingMessages, assistantMsg, ...toolMessages];
  }

  throw new Error(`工具调用轮数超过上限（${MAX_TOOL_ROUNDS} 轮），已停止`);
}

export async function executeChatTurn(options: {
  model: string;
  messages: Message[];
  signal?: AbortSignal;
  systemPrompt?: string;
  project?: Project | null;
  relatedContext?: {
    memories?: ProjectMemoryRecord[];
    summaries?: SessionSummaryRecord[];
  };
  enabledToolNames?: string[];
  enabledToolDescriptions?: Record<string, string>;
  onChunk?: (chunk: string) => void;
  knowledgeQuery?: string | null;
  knowledgeCollectionId?: string | null;
  enableKnowledgeContext?: boolean;
  enableMemoryExtraction?: boolean;
  enableSummaryExtraction?: boolean;
  enableToolProtocol?: boolean;
  /** function calling：工具声明；与 executeToolCall 同时提供时启用工具循环 */
  tools?: ChatToolParam[];
  /** 执行一次模型发起的工具调用，返回结果文本 */
  executeToolCall?: (toolCall: ChatToolCall) => Promise<string>;
}): Promise<ChatExecutionResult> {
  const {
    model,
    messages,
    signal,
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    project,
    relatedContext,
    enabledToolNames,
    enabledToolDescriptions,
    onChunk,
    knowledgeQuery,
    knowledgeCollectionId,
    enableKnowledgeContext = true,
    enableMemoryExtraction = true,
    enableSummaryExtraction = true,
    enableToolProtocol = false,
    tools,
    executeToolCall,
  } = options;

  if (signal?.aborted) {
    throw new DOMException("Request aborted", "AbortError");
  }

  const registeredProviders = modelRegistry.getRegisteredProviders();
  if (registeredProviders.length === 0) {
    throw new Error("请先配置至少一个提供方");
  }

  const adapter = modelRegistry.getAdapterForModel(model);
  if (!adapter) {
    throw new Error(`模型 "${model}" 对应的提供方尚未配置`);
  }

  const modelConfig = modelRegistry.getModelConfig(model);
  const preferences = getUsagePreferences();
  const personaConfig = await loadPersonaConfig();
  const hasImages = messages.some((message) => (message.images?.length ?? 0) > 0);
  if (hasImages && (!modelConfig?.supportsVision || !preferences.enableVisionInput)) {
    throw new Error("当前模型或偏好设置不允许图片输入");
  }

  const knowledgeContext =
    enableKnowledgeContext &&
    !shouldSkipKnowledgeContext(messages) &&
    !signal?.aborted
      ? await buildKnowledgeContextBlock({
          model,
          messages,
          knowledgeQuery,
          knowledgeCollectionId,
          signal,
        })
      : null;

  const projectAgentsMd = project?.workspacePath
    ? await invoke<string>("read_project_agents_md", { projectPath: project.workspacePath }).catch(() => "")
    : "";

  const composedSystemPrompt = buildOmniSystemPrompt({
    project,
    baseSystemPrompt: systemPrompt,
    messages,
    relatedContext,
    knowledgeContext,
    enabledToolNames,
    enabledToolDescriptions,
    includeMemoryExtraction: enableMemoryExtraction,
    includeSummaryExtraction: enableSummaryExtraction,
    includeToolProtocol: enableToolProtocol,
    persona: personaConfig,
    projectAgentsMd,
  });
  const systemMessage: Message = { role: "system", content: composedSystemPrompt };
  const knowledgeMessages: Message[] = knowledgeContext
    ? [{ role: "system", content: knowledgeContext.block }]
    : [];
  const requestMessages: Message[] = [systemMessage, ...knowledgeMessages, ...messages];

  const hasTools = Boolean(tools?.length && executeToolCall);

  // 工具循环（function calling）：全程非流式，模型可多轮发起工具调用。
  if (hasTools) {
    const toolResult = await runToolLoop({
      model,
      requestMessages,
      temperature: preferences.temperature,
      maxTokens: preferences.maxOutputTokens,
      tools: tools!,
      signal,
      executeToolCall: executeToolCall!,
    });

    if (signal?.aborted) {
      throw new DOMException("Request aborted", "AbortError");
    }
    if (onChunk) {
      onChunk(toolResult.content);
    }
    const parsed = parseOmniStructuredOutput(toolResult.content);
    const promptTokens = estimatePromptTokens(requestMessages);
    const completionTokens = estimateTokens(parsed.content);
    return {
      content: parsed.content,
      model: toolResult.model,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      estimated: true,
      costUsd: estimateCost(model, promptTokens, completionTokens),
      knowledgeContext: knowledgeContext ?? null,
      suggestedMemories: parsed.suggestedMemories,
      suggestedSummary: parsed.suggestedSummary,
    };
  }

  const shouldStream = Boolean(modelConfig?.supportsStreaming && preferences.enableStreaming && onChunk);

  if (shouldStream) {
    let streamedContent = "";
    const response = await modelRegistry.chatStream(
      {
        messages: requestMessages,
        model,
        temperature: preferences.temperature,
        maxTokens: preferences.maxOutputTokens,
        stream: true,
      },
      (chunk) => {
        if (signal?.aborted) {
          return;
        }
        if (chunk.done) return;
        streamedContent += chunk.content;
        onChunk?.(chunk.content);
      }
    );

    if (signal?.aborted) {
      throw new DOMException("Request aborted", "AbortError");
    }

    const parsed = parseOmniStructuredOutput(streamedContent || response.content);
    const promptTokens = estimatePromptTokens(requestMessages);
    const completionTokens = estimateTokens(parsed.content);
    return {
      content: parsed.content,
      model: response.model,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      estimated: true,
      costUsd: estimateCost(model, promptTokens, completionTokens),
      knowledgeContext: knowledgeContext ?? null,
      suggestedMemories: parsed.suggestedMemories,
      suggestedSummary: parsed.suggestedSummary,
    };
  }

  const response = await modelRegistry.chat({
    messages: requestMessages,
    model,
    temperature: preferences.temperature,
    maxTokens: preferences.maxOutputTokens,
    stream: false,
  });

  if (signal?.aborted) {
    throw new DOMException("Request aborted", "AbortError");
  }

  const parsed = parseOmniStructuredOutput(response.content);
  const promptTokens = response.usage?.promptTokens ?? estimatePromptTokens(requestMessages);
  const completionTokens = response.usage?.completionTokens ?? estimateTokens(parsed.content);
  return {
    content: parsed.content,
    model: response.model,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: response.usage?.totalTokens ?? promptTokens + completionTokens,
    },
    estimated: !response.usage,
    costUsd: estimateCost(model, promptTokens, completionTokens),
    knowledgeContext: knowledgeContext ?? null,
    suggestedMemories: parsed.suggestedMemories,
    suggestedSummary: parsed.suggestedSummary,
  };
}
