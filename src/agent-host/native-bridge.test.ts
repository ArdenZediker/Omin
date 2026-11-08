import { describe, expect, it } from "vitest";
import { AgentToolRegistry } from "../agent-core";
import {
  NativeStdioBridge,
  NativeToolController,
  type NativeBridgeRequest,
  type NativeBridgeResult,
} from "./native-bridge";

function context(signal = new AbortController().signal) {
  return { sessionId: "session-1", turn: 1, step: 2, signal };
}

describe("NativeStdioBridge", () => {
  it("correlates calls and forwards tool results", async () => {
    const written: NativeBridgeRequest[] = [];
    const bridge = new NativeStdioBridge((message) => {
      written.push(message);
    });

    const result = bridge.call("read_file", "{\"path\":\"README.md\"}", context());
    expect(written[0]).toMatchObject({
      kind: "native-tool-call",
      tool: "read_file",
      arguments: "{\"path\":\"README.md\"}",
      sessionId: "session-1",
      turn: 1,
      step: 2,
    });

    const response: NativeBridgeResult = {
      kind: "native-tool-result",
      id: written[0].id,
      ok: true,
      result: { content: "contents", isError: false },
    };
    expect(bridge.receive(response)).toBe(true);
    await expect(result).resolves.toEqual({
      content: "contents",
    });
  });

  it("sends a cancel frame and rejects when the runtime aborts", async () => {
    const written: NativeBridgeRequest[] = [];
    const bridge = new NativeStdioBridge((message) => {
      written.push(message);
    });
    const controller = new AbortController();
    const result = bridge.call("execute", "{}", context(controller.signal));

    controller.abort(new Error("stop"));

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(written[1]).toMatchObject({
      kind: "native-tool-cancel",
      id: written[0].id,
      reason: "stop",
    });
  });

  it("returns native failures as structured errors", async () => {
    const written: NativeBridgeRequest[] = [];
    const bridge = new NativeStdioBridge((message) => {
      written.push(message);
    });
    const result = bridge.call("write_file", "{}", context());

    bridge.receive({
      kind: "native-tool-result",
      id: written[0].id,
      ok: false,
      error: { message: "permission denied", code: "PERMISSION_DENIED" },
    } satisfies NativeBridgeResult);

    await expect(result).rejects.toMatchObject({
      name: "PERMISSION_DENIED",
      message: "permission denied",
    });
  });
});

describe("NativeToolController", () => {
  it("registers schemas and routes execution through the bridge", async () => {
    const registry = new AgentToolRegistry();
    const controller = new NativeToolController(registry);
    const calls: Array<{ tool: string; args: string }> = [];
    controller.attachBridge({
      async call(tool, args) {
        calls.push({ tool, args });
        return { content: "native result" };
      },
    });
    controller.configureTools([{
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object" },
      parallelSafe: true,
    }]);

    expect(registry.schemas()).toEqual([{
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object" },
    }]);
    await expect(registry.get("read_file")?.execute({
      sessionId: "session-1",
      turn: 1,
      step: 1,
      call: { id: "call-1", name: "read_file", arguments: "{\"path\":\"x\"}" },
      signal: new AbortController().signal,
    })).resolves.toEqual({ content: "native result" });
    expect(calls).toEqual([{ tool: "read_file", args: "{\"path\":\"x\"}" }]);
    await expect(registry.executionMode("read_file", "{}")).resolves.toBe("parallel");
  });

  it("replaces the previous configured schema set", () => {
    const registry = new AgentToolRegistry();
    const controller = new NativeToolController(registry);
    controller.configureTools([{
      name: "old",
      description: "Old tool",
      parameters: {},
    }]);
    controller.configureTools([{
      name: "new",
      description: "New tool",
      parameters: {},
    }]);
    expect(registry.schemas().map((tool) => tool.name)).toEqual(["new"]);
  });

  it("creates isolated registries for session-scoped tools", async () => {
    const controller = new NativeToolController(new AgentToolRegistry());
    controller.attachBridge({
      async call(tool) {
        return { content: `${tool} result` };
      },
    });
    const first = controller.createTools([{
      name: "first_tool",
      description: "First",
      parameters: { type: "object" },
    }]);
    const second = controller.createTools([{
      name: "second_tool",
      description: "Second",
      parameters: { type: "object" },
    }]);

    expect(first.schemas().map((tool) => tool.name)).toEqual(["first_tool"]);
    expect(second.schemas().map((tool) => tool.name)).toEqual(["second_tool"]);
    await expect(first.get("first_tool")?.execute({
      sessionId: "session-1",
      turn: 1,
      step: 1,
      call: { id: "call-1", name: "first_tool", arguments: "{}" },
      signal: new AbortController().signal,
    })).resolves.toEqual({ content: "first_tool result" });
  });
});
