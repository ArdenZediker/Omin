/**
 * 跨适配器的工具调用（function calling）序列化层。
 *
 * 每种线协议（OpenAI 兼容 / Claude / Gemini / Ollama）对「工具声明、
 * assistant 发起调用、tool 结果回填」的表示不同，这里集中转换，
 * 适配器只负责对接 HTTP 层。
 *
 * 内部统一形态（见 adapters/types.ts）：
 * - ChatToolParam: { name, description?, parameters? }
 * - Message.role === "assistant" 且带 toolCalls → 模型发起的调用
 * - Message.role === "tool" → 一次调用的结果（toolCallId + content）
 */

import type { ChatToolCall, ChatToolParam, Message } from "./types";
import { toWireRole } from "./types";

// ---------------------------------------------------------------------------
// OpenAI 兼容协议（openai / deepseek / openrouter / moonshot / siliconflow /
// dashscope / zhipu 均走此格式）
// ---------------------------------------------------------------------------

export function toOpenAITools(tools?: ChatToolParam[]) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.parameters ?? { type: "object", properties: {} },
    },
  }));
}

/** 单条消息转 OpenAI 线格式（图片消息由调用方自行展开）。 */
export function toOpenAIMessage(msg: Message): Record<string, unknown> {
  if (msg.role === "tool") {
    return { role: "tool", tool_call_id: msg.toolCallId ?? "", content: msg.content };
  }
  if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: msg.content || null,
      tool_calls: msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
  }
  return { role: toWireRole(msg.role), content: msg.content };
}

export function parseOpenAIToolCalls(data: Record<string, unknown>): ChatToolCall[] | undefined {
  const choices = data.choices as Array<{ message?: { tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }> | undefined;
  const raw = choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.map((tc) => ({
    id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
    name: tc.function?.name ?? "",
    arguments: tc.function?.arguments ?? "{}",
  }));
}

// ---------------------------------------------------------------------------
// Claude / Anthropic 协议
// ---------------------------------------------------------------------------

export function toClaudeTools(tools?: ChatToolParam[]) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.parameters ?? { type: "object", properties: {} },
  }));
}

/** 把 tool_use / tool_result 块转成 Claude 线格式消息（图片分支由调用方展开）。 */
export function toClaudeMessage(msg: Message): Record<string, unknown> | null {
  if (msg.role === "system") return null; // system 由调用方单独抽出
  if (msg.role === "tool") {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: msg.toolCallId ?? "",
          content: msg.content,
        },
      ],
    };
  }
  if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
    const blocks: Array<Record<string, unknown>> = [];
    if (msg.content?.trim()) {
      blocks.push({ type: "text", text: msg.content });
    }
    for (const tc of msg.toolCalls) {
      let input: unknown = {};
      try {
        input = JSON.parse(tc.arguments || "{}");
      } catch {
        input = { raw: tc.arguments };
      }
      blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
    }
    return { role: "assistant", content: blocks };
  }
  return { role: toWireRole(msg.role), content: msg.content };
}

export function parseClaudeToolCalls(data: Record<string, unknown>): ChatToolCall[] | undefined {
  const content = data.content as Array<{ type?: string; id?: string; name?: string; input?: unknown }> | undefined;
  if (!Array.isArray(content)) return undefined;
  const calls = content.filter((b) => b.type === "tool_use");
  if (calls.length === 0) return undefined;
  return calls.map((c) => ({
    id: c.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
    name: c.name ?? "",
    arguments: JSON.stringify(c.input ?? {}),
  }));
}

// ---------------------------------------------------------------------------
// Gemini 协议
// ---------------------------------------------------------------------------

export function toGeminiTools(tools?: ChatToolParam[]) {
  if (!tools || tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        parameters: t.parameters ?? { type: "object", properties: {} },
      })),
    },
  ];
}

/** 转 Gemini content part；返回 null 表示该消息需要由调用方特殊处理。 */
export function toGeminiContent(msg: Message): { role: "user" | "model"; parts: Array<Record<string, unknown>> } | null {
  if (msg.role === "system") return null;
  if (msg.role === "tool") {
    return {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: msg.toolCallName ?? "",
            response: { result: msg.content },
          },
        },
      ],
    };
  }
  const parts: Array<Record<string, unknown>> = [];
  if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
    for (const tc of msg.toolCalls) {
      let args: unknown = {};
      try {
        args = JSON.parse(tc.arguments || "{}");
      } catch {
        args = { raw: tc.arguments };
      }
      parts.push({ functionCall: { name: tc.name, args } });
    }
    return { role: "model", parts };
  }
  parts.push({ text: msg.content });
  return { role: msg.role === "project" ? "model" : "user", parts };
}

export function parseGeminiToolCalls(data: Record<string, unknown>): ChatToolCall[] | undefined {
  const candidates = data.candidates as Array<{ content?: { parts?: Array<{ functionCall?: { name?: string; args?: unknown } }> } }> | undefined;
  const parts = candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return undefined;
  const calls = parts.filter((p) => p.functionCall);
  if (calls.length === 0) return undefined;
  return calls.map((p) => ({
    id: `gemini_${Math.random().toString(36).slice(2, 10)}`,
    name: p.functionCall?.name ?? "",
    arguments: JSON.stringify(p.functionCall?.args ?? {}),
  }));
}

// ---------------------------------------------------------------------------
// Ollama 协议（OpenAI 风格 tools，但 tool_calls 无 id，工具结果按顺序对应）
// ---------------------------------------------------------------------------

