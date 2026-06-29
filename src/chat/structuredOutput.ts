import type { SuggestedAssistantMemory, SuggestedSessionSummary } from "./types";
import { OMNI_STRUCTURED_MEMORY_TAG, OMNI_STRUCTURED_SUMMARY_TAG } from "./promptModules";

type ParsedStructuredOutput = {
  content: string;
  suggestedMemories: SuggestedAssistantMemory[];
  suggestedSummary: SuggestedSessionSummary | null;
};

function readTagBlock(content: string, tag: string) {
  const pattern = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*<\\/${tag}>`, "i");
  const match = content.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function stripTagBlocks(content: string) {
  return content
    .replace(new RegExp(`\\n?\\s*<${OMNI_STRUCTURED_MEMORY_TAG}>[\\s\\S]*?<\\/${OMNI_STRUCTURED_MEMORY_TAG}>\\s*`, "gi"), "\n")
    .replace(new RegExp(`\\n?\\s*<${OMNI_STRUCTURED_SUMMARY_TAG}>[\\s\\S]*?<\\/${OMNI_STRUCTURED_SUMMARY_TAG}>\\s*`, "gi"), "\n")
    .trim();
}

function clip(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function parseJsonBlock<T>(raw: string | null): T | null {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function parseSuggestedMemories(raw: string | null) {
  const parsed = parseJsonBlock<Array<{ content?: unknown; reason?: unknown }>>(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }

  const seen = new Set<string>();
  return parsed
    .map((item) => ({
      content: typeof item.content === "string" ? clip(item.content, 120) : "",
      reason: typeof item.reason === "string" ? clip(item.reason, 120) : null,
    }))
    .filter((item) => item.content.length >= 4)
    .filter((item) => {
      const key = item.content.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 3);
}

function parseSuggestedSummary(raw: string | null): SuggestedSessionSummary | null {
  const parsed = parseJsonBlock<{ title?: unknown; summary?: unknown }>(raw);
  if (!parsed || typeof parsed.summary !== "string") {
    return null;
  }
  const summary = clip(parsed.summary, 220);
  if (!summary) {
    return null;
  }
  return {
    title: typeof parsed.title === "string" ? clip(parsed.title, 18) : null,
    summary,
  };
}

export function parseOmniStructuredOutput(content: string): ParsedStructuredOutput {
  const memoryBlock = readTagBlock(content, OMNI_STRUCTURED_MEMORY_TAG);
  const summaryBlock = readTagBlock(content, OMNI_STRUCTURED_SUMMARY_TAG);
  return {
    content: stripTagBlocks(content),
    suggestedMemories: parseSuggestedMemories(memoryBlock),
    suggestedSummary: parseSuggestedSummary(summaryBlock),
  };
}
