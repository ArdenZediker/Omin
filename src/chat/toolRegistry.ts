import type { Message } from "../adapters/types";
import type { ResolvedLocalSlashCommand } from "./skills";
import type { ArtifactSpec } from "./artifacts";
import { requestConfirmation, type ConfirmationRequest } from "./confirmationGate";

export type ToolExecutionCommand = Pick<ResolvedLocalSlashCommand, "command" | "args">;

export type ToolExecutionContext = {
  activeChatId: string | null;
  chatSessions: Array<{
    id: string;
    title: string;
    messages: Message[];
  }>;
};

export type ToolExecutionResult = {
  ok: boolean;
  error?: string;
  outputText?: string;
  data?: unknown;
  /** 本次执行产出的可交付内容（文件/网页/技能等），UI 渲染产物卡片并入聚合面板 */
  artifact?: ArtifactSpec;
};

export type ToolDefinition = {
  id: string;
  command: string;
  title: string;
  /**
   * 危险操作前置确认：执行前调用，返回确认请求描述则由用户拍板。
   * 返回 null 表示本次参数无需确认（如缺少必填参数、操作落在安全范围）。
   *
   * 声明在这里而非各工具 execute 内部，是为了让「模型 function calling」与
   * 「用户手敲斜杠命令」两条执行路径共用同一道门，不会有绕过口子。
   */
  confirm?: (command: ToolExecutionCommand) => Omit<ConfirmationRequest, "source"> | null;
  execute: (command: ToolExecutionCommand, context: ToolExecutionContext) => Promise<ToolExecutionResult | void>;
};

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition) {
    this.tools.set(tool.command, tool);
  }

  get(command: string) {
    return this.tools.get(command) ?? null;
  }

  list() {
    return Array.from(this.tools.values());
  }

  async execute(command: ToolExecutionCommand, context: ToolExecutionContext): Promise<ToolExecutionResult | void> {
    const tool = this.get(command.command);
    if (!tool) {
      return { ok: false, error: `暂不支持命令：${command.command}` };
    }
    // 危险操作拦截：先确认再执行，被拒绝则原样返回失败（不抛异常，工具循环照常收敛）。
    if (tool.confirm) {
      const request = tool.confirm(command);
      if (request) {
        const approved = await requestConfirmation({ ...request, source: tool.id });
        if (!approved) {
          return { ok: false, error: `用户取消了本次「${tool.title}」操作，未执行任何改动。` };
        }
      }
    }
    return tool.execute(command, context);
  }
}