export function toOllamaTools(tools?: ChatToolParam[]) {
  return toOpenAITools(tools);
}

export function toOllamaMessage(msg: Message): Record<string, unknown> {
  if (msg.role === "tool") {
    // Ollama 的 tool 消息没有 tool_call_id，按顺序与 assistant.tool_calls 对应
    return { role: "tool", content: msg.content };
  }
  if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: msg.content,
      tool_calls: msg.toolCalls.map((tc) => ({
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
  }
  return { role: toWireRole(msg.role), content: msg.content };
}

export function parseOllamaToolCalls(data: Record<string, unknown>): ChatToolCall[] | undefined {
  const message = data.message as { tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> } | undefined;
  const raw = message?.tool_calls;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.map((tc, index) => ({
    id: `ollama_${index}_${Math.random().toString(36).slice(2, 8)}`,
    name: tc.function?.name ?? "",
    arguments:
      typeof tc.function?.arguments === "string"
        ? tc.function.arguments
        : JSON.stringify(tc.function?.arguments ?? {}),
  }));
}

// ---------------------------------------------------------------------------
// 流式 tool_calls 增量解析（SSE 逐 chunk 累加）
// ---------------------------------------------------------------------------

type OpenAIStreamToolDelta = Array<{
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}>;

/**
 * OpenAI 兼容流式 tool_calls 累加器：流式响应里 tool_calls 是增量片段
 * （同一 index 跨多个 chunk 的 id/name/arguments 拼接），结束时统一取出。
 */
export class OpenAIStreamToolAccumulator {
  private calls: ChatToolCall[] = [];
  private byIndex = new Map<number, { id?: string; name?: string; args: string }>();

  /** 喂入一个 SSE chunk 的 delta.tool_calls（可为空数组/undefined）。 */
  add(delta: OpenAIStreamToolDelta | undefined): void {
    if (!Array.isArray(delta)) return;
    for (const part of delta) {
      const index = part.index ?? 0;
      const entry = this.byIndex.get(index) ?? { args: "" };
      if (part.id) entry.id = part.id;
      if (part.function?.name) entry.name = part.function.name;
      if (part.function?.arguments) entry.args += part.function.arguments;
      this.byIndex.set(index, entry);
    }
  }

  /** 结束流式后取出完整调用；缺 name 的残片丢弃。 */
  getToolCalls(): ChatToolCall[] | undefined {
    for (const [index, entry] of this.byIndex) {
      if (!entry.name) {
        this.byIndex.delete(index);
        continue;
      }
      this.calls.push({
        id: entry.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
        name: entry.name,
        arguments: entry.args || "{}",
      });
    }
    this.byIndex.clear();
    return this.calls.length > 0 ? this.calls : undefined;
  }
}

/** Claude SSE：content_block_start(tool_use) + input_json_delta 增量 + content_block_stop。 */
export class ClaudeStreamToolAccumulator {
  private pending: Array<{ id?: string; name?: string; args: string; open: boolean }> = [];
  private calls: ChatToolCall[] = [];

  /** 喂入一个 SSE 事件（已 JSON.parse 的 data 对象）。 */
  add(event: { type?: string; index?: number; content_block?: { type?: string; id?: string; name?: string; input?: unknown }; delta?: { type?: string; partial_json?: string } }): void {
    if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
      this.pending[event.index ?? this.pending.length] = {
        id: event.content_block.id,
        name: event.content_block.name,
        args: typeof event.content_block.input === "object" && event.content_block.input ? JSON.stringify(event.content_block.input) : "",
        open: true,
      };
    } else if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta" && event.delta.partial_json) {
      const entry = this.pending[event.index ?? 0];
      if (entry) entry.args += event.delta.partial_json;
    } else if (event.type === "content_block_stop") {
      const entry = this.pending[event.index ?? 0];
      if (entry) entry.open = false;
    }
  }

  /** 流结束后取出完整调用（input_json 可能不完整，尽力 JSON 修复）。 */
  getToolCalls(): ChatToolCall[] | undefined {
    for (const entry of this.pending) {
      if (!entry || !entry.name) continue;
      let args = entry.args.trim();
      if (!args) {
        args = "{}";
      } else {
        try {
          JSON.parse(args);
        } catch {
          // 增量被截断（如参数里有未闭合引号），包一层补全
          try {
            args = JSON.stringify(JSON.parse(`{${args}}`));
          } catch {
            args = "{}";
          }
        }
      }
      this.calls.push({
        id: entry.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
        name: entry.name,
        arguments: args,
      });
    }
    this.pending = [];
    return this.calls.length > 0 ? this.calls : undefined;
  }
}

/** Gemini SSE：每个 chunk 的 parts 是全量快照，直接取带 functionCall 的。 */
export function parseGeminiStreamToolCalls(parts: Array<Record<string, unknown>> | undefined): ChatToolCall[] | undefined {
  if (!Array.isArray(parts)) return undefined;
  const calls = parts.filter((p) => p.functionCall && typeof p.functionCall === "object");
  if (calls.length === 0) return undefined;
  return calls.map((p) => {
    const fn = p.functionCall as { name?: string; args?: unknown } | undefined;
    return {
      id: `gemini_${Math.random().toString(36).slice(2, 10)}`,
      name: fn?.name ?? "",
      arguments: JSON.stringify(fn?.args ?? {}),
    };
  });
}
