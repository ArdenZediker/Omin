import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// mock SQLite 存储为内存实现
const memoryStore = new Map<string, string>();

vi.mock("../app/sqliteStorage", () => ({
  readSqliteBackedJson: <T,>(key: string, fallback: T): T => {
    const raw = memoryStore.get(key);
    if (!raw) return fallback;
    try {
      if (Array.isArray(fallback)) return JSON.parse(raw) as T;
      return { ...(fallback as object), ...JSON.parse(raw) } as T;
    } catch {
      return fallback;
    }
  },
  saveSqliteBackedValue: (key: string, value: string) => {
    memoryStore.set(key, value);
  },
  readSqliteBackedValue: (key: string): string | null => memoryStore.get(key) ?? null,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://${path}`,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn(),
}));

import ArtifactsPanel from "./ArtifactsPanel";
import { appendArtifact, loadArtifactPanelState } from "../chat/artifacts";

describe("ArtifactsPanel 产物面板", () => {
  beforeEach(() => {
    memoryStore.clear();
  });

  it("无产物时概览显示空状态", () => {
    render(<ArtifactsPanel projectId="p1" onJumpToSession={vi.fn()} />);

    expect(screen.getByRole("tab", { name: /概览/ })).toHaveClass("artifacts-panel__tab--active");
    expect(screen.getByText("暂无产物")).toBeTruthy();
  });

  it("有产物时概览显示统计与列表", () => {
    appendArtifact({ type: "docx", title: "周报.docx", size: 2048, projectId: "p1", sessionId: "s1" });
    appendArtifact({ type: "code", title: "main.tsx", size: 1024, projectId: "p1", sessionId: "s1" });

    render(<ArtifactsPanel projectId="p1" onJumpToSession={vi.fn()} />);

    // 统计卡片：总览
    const totalStat = screen.getByText("全部产物").closest(".artifacts-panel__overview-stat");
    expect(totalStat?.querySelector("strong")?.textContent).toBe("2");

    // 类型标签与文件标题
    expect(screen.getByText("文档")).toBeTruthy();
    expect(screen.getByText("代码")).toBeTruthy();
    expect(screen.getByText("周报.docx")).toBeTruthy();
    expect(screen.getByText("main.tsx")).toBeTruthy();
  });

  it("点击产物打开为文件标签", () => {
    const artifact = appendArtifact({ type: "text", title: "笔记.md", content: "# Hello", projectId: "p1", sessionId: "s1" });

    render(<ArtifactsPanel projectId="p1" onJumpToSession={vi.fn()} />);

    fireEvent.click(screen.getByText("笔记.md"));

    expect(screen.getByRole("tab", { name: /笔记\.md/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /笔记\.md/ })).toHaveClass("artifacts-panel__tab--active");
    expect(screen.getByText("Hello")).toBeTruthy();

    // 状态持久化
    const state = loadArtifactPanelState();
    expect(state.activeTabId).toBe(artifact.id);
    expect(state.openArtifactIds).toContain(artifact.id);
  });

  it("文件标签有关闭按钮，全部关闭后回到概览", () => {
    appendArtifact({ type: "text", title: "A.md", content: "A", projectId: "p1", sessionId: "s1" });
    appendArtifact({ type: "text", title: "B.md", content: "B", projectId: "p1", sessionId: "s1" });

    render(<ArtifactsPanel projectId="p1" onJumpToSession={vi.fn()} />);

    fireEvent.click(screen.getByText("A.md"));
    fireEvent.click(screen.getByRole("tab", { name: /概览/ }));
    fireEvent.click(screen.getByText("B.md"));

    expect(screen.getByRole("tab", { name: /A\.md/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /B\.md/ })).toBeTruthy();

    // 关闭 A
    fireEvent.click(screen.getAllByLabelText(/关闭/)[0]);
    expect(screen.queryByRole("tab", { name: /A\.md/ })).toBeNull();

    // 关闭 B
    fireEvent.click(screen.getAllByLabelText(/关闭/)[0]);
    expect(screen.queryByRole("tab", { name: /B\.md/ })).toBeNull();

    expect(screen.getByRole("tab", { name: /概览/ })).toHaveClass("artifacts-panel__tab--active");
    // 概览列表仍显示已关闭的产物，可再次点击打开
    expect(screen.getByText("A.md")).toBeTruthy();
    expect(screen.getByText("B.md")).toBeTruthy();

    const state = loadArtifactPanelState();
    expect(state.activeTabId).toBe("overview");
    expect(state.openArtifactIds).toHaveLength(0);
  });

  it("持久化：全部关闭后 reopen 默认展示概览", () => {
    appendArtifact({ type: "text", title: "C.md", content: "C", projectId: "p1", sessionId: "s1" });

    const { unmount } = render(<ArtifactsPanel projectId="p1" onJumpToSession={vi.fn()} />);
    fireEvent.click(screen.getByText("C.md"));
    expect(screen.getByRole("tab", { name: /C\.md/ })).toBeTruthy();

    // 关闭标签
    fireEvent.click(screen.getByLabelText(/关闭/));
    expect(screen.getByRole("tab", { name: /概览/ })).toHaveClass("artifacts-panel__tab--active");
    unmount();

    // 模拟重新挂载（边栏重新展开）
    render(<ArtifactsPanel projectId="p1" onJumpToSession={vi.fn()} />);
    expect(screen.getByRole("tab", { name: /概览/ })).toHaveClass("artifacts-panel__tab--active");
    expect(screen.queryByRole("tab", { name: /C\.md/ })).toBeNull();
  });

  it("删除产物后对应的打开标签自动清理", () => {
    const a = appendArtifact({ type: "text", title: "A.md", content: "A", projectId: "p1", sessionId: "s1" });
    const b = appendArtifact({ type: "text", title: "B.md", content: "B", projectId: "p1", sessionId: "s1" });

    render(<ArtifactsPanel projectId="p1" onJumpToSession={vi.fn()} />);
    fireEvent.click(screen.getByText("A.md"));
    fireEvent.click(screen.getByRole("tab", { name: /概览/ }));
    fireEvent.click(screen.getByText("B.md"));

    // 删除 A：先回到概览列表，找到 A.md 所在行并点击其删除按钮
    fireEvent.click(screen.getByRole("tab", { name: /概览/ }));
    const aItem = screen
      .getAllByRole("listitem")
      .find((item) => item.textContent?.includes("A.md")) as HTMLElement;
    const aRow = aItem.querySelector(".artifacts-panel__item-row") as HTMLElement;
    fireEvent.click(within(aRow).getByLabelText("删除该产物"));

    expect(screen.queryByRole("tab", { name: /A\.md/ })).toBeNull();
    expect(screen.getByRole("tab", { name: /B\.md/ })).toBeTruthy();

    const state = loadArtifactPanelState();
    expect(state.openArtifactIds).not.toContain(a.id);
    expect(state.openArtifactIds).toContain(b.id);
  });
});
