import type { SessionEventStore } from "./event-store";
import type { AgentPrompt, AgentSessionId } from "./types";

export type AgentInboxTarget = "next-turn" | "next-step";

type InboxState = Record<AgentInboxTarget, AgentPrompt[]>;

type InboxSplice = {
  target: AgentInboxTarget;
  start: number;
  removedCount?: number;
  inserted: AgentPrompt[];
  outcome?: "claimed" | "cancelled";
};

/**
 * Durable pending input for one agent session.
 *
 * The inbox is reconstructed solely from `agent/inbox/spliced` events. A
 * serialized command tail makes append/claim/clear atomic relative to one
 * another even when several Host RPC calls arrive concurrently.
 */
export class AgentInbox {
  private readonly state: InboxState = {
    "next-turn": [],
    "next-step": [],
  };
  private commandTail: Promise<void> = Promise.resolve();

  private constructor(
    readonly sessionId: AgentSessionId,
    private readonly store: SessionEventStore,
  ) {}

  static async load(
    sessionId: AgentSessionId,
    store: SessionEventStore,
  ): Promise<AgentInbox> {
    const inbox = new AgentInbox(sessionId, store);
    const events = await store.read(sessionId);
    for (const event of events) {
      if (event.type === "agent/inbox/spliced") {
        inbox.apply(event.payload);
      }
    }
    return inbox;
  }

  get nextTurn(): readonly AgentPrompt[] {
    return this.state["next-turn"];
  }

  get nextStep(): readonly AgentPrompt[] {
    return this.state["next-step"];
  }

  get hasPending(): boolean {
    return this.nextTurn.length > 0 || this.nextStep.length > 0;
  }

  append(target: AgentInboxTarget, prompt: AgentPrompt): Promise<void> {
    return this.serialize(async () => {
      await this.splice(target, this.state[target].length, 0, [prompt]);
    });
  }

  /**
   * Consume the entire next-step batch and, when requested, one next-turn
   * prompt. The returned messages retain their model order.
   */
  claim(target: AgentInboxTarget): Promise<AgentPrompt[]> {
    return this.serialize(async () => {
      const claimed = await this.splice(
        "next-step",
        0,
        this.state["next-step"].length,
        [],
        "claimed",
      );
      if (target === "next-turn") {
        claimed.push(...await this.splice("next-turn", 0, 1, [], "claimed"));
      }
      return claimed;
    });
  }

  clear(): Promise<AgentPrompt[]> {
    return this.serialize(async () => {
      const removed = await this.splice(
        "next-step",
        0,
        this.state["next-step"].length,
        [],
        "cancelled",
      );
      removed.push(...await this.splice(
        "next-turn",
        0,
        this.state["next-turn"].length,
        [],
        "cancelled",
      ));
      return removed;
    });
  }

  remove(target: AgentInboxTarget, promptId: string): Promise<boolean> {
    return this.serialize(async () => {
      const index = this.state[target].findIndex((prompt) => prompt.id === promptId);
      if (index < 0) return false;
      await this.splice(target, index, 1, [], "cancelled");
      return true;
    });
  }

  private async splice(
    target: AgentInboxTarget,
    requestedStart: number,
    requestedDeleteCount: number,
    inserted: AgentPrompt[],
    outcome?: InboxSplice["outcome"],
  ): Promise<AgentPrompt[]> {
    const inbox = this.state[target];
    const start = Math.min(Math.max(0, Math.trunc(requestedStart)), inbox.length);
    const removedCount = Math.min(
      Math.max(0, Math.trunc(requestedDeleteCount)),
      inbox.length - start,
    );
    if (removedCount === 0 && inserted.length === 0) return [];

    const splice: InboxSplice = {
      target,
      start,
      ...(removedCount === 0 ? {} : { removedCount }),
      inserted,
      ...(outcome === undefined ? {} : { outcome }),
    };
    this.validate(splice);
    const event = await this.store.append<"agent/inbox/spliced">(this.sessionId, {
      type: "agent/inbox/spliced",
      payload: splice,
    });
    return this.apply(event.payload);
  }

  private apply(splice: InboxSplice): AgentPrompt[] {
    this.validate(splice);
    return this.state[splice.target].splice(
      splice.start,
      splice.removedCount ?? 0,
      ...splice.inserted,
    );
  }

  private validate(splice: InboxSplice): void {
    const inbox = this.state[splice.target];
    const removedCount = splice.removedCount ?? 0;
    if (
      !Number.isSafeInteger(splice.start)
      || splice.start < 0
      || splice.start > inbox.length
      || !Number.isSafeInteger(removedCount)
      || removedCount < 0
      || splice.start + removedCount > inbox.length
    ) {
      throw new Error("invalid agent inbox splice");
    }

    const candidate = [
      ...inbox.slice(0, splice.start),
      ...splice.inserted,
      ...inbox.slice(splice.start + removedCount),
    ];
    const all = splice.target === "next-turn"
      ? [...candidate, ...this.nextStep]
      : [...this.nextTurn, ...candidate];
    const ids = new Set<string>();
    for (const prompt of all) {
      if (ids.has(prompt.id)) {
        throw new Error(`agent prompt "${prompt.id}" is already pending`);
      }
      ids.add(prompt.id);
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.commandTail.then(operation, operation);
    this.commandTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
