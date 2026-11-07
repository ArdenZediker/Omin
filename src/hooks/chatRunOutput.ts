import type { Message, ChatStep } from "../adapters/types";
import type { Artifact } from "../chat/artifacts";
import type { TaskExecutionResult } from "../chat/taskTypes";
import type { Project } from "../chat/types";
import { settleMessageSteps } from "../chat/stepSettlement";

/** Captured per invocation, never inferred from whichever chat is currently selected. */
export type ChatRunOutput = {
  sessionId: string | null;
  runId: number;
  project: Project | null;
  messages: Message[];
  artifacts: Artifact[];
  text: string;
  reasoning: string;
  task?: TaskExecutionResult;
};

export function createChatRunOutput(sessionId: string | null, runId: number, project: Project | null, messages: Message[]): ChatRunOutput {
  return { sessionId, runId, project, messages, artifacts: [], text: "", reasoning: "" };
}

function mergeUnique<T>(first: T[] = [], second: T[] = [], key: (entry: T) => string): T[] {
  const result = new Map(first.map((entry) => [key(entry), entry]));
  second.forEach((entry) => result.set(key(entry), entry));
  return [...result.values()];
}

/** Merge a terminal result into the existing reply; failed review must not erase streamed work. */
export function mergeChatRunReply(run: ChatRunOutput, previous?: Message, result?: TaskExecutionResult): Message {
  const final = result?.finalResult;
  const artifacts = mergeUnique(previous?.artifacts, run.artifacts, (entry) => entry.id);
  const steps = mergeUnique(mergeUnique(previous?.steps, result?.partialSteps, (entry: ChatStep) =>
    entry.type === "tool_call" ? `tool:${entry.name}:${entry.arguments}` :
      entry.type === "artifact" ? `artifact:${entry.artifactId}` : JSON.stringify(entry)), final?.steps, (entry: ChatStep) =>
    entry.type === "tool_call" ? `tool:${entry.name}:${entry.arguments}` :
      entry.type === "artifact" ? `artifact:${entry.artifactId}` : JSON.stringify(entry));
  for (const artifact of artifacts) {
    if (!steps.some((step) => step.type === "artifact" && step.artifactId === artifact.id)) {
      steps.push({ type: "artifact", artifactId: artifact.id, title: artifact.title });
    }
  }
  const partial = run.text || result?.partialText || previous?.content || "";
  const content = final?.content || result?.toolResult?.outputText || partial;
  // On failure a short final error is not a replacement for the already delivered partial answer.
  const preservePartial = result && result.status !== "completed" && partial && content && !content.includes(partial);
  return {
    ...previous,
    role: "project",
    content: preservePartial ? `${partial}\n\n${content}` : content,
    reasoning: final?.reasoning || run.reasoning || result?.partialReasoning || previous?.reasoning,
    knowledgeContext: final?.knowledgeContext ?? previous?.knowledgeContext,
    artifacts: artifacts.length ? artifacts : undefined,
    toolCallResults: mergeUnique(previous?.toolCallResults, final?.toolCallResults, (entry) => entry.id),
    steps: settleMessageSteps(steps),
  };
}

export function hasChatRunReply(message: Message) {
  return Boolean(message.content.trim() || message.reasoning?.trim() || message.steps?.length || message.artifacts?.length || message.toolCallResults?.length);
}

export function updateChatRunMessages(current: Message[], run: ChatRunOutput, result?: TaskExecutionResult): Message[] {
  const index = run.messages.length;
  const previous = current[index]?.role === "project" ? current[index] : undefined;
  const reply = mergeChatRunReply(run, previous, result);
  if (!hasChatRunReply(reply)) return current;
  return [...current.slice(0, index), reply, ...current.slice(index + (previous ? 1 : 0))];
}
