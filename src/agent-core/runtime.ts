import type {
  AgentEvent,
  AgentEventDraft,
  AgentEventOf,
  AgentEventType,
  AgentStepEndReason,
  AgentTurnEndReason,
} from "./events";
import type { SessionEventStore } from "./event-store";
import { AgentInbox, type AgentInboxTarget } from "./inbox";
import { latestTurn, projectMessages } from "./message-projection";
import type { ModelFinishReason, ModelProvider, ModelStreamEvent } from "./model";
import {
  addAgentUsage,
  emptyAgentUsage,
  reasoningBlocks,
  textBlocks,
  type AgentContentBlock,
  type AgentImage,
  type AgentMessage,
  type AgentModelConfig,
  type AgentPrompt,
  type AgentSessionId,
  type AgentToolCall,
  type AgentUsage,
} from "./types";
import { AgentToolRegistry, type ToolExecutionResult } from "./tools";

export interface AgentRuntimeOptions {
  store: SessionEventStore;
  model: ModelProvider;
  tools: AgentToolRegistry;
  maxStepsPerTurn?: number;
  maxParallelToolCalls?: number;
  now?: () => number;
  idFactory?: () => string;
}

export interface CreateAgentSessionOptions {
  title?: string;
  cwd: string;
  /** Optional prior transcript, used when attaching the durable Host to an existing Omni chat. */
  history?: AgentMessage[];
}

export interface PromptOptions {
  model: AgentModelConfig;
  system?: string;
  images?: AgentImage[];
}

export interface CancelOptions {
  /** Keep pending follow-ups instead of clearing the inbox. */
  keepInbox?: boolean;
  reason?: string;
}

export interface AgentTurnResult {
  sessionId: AgentSessionId;
  turn: number;
  promptIds: string[];
  content: string;
  reasoning: string;
  usage: AgentUsage;
  reason: AgentTurnEndReason;
}

export interface EnqueuedAgentPrompt {
  promptId: string;
  result: Promise<AgentTurnResult>;
}

export type AgentEventListener = (event: AgentEvent) => void;

interface CollectedModelResponse {
  message: AgentMessage;
  finish: ModelFinishReason;
  rawUsage?: import("./types").AgentTokenUsage;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

interface SessionState {
  sessionId: AgentSessionId;
  inbox: AgentInbox;
  lastTurn: number;
  running: boolean;
  wakeRequested: boolean;
  controller?: AbortController;
  activity: Promise<void>;
  waiters: Map<string, Deferred<AgentTurnResult>>;
}

const DEFAULT_MAX_STEPS_PER_TURN = 60;
const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 8;

/**
 * Event-sourced ReAct loop with DSH-style inbox semantics.
 *
 * `followup` queues a future turn, `steer` joins the next step of the active
 * turn, `inject` joins only when a driver is already running, and `cancel`
 * aborts the active step while optionally clearing pending input.
 */
export class AgentRuntime {
  private readonly store: SessionEventStore;
  private readonly model: ModelProvider;
  private readonly tools: AgentToolRegistry;
  private readonly maxStepsPerTurn: number;
  private readonly maxParallelToolCalls: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly sessions = new Map<AgentSessionId, SessionState>();
  private readonly loading = new Map<AgentSessionId, Promise<SessionState>>();
  private readonly listeners = new Map<AgentSessionId, Set<AgentEventListener>>();
  private readonly sessionTools = new Map<AgentSessionId, AgentToolRegistry>();

  constructor(options: AgentRuntimeOptions) {
    this.store = options.store;
    this.model = options.model;
    this.tools = options.tools;
    this.maxStepsPerTurn = options.maxStepsPerTurn ?? DEFAULT_MAX_STEPS_PER_TURN;
    this.maxParallelToolCalls = Math.max(
      1,
      options.maxParallelToolCalls ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS,
    );
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }

  async createSession(options: CreateAgentSessionOptions): Promise<AgentSessionId> {
    const sessionId = this.idFactory();
    const event = await this.appendEvent(sessionId, {
      type: "session/created",
      payload: {
        cwd: options.cwd,
        ...(options.title ? { title: options.title } : {}),
        ...(options.history?.length ? { history: options.history } : {}),
      },
    });
    const state = await this.createState(sessionId, [event]);
    this.sessions.set(sessionId, state);
    return sessionId;
  }

