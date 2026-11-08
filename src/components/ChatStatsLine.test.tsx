// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Message } from "../adapters/types";
import ChatStatsLine from "./ChatStatsLine";

const settledTurn = (overrides: Partial<Message> = {}): Message => ({
  role: "project",
  content: "answer",
  turnUsage: {
    inputTokens: 1_000,
    outputTokens: 40,
    totalTokens: 1_040,
    model: "test",
    toolRounds: 1,
    cachedPromptTokens: 360,
    generationDurationMs: 2_000,
        modelDurationMs: 69_000,
        ttftDurationMs: 12_000,
        ttftSamples: 1,
  },
  ...overrides,
});

describe("ChatStatsLine", () => {
  it("renders DSH-style turn, throughput, token and cache-hit stats", () => {
    const messages: Message[] = [
      { role: "user", content: "q1" },
      settledTurn({ content: "a1", toolCallResults: [] }),
      { role: "user", content: "q2" },
      settledTurn(),
    ];
    render(<ChatStatsLine messages={messages} />);

    expect(screen.getByTitle(/2 轮 2 步 · 20 tok\/s/).textContent)
      .toContain("2.1K tok · 缓存命中 36%");
  });

  it("waits for the current streamed answer to settle before changing stats", () => {
    const messages: Message[] = [
      { role: "user", content: "q1" },
      settledTurn(),
      { role: "user", content: "q2" },
      { role: "project", content: "partial" },
    ];
    render(<ChatStatsLine messages={messages} isLoading />);

    expect(screen.getByTitle(/1 轮 1 步/).textContent).not.toContain("partial");
  });

  it("opens session and token details from the stats line", () => {
    const messages: Message[] = [
      { role: "user", content: "q1" },
      settledTurn(),
    ];
    render(<ChatStatsLine messages={messages} />);

    fireEvent.click(screen.getByRole("button", { name: /会话统计/ }));
    const sessionDialog = screen.getByRole("dialog", { name: "会话统计" });
    expect(within(sessionDialog).getByText("模型用时").parentElement?.textContent)
      .toContain("1分9秒");
    expect(within(sessionDialog).getByText(/首 token 平均/).parentElement?.textContent)
      .toContain("12秒");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "会话统计" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Token 用量/ }));
    const tokenDialog = screen.getByRole("dialog", { name: "Token 用量" });
    expect(tokenDialog.textContent).toContain("1,040 tok");
    expect(tokenDialog.textContent).toContain("缓存命中36%");
    expect(tokenDialog.textContent).toContain("未缓存输入640 tok");
    expect(tokenDialog.textContent).toContain("缓存读取360 tok");
    expect(tokenDialog.textContent).toContain("输出40 tok");
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Token 用量" })).toBeNull();
  });

  it("opens the DSH-style context breakdown", () => {
    render(
      <ChatStatsLine
        messages={[]}
        contextUsage={{
          modelId: "test",
          contextWindow: 100_000,
          systemPrompt: "system prompt",
          tools: [],
          mcpTools: [],
          skillsPrompt: "",
          messages: [],
          inputText: "hello",
          inputImages: [],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /上下文已用/ }));
    const dialog = screen.getByRole("dialog", { name: "上下文用量" });
    expect(dialog.textContent).toContain("上下文已用");
    expect(dialog.textContent).toContain("系统提示词");
    expect(dialog.textContent).toContain("工具定义");
    expect(dialog.textContent).toContain("对话消息");
  });
});
