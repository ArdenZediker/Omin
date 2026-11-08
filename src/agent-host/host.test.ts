import { describe, expect, it } from "vitest";
import {
  AgentRuntime,
  AgentToolRegistry,
  InMemorySessionEventStore,
  type ModelProvider,
} from "../agent-core";
import { AgentHost } from "./host";
import { NativeToolController } from "./native-bridge";
import type {
  HostNotification,
  HostRequest,
  HostResponse,
  HostServerMessage,
} from "./protocol";
import type {
  AgentProviderRegistry,
  AgentProviderStatus,
} from "./provider-settings";
import { HostStdioServer } from "./stdio";

type HostRequestWithoutEnvelope<T> = T extends unknown
  ? Omit<T, "kind" | "id">
  : never;

function oneTurnModel(text = "host answer"): ModelProvider {
  return {
    async *stream() {
      yield { type: "text-delta", text };
      yield { type: "finish", reason: { kind: "stop" } };
    },
  };
}

function runtime(model = oneTurnModel()): AgentRuntime {
  return new AgentRuntime({
    store: new InMemorySessionEventStore(),
    model,
    tools: new AgentToolRegistry(),
  });
}

function request(
  id: string,
  body: HostRequestWithoutEnvelope<HostRequest>,
): HostRequest {
  return { kind: "request", id, ...body } as HostRequest;
}

