import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EventLogPort } from "../agent-core";
import type { AgentSessionId } from "../agent-core";

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT"
  );
}

/**
 * File-backed event log used by the Node Agent Host.
 *
 * Session ids never become path segments. The opaque file name prevents a
 * malformed or hostile id from escaping the configured data directory.
 */
export class FileEventLogPort implements EventLogPort {
  constructor(private readonly rootDir: string) {}

  async read(sessionId: AgentSessionId): Promise<string | null> {
    try {
      return await readFile(this.filePath(sessionId), "utf8");
    } catch (error: unknown) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  async append(sessionId: AgentSessionId, content: string): Promise<void> {
    const filePath = this.filePath(sessionId);
    await this.ensureParent(filePath);
    const handle = await open(filePath, "a", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async replace(sessionId: AgentSessionId, content: string): Promise<void> {
    const filePath = this.filePath(sessionId);
    await this.ensureParent(filePath);
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await rename(temporaryPath, filePath);
    } catch (error: unknown) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private filePath(sessionId: AgentSessionId): string {
    const digest = createHash("sha256").update(sessionId, "utf8").digest("hex");
    return join(this.rootDir, `${digest}.jsonl`);
  }

  private async ensureParent(filePath: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  }
}
