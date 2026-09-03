// ChangesPanel 单元测试 — 覆盖概览/分组渲染与 DiffBody 行号推进
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitFileChange, GitFileDiff } from "../chat/gitChanges";

// Tauri invoke mock — 允许按调用顺序返回不同结果（先 fetchGitStatus 后 fetchGitDiff）
const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// Tauri dialog mock — 在 ChangesPanel 的「选择目录…」按钮分支使用
const mockOpenDialog = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => mockOpenDialog(...args),
}));

import ChangesPanel from "./ChangesPanel";

const files: GitFileChange[] = [
  { path: "src-tauri/src/lib.rs", status: " M", additions: 100, deletions: 50, staged: false },
  { path: "src-tauri/src/legacy.rs", status: "M ", additions: 39, deletions: 0, staged: true },
  { path: "src-tauri/src/MIGRATION.md", status: "??", additions: 124, deletions: 0, staged: false },
  { path: "src-tauri/src/old.rs", status: " D", additions: 0, deletions: 12, staged: false },
  { path: "assets/logo.png", status: "??", additions: -1, deletions: -1, staged: false },
];

const unifiedDiff = [
  "diff --git a/foo.rs b/foo.rs",
  "index 1234..5678 100644",
  "--- a/foo.rs",
  "+++ b/foo.rs",
  "@@ -1,3 +1,3 @@",
  "-old line",
  "+new line",
  " unchanged",
  "@@ -10,2 +10,4 @@",
  "+inserted 1",
  "+inserted 2",
].join("\n");

beforeEach(() => {
  mockInvoke.mockReset();
  mockOpenDialog.mockReset();
});

afterEach(() => {
  mockInvoke.mockReset();
  mockOpenDialog.mockReset();
});

describe("ChangesPanel 变更面板", () => {
  it("工作区路径为空时显示「未绑定项目工作区」空态，可一键「选择目录…」", async () => {
    render(<ChangesPanel workspacePath={null} />);
    expect(await screen.findByText("未绑定项目工作区")).toBeTruthy();
    expect(mockInvoke).not.toHaveBeenCalled();
    // 选择目录按钮出现
    const pickBtn = screen.getByLabelText("选择目录");
    expect(pickBtn).toBeTruthy();
  });

  it("点击「选择目录…」按钮唤起 dialog，选定路径后拉取对应仓库 status", async () => {
    mockOpenDialog.mockResolvedValueOnce("D:/my-repo");
    mockInvoke.mockResolvedValueOnce(files);
    render(<ChangesPanel workspacePath={null} />);

    const pickBtn = await screen.findByLabelText("选择目录");
    fireEvent.click(pickBtn);

    await waitFor(() => expect(mockOpenDialog).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: "选择本地目录查看 Git 变更",
    }));

    // 选完目录后应以该路径拉 status
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("git_status_files", { projectPath: "D:/my-repo" });
    });
    // 顶部徽标会出现工作区路径
    expect(await screen.findByText("D:/my-repo")).toBeTruthy();
    // 拿到文件列表后看到分组
    expect(await screen.findByText("工作区改动")).toBeTruthy();
  });

  it("调用 git_status_files 拉取列表并展示分组与汇总", async () => {
    mockInvoke.mockResolvedValueOnce(files);
    render(<ChangesPanel workspacePath="D:/repo" branchName="feature/p0" />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("git_status_files", { projectPath: "D:/repo" });
    });

    // 总加/删（排除 binary）= 100+39+124 = 263 ; 50 + 0 + 0 = 50
    expect(screen.getByText("+263")).toBeTruthy();
    expect(screen.getByText("-50")).toBeTruthy();
    expect(screen.getAllByText(/lib\.rs/).length).toBeGreaterThan(0);
    expect(screen.getByText(/MIGRATION\.md/)).toBeTruthy();
    expect(screen.getAllByText("二进制").length).toBeGreaterThan(0);
    // 分组标题应至少出现「未跟踪/工作区改动/已暂存/删除」
    expect(screen.getByText("工作区改动")).toBeTruthy();
    expect(screen.getByText("已暂存")).toBeTruthy();
    expect(screen.getByText("未跟踪")).toBeTruthy();
    expect(screen.getByText("删除")).toBeTruthy();
    // 分支徽标
    expect(screen.getByText("feature/p0")).toBeTruthy();
  });

  it("空工作区显示「工作区干净」", async () => {
    mockInvoke.mockResolvedValueOnce([]);
    render(<ChangesPanel workspacePath="D:/repo" />);
    expect(await screen.findByText("工作区干净")).toBeTruthy();
  });

  it("git 失败时显示错误与重试", async () => {
    mockInvoke.mockRejectedValueOnce("fatal: not a git repository");
    render(<ChangesPanel workspacePath="D:/nope" />);
    expect(await screen.findByText("无法读取工作区变更")).toBeTruthy();
    expect(screen.getByText("重试")).toBeTruthy();
  });

  it("点击文件行触发 fetchGitDiff 并渲染 diff", async () => {
    mockInvoke.mockResolvedValueOnce(files);
    mockInvoke.mockResolvedValueOnce({
      path: "src-tauri/src/lib.rs",
      status: " M",
      unified_diff: unifiedDiff,
      additions: 1,
      deletions: 1,
    } satisfies GitFileDiff);
    render(<ChangesPanel workspacePath="D:/repo" />);

    await waitFor(() => expect(screen.getByText(/lib\.rs/)).toBeTruthy());
    // 点开第一个变更 (lib.rs 是工作区改动组的首个)
    fireEvent.click(screen.getAllByRole("button", { name: /lib\.rs/ })[0]);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("git_diff_file", {
        projectPath: "D:/repo",
        filePath: "src-tauri/src/lib.rs",
        staged: false,
      });
    });
    // 渲染 hunk 头与 @@ 段
    expect(await screen.findByText("@@ -1,3 +1,3 @@")).toBeTruthy();
    expect(await screen.findByText("@@ -10,2 +10,4 @@")).toBeTruthy();
    // 行号表头单元格存在
    const cells = document.querySelectorAll(".changes-panel__lineno");
    expect(cells.length).toBeGreaterThan(0);
  });

  it("diff 加载失败时显示错误", async () => {
    mockInvoke.mockResolvedValueOnce(files);
    mockInvoke.mockRejectedValueOnce("binary diff unsupported");
    render(<ChangesPanel workspacePath="D:/repo" />);
    await waitFor(() => expect(screen.getAllByText(/lib\.rs/).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole("button", { name: /lib\.rs/ })[0]);

    expect(await screen.findByText("读取 diff 失败")).toBeTruthy();
    expect(screen.getByText(/binary diff unsupported/)).toBeTruthy();
  });

  it("「选择目录…」被取消时（dialog 返回 null）不触发 status 拉取", async () => {
    mockOpenDialog.mockResolvedValueOnce(null);
    render(<ChangesPanel workspacePath={null} />);
    fireEvent.click(await screen.findByLabelText("选择目录"));
    // dialog 返回 null 不应触发 invoke
    await waitFor(() => expect(mockOpenDialog).toHaveBeenCalled());
    // 给一点时间确认不会发生意外拉取
    await new Promise((r) => setTimeout(r, 30));
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("概览标题栏的刷新按钮重新拉取", async () => {
    mockInvoke.mockResolvedValueOnce(files).mockResolvedValueOnce([]);
    render(<ChangesPanel workspacePath="D:/repo" />);
    await waitFor(() => expect(screen.getAllByText(/lib\.rs/).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByTitle("刷新变更列表"));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(2));
  });
});
