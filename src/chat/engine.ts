import { modelRegistry } from "../adapters/registry";
import { pluginRegistry } from "../plugins/registry";
import { getToolManifestById } from "../config/manifests/tools";
import type { ChatStep, ChatToolCall, ChatToolCallResult, ChatToolParam, Message, ModelConfig, ChatOptions } from "../adapters/types";
import { defaultChatOptions, resolveContextWindow } from "../adapters/chatOptions";
import type { FileDiff } from "./fileDiff";
import { invoke } from "@tauri-apps/api/core";
import { getUsagePreferences, loadPersonaConfig } from "./storage";
import type { ChatExecutionResult } from "./types";
import { buildKnowledgeContextBlock } from "./knowledgeContext";
import { buildOmniSystemPrompt } from "./promptModules";
import { parseOmniStructuredOutput } from "./structuredOutput";
import { getModelPricing } from "../adapters/modelCatalog";
import type { ProjectMemoryRecord, Project, SessionSummaryRecord } from "./types";
import { estimateTokens, estimatePromptTokens } from "./tokenEstimator";

const DEFAULT_SYSTEM_PROMPT =
  "You are Omni, a helpful, knowledgeable AI project. Be concise and clear. Use markdown when useful.";

/** 单轮对话中模型可发起的最大工具调用轮数（防止死循环）。 */
const MAX_TOOL_ROUNDS = 6;

/**
 * 工具调用的增强执行结果：除回填给模型的文本外，还可携带本次执行落库产物的引用。
 * 引擎收到 artifact 时会在对应 tool_call step 之后追加 `artifact` step（实时推送 + 持久化），
 * 时间线即可渲染可点击跳转产物面板的迷你卡片。
 */
export interface ToolCallOutcome {
  outputText: string;
  artifact?: { artifactId: string; title: string };
  /** 本次执行最终产出/修改的文件绝对路径（写文件类工具回填，供变更面板显示真实文件名） */
  path?: string;
  /** 文件写入类工具产生的差异（随结果透传，供变更面板 before/after 对比） */
  fileDiff?: FileDiff;
  /** 工具内部产生的额外模型用量（子 Agent 委派回填，并入父循环用量统计） */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number; estimated?: boolean };
  /** 工具内部消耗的额外工具轮数（子 Agent 委派回填，并入会话「N 轮工具」统计） */
  toolRounds?: number;
}

/** 上下文窗口占用超过该比例触发历史压缩 */
const CONTEXT_BUDGET_RATIO = 0.75;

const COMPACTION_PROMPT =
  "你是对话压缩器。把下面这段历史对话压缩成一段简洁的中文摘要，保留：用户的核心诉求、已经完成的工作、关键决策与结论、未完成事项。控制在 300 字以内，直接输出摘要正文，不要任何前缀。";

/** 工具结果超过该字符数则就地截断（model-free 剪枝），保留头部 + 截断注记。
 * 吸收 DSH 的 toolResultPruner：在 LLM 摘要前先压工具输出——即使摘要失败，
 * 上下文里的工具结果也已缩短，等于直接减小本请求的 token 占用。 */
const TOOL_RESULT_PRUNE_LIMIT = 2400;

/** 压缩「无收益」判定阈值（吸收 atomcode 的 committed/refused 守卫）：摘要相对被压缩原文的
 * token 比例超过该值时，说明付了一次完整 LLM 调用却只换来几乎等长的摘要，不如直接丢最旧一轮。 */
const COMPACTION_NO_GAIN_RATIO = 0.85;

/**
 * model-free 截断过长的工具结果消息（role:"tool"），保留头部 + 截断注记。
 * 不动 toolCallId/toolCallName；非工具消息或不足上限的原文原样返回。
 */
export function pruneToolResultMessages(messages: Message[]): Message[] {
  let changed = false;
  const pruned = messages.map((message) => {
    if (message.role !== "tool" || !message.content || message.content.length <= TOOL_RESULT_PRUNE_LIMIT) {
      return message;
    }
    changed = true;
    return {
      ...message,
      content:
        message.content.slice(0, TOOL_RESULT_PRUNE_LIMIT) +
        `\n…[工具结果已截断，原 ${message.content.length} 字符，保留前 ${TOOL_RESULT_PRUNE_LIMIT} 字符]`,
    };
  });
  return changed ? pruned : messages;
}

