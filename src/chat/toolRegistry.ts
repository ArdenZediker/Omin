import type { Message } from "../adapters/types";
import type { ResolvedLocalSlashCommand } from "./skills";
import type { ArtifactSpec } from "./artifacts";

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
    return tool.execute(command, context);
  }
}
