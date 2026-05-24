import type { Message } from "../adapters/types";
import { executeChatTurn } from "./engine";
import { runTaskPlan } from "./taskRunner";
import type { ResolvedLocalSlashCommand } from "./skills";
import { resolveLocalSlashCommand } from "./skills";
import type { TaskExecutionResult, TaskIntent, TaskPlan, TaskStep } from "./taskTypes";

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
  onChunk?: (chunk: string) => void;
  intent?: TaskIntent;
  plan?: TaskPlan;
}): Promise<TaskExecutionResult> {
  const { model, messages, signal, systemPrompt, onChunk } = options;
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
          onChunk,
          enableKnowledgeContext: intent === "chat",
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
  executeTool: (command: ResolvedLocalSlashCommand) => Promise<{ ok: boolean; error?: string; outputText?: string; data?: unknown } | void>;
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

async function executeAnalyzeFilesTask(options: {
  model: string;
  command: ResolvedLocalSlashCommand;
  currentMessages: Message[];
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void;
  executeTool: (command: ResolvedLocalSlashCommand) => Promise<{ ok: boolean; error?: string; outputText?: string; data?: unknown } | void>;
}): Promise<TaskExecutionResult> {
  const { model, command, currentMessages, signal, onChunk, executeTool } = options;
  const query = command.args.trim();
  const plan = createTaskPlan({
    intent: "tool_chain",
    model,
    messages: currentMessages,
    goal: `分析工作区中与“${query}”相关的文件`,
    metadata: {
      command: command.command,
      query,
    },
  });
  plan.childTaskIds = [`${plan.taskId}:search`, `${plan.taskId}:read`, `${plan.taskId}:summarize`];

  let readSnippets: Array<{ path: string; content: string }> = [];
  let modelMessages = currentMessages;

  const runResult = await runTaskPlan({
    plan,
    signal,
    initialState: {
      conversationMessages: currentMessages,
    },
    executeStep: async ({ step, api }) => {
      if (step.id === "plan_chain") {
        if (!query) {
          throw new Error("用法: /analyze_files 关键字");
        }
        api.appendTrace("组合工具任务规划完成");
        return;
      }

      if (step.id === "act_search") {
        api.appendTrace(`开始搜索文件内容：${query}`);
        const searchResult = await executeTool({
          ...command,
          command: "/search_files",
          args: query,
        });

        if (!searchResult || searchResult.ok === false) {
          throw new Error(searchResult?.error || "文件内容搜索失败");
        }

        api.setToolResult(searchResult);
        api.appendTrace("文件内容搜索完成");
        return;
      }

      if (step.id === "act_read") {
        const searchData = Array.isArray(runResult.state.toolResult?.data)
          ? (runResult.state.toolResult?.data as Array<{ path?: string }>)
          : [];
        const uniquePaths = [...new Set(searchData.map((item) => item.path).filter((path): path is string => Boolean(path)))].slice(0, 3);

        if (uniquePaths.length === 0) {
          throw new Error("没有可供读取的匹配文件");
        }

        readSnippets = [];
        for (const path of uniquePaths) {
          api.appendTrace(`读取文件：${path}`);
          const readResult = await executeTool({
            ...command,
            command: "/read_file",
            args: path,
          });

          if (!readResult || readResult.ok === false) {
            throw new Error(readResult?.error || `读取文件失败: ${path}`);
          }

          readSnippets.push({
            path,
            content: readResult.outputText || "",
          });
        }

        modelMessages = [
          ...currentMessages,
          {
            role: "user",
            content: [
              `请基于下面与“${query}”相关的文件内容，输出简洁总结：`,
              "",
              ...readSnippets.map((result) => `文件：${result.path}\n${result.content}`),
            ].join("\n\n"),
          },
        ];

        api.setConversationMessages(modelMessages);
        api.appendTrace(`已读取 ${readSnippets.length} 个文件`);
        return;
      }

      if (step.id === "act_model") {
        api.appendTrace("开始总结搜索结果");
        const finalResult = await executeChatTurn({
          model,
          messages: modelMessages,
          signal,
          onChunk,
          enableKnowledgeContext: false,
        });
        api.setFinalResult(finalResult);
        api.appendTrace("组合任务总结完成");
        return;
      }

      if (step.id === "review_output") {
        api.appendTrace("组合任务输出校验完成");
        return;
      }

      if (step.id === "finalize_output") {
        api.appendTrace("组合任务结果已整理");
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

export async function executeInputTask(options: {
  input: string;
  images?: string[];
  hiddenContext?: string;
  currentMessages: Message[];
  preparedMessages?: Message[];
  model: string;
  signal?: AbortSignal;
  systemPrompt?: string;
  onChunk?: (chunk: string) => void;
  onPrepareConversation?: (messages: Message[]) => void;
  executeTool: (command: ResolvedLocalSlashCommand) => Promise<{ ok: boolean; error?: string; outputText?: string; data?: unknown } | void>;
}): Promise<TaskExecutionResult> {
  const { input, images, hiddenContext, currentMessages, preparedMessages: preparedMessagesOverride, model, signal, systemPrompt, onChunk, onPrepareConversation, executeTool } = options;
  const localCommand = !images || images.length === 0 ? resolveLocalSlashCommand(input) : null;

  if (localCommand) {
    if (localCommand.command === "/analyze_files") {
      return executeAnalyzeFilesTask({
        model,
        command: localCommand,
        currentMessages,
        signal,
        onChunk,
        executeTool,
      });
    }

    return executeLocalCommandTask({
      model,
      command: localCommand,
      executeTool,
    });
  }

  const preparedMessages: Message[] = preparedMessagesOverride ?? [...currentMessages, { role: "user", content: input, images }];
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
    onChunk,
    intent: "chat",
    plan,
  });
}
