import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const root = resolve(import.meta.dirname, "..");
const target = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
}[`${process.platform}-${process.arch}`];
if (!target) {
  throw new Error(`agent-host smoke: unsupported platform ${process.platform}/${process.arch}`);
}

const extension = process.platform === "win32" ? ".exe" : "";
const binary = join(
  root,
  "src-tauri",
  "binaries",
  `omni-agent-host-${target}${extension}`,
);
const dataDir = await mkdtemp(join(tmpdir(), "omni-agent-host-smoke-"));
const modelRequests = [];

function writeSse(response, events) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  for (const event of events) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  response.write("data: [DONE]\n\n");
  response.end();
}

const modelServer = createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    const parsed = JSON.parse(body);
    modelRequests.push(parsed);
    const hasToolResult = parsed.messages.some((message) => message.role === "tool");
    if (!hasToolResult) {
      writeSse(response, [{
        id: "chatcmpl-tool",
        object: "chat.completion.chunk",
        model: "mock-model",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: "call-read",
              type: "function",
              function: {
                name: "read_file",
                arguments: "{\"path\":\"README.md\"}",
              },
            }],
          },
          finish_reason: null,
        }],
      }]);
      return;
    }
    writeSse(response, [
      {
        id: "chatcmpl-final-1",
        object: "chat.completion.chunk",
        model: "mock-model",
        choices: [{
          index: 0,
          delta: { content: "native tool completed: " },
          finish_reason: null,
        }],
      },
      {
        id: "chatcmpl-final-2",
        object: "chat.completion.chunk",
        model: "mock-model",
        choices: [{
          index: 0,
          delta: { content: "file body" },
          finish_reason: "stop",
        }],
      },
      {
        id: "chatcmpl-final-2",
        object: "chat.completion.chunk",
        model: "mock-model",
        choices: [],
        usage: {
          prompt_tokens: 21,
          completion_tokens: 8,
          total_tokens: 29,
        },
      },
    ]);
  });
});

await new Promise((resolveListen, rejectListen) => {
  modelServer.once("error", rejectListen);
  modelServer.listen(0, "127.0.0.1", resolveListen);
});
const address = modelServer.address();
if (!address || typeof address === "string") {
  throw new Error("agent-host smoke: model server did not expose a TCP port");
}

class HostProcess {
  constructor(label) {
    this.label = label;
    this.pending = new Map();
    this.events = [];
    this.waiters = new Set();
    this.stderr = "";
    this.child = spawn(binary, ["--data-dir", dataDir], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.lines = createInterface({
      input: this.child.stdout,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    this.lines.on("line", (line) => this.receive(line));
    this.exit = new Promise((resolveExit, rejectExit) => {
      this.child.once("error", rejectExit);
      this.child.once("exit", (code, signal) => {
        resolveExit({ code, signal });
      });
    });
  }

  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.fail(new Error(`invalid Host JSON: ${line}\n${String(error)}`));
      return;
    }
    if (message.kind === "response") {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.ok) waiter.resolve(message.result);
      else waiter.reject(new Error(message.error?.message ?? "Host request failed"));
      return;
    }
    if (message.kind === "native-tool-call") {
      this.child.stdin.write(`${JSON.stringify({
        kind: "native-tool-result",
        id: message.id,
        ok: true,
        result: { content: "file body", isError: false },
      })}\n`);
      return;
    }
    if (message.kind === "event") {
      this.events.push(message.event);
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(message.event)) {
          this.waiters.delete(waiter);
          waiter.resolve(message.event);
        }
      }
    }
  }

  fail(error) {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
  }

  request(command, params) {
    const id = `${this.label}-${crypto.randomUUID()}`;
    const promise = new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`Host request timed out: ${command}; stderr=${this.stderr}`));
      }, 15_000);
      this.pending.set(id, {
        resolve(value) {
          clearTimeout(timer);
          resolveRequest(value);
        },
        reject(error) {
          clearTimeout(timer);
          rejectRequest(error);
        },
      });
    });
    this.child.stdin.write(`${JSON.stringify({
      kind: "request",
      id,
      command,
      ...(params ? { params } : {}),
    })}\n`);
    return promise;
  }

  waitForEvent(predicate) {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolveEvent, rejectEvent) => {
      const waiter = {
        predicate,
        resolve(value) {
          clearTimeout(timer);
          resolveEvent(value);
        },
        reject(error) {
          clearTimeout(timer);
          rejectEvent(error);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        rejectEvent(new Error(`Host event timed out; stderr=${this.stderr}`));
      }, 15_000);
      this.waiters.add(waiter);
    });
  }

  async close() {
    await this.request("host.shutdown");
    this.child.stdin.end();
    const exit = await Promise.race([
      this.exit,
      new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(null), 3_000)),
    ]);
    if (exit === null) {
      this.child.kill();
      await this.exit;
      throw new Error(`Host ${this.label} did not exit after graceful shutdown`);
    }
    if (exit.code !== 0) {
      throw new Error(
        `Host ${this.label} exited with code ${exit.code}, signal ${exit.signal}; stderr=${this.stderr}`,
      );
    }
  }
}

