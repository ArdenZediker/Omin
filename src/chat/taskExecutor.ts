import type { ChatToolCall, ChatToolParam, ChatImage, Message } from "../adapters/types";
import { executeChatTurn } from "./engine";
import { runTaskPlan } from "./taskRunner";
import type { ResolvedLocalSlashCommand } from "./skills";
import { resolveLocalSlashCommand } from "./skills";
import type { TaskExecutionResult, TaskIntent, TaskPlan, TaskStep } from "./taskTypes";
import type { ProjectMemoryRecord, Project, SessionSummaryRecord, ChatStep } from "./types";

function createTaskId() {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
      { id: "act_search", title: "搜索相关文件", kind: "tool", stage: "act", status: "pending" },
      { id: "act_read", title: "读取命中文件内容", kind: "tool", stage: "act", status: "pending" },
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
}): Promise<TaskExecutionResult> {
  const { model, messages, signal, systemPrompt, project, relatedContext, enabledToolNames, onChunk, onReasoning, onToolStep, knowledgeCollectionId } = options;
  const intent = options.intent ?? "chat";
  const plan = options.plan ?? createTaskPlan({ intent, model, messages });

  const runResult = await runTaskPlan({
    plan,
    signal,
    initialState: {
      conversationMessages: messages,
    },
    executeStep: async ({ step, api }) => {
      if (step.kind === "input") {
        api.appendTrace("已完成输入整理");
        return;
      }

      if (step.kind === "tool") {
        api.appendTrace(`执行步骤：${step.title}`);
        return;
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
          onChunk,
          onReasoning,
          onToolStep,
          knowledgeCollectionId,
          enableKnowledgeContext: intent === "chat",
          enableMemoryExtraction: intent === "chat",
          enableSummaryExtraction: intent === "chat",
          enableToolProtocol: intent !== "chat",
          tools: options.tools,
          executeToolCall: options.executeToolCall,
        });
        api.setFinalResult(finalResult);
        api.appendTrace("模型回复生成完成");
        return;
      }

      if (step.kind === "review") {
        api.appendTrace("模型输出校验完成");
        return;
      }

      if (step.kind === "finalize") {
        api.appendTrace("回复内容和用量统计已整理");
      }
    },
  });

  return {
    taskId: plan.taskId,
    intent: plan.intent,
    status: runResult.status,
    plan: runResult.plan,
    trace: runResult.trace,
    conversationMessages: runResult.state.conversationMessages,
    finalResult: runResult.state.finalResult,
    toolResult: runResult.state.toolResult,
    error: runResult.state.error,
  };
}

async function executeLocalCommandTask(options: {
  model: string;
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

  const runResult = await runTaskPlan({
    plan,
    executeStep: async ({ api }) => {
      api.appendTrace(`执行本地命令：${command.command}`);
      const result = await executeTool(command);
      if (result && result.ok === false) {
        throw new Error(result.error || "本地命令执行失败");
      }
      api.setToolResult(result ?? { ok: true });
    },
  });

  return {
    taskId: plan.taskId,
    intent: plan.intent,
    status: runResult.status,
    plan: runResult.plan,
    trace: runResult.trace,
    toolResult: runResult.state.toolResult,
    error: runResult.state.error,
  };
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
  onPrepareConversation?: (messages: Message[]) => void;
  executeTool: (command: ResolvedLocalSlashCommand) => Promise<{ ok: boolean; error?: string; outputText?: string; data?: unknown; artifact?: import("./artifacts").ArtifactSpec } | void>;
  /** function calling：工具声明（透传给 executeTask） */
  tools?: ChatToolParam[];
  /** 执行一次模型发起的工具调用（透传给 executeTask） */
  executeToolCall?: (toolCall: ChatToolCall) => Promise<string | import("./engine").ToolCallOutcome>;
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
    onPrepareConversation,
    executeTool,
  } = options;
  const localCommand = !images || images.length === 0 ? resolveLocalSlashCommand(input) : null;

  if (localCommand) {
    if (localCommand.kind === "skill") {
      if (project && !project.allowedSkillIds.includes(localCommand.id)) {
        throw new Error(`当前助手未启用技能：${localCommand.title}`);
      }
      const skillMessages = buildSkillMessages(localCommand, currentMessages);
      const skillSystemPrompt = [systemPrompt, localCommand.systemPrompt?.trim()].filter(Boolean).join("\n\n") || undefined;
      return executeTask({
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
  });
}

    return executeLocalCommandTask({
      model,
      command: localCommand,
      executeTool,
    });
  }

  const preparedMessages: Message[] = preparedMessagesOverride ?? [...currentMessages, { role: "user", content: input, images, attachments }];
  if (!preparedMessagesOverride) {
    onPrepareConversation?.(preparedMessages);
  }

  const plan = createTaskPlan({
    intent: "chat",
    model,
    messages: preparedMessages,
  });

  return executeTask({
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
  });
}
