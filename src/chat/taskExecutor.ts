import type { ChatToolCall, ChatToolParam, ChatImage, Message } from "../adapters/types";
import { executeChatTurn } from "./engine";
import { runTaskPlan } from "./taskRunner";
import type { ResolvedLocalSlashCommand } from "./skills";
import { resolveLocalSlashCommand } from "./skills";
import { pluginRegistry } from "../plugins/registry";
import type { TaskExecutionResult, TaskIntent, TaskPlan, TaskStep } from "./taskTypes";
import type { ProjectMemoryRecord, Project, SessionSummaryRecord, ChatStep } from "./types";
import { validateTaskOutput } from "./taskValidation";

function createTaskId() {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

type TaskStateListener = (result: TaskExecutionResult) => void | Promise<void>;

async function executeRecordedPlan(
  options: Parameters<typeof runTaskPlan>[0],
  onTaskState?: TaskStateListener,
  partialOutput?: { text: string; reasoning: string; steps: ChatStep[] },
): Promise<TaskExecutionResult> {
  const { plan } = options;
  const initial: TaskExecutionResult = {
    taskId: plan.taskId, intent: plan.intent, status: "running", plan,
    trace: [], conversationMessages: options.initialState?.conversationMessages ?? plan.sourceMessages,
  };
  try {
    await onTaskState?.(structuredClone(initial));
  } catch (error) {
    return { ...initial, status: "failed", error: `任务开始状态未保存，尚未执行：${String(error)}` };
  }
  const run = await runTaskPlan(options);
  const result: TaskExecutionResult = {
    taskId: plan.taskId, intent: plan.intent, status: run.status, plan: run.plan,
    trace: run.trace, ...run.state,
    partialText: partialOutput?.text || undefined,
    partialReasoning: partialOutput?.reasoning || undefined,
    partialSteps: partialOutput?.steps.length ? partialOutput.steps : undefined,
  };
  try {
    await onTaskState?.(structuredClone(result));
  } catch (error) {
    // 执行可能已经产生副作用；保留结果，并明确禁止把保存失败当作可重跑信号。
    result.error = `${result.error ? `${result.error}；` : ""}任务结果尚未保存：${String(error)}。请重试保存，不要重复执行已完成操作。`;
    if (result.status === "completed") result.status = "failed";
  }
  return result;
}

function summarizeGoal(messages: Message[], fallback = "执行一轮聊天任务") {
  const latestUserMessage = [...messages].reverse().find((message) => message.role === "user");
  const content = latestUserMessage?.content.trim() || fallback;
  return content.length > 80 ? `${content.slice(0, 77)}...` : content;
}

function createTaskPlan(options: {
  intent: TaskIntent;
  model: string;
  messages: Message[];
  goal?: string;
  metadata?: TaskPlan["metadata"];
}): TaskPlan {
  const { intent, model, messages, goal, metadata } = options;
  let steps: TaskStep[] = [];

  if (intent === "local_command") {
    steps = [
      { id: "plan_command", title: "解析本地命令", kind: "input", stage: "plan", status: "pending" },
      { id: "act_tool", title: "执行本地工具步骤", kind: "tool", stage: "act", status: "pending" },
      { id: "finalize_command", title: "整理命令结果", kind: "finalize", stage: "finalize", status: "pending" },
    ];
  } else if (intent === "tool_chain") {
    steps = [
      { id: "plan_chain", title: "规划组合工具任务", kind: "input", stage: "plan", status: "pending" },
      { id: "act_model", title: "调用模型总结结果", kind: "model", stage: "act", status: "pending" },
      { id: "review_output", title: "校验总结结果", kind: "review", stage: "review", status: "pending" },
      { id: "finalize_output", title: "整理链路输出", kind: "finalize", stage: "finalize", status: "pending" },
    ];
  } else {
    steps = [
      { id: "plan_input", title: "整理用户输入", kind: "input", stage: "plan", status: "pending" },
      { id: "act_model", title: "调用模型生成回复", kind: "model", stage: "act", status: "pending" },
      { id: "review_output", title: "校验模型输出结果", kind: "review", stage: "review", status: "pending" },
      { id: "finalize_output", title: "整理回复和用量统计", kind: "finalize", stage: "finalize", status: "pending" },
    ];
  }

  return {
    taskId: createTaskId(),
    intent,
    goal: goal ?? summarizeGoal(messages),
    model,
    sourceMessages: messages,
    createdAt: Date.now(),
    steps,
    metadata,
  };
}

export async function executeTask(options: {
  model: string;
  onTaskState?: TaskStateListener;
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
  /** 推理模型思考链增量回调（透传给 executeChatTurn） */
  onReasoning?: (reasoning: string) => void;
  /** 每个工具调用执行完成时回调（实时上屏 UI 的「思考过程」步骤） */
  onToolStep?: (step: ChatStep) => void;
  knowledgeCollectionId?: string | null;
  intent?: TaskIntent;
  plan?: TaskPlan;
  /** function calling：工具声明（透传给 executeChatTurn） */
  tools?: ChatToolParam[];
  /** 执行一次模型发起的工具调用（透传给 executeChatTurn） */
  executeToolCall?: (toolCall: ChatToolCall) => Promise<string | import("./engine").ToolCallOutcome>;
  /** 只注入这些 id 的技能提示（专家角色切换时按专家绑定过滤）；透传给 executeChatTurn */
  enabledSkillIds?: string[];
}): Promise<TaskExecutionResult> {
  const { model, messages, signal, systemPrompt, project, relatedContext, enabledToolNames, onChunk, onReasoning, onToolStep, knowledgeCollectionId } = options;
  const intent = options.intent ?? "chat";
  const plan = options.plan ?? createTaskPlan({ intent, model, messages });
  const partialOutput: { text: string; reasoning: string; steps: ChatStep[] } = { text: "", reasoning: "", steps: [] };

  return executeRecordedPlan({
    plan,
    signal,
    initialState: {
      conversationMessages: messages,
    },
    executeStep: async ({ step, state, api }) => {
      if (step.kind === "input") {
        api.appendTrace("已完成输入整理");
        return;
      }

      if (step.kind === "tool") {
        throw new Error(`任务计划包含未绑定执行器的工具步骤：${step.title}`);
      }

      if (step.kind === "model") {
        api.appendTrace(`开始调用模型：${model}`);
        const finalResult = await executeChatTurn({
          model,
          messages,
          signal,
          systemPrompt,
          project,
          relatedContext,
          enabledToolNames,
          onChunk: (chunk) => { partialOutput.text += chunk; onChunk?.(chunk); },
          onReasoning: (reasoning) => { partialOutput.reasoning += reasoning; onReasoning?.(reasoning); },
          onToolStep: (toolStep) => { partialOutput.steps.push(toolStep); onToolStep?.(toolStep); },
          knowledgeCollectionId,
          enableKnowledgeContext: intent === "chat",
          enableMemoryExtraction: intent === "chat",
          enableSummaryExtraction: intent === "chat",
          enableToolProtocol: intent !== "chat",
          tools: options.tools,
          executeToolCall: options.executeToolCall,
          enabledSkillIds: options.enabledSkillIds,
        });
        api.setFinalResult(finalResult);
        api.appendTrace("模型回复生成完成");
        return;
      }

      if (step.kind === "review") {
        await validateTaskOutput(state.finalResult);
        api.appendTrace("模型输出校验完成");
        return;
      }

      if (step.kind === "finalize") {
        api.appendTrace("回复内容和用量统计已整理");
      }
    },
  }, options.onTaskState, partialOutput);
}

async function executeLocalCommandTask(options: {
  model: string;
  signal?: AbortSignal;
  onTaskState?: TaskStateListener;
  command: ResolvedLocalSlashCommand;
  executeTool: (command: ResolvedLocalSlashCommand) => Promise<{ ok: boolean; error?: string; outputText?: string; data?: unknown; artifact?: import("./artifacts").ArtifactSpec } | void>;
}): Promise<TaskExecutionResult> {
  const { model, command, executeTool } = options;
  const plan = createTaskPlan({
    intent: "local_command",
    model,
    messages: [],
    goal: `执行命令 ${command.command}${command.args ? ` ${command.args}` : ""}`,
    metadata: {
      toolId: command.id,
    },
  });

  return executeRecordedPlan({
    plan,
    signal: options.signal,
    executeStep: async ({ step, api }) => {
      if (step.kind !== "tool") return;
      api.appendTrace(`执行本地命令：${command.command}`);
      const result = await executeTool(command);
      api.setToolResult(result ?? { ok: true });
      if (result && result.ok === false) {
        throw new Error(result.error || "本地命令执行失败");
      }
    },
  }, options.onTaskState);
}

function buildSkillMessages(command: ResolvedLocalSlashCommand, currentMessages: Message[]) {
  const latestUserMessage = [...currentMessages].reverse().find((message) => message.role === "user")?.content?.trim() ?? "";
  const target = command.args.trim() || latestUserMessage;
  const prefix = command.promptPrefix ?? `请执行技能：${command.title}`;
  return [
    ...currentMessages,
    {
      role: "user" as const,
      content: [prefix, "", target || "请基于最近对话执行该技能。"].join("\n"),
    },
  ];
}

export async function executeInputTask(options: {
  input: string;
  onTaskState?: TaskStateListener;
  images?: ChatImage[];
  /** 用户随消息附带的本地文件（绝对路径引用）；写入 user 消息，供历史渲染与模型按需读取 */
  attachments?: import("./types").ChatAttachment[];
  hiddenContext?: string;
  currentMessages: Message[];
  preparedMessages?: Message[];
  model: string;
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
  /** 推理模型思考链增量回调（透传给 executeChatTurn） */
  onReasoning?: (reasoning: string) => void;
  /** 每个工具调用执行完成时回调（实时上屏 UI 的「思考过程」步骤） */
  onToolStep?: (step: ChatStep) => void;
  knowledgeCollectionId?: string | null;
  selectedKnowledgeCollection?: { id: string; name: string } | null;
  selectedExpert?: { id: string; name: string } | null;
  selectedMode?: { kind: "skill" | "tool"; command: string; name: string } | null;
  onPrepareConversation?: (messages: Message[]) => void;
  executeTool: (command: ResolvedLocalSlashCommand) => Promise<{ ok: boolean; error?: string; outputText?: string; data?: unknown; artifact?: import("./artifacts").ArtifactSpec } | void>;
  /** function calling：工具声明（透传给 executeTask） */
  tools?: ChatToolParam[];
  /** 执行一次模型发起的工具调用（透传给 executeTask） */
  executeToolCall?: (toolCall: ChatToolCall) => Promise<string | import("./engine").ToolCallOutcome>;
  /** 只注入这些 id 的技能提示（专家角色切换时按专家绑定过滤）；透传给 executeTask */
  enabledSkillIds?: string[];
}): Promise<TaskExecutionResult> {
  const {
    input,
    images,
    attachments,
    hiddenContext,
    currentMessages,
    preparedMessages: preparedMessagesOverride,
    model,
    signal,
    systemPrompt,
    project,
    relatedContext,
    enabledToolNames,
    onChunk,
    knowledgeCollectionId,
    selectedKnowledgeCollection,
    selectedExpert,
    selectedMode,
    onPrepareConversation,
    executeTool,
  } = options;
  // 「上屏 + 落库」共用的消息基底，必须在斜杠分支之前算好。
  //
  // 会话的创建与用户消息的写入**只发生在 `onPrepareConversation` 里** —— 它是整条发送
  // 链路上唯一的会话创建口（`createSessionFromMessages` 的调用方）。早期版本只在普通
  // 对话分支调用它，于是斜杠命令（技能与工具）在新会话下既不建会话、用户消息也不上屏；
  // 工具结果又写回「发送前」的数组，两条路都把用户刚发的那句丢了 —— 表现就是
  // 「/命令发出去没反应，窗口里什么都没有」。
  const preparedMessages: Message[] = preparedMessagesOverride ?? [
    ...currentMessages,
    {
      role: "user",
      content: input,
      images,
      attachments,
      selectedKnowledgeCollection: selectedKnowledgeCollection ?? undefined,
      selectedExpert: selectedExpert ?? undefined,
      selectedMode: selectedMode ?? undefined,
    },
  ];

  const localCommand = !images || images.length === 0 ? resolveLocalSlashCommand(input) : null;

  if (localCommand) {
    if (localCommand.kind === "skill") {
      // 项目白名单只约束内置技能（助手能力策展）。用户自行安装的技能
      // （SkillHub / 插件市场 / 本地导入 / 技能创作）以「我的技能」全局开关
      // 为授权入口：安装即对所有助手可用，否则会出现装完即被所有项目拒绝、
      // 又没有 UI 能给已有项目补勾的死局（与普通对话的技能注入行为对齐——
      // 那条路径本来就注入全部已启用技能，不受白名单限制）。
      const isUserInstalledSkill =
        pluginRegistry.isInstalled(localCommand.id) && !pluginRegistry.isBuiltin(localCommand.id);
      if (
        project &&
        !project.allowedSkillIds.includes(localCommand.id) &&
        !isUserInstalledSkill
      ) {
        throw new Error(`当前助手未启用技能：${localCommand.title}`);
      }
      const skillMessages = buildSkillMessages(localCommand, currentMessages);
      // 交给调用方的数组既是送给模型的消息，也是上屏/落库的内容（口径见
      // docs/superpowers/plans/2026-05-16-hide-linked-context-from-chat-ui.md：
      // «task execution continues to use the same preparedMessages array for display and storage»）。
      // 漏了这一步，技能命令在新会话下就没有任何可见产出。
      if (!preparedMessagesOverride) {
        onPrepareConversation?.(skillMessages);
      }
      const skillSystemPrompt = [systemPrompt, localCommand.systemPrompt?.trim()].filter(Boolean).join("\n\n") || undefined;
      return executeTask({
        onTaskState: options.onTaskState,
        model,
        messages: skillMessages,
        signal,
        systemPrompt: skillSystemPrompt,
        project,
        relatedContext,
        enabledToolNames,
        onChunk,
        onReasoning: options.onReasoning,
        onToolStep: options.onToolStep,
        knowledgeCollectionId,
        intent: "chat",
        tools: options.tools,
        executeToolCall: options.executeToolCall,
        enabledSkillIds: options.enabledSkillIds,
      });
    }

    // 工具命令：本地确定性执行。危险操作照样先过确认门 —— `confirm` 声明在
    // toolRegistry 的 ToolDefinition 上，function calling 与手敲斜杠共用同一道门
    //（见 toolRegistry.ts:36-42），不存在绕过口子。
    // 可达性由 `resolveLocalSlashCommand` 的判据保证：它只会返回技能，
    // 或 `localTools` 里真有执行器的工具（`agent` 不在其列，早已返回 null 走模型）。
    // 同样先准备会话：工具命令没有模型回复，用户敲下的 `/xxx args` 本身就是这一轮的
    // 用户消息，调用方随后把工具输出追加在它后面。
    if (!preparedMessagesOverride) {
      onPrepareConversation?.(preparedMessages);
    }
    return executeLocalCommandTask({
      onTaskState: options.onTaskState,
      model,
      signal,
      command: localCommand,
      executeTool,
    });
  }

  if (!preparedMessagesOverride) {
    onPrepareConversation?.(preparedMessages);
  }

  const plan = createTaskPlan({
    intent: "chat",
    model,
    messages: preparedMessages,
  });

  return executeTask({
    onTaskState: options.onTaskState,
    model,
    messages: preparedMessages,
    signal,
    systemPrompt: [systemPrompt, hiddenContext?.trim()].filter(Boolean).join("\n\n") || undefined,
    project,
    relatedContext,
    enabledToolNames,
    onChunk,
    onReasoning: options.onReasoning,
    onToolStep: options.onToolStep,
    knowledgeCollectionId,
    intent: "chat",
    plan,
    tools: options.tools,
    executeToolCall: options.executeToolCall,
    enabledSkillIds: options.enabledSkillIds,
  });
}
