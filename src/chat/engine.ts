import { modelRegistry } from "../adapters/registry";
import type { ChatStep, ChatToolCall, ChatToolCallResult, ChatToolParam, Message, ModelConfig } from "../adapters/types";
import { invoke } from "@tauri-apps/api/core";
import { getUsagePreferences, loadPersonaConfig } from "./storage";
import type { ChatExecutionResult } from "./types";
import { buildKnowledgeContextBlock } from "./knowledgeContext";
import { buildOmniSystemPrompt } from "./promptModules";
import { parseOmniStructuredOutput } from "./structuredOutput";
import { getModelPricing } from "../adapters/modelCatalog";
import type { ProjectMemoryRecord, Project, SessionSummaryRecord } from "./types";

const DEFAULT_SYSTEM_PROMPT =
  "You are Omni, a helpful, knowledgeable AI project. Be concise and clear. Use markdown when useful.";

/** 单轮对话中模型可发起的最大工具调用轮数（防止死循环）。 */
const MAX_TOOL_ROUNDS = 6;

/** 上下文窗口占用超过该比例触发历史压缩 */
const CONTEXT_BUDGET_RATIO = 0.75;

const COMPACTION_PROMPT =
  "你是对话压缩器。把下面这段历史对话压缩成一段简洁的中文摘要，保留：用户的核心诉求、已经完成的工作、关键决策与结论、未完成事项。控制在 300 字以内，直接输出摘要正文，不要任何前缀。";

/**
 * token 估算：CJK 每字符约 1 token，其余按 4 字符 1 token。
 * （原 length/4 对中文低估约 4 倍，导致成本与压缩判断失真。）
 */
