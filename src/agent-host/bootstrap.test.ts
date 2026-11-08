import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPersistentAgentHost } from "./bootstrap";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omni-agent-host-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => (
      rm(directory, { recursive: true, force: true })
    )),
  );
});

describe("createPersistentAgentHost", () => {
  it("reopens durable session metadata in a new Host instance", async () => {
    const dataDir = await temporaryDirectory();
    const first = createPersistentAgentHost({ dataDir });
    const created = await first.host.handle({
      kind: "request",
      id: "create",
      command: "session.create",
      params: { cwd: "/workspace", title: "Durable" },
    });
    if (!created.ok || !("sessionId" in created.result)) {
      throw new Error("session.create did not return a session id");
    }
    const sessionId = created.result.sessionId;

    const resumed = createPersistentAgentHost({ dataDir });
    const events = await resumed.host.handle({
      kind: "request",
      id: "events",
      command: "session.events",
      params: { sessionId },
    });

    expect(events).toMatchObject({
      ok: true,
      result: {
        events: [{
          seq: 1,
          sessionId,
          type: "session/created",
          payload: { cwd: "/workspace", title: "Durable" },
        }],
      },
    });
  });

  it("accepts provider configuration without persisting credentials", async () => {
    const dataDir = await temporaryDirectory();
    const app = createPersistentAgentHost({ dataDir });
    const configured = await app.host.handle({
      kind: "request",
      id: "configure",
      command: "provider.configure",
      params: {
        provider: "openai",
        apiKey: "temporary-secret",
        protocol: "openai",
      },
    });
    expect(configured).toMatchObject({
      ok: true,
      result: { provider: "openai", hasApiKey: true },
    });

    const resumed = createPersistentAgentHost({ dataDir });
    const listed = await resumed.host.handle({
      kind: "request",
      id: "list",
      command: "provider.list",
    });
    expect(listed).toMatchObject({ ok: true, result: { providers: [] } });
  });
});
