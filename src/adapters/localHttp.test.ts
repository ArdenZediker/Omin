import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ channels: [] as Array<{ onmessage: (event: unknown) => void }>, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage!: (event: unknown) => void;
    constructor() { transport.channels.push(this); }
  },
  invoke: transport.invoke,
}));

import { fetchLoopbackHttp, isLoopbackHttpUrl, shouldProxyLoopbackHttp } from "./localHttp";

describe("loopback model transport", () => {
  beforeEach(() => {
    transport.channels.length = 0;
    transport.invoke.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  });

  it("recognizes IPv4, IPv6, and localhost but rejects LAN/public targets and credentials", () => {
    expect(isLoopbackHttpUrl("http://127.0.0.1:3425/v1")).toBe(true);
    expect(isLoopbackHttpUrl("http://[::1]:3425/v1")).toBe(true);
    expect(isLoopbackHttpUrl("http://localhost:3425/v1")).toBe(true);
    expect(isLoopbackHttpUrl("http://192.168.1.5:3425/v1")).toBe(false);
    expect(isLoopbackHttpUrl("http://localhost.attacker.test/v1")).toBe(false);
    expect(isLoopbackHttpUrl("http://token@localhost:3425/v1")).toBe(false);
    expect(shouldProxyLoopbackHttp("http://127.0.0.1:3425/v1")).toBe(true);
  });

  it("bridges response headers and stream chunks without a WebView fetch", async () => {
    let resolveInvoke!: () => void;
    transport.invoke.mockImplementation(() => new Promise<void>((resolve) => { resolveInvoke = resolve; }));
    const responsePromise = fetchLoopbackHttp("http://127.0.0.1:3425/v1/models", { method: "GET" });
    const channel = transport.channels[0];
    channel.onmessage({ type: "headers", status: 200, headers: { "content-type": "application/json" } });
    const response = await responsePromise;
    channel.onmessage({ type: "chunk", data: [...new TextEncoder().encode('{"data":[] }')] });
    channel.onmessage({ type: "end" });
    await expect(response.json()).resolves.toEqual({ data: [] });
    resolveInvoke();
    expect(transport.invoke).toHaveBeenCalledWith("loopback_http_request", expect.objectContaining({
      request: expect.objectContaining({ url: "http://127.0.0.1:3425/v1/models", method: "GET", timeoutMs: 60_000 }),
    }));
  });

  it("cancels the backend request when the response stream is aborted", async () => {
    let resolveInvoke!: () => void;
    transport.invoke.mockImplementation((command: string) => {
      if (command === "loopback_http_request") return new Promise<void>((resolve) => { resolveInvoke = resolve; });
      return Promise.resolve();
    });
    const abort = new AbortController();
    const responsePromise = fetchLoopbackHttp("http://127.0.0.1:3425/v1/chat/completions", { method: "POST" }, abort.signal);
    transport.channels[0].onmessage({ type: "headers", status: 200, headers: {} });
    const response = await responsePromise;
    const reading = response.body!.getReader().read();
    abort.abort();
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    expect(transport.invoke).toHaveBeenCalledWith("cancel_loopback_http_request", expect.any(Object));
    resolveInvoke();
  });
});