describe("AgentHost", () => {
  it("owns session commands and publishes durable runtime events", async () => {
    const host = new AgentHost(runtime());
    const notifications: HostNotification[] = [];
    host.subscribe((notification) => notifications.push(notification));

    const ping = await host.handle(request("1", { command: "host.ping" }));
    expect(ping).toMatchObject({
      kind: "response",
      id: "1",
      ok: true,
      result: { pong: true, protocolVersion: 1 },
    });

    const created = await host.handle(request("2", {
      command: "session.create",
      params: { cwd: "/workspace", title: "Host test" },
    }));
    expect(created.ok).toBe(true);
    if (!created.ok || !("sessionId" in created.result)) {
      throw new Error("session.create did not return a session id");
    }
    const sessionId = created.result.sessionId;

    const prompted = await host.handle(request("3", {
      command: "session.prompt",
      params: {
        sessionId,
        content: "hello",
        images: [{ src: "data:image/png;base64,AAAA", name: "shot.png" }],
        model: { provider: "test", model: "test-model" },
      },
    }));
    expect(prompted).toMatchObject({ ok: true, result: { promptId: expect.any(String) } });

    const idle = await host.handle(request("4", {
      command: "session.when-idle",
      params: { sessionId },
    }));
    expect(idle).toMatchObject({ ok: true, result: {} });
    expect(notifications.some((notification) =>
      notification.event.type === "turn/completed"
    )).toBe(true);

    const eventResult = await host.handle(request("5", {
      command: "session.events",
      params: { sessionId },
    }));
    expect(eventResult.ok).toBe(true);
    if (eventResult.ok && "events" in eventResult.result) {
      expect(eventResult.result.events.map((event) => event.type))
        .toContain("assistant/message");
      const userMessage = eventResult.result.events.find((event) =>
        event.type === "user/message"
      );
      expect(userMessage).toMatchObject({
        type: "user/message",
        payload: {
          message: {
            content: [
              {
                type: "image",
                image: { src: "data:image/png;base64,AAAA", name: "shot.png" },
              },
              { type: "text", text: "hello" },
            ],
          },
        },
      });
    }
  });

  it("returns structured command errors without killing the host", async () => {
    const host = new AgentHost(runtime());
    const missing = await host.handle(request("1", {
      command: "session.status",
      params: { sessionId: "missing" },
    }));
    expect(missing).toMatchObject({
      kind: "response",
      id: "1",
      ok: false,
      error: { message: expect.stringContaining("does not exist") },
    });

    const ping = await host.handle(request("2", { command: "host.ping" }));
    expect(ping.ok).toBe(true);
  });

  it("cancels active sessions before shutting down", async () => {
    const model: ModelProvider = {
      async *stream({ signal }) {
        if (signal.aborted) throw new DOMException("cancelled", "AbortError");
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("cancelled", "AbortError"));
          }, { once: true });
        });
        yield { type: "finish", reason: { kind: "stop" } };
      },
    };
    const host = new AgentHost(runtime(model));
    const created = await host.handle(request("create", {
      command: "session.create",
      params: { cwd: "/workspace" },
    }));
    if (!created.ok || !("sessionId" in created.result)) {
      throw new Error("session.create did not return a session id");
    }
    await host.handle(request("prompt", {
      command: "session.prompt",
      params: {
        sessionId: created.result.sessionId,
        content: "wait",
        model: { provider: "test", model: "test-model" },
      },
    }));

    await expect(host.handle(request("shutdown", {
      command: "host.shutdown",
    }))).resolves.toMatchObject({
      ok: true,
      result: {},
    });
    const events = await host.handle(request("events", {
      command: "session.events",
      params: { sessionId: created.result.sessionId },
    }));
    expect(events.ok).toBe(true);
    if (!events.ok || !("events" in events.result)) {
      throw new Error("session.events failed");
    }
    expect(events.result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "turn/completed",
        payload: expect.objectContaining({
          reason: expect.objectContaining({ kind: "aborted" }),
        }),
      }),
    ]));
  });

  it("configures providers without returning credentials", async () => {
    const statuses = new Map<string, AgentProviderStatus>();
    const providers: AgentProviderRegistry = {
      configureProvider(settings) {
        const status: AgentProviderStatus = {
          provider: settings.provider,
          protocol: settings.protocol ?? "openai",
          hasApiKey: settings.apiKey.length > 0,
          ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
        };
        statuses.set(settings.provider, status);
        return status;
      },
      removeProvider(provider) {
        return statuses.delete(provider);
      },
      listProviders() {
        return [...statuses.values()];
      },
    };
    const host = new AgentHost(runtime(), providers);

    const configured = await host.handle(request("configure", {
      command: "provider.configure",
      params: {
        provider: "openai",
        apiKey: "super-secret",
        baseUrl: "https://example.test/v1",
        protocol: "openai",
      },
    }));
    expect(configured).toMatchObject({
      ok: true,
      result: {
        provider: "openai",
        protocol: "openai",
        baseUrl: "https://example.test/v1",
        hasApiKey: true,
      },
    });
    expect(JSON.stringify(configured)).not.toContain("super-secret");

    const listed = await host.handle(request("list", {
      command: "provider.list",
    }));
    expect(listed).toMatchObject({
      ok: true,
      result: { providers: [{ provider: "openai", hasApiKey: true }] },
    });

    const removed = await host.handle(request("remove", {
      command: "provider.remove",
      params: { provider: "openai" },
    }));
    expect(removed).toMatchObject({ ok: true, result: { removed: true } });
  });

  it("configures native tools through the Host contract", async () => {
    const tools = new AgentToolRegistry();
    const nativeTools = new NativeToolController(tools);
    const host = new AgentHost(new AgentRuntime({
      store: new InMemorySessionEventStore(),
      model: oneTurnModel(),
      tools,
    }), undefined, nativeTools);

    const configured = await host.handle(request("configure-tools", {
      command: "tools.configure",
      params: {
        tools: [{
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object" },
          parallelSafe: true,
        }],
      },
    }));
    expect(configured).toMatchObject({
      ok: true,
      result: {
        tools: [{
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object" },
        }],
      },
    });
  });

  it("keeps configured tools scoped to one session", async () => {
    const tools = new AgentToolRegistry();
    const nativeTools = new NativeToolController(tools);
    const host = new AgentHost(new AgentRuntime({
      store: new InMemorySessionEventStore(),
      model: oneTurnModel(),
      tools,
    }), undefined, nativeTools);
    const first = await host.handle(request("create-first", {
      command: "session.create",
      params: { cwd: "/first" },
    }));
    const second = await host.handle(request("create-second", {
      command: "session.create",
      params: { cwd: "/second" },
    }));
    if (
      !first.ok
      || !("sessionId" in first.result)
      || !second.ok
      || !("sessionId" in second.result)
    ) {
      throw new Error("session.create failed");
    }

    const configured = await host.handle(request("configure-session", {
      command: "session.configure-tools",
      params: {
        sessionId: first.result.sessionId,
        tools: [{
          name: "todo_write",
          description: "Write todos",
          parameters: { type: "object" },
        }],
      },
    }));
    expect(configured).toMatchObject({
      ok: true,
      result: { tools: [{ name: "todo_write" }] },
    });

    const firstTools = await host.handle(request("first-tools", {
      command: "tools.list",
      params: { sessionId: first.result.sessionId },
    }));
    const secondTools = await host.handle(request("second-tools", {
      command: "tools.list",
      params: { sessionId: second.result.sessionId },
    }));
    expect(firstTools).toMatchObject({
      ok: true,
      result: { tools: [{ name: "todo_write" }] },
    });
    expect(secondTools).toMatchObject({
      ok: true,
      result: { tools: [] },
    });
  });
});

