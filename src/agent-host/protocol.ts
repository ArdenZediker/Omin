import type {
  AgentEvent,
  AgentModelConfig,
  AgentSessionId,
  AgentToolSchema,
} from "../agent-core";
import type {
  AgentProviderSettings,
  AgentProviderStatus,
} from "./provider-settings";

export type HostRequest =
  | {
      kind: "request";
      id: string;
      command: "host.ping";
    }
  | {
      kind: "request";
      id: string;
      command: "session.create";
      params: { cwd: string; title?: string };
    }
  | {
      kind: "request";
      id: string;
      command: "session.prompt" | "session.followup";
      params: {
        sessionId: AgentSessionId;
        content: string;
        model: AgentModelConfig;
        system?: string;
      };
    }
  | {
      kind: "request";
      id: string;
      command: "session.steer" | "session.inject";
      params: {
        sessionId: AgentSessionId;
        content: string;
        model: AgentModelConfig;
        system?: string;
      };
    }
  | {
      kind: "request";
      id: string;
      command: "session.cancel";
      params: {
        sessionId: AgentSessionId;
        keepInbox?: boolean;
        reason?: string;
      };
    }
  | {
      kind: "request";
      id: string;
      command: "session.remove-pending";
      params: { sessionId: AgentSessionId; promptId: string };
    }
  | {
      kind: "request";
      id: string;
      command: "session.when-idle";
      params: { sessionId: AgentSessionId };
    }
  | {
      kind: "request";
      id: string;
      command: "session.status";
      params: { sessionId: AgentSessionId };
    }
  | {
      kind: "request";
      id: string;
      command: "session.events";
      params: {
        sessionId: AgentSessionId;
        afterSeq?: number;
        limit?: number;
      };
    }
  | {
      kind: "request";
      id: string;
      command: "tools.list";
    }
  | {
      kind: "request";
      id: string;
      command: "provider.configure";
      params: AgentProviderSettings;
    }
  | {
      kind: "request";
      id: string;
      command: "provider.remove";
      params: { provider: string };
    }
  | {
      kind: "request";
      id: string;
      command: "provider.list";
    };

export type HostCommand = HostRequest["command"];

export type HostResult =
  | { pong: true; protocolVersion: 1 }
  | { sessionId: AgentSessionId }
  | { promptId: string }
  | { removed: boolean }
  | { running: boolean }
  | { events: AgentEvent[] }
  | { tools: AgentToolSchema[] }
  | AgentProviderStatus
  | { providers: AgentProviderStatus[] }
  | Record<string, never>;

export type HostResponse =
  | {
      kind: "response";
      id: string;
      ok: true;
      result: HostResult;
    }
  | {
      kind: "response";
      id: string;
      ok: false;
      error: { message: string; code?: string };
    };

export type HostNotification = {
  kind: "event";
  event: AgentEvent;
};

export type HostServerMessage = HostResponse | HostNotification;
