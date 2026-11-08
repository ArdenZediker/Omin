import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentEvent,
  AgentImage,
  AgentMessage,
  AgentModelConfig,
  AgentSessionId,
  AgentToolSchema,
} from "../agent-core";
import type {
  HostCommand,
  HostNotification,
  HostResult,
} from "../agent-host/protocol";
import { modelRegistry } from "../adapters/registry";
import type { ChatToolParam } from "../adapters/types";

export const AGENT_HOST_EVENT = "omni-agent-event";
export const AGENT_HOST_STATUS_EVENT = "omni-agent-host-status";
export const AGENT_HOST_CLIENT_TOOL_EVENT = "omni-agent-client-tool-call";

export interface AgentHostStatus {
  running: boolean;
  pid?: number | null;
  binaryPath?: string | null;
  dataDir?: string | null;
}

export interface AgentHostRequestInput {
  command: HostCommand;
  params?: Record<string, unknown>;
}

export interface AgentHostClientToolCall {
  kind: "native-tool-call";
  id: string;
  tool: string;
  arguments: string;
  sessionId: AgentSessionId;
  turn: number;
  step: number;
}

export interface AgentHostClientToolResult {
  content: string;
  isError?: boolean;
  concludesTurn?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function startAgentHost(): Promise<AgentHostStatus> {
  return invoke<AgentHostStatus>("agent_host_start");
}

export async function stopAgentHost(): Promise<void> {
  await invoke("agent_host_stop");
}

export async function agentHostStatus(): Promise<AgentHostStatus> {
  return invoke<AgentHostStatus>("agent_host_status");
}

export async function requestAgentHost<T extends HostResult>(
  command: HostCommand,
  params?: Record<string, unknown>,
): Promise<T> {
  return invoke<T>("agent_host_request", {
    request: {
      command,
      ...(params ? { params } : {}),
    } satisfies AgentHostRequestInput,
  });
}

export async function subscribeAgentHostEvents(
  listener: (notification: HostNotification) => void,
): Promise<UnlistenFn> {
  return listen<HostNotification>(AGENT_HOST_EVENT, (event) => {
    listener(event.payload);
  });
}

export async function subscribeAgentHostStatus(
  listener: (status: AgentHostStatus & { reason?: string }) => void,
): Promise<UnlistenFn> {
  return listen<AgentHostStatus & { reason?: string }>(AGENT_HOST_STATUS_EVENT, (event) => {
    listener(event.payload);
  });
}

export async function subscribeAgentHostClientToolCalls(
  listener: (call: AgentHostClientToolCall) => void,
): Promise<UnlistenFn> {
  return listen<AgentHostClientToolCall>(AGENT_HOST_CLIENT_TOOL_EVENT, (event) => {
    if (
      event.payload?.kind === "native-tool-call"
      && typeof event.payload.id === "string"
    ) {
      listener(event.payload);
    }
  });
}

export async function respondAgentHostClientToolCall(
  id: string,
  result: AgentHostClientToolResult,
): Promise<void> {
  await invoke("agent_host_client_tool_result", {
    input: {
      id,
      ok: true,
      result,
    },
  });
}

export async function failAgentHostClientToolCall(
  id: string,
  message: string,
  code = "CLIENT_TOOL_ERROR",
): Promise<void> {
  await invoke("agent_host_client_tool_result", {
    input: {
      id,
      ok: false,
      error: { message, code },
    },
  });
}

/**
 * Rehydrates the Host process with the current provider registry.
 *
 * Provider credentials intentionally live only in the Host process. Call this
 * after a Host restart and before the first prompt.
 */
export async function configureAgentHostProviders(): Promise<void> {
  for (const { provider, config } of modelRegistry.getProviderConfigs()) {
    await requestAgentHost("provider.configure", {
      provider,
      apiKey: config.apiKey ?? "",
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      ...(config.protocol ? { protocol: config.protocol } : {}),
      ...(config.customHeaders ? { customHeaders: config.customHeaders } : {}),
    });
  }
}

export async function ensureAgentHost(): Promise<AgentHostStatus> {
  const status = await startAgentHost();
  await configureAgentHostProviders();
  return status;
}

export function createAgentModelConfig(
  modelId: string,
  overrides: Partial<AgentModelConfig> = {},
): AgentModelConfig {
  const model = modelRegistry.getModelConfig(modelId);
  if (!model) {
    throw new Error(`No model configuration found for: ${modelId}`);
  }
  const reasoningEffort = overrides.reasoningEffort ?? model.defaultReasoningEffort;
  return {
    provider: overrides.provider ?? model.provider,
    model: overrides.model ?? model.requestModelId ?? model.id,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(overrides.maxTokens !== undefined
      ? { maxTokens: overrides.maxTokens }
      : model.maxOutput !== undefined
        ? { maxTokens: model.maxOutput }
        : {}),
    ...(overrides.temperature !== undefined ? { temperature: overrides.temperature } : {}),
  };
}

export async function createAgentSession(
  cwd: string,
  title?: string,
  history?: AgentMessage[],
): Promise<AgentSessionId> {
  const result = await requestAgentHost<{ sessionId: AgentSessionId }>(
    "session.create",
    {
      cwd,
      ...(title ? { title } : {}),
      ...(history?.length ? { history } : {}),
    },
  );
  return result.sessionId;
}

export async function configureAgentSessionTools(
  sessionId: AgentSessionId,
  tools: ChatToolParam[],
): Promise<AgentToolSchema[]> {
  const result = await requestAgentHost<{ tools: AgentToolSchema[] }>(
    "session.configure-tools",
    {
      sessionId,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.parameters ?? {
          type: "object",
          properties: {},
        },
      })),
    },
  );
  return result.tools;
}

export async function promptAgentSession(
  sessionId: AgentSessionId,
  content: string,
  model: AgentModelConfig,
  system?: string,
  images?: AgentImage[],
): Promise<string> {
  const result = await requestAgentHost<{ promptId: string }>("session.prompt", {
    sessionId,
    content,
    ...(images?.length ? { images } : {}),
    model,
    ...(system ? { system } : {}),
  });
  return result.promptId;
}

export async function cancelAgentSession(
  sessionId: AgentSessionId,
  reason?: string,
): Promise<void> {
  await requestAgentHost("session.cancel", {
    sessionId,
    ...(reason ? { reason } : {}),
  });
}

export async function readAgentEvents(
  sessionId: AgentSessionId,
  afterSeq?: number,
  limit?: number,
): Promise<AgentEvent[]> {
  const result = await requestAgentHost<{ events: AgentEvent[] }>("session.events", {
    sessionId,
    ...(afterSeq !== undefined ? { afterSeq } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
  return result.events;
}

export { errorMessage as agentHostErrorMessage };