  /**
   * Queue a follow-up and return the result of the turn that owns it. Prompt
   * calls never contend with a live turn: callers can append additional input
   * while the current model or tool is running.
   */
  async prompt(
    sessionId: AgentSessionId,
    content: string,
    options: PromptOptions,
  ): Promise<AgentTurnResult> {
    return this.followup(sessionId, content, options);
  }

  async followup(
    sessionId: AgentSessionId,
    content: string,
    options: PromptOptions,
  ): Promise<AgentTurnResult> {
    const queued = await this.enqueueFollowup(sessionId, content, options);
    return queued.result;
  }

  async enqueueFollowup(
    sessionId: AgentSessionId,
    content: string,
    options: PromptOptions,
  ): Promise<EnqueuedAgentPrompt> {
    const deferred = this.deferred<AgentTurnResult>();
    const prompt = this.createPrompt(content, options);
    const state = await this.requireState(sessionId);
    state.waiters.set(prompt.id, deferred);
    try {
      await state.inbox.append("next-turn", prompt);
      await this.wakeDriver(state);
    } catch (error) {
      state.waiters.delete(prompt.id);
      deferred.reject(error);
      throw error;
    }
    return {
      promptId: prompt.id,
      result: deferred.promise,
    };
  }

  async steer(
    sessionId: AgentSessionId,
    content: string,
    options: PromptOptions,
  ): Promise<string> {
    return this.send(sessionId, "next-step", content, options, true);
  }

  async inject(
    sessionId: AgentSessionId,
    content: string,
    options: PromptOptions,
  ): Promise<string> {
    return this.send(sessionId, "next-step", content, options, false);
  }

  async cancel(
    sessionId: AgentSessionId,
    options: CancelOptions = {},
  ): Promise<void> {
    const state = await this.requireState(sessionId);
    if (options.keepInbox !== true) {
      const removed = await state.inbox.clear();
      this.rejectQueued(state, removed, new DOMException(
        options.reason ?? "agent inbox cleared",
        "AbortError",
      ));
    }
    state.controller?.abort(options.reason ?? "cancelled by caller");
  }

  async removePending(sessionId: AgentSessionId, promptId: string): Promise<boolean> {
    const state = await this.requireState(sessionId);
    const removed = await state.inbox.remove("next-step", promptId)
      || await state.inbox.remove("next-turn", promptId);
    if (removed) {
      const waiter = state.waiters.get(promptId);
      if (waiter) {
        state.waiters.delete(promptId);
        waiter.reject(new DOMException("agent prompt removed", "AbortError"));
      }
    }
    return removed;
  }

  async whenIdle(sessionId: AgentSessionId): Promise<void> {
    const state = await this.requireState(sessionId);
    let activity: Promise<void>;
    do {
      activity = state.activity;
      await activity;
    } while (activity !== state.activity || state.running);
  }

  async isRunning(sessionId: AgentSessionId): Promise<boolean> {
    return (await this.requireState(sessionId)).running;
  }

  /**
   * Attaches a session-specific tool catalog. Configuration is rejected while
   * a turn is running so a tool list cannot change underneath a live model
   * step. Sessions without an explicit catalog use the Host default registry.
   */
  async configureTools(
    sessionId: AgentSessionId,
    tools: AgentToolRegistry,
  ): Promise<AgentToolRegistry> {
    const state = await this.requireState(sessionId);
    if (state.running) {
      throw new Error(`Agent session "${sessionId}" is running`);
    }
    this.sessionTools.set(sessionId, tools);
    return tools;
  }

