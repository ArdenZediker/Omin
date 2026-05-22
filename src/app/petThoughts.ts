import type { PetThoughtState } from "./types";

export function getPetThoughtKey(thought: PetThoughtState) {
  if (thought.sessionId) {
    return `session:${thought.sessionId}`;
  }

  return thought.thoughtId ? `thought:${thought.thoughtId}` : `adhoc:${thought.updatedAt}`;
}

export function matchesPetThought(
  thought: PetThoughtState,
  target: { sessionId?: string | null; thoughtId?: string | null }
) {
  if (target.sessionId && thought.sessionId === target.sessionId) {
    return true;
  }

  return Boolean(target.thoughtId && thought.thoughtId === target.thoughtId);
}
