import {
  AgentToolRegistry,
  type AgentToolSchema,
  type ToolExecutionResult,
} from "../agent-core";

export interface NativeToolDescriptor extends AgentToolSchema {
  parallelSafe?: boolean;
}

export interface NativeToolExecutionContext {
  sessionId: string;
  turn: number;
  step: number;
  signal: AbortSignal;
}

export interface NativeToolBridge {
  call(
    tool: string,
    argumentsText: string,
    context: NativeToolExecutionContext,
  ): Promise<ToolExecutionResult>;
  receive?(message: unknown): boolean;
  close?(reason?: string): void;
}

export type NativeBridgeRequest =
  | {
      kind: "native-tool-call";
      id: string;
      tool: string;
      arguments: string;
      sessionId: string;
      turn: number;
      step: number;
    }
  | {
      kind: "native-tool-cancel";
      id: string;
      reason: string;
    };

export type NativeBridgeResult =
  | {
      kind: "native-tool-result";
      id: string;
      ok: true;
      result: ToolExecutionResult;
    }
  | {
      kind: "native-tool-result";
      id: string;
      ok: false;
      error: { message: string; code?: string };
    };

interface PendingCall {
  resolve: (result: ToolExecutionResult) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Correlated native tool calls over an ordered line transport.
 *
 * The caller owns the write side. Incoming result frames are fed back through
 * `receive` by the process transport.
 */
export class NativeStdioBridge implements NativeToolBridge {
  private readonly pending = new Map<string, PendingCall>();

  constructor(
    private readonly write: (
      message: NativeBridgeRequest,
    ) => void | Promise<void>,
    private readonly timeoutMs = 5 * 60_000,
  ) {}

  async call(
    tool: string,
    argumentsText: string,
    context: NativeToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    context.signal.throwIfAborted();
    const id = crypto.randomUUID();
    let promise: Promise<ToolExecutionResult>;
    promise = new Promise<ToolExecutionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`native tool "${tool}" timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      const onAbort = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        void Promise.resolve(this.write({
          kind: "native-tool-cancel",
          id,
          reason: context.signal.reason instanceof Error
            ? context.signal.reason.message
            : "cancelled by caller",
        })).catch(() => undefined);
        reject(new DOMException("Native tool call aborted", "AbortError"));
      };
      context.signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          context.signal.removeEventListener("abort", onAbort);
        },
      });
    });

    try {
      await this.write({
        kind: "native-tool-call",
        id,
        tool,
        arguments: argumentsText,
        sessionId: context.sessionId,
        turn: context.turn,
        step: context.step,
      });
      return await promise;
    } catch (error: unknown) {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        pending.cleanup();
      }
      pending?.reject(error);
      throw error;
    }
  }

  receive(message: unknown): boolean {
    if (!isRecord(message) || message.kind !== "native-tool-result") {
      return false;
    }
    if (typeof message.id !== "string") return false;
    const pending = this.pending.get(message.id);
    if (!pending) return true;
    this.pending.delete(message.id);
    pending.cleanup();

    if (message.ok === true) {
      if (!isRecord(message.result) || typeof message.result.content !== "string") {
        pending.reject(new Error("native tool returned a malformed result"));
        return true;
      }
      pending.resolve({
        content: message.result.content,
        ...(message.result.isError === true ? { isError: true } : {}),
        ...(message.result.concludesTurn === true ? { concludesTurn: true } : {}),
      });
      return true;
    }
    if (message.ok === false && isRecord(message.error)) {
      const errorMessage = typeof message.error.message === "string"
        ? message.error.message
        : "native tool failed";
      const code = typeof message.error.code === "string"
        ? message.error.code
        : "NATIVE_TOOL_ERROR";
      const error = new Error(errorMessage);
      error.name = code;
      pending.reject(error);
      return true;
    }
    pending.reject(new Error("native tool returned a malformed result"));
    return true;
  }

  close(reason = "native bridge closed"): void {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
}

/**
 * Binds transport-provided tool schemas to the Agent runtime registry.
 *
 * Configuration can arrive before the native transport is attached. Calls
 * remain unavailable until a bridge exists.
 */
export class NativeToolController {
  private bridge?: NativeToolBridge;
  private disposers: Array<() => void> = [];

  constructor(private readonly registry: AgentToolRegistry) {}

  attachBridge(bridge: NativeToolBridge): void {
    this.bridge = bridge;
  }

  configureTools(tools: NativeToolDescriptor[]): AgentToolSchema[] {
    const next = this.createTools(tools);
    for (const dispose of this.disposers.splice(0).reverse()) dispose();
    for (const tool of next.all()) {
      this.disposers.push(this.registry.register(tool));
    }
    return this.registry.schemas();
  }

  /**
   * Creates an isolated registry for one Host session. All descriptors still
   * route through the same correlated transport; the Rust side decides whether
   * a call executes natively or is delegated to the Omni UI.
   */
  createTools(tools: NativeToolDescriptor[]): AgentToolRegistry {
    const names = new Set<string>();
    for (const tool of tools) {
      if (!tool.name || names.has(tool.name)) {
        throw new Error(`invalid or duplicate native tool name: "${tool.name}"`);
      }
      names.add(tool.name);
    }

    const registry = new AgentToolRegistry();
    for (const tool of tools) {
      registry.register({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        executionMode: tool.parallelSafe === true ? "parallel" : "exclusive",
        execute: (context) => this.requireBridge().call(
          tool.name,
          context.call.arguments,
          {
            sessionId: context.sessionId,
            turn: context.turn,
            step: context.step,
            signal: context.signal,
          },
        ),
      });
    }
    return registry;
  }

  receive(message: unknown): boolean {
    return this.bridge?.receive?.(message) === true;
  }

  close(reason?: string): void {
    this.bridge?.close?.(reason);
  }

  private requireBridge(): NativeToolBridge {
    if (!this.bridge) throw new Error("native bridge is not connected");
    return this.bridge;
  }
}