function estimateTokens(text: string) {
  const normalized = text.trim();
  if (!normalized) return 0;
  const cjk = (normalized.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const rest = normalized.length - cjk;
  return Math.max(1, Math.ceil(cjk * 1.1 + rest / 4));
}

function estimatePromptTokens(messages: Message[]) {
  return messages.reduce((total, message) => {
    const imageTokens = (message.images?.length ?? 0) * 256;
    return total + estimateTokens(message.content) + imageTokens;
  }, 0);
}

/** 成本估算：价格目录（USD/1M tokens）→ 本次调用成本；未收录返回 0（未知）。 */
function estimateCost(model: string, promptTokens: number, completionTokens: number) {
  const pricing = getModelPricing(model);
  if (!pricing) return 0;
  const input = pricing.input ?? 0;
  const output = pricing.output ?? 0;
  return (promptTokens / 1_000_000) * input + (completionTokens / 1_000_000) * output;
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

interface UsageAccumulator {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 是否全部为真实 usage（任一估算即为 false） */
  allReal: boolean;
}

function emptyUsage(): UsageAccumulator {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, allReal: true };
}

function accumulateUsage(acc: UsageAccumulator, usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined, estimatedFor: { promptTokens: number; completionTokens: number }) {
  if (usage) {
    acc.promptTokens += usage.promptTokens;
    acc.completionTokens += usage.completionTokens;
    acc.totalTokens += usage.totalTokens;
  } else {
    acc.promptTokens += estimatedFor.promptTokens;
    acc.completionTokens += estimatedFor.completionTokens;
    acc.totalTokens += estimatedFor.promptTokens + estimatedFor.completionTokens;
    acc.allReal = false;
  }
}

/**
 * 上下文预算压缩：当请求超窗口预算时，把最旧的对话压缩成一条摘要。
 * 摘要在独立的一次小请求里生成（非流式），失败则丢弃最旧轮次兜底。
 */
async function compactHistoryIfNeeded(options: {
  model: string;
  requestMessages: Message[];
  modelConfig?: ModelConfig;
  signal?: AbortSignal;
}): Promise<Message[]> {
  const { model, requestMessages, modelConfig, signal } = options;
  const contextWindow = modelConfig?.maxTokens ?? 128000;
  const budget = Math.floor(contextWindow * CONTEXT_BUDGET_RATIO);
  const estimated = estimatePromptTokens(requestMessages);

  if (estimated <= budget) {
    return requestMessages;
  }

  // 找出可压缩区间：跳过 system/knowledge（前部）与最后一条 user 消息
  const compactableStart = requestMessages.findIndex((m) => m.role !== "system");
  if (compactableStart < 0) return requestMessages;
  const latestUserIdx = [...requestMessages].reverse().findIndex((m) => m.role === "user");
  if (latestUserIdx < 0) return requestMessages;
  const compactableEnd = requestMessages.length - 1 - latestUserIdx;

  const slice = requestMessages.slice(compactableStart, compactableEnd);
  if (slice.length < 2) {
    // 没有可压缩的历史，直接返回（由模型侧尽力而为）
    return requestMessages;
  }

  // 只压缩最旧的 60%，保留近端细节
  const sliceBudget = Math.floor(slice.length * 0.6);
  const compactSlice = slice.slice(0, Math.max(2, sliceBudget));
  const retained = requestMessages.slice(compactableStart + compactSlice.length);

  try {
    const response = await modelRegistry.chat({
      model,
      messages: [{ role: "system", content: COMPACTION_PROMPT }, ...compactSlice],
      maxTokens: 600,
      stream: false,
      signal,
      temperature: 0.2,
    });
    const summary = response.content.trim();
    if (summary && summary.length > 20) {
      // 保留前部 system/knowledge 消息 + 摘要 + 近端保留消息
      const leading = requestMessages.slice(0, compactableStart);
      return [...leading, { role: "assistant" as const, content: `【历史对话摘要】${summary}` }, ...retained];
    }
  } catch {
    // 压缩失败：走丢弃兜底
  }

  // 兜底：丢掉最旧一轮对话（保留 system/knowledge 与近端）
  const leading = requestMessages.slice(0, compactableStart);
  return [...leading, ...requestMessages.slice(compactableStart + 2)];
}

/**
 * 工具调用循环：流式发起（文本实时回显），模型发起 tool_calls → 并行执行 →
 * 结果回填 → 再次流式请求，直到给出最终回复或轮数耗尽。
 * 轮数耗尽不报错：追加一条「总结当前进度」的最终请求降级收尾。
 */
async function runToolLoop(options: {
  model: string;
  requestMessages: Message[];
  temperature?: number;
  maxTokens?: number;
  tools: ChatToolParam[];
  signal?: AbortSignal;
  modelConfig?: ModelConfig;
  onChunk?: (chunk: string) => void;
  onReasoning?: (reasoning: string) => void;
  executeToolCall: (toolCall: ChatToolCall) => Promise<string>;
}): Promise<{
  content: string;
  model: string;
  usage: UsageAccumulator;
  toolRounds: number;
  reasoning: string;
  toolCallResults: ChatToolCallResult[];
  steps: ChatStep[];
}> {
  const { model, requestMessages, temperature, maxTokens, tools, signal, modelConfig, onChunk, onReasoning, executeToolCall } = options;
  let workingMessages = [...requestMessages];
  const usage = emptyUsage();
  let reasoning = "";
  let roundReasoning = "";
  const allToolCallResults: ChatToolCallResult[] = [];
  const steps: ChatStep[] = [];
  const canStream = modelConfig?.supportsStreaming !== false;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (signal?.aborted) {
      throw new DOMException("Request aborted", "AbortError");
    }

    let response;
    if (canStream) {
      response = await modelRegistry.chatStream(
        {
          messages: workingMessages,
          model,
          temperature,
          maxTokens,
          stream: true,
          tools,
          signal,
        },
        (chunk) => {
          if (signal?.aborted) return;
          if (chunk.reasoning) {
            reasoning += chunk.reasoning;
            roundReasoning += chunk.reasoning;
            onReasoning?.(chunk.reasoning);
          }
          if (chunk.content) {
            onChunk?.(chunk.content);
          }
        }
      );
    } else {
      response = await modelRegistry.chat({
        messages: workingMessages,
        model,
        temperature,
        maxTokens,
        stream: false,
        tools,
        signal,
      });
      // 非流式响应：把模型一次性返回的 reasoning 文本累加到本轮 reasoning（与流式分支语义对齐）
      if (response.reasoning) {
        reasoning += response.reasoning;
        roundReasoning += response.reasoning;
        onReasoning?.(response.reasoning);
      }
      if (response.content) {
        onChunk?.(response.content);
      }
    }

    accumulateUsage(usage, response.usage, {
      promptTokens: estimatePromptTokens(workingMessages),
      completionTokens: estimateTokens(response.content ?? ""),
    });

    if (!response.toolCalls || response.toolCalls.length === 0) {
      if (roundReasoning.trim()) {
        steps.push({ type: "reasoning", text: roundReasoning });
        roundReasoning = "";
      }
      return { content: response.content ?? "", model: response.model, usage, toolRounds: round + 1, reasoning, toolCallResults: allToolCallResults, steps };
    }

    // 本轮 reasoning 增量 → step（本轮 reasoning 在工具调用之前发生）
    if (roundReasoning.trim()) {
      steps.push({ type: "reasoning", text: roundReasoning });
      roundReasoning = "";
    }

    const assistantMsg: Message = {
      role: "assistant",
      content: response.content ?? "",
      toolCalls: response.toolCalls,
    };
    // 并行执行本轮全部工具调用（保持结果顺序与 tool_calls 一致）
    const results = await Promise.all(
      response.toolCalls.map(async (toolCall) => {
        try {
          return await executeToolCall(toolCall);
        } catch (error) {
          return `工具执行失败：${error instanceof Error ? error.message : String(error)}`;
        }
      })
    );
    // 记录本轮全部 tool_call 结果（按时间/调用顺序追加），供 UI 思考块渲染步骤
    response.toolCalls.forEach((toolCall, index) => {
      const result = results[index];
      allToolCallResults.push({
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
        result,
        isError: result.startsWith("工具执行失败"),
        round,
      });
      // steps 流：本轮工具调用按执行顺序追加
      steps.push({
        type: "tool_call",
        name: toolCall.name,
        arguments: toolCall.arguments,
        result,
        isError: result.startsWith("工具执行失败"),
      });
    });
    const toolMessages: Message[] = response.toolCalls.map((toolCall, index) => ({
      role: "tool",
      content: results[index],
      toolCallId: toolCall.id,
      toolCallName: toolCall.name,
    }));
    workingMessages = [...workingMessages, assistantMsg, ...toolMessages];
  }

  // 轮数耗尽：降级为「总结进度」的最终请求（不再给工具，避免继续循环）
  const degradeMessages: Message[] = [
    ...workingMessages,
    { role: "user", content: "工具调用轮数已达上限。请基于目前已完成的步骤，直接给出当前进度与结果总结，不要再调用任何工具。" },
  ];
  const response = await modelRegistry.chat({
    messages: degradeMessages,
    model,
    temperature,
    maxTokens,
    stream: false,
    signal,
  });
  accumulateUsage(usage, response.usage, {
    promptTokens: estimatePromptTokens(degradeMessages),
    completionTokens: estimateTokens(response.content ?? ""),
  });
  return { content: response.content ?? "", model: response.model, usage, toolRounds: MAX_TOOL_ROUNDS, reasoning, toolCallResults: allToolCallResults, steps };
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
  onReasoning?: (reasoning: string) => void;
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
    onReasoning,
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
  let requestMessages: Message[] = [systemMessage, ...knowledgeMessages, ...messages];

  // 上下文预算：超窗压缩（不重复压缩，一次足够）
  if (requestMessages.length > 4) {
    requestMessages = await compactHistoryIfNeeded({ model, requestMessages, modelConfig, signal });
  }

  const hasTools = Boolean(tools?.length && executeToolCall && modelConfig?.toolCalling !== false);

  // 工具循环（function calling）：流式发起，模型可多轮调用工具。
  if (hasTools) {
    const toolResult = await runToolLoop({
      model,
      requestMessages,
      temperature: preferences.temperature,
      maxTokens: preferences.maxOutputTokens,
      tools: tools!,
      signal,
      modelConfig,
      onChunk,
      onReasoning,
      executeToolCall: executeToolCall!,
    });

    if (signal?.aborted) {
      throw new DOMException("Request aborted", "AbortError");
    }
    const parsed = parseOmniStructuredOutput(toolResult.content);
    return {
      content: parsed.content,
      model: toolResult.model,
      usage: toolResult.usage,
      estimated: !toolResult.usage.allReal,
      costUsd: estimateCost(model, toolResult.usage.promptTokens, toolResult.usage.completionTokens),
      knowledgeContext: knowledgeContext ?? null,
      suggestedMemories: parsed.suggestedMemories,
      suggestedSummary: parsed.suggestedSummary,
      reasoning: toolResult.reasoning || undefined,
      toolRounds: toolResult.toolRounds,
      toolCallResults: toolResult.toolCallResults.length ? toolResult.toolCallResults : undefined,
      steps: toolResult.steps.length ? toolResult.steps : undefined,
    };
  }

  const shouldStream = Boolean(modelConfig?.supportsStreaming && preferences.enableStreaming && onChunk);

  if (shouldStream) {
    let streamedContent = "";
    let reasoning = "";
    const response = await modelRegistry.chatStream(
      {
        messages: requestMessages,
        model,
        temperature: preferences.temperature,
        maxTokens: preferences.maxOutputTokens,
        stream: true,
        signal,
      },
      (chunk) => {
        if (signal?.aborted) {
          return;
        }
        if (chunk.done) return;
        if (chunk.reasoning) {
          reasoning += chunk.reasoning;
          onReasoning?.(chunk.reasoning);
        }
        if (chunk.content) {
          streamedContent += chunk.content;
          onChunk?.(chunk.content);
        }
      }
    );

    if (signal?.aborted) {
      throw new DOMException("Request aborted", "AbortError");
    }

    const parsed = parseOmniStructuredOutput(streamedContent || response.content);
    const estimated = { promptTokens: estimatePromptTokens(requestMessages), completionTokens: estimateTokens(parsed.content) };
    return {
      content: parsed.content,
      model: response.model,
      usage: {
        promptTokens: response.usage?.promptTokens ?? estimated.promptTokens,
        completionTokens: response.usage?.completionTokens ?? estimated.completionTokens,
        totalTokens: response.usage?.totalTokens ?? estimated.promptTokens + estimated.completionTokens,
      },
      estimated: !response.usage,
      costUsd: estimateCost(model, response.usage?.promptTokens ?? estimated.promptTokens, response.usage?.completionTokens ?? estimated.completionTokens),
      knowledgeContext: knowledgeContext ?? null,
      suggestedMemories: parsed.suggestedMemories,
      suggestedSummary: parsed.suggestedSummary,
      reasoning: reasoning || undefined,
    };
  }

  const response = await modelRegistry.chat({
    messages: requestMessages,
    model,
    temperature: preferences.temperature,
    maxTokens: preferences.maxOutputTokens,
    stream: false,
    signal,
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
    reasoning: response.reasoning || undefined,
  };
}
