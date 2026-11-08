import type {
  AgentEvent,
  AgentEventDraft,
  AgentEventOf,
  AgentEventType,
} from "./events";
import type { SessionEventStore } from "./event-store";
import type { AgentSessionId } from "./types";

/**
 * Storage implementation used by a JSONL event store.
 *
 * `read` returns the complete UTF-8 log text. `append` must append exactly the
 * supplied text. `replace` replaces the complete log and is used only to
 * discard an incomplete final line after a crash.
 */
export interface EventLogPort {
  read(sessionId: AgentSessionId): Promise<string | null>;
  append(sessionId: AgentSessionId, content: string): Promise<void>;
  replace(sessionId: AgentSessionId, content: string): Promise<void>;
  delete(sessionId: AgentSessionId): Promise<void>;
}

export class EventLogCorruptionError extends Error {
  constructor(
    readonly sessionId: AgentSessionId,
    readonly line: number,
    detail: string,
  ) {
    super(`corrupt event log for session "${sessionId}" at line ${line}: ${detail}`);
    this.name = "EventLogCorruptionError";
  }
}

interface SessionLog {
  events: AgentEvent[];
  validContent: string;
  hasIncompleteTail: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLog(sessionId: AgentSessionId, content: string): SessionLog {
  const events: AgentEvent[] = [];
  const lines = content.split("\n");
  const completeLineCount = lines.length - 1;
  let validContent = "";

  for (let index = 0; index < completeLineCount; index += 1) {
    const line = lines[index].replace(/\r$/, "");
    const lineNumber = index + 1;
    if (line.length === 0) {
      throw new EventLogCorruptionError(sessionId, lineNumber, "empty line");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new EventLogCorruptionError(sessionId, lineNumber, "invalid JSON");
    }
    if (!isRecord(parsed)) {
      throw new EventLogCorruptionError(sessionId, lineNumber, "event must be an object");
    }

    const expectedSeq = events.length + 1;
    if (parsed.seq !== expectedSeq) {
      throw new EventLogCorruptionError(
        sessionId,
        lineNumber,
        `expected seq ${expectedSeq}, received ${String(parsed.seq)}`,
      );
    }
    if (parsed.sessionId !== sessionId) {
      throw new EventLogCorruptionError(
        sessionId,
        lineNumber,
        "event belongs to a different session",
      );
    }
    if (typeof parsed.type !== "string" || parsed.type.length === 0) {
      throw new EventLogCorruptionError(sessionId, lineNumber, "missing event type");
    }
    if (typeof parsed.at !== "number" || !Number.isFinite(parsed.at)) {
      throw new EventLogCorruptionError(sessionId, lineNumber, "invalid event timestamp");
    }
    if (!isRecord(parsed.payload)) {
      throw new EventLogCorruptionError(sessionId, lineNumber, "invalid event payload");
    }

    events.push(parsed as unknown as AgentEvent);
    validContent += `${line}\n`;
  }

  return {
    events,
    validContent,
    hasIncompleteTail: content.length > 0 && !content.endsWith("\n"),
  };
}

/**
 * Durable JSONL session event store with strict per-session ordering.
 *
 * A process crash can leave a partial final line. That line is never exposed
 * to callers and is removed before the next append. Corruption anywhere in a
 * completed line is rejected so replay cannot silently diverge from history.
 */
export class JsonlSessionEventStore implements SessionEventStore {
  private readonly logs = new Map<AgentSessionId, SessionLog>();
  private readonly loading = new Map<AgentSessionId, Promise<SessionLog>>();
  private readonly queues = new Map<AgentSessionId, Promise<void>>();

  constructor(private readonly port: EventLogPort) {}

  append<TType extends AgentEventType>(
    sessionId: AgentSessionId,
    draft: AgentEventDraft<TType>,
  ): Promise<AgentEventOf<TType>> {
    return this.serialize(sessionId, async () => {
      const log = await this.load(sessionId);
      if (log.hasIncompleteTail) {
        await this.port.replace(sessionId, log.validContent);
        log.hasIncompleteTail = false;
      }

      const event = {
        ...draft,
        seq: log.events.length + 1,
        sessionId,
        at: draft.at ?? Date.now(),
      } as AgentEventOf<TType>;
      const line = `${JSON.stringify(event)}\n`;
      await this.port.append(sessionId, line);
      log.events.push(event);
      log.validContent += line;
      return event;
    });
  }

  async read(
    sessionId: AgentSessionId,
    options: { afterSeq?: number; limit?: number } = {},
  ): Promise<AgentEvent[]> {
    await this.queues.get(sessionId);
    const log = await this.load(sessionId);
    const afterSeq = options.afterSeq ?? 0;
    const limit = Math.max(0, options.limit ?? Number.POSITIVE_INFINITY);
    return log.events
      .filter((event) => event.seq > afterSeq)
      .slice(0, limit);
  }

  delete(sessionId: AgentSessionId): Promise<void> {
    return this.serialize(sessionId, async () => {
      this.logs.delete(sessionId);
      this.loading.delete(sessionId);
      await this.port.delete(sessionId);
    });
  }

  private async load(sessionId: AgentSessionId): Promise<SessionLog> {
    const existing = this.logs.get(sessionId);
    if (existing) return existing;

    const inFlight = this.loading.get(sessionId);
    if (inFlight) return inFlight;

    const loading = this.port.read(sessionId).then((content) => {
      const log = parseLog(sessionId, content ?? "");
      this.logs.set(sessionId, log);
      return log;
    });
    this.loading.set(sessionId, loading);
    try {
      return await loading;
    } finally {
      this.loading.delete(sessionId);
    }
  }

  private serialize<T>(
    sessionId: AgentSessionId,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(sessionId, tail);
    void tail.finally(() => {
      if (this.queues.get(sessionId) === tail) {
        this.queues.delete(sessionId);
      }
    });
    return result;
  }
}
