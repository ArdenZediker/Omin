import type {
  AgentToolCall,
  AgentToolSchema,
} from "./types";

export type ToolExecutionMode = "parallel" | "exclusive";

export interface ToolExecutionContext {
  sessionId: string;
  turn: number;
  step: number;
  call: AgentToolCall;
  signal: AbortSignal;
}

export interface ToolExecutionResult {
  content: string;
  isError?: boolean;
  concludesTurn?: boolean;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  executionMode?: ToolExecutionMode;
  /**
   * Runtime classification based on parsed arguments. Returning exactly true
   * permits overlap with other parallel-safe calls; everything else is an
   * exclusive barrier.
   */
  isConcurrencySafe?: (argumentsText: string) => boolean | Promise<boolean>;
  execute(context: ToolExecutionContext): Promise<ToolExecutionResult>;
}

export class AgentToolRegistry {
  private readonly tools = new Map<string, AgentToolDefinition>();

  register(tool: AgentToolDefinition): () => void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate agent tool: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    return () => {
      if (this.tools.get(tool.name) === tool) {
        this.tools.delete(tool.name);
      }
    };
  }

  get(name: string): AgentToolDefinition | undefined {
    return this.tools.get(name);
  }

  async executionMode(name: string, argumentsText: string): Promise<ToolExecutionMode> {
    const tool = this.tools.get(name);
    if (!tool) return "exclusive";
    if (tool.isConcurrencySafe) {
      try {
        return await tool.isConcurrencySafe(argumentsText) === true
          ? "parallel"
          : "exclusive";
      } catch {
        return "exclusive";
      }
    }
    return tool.executionMode === "parallel" ? "parallel" : "exclusive";
  }

  schemas(): AgentToolSchema[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  all(): AgentToolDefinition[] {
    return [...this.tools.values()];
  }
}