/** 压缩是否「无收益」：摘要 token 接近被压缩原文 token（超过比例阈值）即视为无收益。 */
export function isCompactionNoGain(summary: string, originalSliceTokens: number): boolean {
  if (originalSliceTokens <= 0) return false;
  return estimateTokens(summary) >= originalSliceTokens * COMPACTION_NO_GAIN_RATIO;
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
 * 单次压缩：当请求超窗口预算时，把最旧的对话压缩成一条摘要（或摘要失败/无收益时丢最旧一轮）。
 * 纯函数式，不改传入数组。多次压缩与「压一次仍超预算」的溢出重试由 `compactHistoryIfNeeded` 循环驱动。
 */
async function compactOnce(options: {
  model: string;
  requestMessages: Message[];
  modelConfig?: ModelConfig;
  signal?: AbortSignal;
}): Promise<{ messages: Message[]; compaction?: { removedCount: number; fallback: boolean } }> {
  const { model, requestMessages, modelConfig, signal } = options;
  const contextWindow = resolveContextWindow(modelConfig);
  const budget = Math.floor(contextWindow * CONTEXT_BUDGET_RATIO);
  const estimated = estimatePromptTokens(requestMessages);

  if (estimated <= budget) {
    return { messages: requestMessages };
  }

  // 找出可压缩区间：跳过 system/knowledge（前部）与最后一条 user 消息
  const compactableStart = requestMessages.findIndex((m) => m.role !== "system");
  if (compactableStart < 0) return { messages: requestMessages };
  const latestUserIdx = [...requestMessages].reverse().findIndex((m) => m.role === "user");
  if (latestUserIdx < 0) return { messages: requestMessages };
  const compactableEnd = requestMessages.length - 1 - latestUserIdx;

  const slice = requestMessages.slice(compactableStart, compactableEnd);
  if (slice.length < 2) {
    // 没有可压缩的历史，直接返回（由模型侧尽力而为）
    return { messages: requestMessages };
  }

  // 只压缩最旧的 60%，保留近端细节（sacred_floor：system/最近 user 永压）
  const sliceBudget = Math.floor(slice.length * 0.6);
  const compactSlice = slice.slice(0, Math.max(2, sliceBudget));
  const leading = requestMessages.slice(0, compactableStart);
  // 摘要前先 model-free 剪枝工具结果（吸 DSH toolResultPruner）：减小摘要请求体量，
  // 且即使摘要失败，retained 里的工具输出也已缩短，直接降低本请求上下文占用。
  const prunedSlice = pruneToolResultMessages(compactSlice);
  const prunedRetained = pruneToolResultMessages(requestMessages.slice(compactableStart + compactSlice.length));
  const droppedOldest = pruneToolResultMessages(requestMessages.slice(compactableStart + 2));

  try {
    const response = await modelRegistry.chat({
      model,
      messages: [{ role: "system", content: COMPACTION_PROMPT }, ...prunedSlice],
      stream: false,
      signal,
      options: { maxTokens: 600, temperature: 0.2 },
    });
    const summary = response.content.trim();
    if (summary && summary.length > 20) {
      // 无收益守卫（吸 atomcode committed/refused）：摘要几乎与原文等长则放弃摘要压缩，
      // 回退丢最旧一轮而非插入一条等长摘要反而徒增一次 LLM 调用。
      if (isCompactionNoGain(summary, estimatePromptTokens(compactSlice))) {
        return { messages: [...leading, ...droppedOldest], compaction: { removedCount: 2, fallback: true } };
      }
      // 保留前部 system/knowledge 消息 + 摘要 + 近端保留消息（工具结果已剪枝）
      return {
        messages: [...leading, { role: "assistant" as const, content: `【历史对话摘要】${summary}` }, ...prunedRetained],
        compaction: { removedCount: compactSlice.length, fallback: false },
      };
    }
  } catch {
    // 摘要失败：走丢弃兜底
  }

  // 兜底：丢掉最旧一轮对话（保留 system/knowledge 与近端；工具结果已剪枝）
  return {
    messages: [...leading, ...droppedOldest],
    compaction: { removedCount: 2, fallback: true },
  };
}

/**
 * 上下文预算压缩（带溢出重试）：超窗时循环压缩最旧部分，直到进入预算或无可压缩区间。
 * 单次压缩见 `compactOnce`；本函数在「压一次仍超预算」的极端长对话下继续升级压缩，
 * 而非压一次就放行（避免溢出窗口导致模型侧截断/报错）。guard 防极端死循环。
 */
export async function compactHistoryIfNeeded(options: {
  model: string;
  requestMessages: Message[];
  modelConfig?: ModelConfig;
  signal?: AbortSignal;
}): Promise<{ messages: Message[]; compaction?: { removedCount: number; fallback: boolean } }> {
  let current = options.requestMessages;
  let lastCompaction: { removedCount: number; fallback: boolean } | undefined;
  for (let guard = 0; guard < 16; guard++) {
    const contextWindow = resolveContextWindow(options.modelConfig);
    const budget = Math.floor(contextWindow * CONTEXT_BUDGET_RATIO);
    if (estimatePromptTokens(current) <= budget) {
      return { messages: current, compaction: lastCompaction };
    }
    const result = await compactOnce({ ...options, requestMessages: current });
    // 无进展（消息数未减）说明已无可压缩区间，停止避免死循环
    if (result.messages.length >= current.length) {
      return { messages: result.messages, compaction: result.compaction ?? lastCompaction };
    }
    current = result.messages;
    lastCompaction = result.compaction;
  }
  return { messages: current, compaction: lastCompaction };
}

/** 工具是否声明了并行安全（concurrencySafe 契约）：MCP 与未声明工具一律视为不安全（保守默认）。 */
function isConcurrencySafeTool(name: string): boolean {
  return getToolManifestById(name)?.concurrencySafe === true;
}

/**
 * 依据 concurrencySafe 声明把同轮工具调用切分为执行块（对齐 harness 的 isConcurrencySafe 契约）：
 * 连续的安全只读调用合入同一块并行执行；任何未声明安全的调用（写入/shell/安装/子 Agent/MCP）
 * 独占一块，块间严格串行，块内 Promise.all。返回块序列，块内元素顺序与原数组一致。
 */
export function partitionToolCallsForExecution(
  toolCalls: ChatToolCall[],
  isSafe: (name: string) => boolean
): ChatToolCall[][] {
  const chunks: ChatToolCall[][] = [];
  for (const call of toolCalls) {
    const previous = chunks[chunks.length - 1]?.[0];
    if (isSafe(call.name) && previous && isSafe(previous.name)) {
      chunks[chunks.length - 1].push(call);
    } else {
      chunks.push([call]);
    }
  }
  return chunks;
}

/**
 * 工具调用循环：流式发起（文本实时回显），模型发起 tool_calls → 并行执行 →
 * 结果回填 → 再次流式请求，直到给出最终回复或轮数耗尽。
 * 轮数耗尽不报错：追加一条「总结当前进度」的最终请求降级收尾。
 */
async function runToolLoop(options: {
  model: string;
  requestMessages: Message[];
  /** 中性 per-call 请求旋钮（温度/上限/推理力度/工具选择），由引擎统一构造 */
  chatOptions?: ChatOptions;
  tools: ChatToolParam[];
  signal?: AbortSignal;
  modelConfig?: ModelConfig;
  onChunk?: (chunk: string) => void;
  onReasoning?: (reasoning: string) => void;
  /** 每个工具调用执行完成时回调（实时上屏 UI 的「思考过程」步骤） */
  onToolStep?: (step: ChatStep) => void;
  executeToolCall: (toolCall: ChatToolCall) => Promise<string | ToolCallOutcome>;
}): Promise<{
  content: string;
  model: string;
  usage: UsageAccumulator;
  toolRounds: number;
  reasoning: string;
  toolCallResults: ChatToolCallResult[];
  steps: ChatStep[];
}> {
  const { model, requestMessages, chatOptions, tools, signal, modelConfig, onChunk, onReasoning, onToolStep, executeToolCall } = options;
  let workingMessages = [...requestMessages];
  const usage = emptyUsage();
  let reasoning = "";
  let roundReasoning = "";
  const allToolCallResults: ChatToolCallResult[] = [];
  const steps: ChatStep[] = [];
  // 工具内部消耗的额外工具轮数（子 Agent 委派回填，跨轮累计）
  let extraToolRounds = 0;
  const canStream = modelConfig?.supportsStreaming !== false;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (signal?.aborted) {
      throw new DOMException("Request aborted", "AbortError");
    }

    let response;
    /** 本轮模型 content 缓冲区。当本轮存在 tool_calls 时，先把 content 攒下来，
     * 等本批工具全部执行完成后再一次性输出，避免用户看到「工具还在转，正文已经出来」的错乱顺序。 */
    let roundContentBuffer = "";
    if (canStream) {
      response = await modelRegistry.chatStream(
        {
          messages: workingMessages,
          model,
          stream: true,
          tools,
          signal,
          options: chatOptions,
        },
        (chunk) => {
          if (signal?.aborted) return;
          if (chunk.reasoning) {
            reasoning += chunk.reasoning;
            roundReasoning += chunk.reasoning;
            onReasoning?.(chunk.reasoning);
          }
          if (chunk.content) {
            roundContentBuffer += chunk.content;
          }
        }
      );
    } else {
      response = await modelRegistry.chat({
        messages: workingMessages,
        model,
        stream: false,
        tools,
        signal,
        options: chatOptions,
      });
      // 非流式响应：把模型一次性返回的 reasoning 文本累加到本轮 reasoning（与流式分支语义对齐）
      if (response.reasoning) {
        reasoning += response.reasoning;
        roundReasoning += response.reasoning;
        onReasoning?.(response.reasoning);
      }
      if (response.content) {
        roundContentBuffer += response.content;
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
      if (roundContentBuffer) {
        onChunk?.(roundContentBuffer);
      }
      return { content: roundContentBuffer || response.content || "", model: response.model, usage, toolRounds: round + 1 + extraToolRounds, reasoning, toolCallResults: allToolCallResults, steps };
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
    // 实时上屏：本轮全部工具调用并行开始，先推送 running 过渡态（不进 steps 数组，
    // 避免瞬时状态被持久化；完成后由运行时把同工具同参数的 running 步骤原地升级为结果行）。
    for (const toolCall of response.toolCalls) {
      onToolStep?.({ type: "tool_call", name: toolCall.name, arguments: toolCall.arguments, result: "", status: "running" });
    }

    // 并行执行本轮工具调用（concurrencySafe 契约：连续只读调用同块并行，
    // 写类/shell/子 Agent 独占执行、与其余调用串行），结果顺序与 tool_calls 一致。
    const executionChunks = partitionToolCallsForExecution(response.toolCalls, isConcurrencySafeTool);
    const outcomes = new Array<{ text: string; artifact?: ToolCallOutcome["artifact"]; path?: string; fileDiff?: FileDiff; usage?: ToolCallOutcome["usage"]; toolRounds?: number }>(response.toolCalls.length);
    let chunkCursor = 0;
    for (const chunk of executionChunks) {
      const settled = await Promise.all(
        chunk.map(async (toolCall): Promise<{ text: string; artifact?: ToolCallOutcome["artifact"]; path?: string; fileDiff?: FileDiff; usage?: ToolCallOutcome["usage"]; toolRounds?: number }> => {
          try {
            const raw = await executeToolCall(toolCall);
            if (typeof raw === "string") {
              return { text: raw };
            }
            return { text: raw.outputText, artifact: raw.artifact, path: raw.path, fileDiff: raw.fileDiff, usage: raw.usage, toolRounds: raw.toolRounds };
          } catch (error) {
            return { text: `工具执行失败：${error instanceof Error ? error.message : String(error)}` };
          }
        })
      );
      settled.forEach((outcome, index) => {
        outcomes[chunkCursor + index] = outcome;
      });
      chunkCursor += chunk.length;
    }
    // 工具内部产生的额外模型用量（子 Agent 委派）并入父循环统计：
    // token 直接累加；estimated 标记污染 allReal（会话统计的「估算」徽标随之点亮）。
    for (const outcome of outcomes) {
      if (outcome.usage) {
        usage.promptTokens += outcome.usage.promptTokens;
        usage.completionTokens += outcome.usage.completionTokens;
        usage.totalTokens += outcome.usage.totalTokens;
        if (outcome.usage.estimated) usage.allReal = false;
      }
      if (typeof outcome.toolRounds === "number") {
        extraToolRounds += outcome.toolRounds;
      }
    }
    // 记录本轮全部 tool_call 结果（按时间/调用顺序追加），供 UI 思考块渲染步骤
    response.toolCalls.forEach((toolCall, index) => {
      const outcome = outcomes[index];
      const result = outcome.text;
      const isError = result.startsWith("工具执行失败");
      const stepRecord: ChatToolCallResult = {
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
        result,
        isError,
        round,
        path: outcome.path,
        fileDiff: outcome.fileDiff,
      };
      allToolCallResults.push(stepRecord);
      // steps 流：本轮工具调用按执行顺序追加
      const step: ChatStep = {
        type: "tool_call",
        name: toolCall.name,
        arguments: toolCall.arguments,
        result,
        isError,
        path: outcome.path,
        fileDiff: outcome.fileDiff,
      };
      steps.push(step);
      // 实时上屏：每完成一个工具调用立刻通知 UI（WorkBuddy 式「边执行边看到步骤」体验）
      onToolStep?.(step);
      // 工具执行落库了交付产物 → 紧跟 tool_call 追加 artifact step（时间线渲染可点击的产物迷你卡片）
      if (outcome.artifact) {
        const artifactStep: ChatStep = {
          type: "artifact",
          artifactId: outcome.artifact.artifactId,
          title: outcome.artifact.title,
        };
        steps.push(artifactStep);
        onToolStep?.(artifactStep);
      }
    });
    // 本批工具全部执行完成，再把本轮正文一次性输出，保证正文出现在工具步骤之后。
    if (roundContentBuffer) {
      onChunk?.(roundContentBuffer);
    }
    const toolMessages: Message[] = response.toolCalls.map((toolCall, index) => ({
      role: "tool",
      content: outcomes[index].text,
      toolCallId: toolCall.id,
      toolCallName: toolCall.name,
    }));
    workingMessages = [...workingMessages, assistantMsg, ...toolMessages];

    // 步间压力预检（改造4 触发双保险·二）：工具结果回填后上下文可能再次超预算。
    // 1) 先 model-free 剪枝本轮（及历史）工具结果——直接砍掉超长工具输出，零 LLM 调用即降占用
    //    （当前轮工具结果位于「最近 user」之后，受 sacred_floor 保护无法被摘要压缩，只能走剪枝）；
    // 2) 仍存在可压缩历史（最近 user 之前 ≥2 条）时才交给 compactHistoryIfNeeded 循环再压，
    //    避免仅当前轮溢出时白白发起一次摘要 LLM 调用（溢出重试由其内部循环保障）。
    // 仅在确有剪枝/压缩时才上屏动作步骤。
    const pruned = pruneToolResultMessages(workingMessages);
    const hasCompletableHistory = (() => {
      const cs = pruned.findIndex((m) => m.role !== "system");
      if (cs < 0) return false;
      const lu = [...pruned].reverse().findIndex((m) => m.role === "user");
      if (lu < 0) return false;
      return pruned.slice(cs, pruned.length - 1 - lu).length >= 2;
    })();
    const precheck = hasCompletableHistory
      ? await compactHistoryIfNeeded({ model, requestMessages: pruned, modelConfig, signal })
      : { messages: pruned };
    if (precheck.messages.length < workingMessages.length) {
      workingMessages = precheck.messages;
      const compactionStep: ChatStep = {
        type: "action",
        label: "压缩",
        title: "Context Compaction",
        icon: "Archive",
        detail: precheck.compaction?.fallback
          ? "工具轮次间上下文再次超出预算，已丢弃最旧历史消息"
          : `工具轮次间上下文再次超出预算，已压缩 ${precheck.compaction?.removedCount ?? 0} 条最旧消息`,
      };
      steps.push(compactionStep);
      onToolStep?.(compactionStep);
    } else if (pruned !== workingMessages) {
      // 仅工具结果被剪枝（未触发摘要压缩），也上屏一条轻量动作
      workingMessages = pruned;
      const pruneStep: ChatStep = {
        type: "action",
        label: "压缩",
        title: "Context Prune",
        icon: "Archive",
        detail: "工具轮次间上下文再次超出预算，已剪枝超长工具结果",
      };
      steps.push(pruneStep);
      onToolStep?.(pruneStep);
    }
  }

  // 轮数耗尽：降级为「总结进度」的最终请求（不再给工具，避免继续循环）
  const degradeMessages: Message[] = [
    ...workingMessages,
    { role: "user", content: "工具调用轮数已达上限。请基于目前已完成的步骤，直接给出当前进度与结果总结，不要再调用任何工具。" },
  ];
  const response = await modelRegistry.chat({
    messages: degradeMessages,
    model,
    stream: false,
    signal,
    options: chatOptions,
  });
  accumulateUsage(usage, response.usage, {
    promptTokens: estimatePromptTokens(degradeMessages),
    completionTokens: estimateTokens(response.content ?? ""),
  });
  return { content: response.content ?? "", model: response.model, usage, toolRounds: MAX_TOOL_ROUNDS + extraToolRounds, reasoning, toolCallResults: allToolCallResults, steps };
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
  /** 每个工具调用执行完成时回调（实时上屏 UI 的「思考过程」步骤） */
  onToolStep?: (step: ChatStep) => void;
  knowledgeQuery?: string | null;
  knowledgeCollectionId?: string | null;
  enableKnowledgeContext?: boolean;
  enableMemoryExtraction?: boolean;
  enableSummaryExtraction?: boolean;
  enableToolProtocol?: boolean;
  /** 只注入这些 id 的技能提示（专家模式/子 Agent 按专家绑定过滤）；缺省 = 全部已启用技能 */
  enabledSkillIds?: string[];
  /** function calling：工具声明；与 executeToolCall 同时提供时启用工具循环 */
  tools?: ChatToolParam[];
  /** 执行一次模型发起的工具调用，返回结果文本（或携带落库产物引用的增强结果） */
  executeToolCall?: (toolCall: ChatToolCall) => Promise<string | ToolCallOutcome>;
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
    onToolStep,
    knowledgeQuery,
    knowledgeCollectionId,
    enableKnowledgeContext = true,
    enableMemoryExtraction = true,
    enableSummaryExtraction = true,
    enableToolProtocol = false,
    enabledSkillIds,
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
  // 中性 per-call 选项：由引擎统一构造（thinking 模型默认带 Medium 推理力度；非 thinking 零影响）
  const chatOptions = defaultChatOptions(modelConfig, {
    temperature: preferences.temperature,
    maxOutputTokens: preferences.maxOutputTokens,
  });
  const personaConfig = await loadPersonaConfig();
  const hasImages = messages.some((message) => (message.images?.length ?? 0) > 0);
  if (hasImages && (!modelConfig?.supportsVision || !preferences.enableVisionInput)) {
    throw new Error("当前模型或偏好设置不允许图片输入");
  }

  // 引擎级动作（知识检索 / 历史压缩等）：实时推送时间线 + 记入最终 steps
  const engineActions: ChatStep[] = [];
  const emitEngineAction = (step: ChatStep) => {
    engineActions.push(step);
    onToolStep?.(step);
  };

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
  if (knowledgeContext && knowledgeContext.sources.length > 0) {
    emitEngineAction({
      type: "action",
      label: "检索",
      title: "Knowledge Search",
      icon: "Search",
      detail: `「${knowledgeContext.query}」命中 ${knowledgeContext.sources.length} 条知识片段`,
    });
  }

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
    enabledSkillPrompts: pluginRegistry
      .listEnabledSkills()
      .filter((s) => !enabledSkillIds || enabledSkillIds.includes(s.id))
      .map((s) => s.systemPrompt)
      .filter((t): t is string => Boolean(t)),
  });
  const systemMessage: Message = { role: "system", content: composedSystemPrompt };
  const knowledgeMessages: Message[] = knowledgeContext
    ? [{ role: "system", content: knowledgeContext.block }]
    : [];
  let requestMessages: Message[] = [systemMessage, ...knowledgeMessages, ...messages];

  // 上下文预算：超窗压缩（不重复压缩，一次足够）
  if (requestMessages.length > 4) {
    const compacted = await compactHistoryIfNeeded({ model, requestMessages, modelConfig, signal });
    requestMessages = compacted.messages;
    if (compacted.compaction) {
      emitEngineAction({
        type: "action",
        label: "压缩",
        title: "Context Compaction",
        icon: "Archive",
        detail: compacted.compaction.fallback
          ? "上下文超出预算且摘要压缩失败，已丢弃最旧的历史消息"
          : `上下文超出预算，已把 ${compacted.compaction.removedCount} 条最旧消息压缩为摘要`,
      });
    }
  }

  const hasTools = Boolean(tools?.length && executeToolCall && modelConfig?.toolCalling !== false);

  // 工具循环（function calling）：流式发起，模型可多轮调用工具。
  if (hasTools) {
    const toolResult = await runToolLoop({
      model,
      requestMessages,
      chatOptions,
      tools: tools!,
      signal,
      modelConfig,
      onChunk,
      onReasoning,
      onToolStep,
      executeToolCall: executeToolCall!,
    });

    if (signal?.aborted) {
      throw new DOMException("Request aborted", "AbortError");
    }
    const parsed = parseOmniStructuredOutput(toolResult.content);
    const finalSteps: ChatStep[] = [...engineActions, ...toolResult.steps];
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
      steps: finalSteps.length ? finalSteps : undefined,
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
        stream: true,
        signal,
        options: chatOptions,
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
      steps: engineActions.length ? engineActions : undefined,
    };
  }

  const response = await modelRegistry.chat({
    messages: requestMessages,
    model,
    stream: false,
    signal,
    options: chatOptions,
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
    steps: engineActions.length ? engineActions : undefined,
  };
}
