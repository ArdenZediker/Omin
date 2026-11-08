import type {
  AgentEvent,
  AgentEventDraft,
  AgentEventOf,
  AgentEventType,
} from "./events";
import type { AgentSessionId } from "./types";

export interface SessionEventStore {
  append<TType extends AgentEventType>(
    sessionId: AgentSessionId,
    draft: AgentEventDraft<TType>,
  ): Promise<AgentEventOf<TType>>;
  read(
    sessionId: AgentSessionId,
    options?: { afterSeq?: number; limit?: number },
  ): Promise<AgentEvent[]>;
}

export class InMemorySessionEventStore implements SessionEventStore {
  private readonly sessions = new Map<AgentSessionId, AgentEvent[]>();

  async append<TType extends AgentEventType>(
    sessionId: AgentSessionId,
    draft: AgentEventDraft<TType>,
  ): Promise<AgentEventOf<TType>> {
    const events = this.sessions.get(sessionId) ?? [];
    const event = {
      ...draft,
      seq: events.length + 1,
      sessionId,
      at: draft.at ?? Date.now(),
    } as AgentEventOf<TType>;
    events.push(event);
    this.sessions.set(sessionId, events);
    return event;
  }

  async read(
    sessionId: AgentSessionId,
    options: { afterSeq?: number; limit?: number } = {},
  ): Promise<AgentEvent[]> {
    const afterSeq = options.afterSeq ?? 0;
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    return (this.sessions.get(sessionId) ?? [])
      .filter((event) => event.seq > afterSeq)
      .slice(0, limit);
  }
}
