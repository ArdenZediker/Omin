import type {
  AgentEvent,
  AgentRuntime,
} from "../agent-core";
import type {
  HostNotification,
  HostRequest,
  HostResponse,
  HostResult,
} from "./protocol";
import type { AgentProviderRegistry } from "./provider-settings";

export type HostNotificationListener = (message: HostNotification) => void;

/**
 * Transport-neutral Agent Host.
 *
 * The Host owns runtime access and translates commands into inbox operations.
 * A stdio, WebSocket, or Tauri bridge can sit on top without changing the
 * command/event contract.
 */
export class AgentHost {
  private readonly listeners = new Set<HostNotificationListener>();
  private readonly subscribedSessions = new Set<string>();

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly providers?: AgentProviderRegistry,
  ) {}

  subscribe(listener: HostNotificationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async handle(request: HostRequest): Promise<HostResponse> {
    try {
      return {
        kind: "response",
        id: request.id,
        ok: true,
        result: await this.dispatch(request),
      };
    } catch (error: unknown) {
      return {
        kind: "response",
        id: request.id,
        ok: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.name ? { code: error.name } : {}),
        },
      };
    }
  }

  private async dispatch(request: HostRequest): Promise<HostResult> {
    switch (request.command) {
      case "host.ping":
        return { pong: true, protocolVersion: 1 };
      case "session.create": {
        const sessionId = await this.runtime.createSession(request.params);
        this.trackSession(sessionId);
        return { sessionId };
      }
      case "session.prompt":
      case "session.followup": {
        this.trackSession(request.params.sessionId);
        const queued = await this.runtime.enqueueFollowup(
          request.params.sessionId,
          request.params.content,
          {
            model: request.params.model,
            ...(request.params.system ? { system: request.params.system } : {}),
          },
        );
        // Completion is represented by durable events. Keep the promise
        // observed so a Host does not emit an unhandled rejection if a
        // queued prompt is cleared by cancellation.
        void queued.result.catch(() => undefined);
        return { promptId: queued.promptId };
      }
      case "session.steer":
      case "session.inject": {
        this.trackSession(request.params.sessionId);
        const options = {
          model: request.params.model,
          ...(request.params.system ? { system: request.params.system } : {}),
        };
        const promptId = request.command === "session.steer"
          ? await this.runtime.steer(
              request.params.sessionId,
              request.params.content,
              options,
            )
          : await this.runtime.inject(
              request.params.sessionId,
              request.params.content,
              options,
            );
        return { promptId };
      }
      case "session.cancel":
        this.trackSession(request.params.sessionId);
        await this.runtime.cancel(request.params.sessionId, {
          ...(request.params.keepInbox === undefined
            ? {}
            : { keepInbox: request.params.keepInbox }),
          ...(request.params.reason ? { reason: request.params.reason } : {}),
        });
        return {};
      case "session.remove-pending":
        this.trackSession(request.params.sessionId);
        return {
          removed: await this.runtime.removePending(
            request.params.sessionId,
            request.params.promptId,
          ),
        };
      case "session.when-idle":
        this.trackSession(request.params.sessionId);
        await this.runtime.whenIdle(request.params.sessionId);
        return {};
      case "session.status":
        this.trackSession(request.params.sessionId);
        return { running: await this.runtime.isRunning(request.params.sessionId) };
      case "session.events": {
        this.trackSession(request.params.sessionId);
        const events = await this.runtime.readEvents(request.params.sessionId, {
          ...(request.params.afterSeq === undefined
            ? {}
            : { afterSeq: request.params.afterSeq }),
          ...(request.params.limit === undefined
            ? {}
            : { limit: request.params.limit }),
        });
        return { events };
      }
      case "tools.list":
        return { tools: this.runtime.listTools() };
      case "provider.configure":
        return this.requireProviders().configureProvider(request.params);
      case "provider.remove":
        return {
          removed: this.requireProviders().removeProvider(request.params.provider),
        };
      case "provider.list":
        return { providers: this.requireProviders().listProviders() };
    }
  }

  private requireProviders(): AgentProviderRegistry {
    if (!this.providers) {
      throw new Error("provider registry is not available in this Host");
    }
    return this.providers;
  }

  private trackSession(sessionId: string): void {
    if (this.subscribedSessions.has(sessionId)) return;
    this.subscribedSessions.add(sessionId);
    this.runtime.subscribe(sessionId, (event: AgentEvent) => {
      const message: HostNotification = { kind: "event", event };
      for (const listener of this.listeners) {
        try {
          listener(message);
        } catch {
          // A disconnected subscriber must not stop event persistence.
        }
      }
    });
  }
}
