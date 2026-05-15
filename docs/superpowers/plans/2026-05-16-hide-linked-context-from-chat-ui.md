# Hide Linked Context From Chat UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep knowledge/context linkage available to the model, but remove the linkage scaffolding from visible chat messages.

**Architecture:** Split the composer payload into two parts: the user-visible prompt and a hidden context block. Thread the hidden block through the chat send pipeline and merge it into the model system prompt before execution. Leave message rendering and session history unchanged so the chat bubble only shows the actual user question.

**Tech Stack:** React, TypeScript, Tauri, existing chat runtime and model adapter layer.

---

### Task 1: Split the composer payload

**Files:**
- Modify: `src/components/ChatInput.tsx`

- [ ] **Step 1: Update the submit payload shape**

```ts
type ChatInputProps = {
  onSend: (content: string, images?: string[], hiddenContext?: string) => void;
};
```

- [ ] **Step 2: Send the visible message and hidden context separately**

```ts
const visibleContent = input.trim();
const hiddenContext =
  contextLines.length > 0 && contextPresetText
    ? `【上下文要求】\n请优先结合以下来源回答：\n${contextLines.join("\n")}\n\n【可用上下文】\n${contextPresetText}`
    : undefined;

onSend(visibleContent, images.length > 0 ? images : undefined, hiddenContext);
```

- [ ] **Step 3: Verify the composer no longer concatenates context into the visible text**

Run: `pnpm exec tsc --noEmit`
Expected: no type errors from the new `onSend` signature.

### Task 2: Thread hidden context into the runtime

**Files:**
- Modify: `src/hooks/useChatRuntime.ts`
- Modify: `src/chat/taskExecutor.ts`

- [ ] **Step 1: Extend the send handler signature**

```ts
const handleSend = useCallback(
  async (content: string, images?: string[], hiddenContext?: string) => {
```

- [ ] **Step 2: Pass the hidden context into the input task**

```ts
const taskResult = await executeInputTask({
  input: content,
  images,
  hiddenContext,
  currentMessages: messages,
  model: executionModel,
  signal: abortController.signal,
  systemPrompt: assistantSystemPrompt,
  onPrepareConversation: (preparedMessages) => {
    conversationMessagesForTask = preparedMessages;
    if (!sessionId) {
      const nextSession = createSessionFromMessages(preparedMessages);
      sessionId = nextSession.id;
    }
    setMessages([...preparedMessages, { role: "assistant", content: "" }]);
  },
  onChunk: /* existing chunk handler */,
  executeTool,
});
```

- [ ] **Step 3: Merge the hidden context into the model system prompt**

```ts
const effectiveSystemPrompt = [systemPrompt, hiddenContext?.trim()].filter(Boolean).join("\n\n") || undefined;

return executeTask({
  model,
  messages: preparedMessages,
  signal,
  systemPrompt: effectiveSystemPrompt,
  onChunk,
  intent,
  plan,
});
```

- [ ] **Step 4: Verify the task executor still prepares the same visible conversation history**

Run: `pnpm exec tsc --noEmit`
Expected: task execution continues to use the same `preparedMessages` array for display and storage.

### Task 3: Rebuild and spot-check the UI

**Files:**
- No code changes expected

- [ ] **Step 1: Run a type check**

Run: `pnpm exec tsc --noEmit`
Expected: pass.

- [ ] **Step 2: Open the chat composer and send a question with linked context enabled**

Expected: the chat bubble shows only the user question, while the model still receives the linked context.

