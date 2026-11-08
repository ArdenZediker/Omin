import type { AgentEvent } from "./events";
import type { AgentMessage } from "./types";

export function projectMessages(events: readonly AgentEvent[]): AgentMessage[] {
  const messages: AgentMessage[] = [];
  const created = events.find((event) => event.type === "session/created");
  if (created?.type === "session/created" && created.payload.history?.length) {
    messages.push(...created.payload.history);
  }
  for (const event of events) {
    switch (event.type) {
      case "user/message":
      case "assistant/message":
      case "tool/result":
        messages.push(event.payload.message);
        break;
      default:
        break;
    }
  }
  return messages;
}

export function latestTurn(events: readonly AgentEvent[]): number {
  let turn = 0;
  for (const event of events) {
    if (event.type === "turn/started") {
      turn = Math.max(turn, event.payload.turn);
    }
  }
  return turn;
}