try {
  const first = new HostProcess("first");
  const ping = await first.request("host.ping");
  if (ping.pong !== true) throw new Error("host.ping did not return pong");

  await first.request("provider.configure", {
    provider: "mock",
    apiKey: "smoke-token",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    protocol: "openai",
  });
  await first.request("tools.configure", {
    tools: [{
      name: "read_file",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      parallelSafe: true,
    }],
  });
  const created = await first.request("session.create", {
    cwd: root,
    title: "Agent Host smoke",
  });
  const completedPromise = first.waitForEvent((event) =>
    event.sessionId === created.sessionId && event.type === "turn/completed"
  );
  await first.request("session.prompt", {
    sessionId: created.sessionId,
    content: "read README.md",
    model: { provider: "mock", model: "mock-model" },
  });
  const completed = await completedPromise;
  if (completed.payload.reason.kind !== "completed") {
    throw new Error(`turn did not complete successfully: ${JSON.stringify(completed.payload.reason)}`);
  }
  const eventTypes = first.events
    .filter((event) => event.sessionId === created.sessionId)
    .map((event) => event.type);
  for (const expected of [
    "turn/started",
    "tool/call",
    "tool/result",
    "assistant/message",
    "turn/completed",
  ]) {
    if (!eventTypes.includes(expected)) {
      throw new Error(`missing Host event: ${expected}; got ${eventTypes.join(", ")}`);
    }
  }
  if (modelRequests.length !== 2) {
    throw new Error(`expected two model requests, got ${modelRequests.length}`);
  }
  if (!modelRequests[0].tools?.some((tool) => tool.function?.name === "read_file")) {
    throw new Error("first model request did not include the native read_file schema");
  }
  if (!modelRequests[1].messages?.some((message) => message.role === "tool")) {
    throw new Error("second model request did not include the native tool result");
  }
  await first.close();

  const logs = (await readdir(dataDir)).filter((name) => name.endsWith(".jsonl"));
  if (logs.length !== 1) {
    throw new Error(`expected one persisted Host log, found ${logs.length}`);
  }
  const jsonl = await readFile(join(dataDir, logs[0]), "utf8");
  if (!jsonl.includes("\"turn/completed\"")) {
    throw new Error("session JSONL did not persist turn/completed");
  }

  const second = new HostProcess("second");
  const replayed = await second.request("session.events", {
    sessionId: created.sessionId,
  });
  if (!replayed.events.some((event) => event.type === "session/created")) {
    throw new Error("replayed session events did not include session/created");
  }
  if (!replayed.events.some((event) => event.type === "tool/result")) {
    throw new Error("replayed session events did not include tool/result");
  }
  await second.close();

  process.stdout.write(
    `agent-host smoke passed: ${eventTypes.length} events, ${modelRequests.length} model calls, restart replay ok\n`,
  );
} finally {
  await new Promise((resolveClose) => modelServer.close(resolveClose));
  await rm(dataDir, { recursive: true, force: true });
}