  subscribe(sessionId: AgentSessionId, listener: AgentEventListener): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set<AgentEventListener>();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(sessionId);
    };
  }

  readEvents(
    sessionId: AgentSessionId,
    options: { afterSeq?: number; limit?: number } = {},
  ): Promise<AgentEvent[]> {
    return this.store.read(sessionId, options);
  }

  /**
   * Stops any active turn, deletes the durable event log, and clears all
   * in-memory state for this session. Returns false for an unknown session.
   */
  async deleteSession(sessionId: AgentSessionId): Promise<boolean> {
    const state = this.sessions.get(sessionId) ?? await this.loading.get(sessionId);
    if (!state) {
      const events = await this.store.read(sessionId, { limit: 1 });
      if (events.length === 0) return false;
    } else {
      await this.cancel(sessionId, { reason: "session deleted" });
      await this.whenIdle(sessionId);
    }

    await this.store.delete(sessionId);
    this.sessions.delete(sessionId);
    this.loading.delete(sessionId);
    this.sessionTools.delete(sessionId);
    this.listeners.delete(sessionId);
    return true;
  }

  listTools(sessionId?: AgentSessionId) {
    return this.toolsFor(sessionId).schemas();
  }

  private async send(
    sessionId: AgentSessionId,
    target: AgentInboxTarget,
    content: string,
    options: PromptOptions,
    wake: boolean,
  ): Promise<string> {
    const prompt = this.createPrompt(content, options);
    const state = await this.requireState(sessionId);
    await state.inbox.append(target, prompt);
    if (wake) await this.wakeDriver(state);
    return prompt.id;
  }

  private createPrompt(content: string, options: PromptOptions): AgentPrompt {
    const normalized = content.trim();
    if (!normalized) throw new Error("Agent prompt cannot be empty");
    return {
      id: this.idFactory(),
      content: normalized,
      ...(options.images?.length ? { images: options.images } : {}),
      config: options.model,
      ...(options.system ? { system: options.system } : {}),
    };
  }

  private async wakeDriver(state: SessionState): Promise<void> {
    if (state.running) {
      state.wakeRequested = true;
      return;
    }
    state.running = true;
    state.wakeRequested = false;
    state.controller = new AbortController();
    await this.appendEvent(state.sessionId, {
      type: "agent/status",
      payload: { status: "running" },
    });
    const activity = this.drive(state).finally(async () => {
      state.running = false;
      state.controller = undefined;
      await this.appendEvent(state.sessionId, {
        type: "agent/status",
        payload: { status: "idle" },
      });
      const shouldWake = state.wakeRequested || state.inbox.hasPending;
      state.wakeRequested = false;
      if (shouldWake) {
        void this.wakeDriver(state).catch(() => undefined);
      }
    });
    state.activity = activity;
    await Promise.resolve();
  }

  private async drive(state: SessionState): Promise<void> {
    while (state.inbox.hasPending) {
      const controller = state.controller;
      if (!controller) throw new Error(`Agent session "${state.sessionId}" lost its driver`);
      await this.runTurn(state, controller.signal);
      if (controller.signal.aborted) break;
    }
  }

  private async runTurn(state: SessionState, signal: AbortSignal): Promise<void> {
    const tools = this.toolsFor(state.sessionId);
    const turn = state.lastTurn + 1;
    state.lastTurn = turn;
    await this.appendEvent(state.sessionId, {
      type: "turn/started",
      payload: { turn },
    });

    const claimed: AgentPrompt[] = [];
    const usage = emptyAgentUsage();
    let turnReason: AgentTurnEndReason = { kind: "completed" };
    let finalText = "";
    let finalReasoning = "";
    let target: AgentInboxTarget = "next-turn";
    let turnConfig: AgentModelConfig | undefined;
    let turnSystem: string | undefined;

    try {
      for (let step = 1; step <= this.maxStepsPerTurn; step += 1) {
        signal.throwIfAborted();
        const stepPrompts = await state.inbox.claim(target);
        claimed.push(...stepPrompts);
        // A step after a tool call has no new inbox input: its next model
        // request is driven by the durable tool/result messages. Only an
        // empty *opening* batch means there is no turn work to start.
        if (step === 1 && stepPrompts.length === 0) break;

        if (stepPrompts.length > 0) {
          turnConfig ??= stepPrompts[0].config;
          turnSystem ??= stepPrompts[0].system;
        }
        if (!turnConfig) {
          throw new Error(`Agent turn ${turn} has no prompt model configuration`);
        }
        await this.appendEvent(state.sessionId, {
          type: "request/header",
          payload: {
            turn,
            config: turnConfig,
            ...(turnSystem ? { system: turnSystem } : {}),
            tools: tools.schemas().map((tool) => tool.name),
          },
        });
        await this.appendEvent(state.sessionId, {
          type: "step/started",
          payload: { turn, step },
        });
        for (const prompt of stepPrompts) {
          await this.appendEvent(state.sessionId, {
            type: "user/message",
            payload: {
              turn,
              step,
              message: {
                id: prompt.id,
                role: "user",
                content: [
                  ...(prompt.images?.length
                    ? prompt.images.map((image) => ({
                        type: "image" as const,
                        image,
                      }))
                    : []),
                  { type: "text", text: prompt.content },
                ],
                createdAt: this.now(),
              },
            },
          });
        }

        let stepEnd: AgentStepEndReason = { kind: "completed" };
        try {
          const events = await this.store.read(state.sessionId);
          const collected = await this.collectModelResponse({
            sessionId: state.sessionId,
            turn,
            step,
            messages: projectMessages(events),
            system: turnSystem,
            config: turnConfig,
            signal,
            tools,
          });
          addAgentUsage(usage, collected.rawUsage);
          await this.appendEvent(state.sessionId, {
            type: "assistant/message",
            payload: {
              turn,
              step,
              message: collected.message,
              ...(collected.rawUsage ? { usage: collected.rawUsage } : {}),
            },
          });

          finalText = textBlocks(collected.message) || finalText;
          finalReasoning = reasoningBlocks(collected.message) || finalReasoning;

          if (collected.finish.kind === "max-tokens") {
            stepEnd = { kind: "max-tokens" };
            turnReason = { kind: "max-tokens" };
          } else if (collected.finish.kind === "stop") {
            stepEnd = { kind: "completed" };
          } else {
            const concluded = await this.executeToolCalls(
              state.sessionId,
              turn,
              step,
              collected.finish.calls,
              signal,
              tools,
            );
            stepEnd = { kind: "tools", count: collected.finish.calls.length };
            if (concluded) turnReason = { kind: "completed" };
          }
        } catch (error: unknown) {
          if (signal.aborted) {
            stepEnd = {
              kind: "aborted",
              ...(typeof signal.reason === "string" ? { message: signal.reason } : {}),
            };
          }
          await this.completeStep(state.sessionId, turn, step, stepEnd);
          throw error;
        }

        await this.completeStep(state.sessionId, turn, step, stepEnd);
        if (stepEnd.kind === "max-tokens") break;
        if (
          stepEnd.kind === "completed"
          && state.inbox.nextStep.length === 0
        ) {
          break;
        }
        if (step === this.maxStepsPerTurn) {
          turnReason = {
            kind: "failed",
            code: "STEP_LIMIT",
            message: `Agent exceeded ${this.maxStepsPerTurn} steps`,
          };
        }
        target = "next-step";
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        turnReason = {
          kind: "aborted",
          ...(typeof signal.reason === "string" ? { message: signal.reason } : {}),
        };
      } else {
        turnReason = {
          kind: "failed",
          code: "RUNTIME_ERROR",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    } finally {
      await this.appendEvent(state.sessionId, {
        type: "turn/completed",
        payload: { turn, reason: turnReason },
      });
    }

    const result: AgentTurnResult = {
      sessionId: state.sessionId,
      turn,
      promptIds: claimed.map((prompt) => prompt.id),
      content: finalText,
      reasoning: finalReasoning,
      usage,
      reason: turnReason,
    };
    for (const prompt of claimed) {
      const waiter = state.waiters.get(prompt.id);
      if (!waiter) continue;
      state.waiters.delete(prompt.id);
      waiter.resolve(result);
    }
  }

  private async collectModelResponse(options: {
    sessionId: string;
    turn: number;
    step: number;
    messages: AgentMessage[];
    system?: string;
    config: AgentModelConfig;
    signal: AbortSignal;
    tools: AgentToolRegistry;
  }): Promise<CollectedModelResponse> {
    const content: AgentContentBlock[] = [];
    let text = "";
    let reasoning = "";
    let rawUsage: import("./types").AgentTokenUsage | undefined;
    let finish: ModelFinishReason | undefined;

    const appendInterrupted = async () => {
      if (reasoning) content.push({ type: "reasoning", text: reasoning });
      if (text) content.push({ type: "text", text });
      if (content.length > 0) {
        await this.appendEvent(options.sessionId, {
          type: "assistant/message",
          payload: {
            turn: options.turn,
            step: options.step,
            message: this.message("assistant", content, {
              provider: options.config.provider,
              model: options.config.model,
            }),
            interrupted: true,
            ...(rawUsage ? { usage: rawUsage } : {}),
          },
        });
      }
    };

    try {
      for await (const event of this.model.stream({
        sessionId: options.sessionId,
        turn: options.turn,
        step: options.step,
        messages: options.messages,
        ...(options.system ? { system: options.system } : {}),
        tools: options.tools.schemas(),
        config: options.config,
        signal: options.signal,
      })) {
        options.signal.throwIfAborted();
        switch (event.type) {
          case "text-delta":
            text += event.text;
            await this.appendChunk(options, { type: "text-delta", text: event.text });
            break;
          case "reasoning-delta":
            reasoning += event.text;
            await this.appendChunk(options, { type: "reasoning-delta", text: event.text });
            break;
          case "usage":
            rawUsage = event.usage;
            break;
          case "finish":
            finish = event.reason;
            break;
        }
      }
    } catch (error: unknown) {
      if (options.signal.aborted) await appendInterrupted();
      throw error;
    }
    if (!finish) throw new Error("Model stream ended without a finish event");

    if (reasoning) content.push({ type: "reasoning", text: reasoning });
    if (text) content.push({ type: "text", text });
    for (const call of finish.kind === "tool-calls" ? finish.calls : []) {
      content.push({ type: "tool-call", call });
    }
    return {
      message: this.message("assistant", content, {
        provider: options.config.provider,
        model: options.config.model,
      }),
      finish,
      ...(rawUsage ? { rawUsage } : {}),
    };
  }

  private async appendChunk(
    options: { sessionId: string; turn: number; step: number },
    chunk: Extract<ModelStreamEvent, { type: "text-delta" | "reasoning-delta" }>,
  ): Promise<void> {
    await this.appendEvent(options.sessionId, {
      type: "assistant/chunk",
      payload: {
        turn: options.turn,
        step: options.step,
        chunk,
      },
    });
  }

  private async executeToolCalls(
    sessionId: string,
    turn: number,
    step: number,
    calls: AgentToolCall[],
    signal: AbortSignal,
    tools: AgentToolRegistry,
  ): Promise<boolean> {
    let next = 0;
    let concluded = false;
    while (next < calls.length) {
      const mode = await tools.executionMode(
        calls[next].name,
        calls[next].arguments,
      );
      const group = [calls[next]];
      if (mode === "parallel") {
        while (
          group.length < this.maxParallelToolCalls
          && next + group.length < calls.length
          && await tools.executionMode(
            calls[next + group.length].name,
            calls[next + group.length].arguments,
          ) === "parallel"
        ) {
          group.push(calls[next + group.length]);
        }
      }

      const groupConcluded = await this.executeToolGroup(
        sessionId,
        turn,
        step,
        group,
        signal,
        tools,
      );
      concluded ||= groupConcluded;
      next += group.length;
      if (signal.aborted) {
        for (const call of calls.slice(next)) {
          await this.appendToolCall(sessionId, turn, step, call);
          await this.appendToolResult(sessionId, turn, step, call, {
            content: "Error: tool call aborted before dispatch",
            isError: true,
          });
        }
        signal.throwIfAborted();
      }
    }
    return concluded;
  }

  private async executeToolGroup(
    sessionId: string,
    turn: number,
    step: number,
    calls: AgentToolCall[],
    signal: AbortSignal,
    tools: AgentToolRegistry,
  ): Promise<boolean> {
    for (const call of calls) {
      signal.throwIfAborted();
      await this.appendToolCall(sessionId, turn, step, call);
    }
    const results = await Promise.all(calls.map((call) =>
      this.executeTool({ sessionId, turn, step, call, signal, tools })
    ));
    let concluded = false;
    for (let index = 0; index < calls.length; index += 1) {
      const result = results[index];
      await this.appendToolResult(sessionId, turn, step, calls[index], result);
      concluded ||= result.concludesTurn === true;
    }
    return concluded;
  }

  private appendToolCall(
    sessionId: string,
    turn: number,
    step: number,
    call: AgentToolCall,
  ): Promise<AgentEventOf<"tool/call">> {
    return this.appendEvent(sessionId, {
      type: "tool/call",
      payload: { turn, step, call },
    });
  }

  private appendToolResult(
    sessionId: string,
    turn: number,
    step: number,
    call: AgentToolCall,
    result: ToolExecutionResult,
  ): Promise<AgentEventOf<"tool/result">> {
    return this.appendEvent(sessionId, {
      type: "tool/result",
      payload: {
        turn,
        step,
        callId: call.id,
        name: call.name,
        isError: result.isError === true,
        message: this.message("tool", [{ type: "text", text: result.content }], {
          callId: call.id,
          name: call.name,
        }),
      },
    });
  }

  private async executeTool(options: {
    sessionId: string;
    turn: number;
    step: number;
    call: AgentToolCall;
    signal: AbortSignal;
    tools: AgentToolRegistry;
  }): Promise<ToolExecutionResult> {
    const tool = options.tools.get(options.call.name);
    if (!tool) {
      return {
        content: `Unknown tool: ${options.call.name}`,
        isError: true,
      };
    }
    try {
      return await tool.execute({
        sessionId: options.sessionId,
        turn: options.turn,
        step: options.step,
        call: options.call,
        signal: options.signal,
      });
    } catch (error: unknown) {
      return {
        content: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  }

  private toolsFor(sessionId?: AgentSessionId): AgentToolRegistry {
    return (
      (sessionId ? this.sessionTools.get(sessionId) : undefined)
      ?? this.tools
    );
  }

  private completeStep(
    sessionId: string,
    turn: number,
    step: number,
    reason: AgentStepEndReason,
  ): Promise<AgentEventOf<"step/completed">> {
    return this.appendEvent(sessionId, {
      type: "step/completed",
      payload: { turn, step, reason },
    });
  }

  private message(
    role: AgentMessage["role"],
    content: AgentContentBlock[],
    source?: Record<string, unknown>,
  ): AgentMessage {
    return {
      id: this.idFactory(),
      role,
      content,
      createdAt: this.now(),
      ...(source ? { source } : {}),
    };
  }

  private async requireState(sessionId: AgentSessionId): Promise<SessionState> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const loading = this.loading.get(sessionId);
    if (loading) return loading;
    const promise = this.loadState(sessionId);
    this.loading.set(sessionId, promise);
    try {
      const state = await promise;
      this.sessions.set(sessionId, state);
      return state;
    } finally {
      this.loading.delete(sessionId);
    }
  }

  private async loadState(sessionId: AgentSessionId): Promise<SessionState> {
    const events = await this.store.read(sessionId);
    if (!events.some((event) => event.type === "session/created")) {
      throw new Error(`Agent session "${sessionId}" does not exist`);
    }
    return this.createState(sessionId, events);
  }

  private async createState(
    sessionId: AgentSessionId,
    events: readonly AgentEvent[],
  ): Promise<SessionState> {
    return {
      sessionId,
      inbox: await AgentInbox.load(sessionId, this.store),
      lastTurn: latestTurn(events),
      running: false,
      wakeRequested: false,
      activity: Promise.resolve(),
      waiters: new Map(),
    };
  }

  private async appendEvent<TType extends AgentEventType>(
    sessionId: AgentSessionId,
    draft: AgentEventDraft<TType>,
  ): Promise<AgentEventOf<TType>> {
    const event = await this.store.append(sessionId, {
      ...draft,
      at: draft.at ?? this.now(),
    });
    for (const listener of this.listeners.get(sessionId) ?? []) {
      try {
        listener(event);
      } catch {
        // A projection subscriber must not corrupt the durable runtime.
      }
    }
    return event;
  }

  private deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }

  private rejectQueued(
    state: SessionState,
    prompts: readonly AgentPrompt[],
    error: unknown,
  ): void {
    for (const prompt of prompts) {
      const waiter = state.waiters.get(prompt.id);
      if (!waiter) continue;
      state.waiters.delete(prompt.id);
      waiter.reject(error);
    }
  }
}
