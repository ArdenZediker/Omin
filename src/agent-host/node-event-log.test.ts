import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlSessionEventStore } from "../agent-core";
import { FileEventLogPort } from "./node-event-log";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omni-agent-log-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createdEvent(title: string) {
  return {
    type: "session/created" as const,
    payload: { cwd: "/workspace", title },
    at: 1,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => (
      rm(directory, { recursive: true, force: true })
    )),
  );
});

describe("FileEventLogPort", () => {
  it("persists a session across store and port instances", async () => {
    const rootDir = await temporaryDirectory();
    const first = new JsonlSessionEventStore(new FileEventLogPort(rootDir));
    await first.append("session/with unsafe characters", createdEvent("one"));

    const resumed = new JsonlSessionEventStore(new FileEventLogPort(rootDir));
    const events = await resumed.read("session/with unsafe characters");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      seq: 1,
      sessionId: "session/with unsafe characters",
      type: "session/created",
    });

    const files = await readdir(rootDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.jsonl$/);
    expect(files[0]).not.toContain("unsafe");
  });

  it("truncates an incomplete crash tail before the next append", async () => {
    const rootDir = await temporaryDirectory();
    const store = new JsonlSessionEventStore(new FileEventLogPort(rootDir));
    await store.append("session-1", createdEvent("one"));

    const rootFiles = await readdir(rootDir);
    const filePath = join(rootDir, rootFiles[0]);
    const firstContent = await readFile(filePath, "utf8");
    await new FileEventLogPort(rootDir).append("session-1", '{"seq":2');

    const resumed = new JsonlSessionEventStore(new FileEventLogPort(rootDir));
    await resumed.append("session-1", createdEvent("two"));

    const repaired = await readFile(filePath, "utf8");
    expect(repaired.startsWith(firstContent)).toBe(true);
    expect(repaired.trimEnd().split("\n")).toHaveLength(2);
    expect(await resumed.read("session-1")).toHaveLength(2);
  });

  it("returns no events for a session that has never been written", async () => {
    const rootDir = await temporaryDirectory();
    const store = new JsonlSessionEventStore(new FileEventLogPort(rootDir));
    await expect(store.read("missing")).resolves.toEqual([]);
  });
});
