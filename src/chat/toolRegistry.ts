import type { Message } from "../adapters/types";
import type { ResolvedLocalSlashCommand } from "./skills";

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
};

export type ToolDefinition = {
  id: string;
  command: string;
  title: string;
  execute: (command: ResolvedLocalSlashCommand, context: ToolExecutionContext) => Promise<ToolExecutionResult | void>;
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

  async execute(command: ResolvedLocalSlashCommand, context: ToolExecutionContext): Promise<ToolExecutionResult | void> {
    const tool = this.get(command.command);
    if (!tool) {
      return { ok: false, error: `暂不支持命令: ${command.command}` };
    }
    return tool.execute(command, context);
  }
}