describe("HostStdioServer", () => {
  it("serves NDJSON requests and streams event notifications", async () => {
    const host = new AgentHost(runtime());
    const written: HostServerMessage[] = [];
    const server = new HostStdioServer(host, (line) => {
      written.push(JSON.parse(line) as HostServerMessage);
    });

    await server.run(lines([
      JSON.stringify(request("ping", { command: "host.ping" })),
      JSON.stringify(request("create", {
        command: "session.create",
        params: { cwd: "/workspace" },
      })),
    ]));
    const created = written.find((message): message is Extract<HostResponse, { ok: true }> =>
      message.kind === "response"
      && message.id === "create"
      && message.ok
    );
    if (!created || !("sessionId" in created.result)) {
      throw new Error("stdio create response missing");
    }
    const sessionId = created.result.sessionId;

    await server.run(lines([
      JSON.stringify(request("prompt", {
        command: "session.prompt",
        params: {
          sessionId,
          content: "hello",
          model: { provider: "test", model: "test-model" },
        },
      })),
      JSON.stringify(request("idle", {
        command: "session.when-idle",
        params: { sessionId },
      })),
    ]));

    expect(written.some((message) => message.kind === "event"
      && message.event.type === "turn/completed")).toBe(true);
    expect(written.some((message) => message.kind === "response"
      && message.id === "idle"
      && message.ok)).toBe(true);
  });

  it("returns a parse error and continues reading later requests", async () => {
    const host = new AgentHost(runtime());
    const written: HostServerMessage[] = [];
    const server = new HostStdioServer(host, (line) => {
      written.push(JSON.parse(line) as HostServerMessage);
    });

    await server.run(lines([
      "{not-json",
      JSON.stringify(request("ping", { command: "host.ping" })),
    ]));

    expect(written).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "response",
        id: "",
        ok: false,
        error: expect.objectContaining({ code: "PARSE_ERROR" }),
      }),
      expect.objectContaining({
        kind: "response",
        id: "ping",
        ok: true,
      }),
    ]));
  });

  it("routes control frames without treating them as Host requests", async () => {
    const host = new AgentHost(runtime());
    const written: HostServerMessage[] = [];
    const controls: unknown[] = [];
    const nativeResult = {
      kind: "native-tool-result",
      id: "call-1",
      ok: true,
      result: { content: "ok" },
    };
    const server = new HostStdioServer(host, (line) => {
      written.push(JSON.parse(line) as HostServerMessage);
    }, (message) => {
      if (typeof message === "object"
        && message !== null
        && "kind" in message
        && message.kind === "native-tool-result") {
        controls.push(message);
        return true;
      }
      return false;
    });

    await server.run(lines([
      JSON.stringify(nativeResult),
      JSON.stringify(request("ping", { command: "host.ping" })),
    ]));

    expect(controls).toEqual([nativeResult]);
    expect(written).toEqual([expect.objectContaining({
      kind: "response",
      id: "ping",
      ok: true,
    })]);
  });
});

async function* lines(values: string[]): AsyncIterable<string> {
  for (const value of values) yield value;
}
