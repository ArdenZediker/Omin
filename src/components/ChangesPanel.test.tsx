import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FileCode2 } from "lucide-react";
import ChangesPanel from "./ChangesPanel";
import type { ChangeEntry } from "../chat/toolActionMap";

const openMock = vi.fn().mockResolvedValue(true);
const revealMock = vi.fn().mockResolvedValue(true);

vi.mock("./ArtifactCards", () => ({
  openArtifactPath: (...args: unknown[]) => openMock(...args),
  revealArtifactPath: (...args: unknown[]) => revealMock(...args),
}));

const entry: ChangeEntry = {
  name: "export_docx",
  verb: "导出",
  title: "Export Word",
  Icon: FileCode2,
  path: "D:/out/report.docx",
  badge: "已导出",
  argsSummary: '{ path: "D:/out/report.docx" }',
  resultPreview: "已生成并保存完成",
};

const UNIFIED_DIFF = [
  "--- a/report.md",
  "+++ b/report.md",
  "@@ -1,2 +1,3 @@",
  " old line",
  "-old line2",
  "+new line2",
  "+new line3",
].join("\n");

const entryWithDiff: ChangeEntry = {
  ...entry,
  name: "write_text_file",
  verb: "写入",
  title: "Write File",
  path: "D:/out/report.md",
  badge: "已写入",
  diff: {
    filename: "report.md",
    insertions: 2,
    deletions: 1,
    diffContent: UNIFIED_DIFF,
  },
};

describe("ChangesPanel（非 git 任务级文件清单）", () => {
  beforeEach(() => {
    openMock.mockClear();
    revealMock.mockClear();
  });

  it("无变更时显示空态引导，不调用 git 命令", () => {
    render(<ChangesPanel changes={[]} />);
    expect(screen.getByText("暂无变更")).toBeTruthy();
  });

  it("渲染文件产出条目、badge 与打开/定位按钮", () => {
    render(<ChangesPanel changes={[entry]} />);
    expect(screen.getByText("report.docx")).toBeTruthy();
    expect(screen.getByText("已导出")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("打开文件"));
    expect(openMock).toHaveBeenCalledWith("D:/out/report.docx");
    fireEvent.click(screen.getByLabelText("在文件夹中显示"));
    expect(revealMock).toHaveBeenCalledWith("D:/out/report.docx");
  });

  it("无 path 的条目禁用打开/定位按钮", () => {
    const noPath: ChangeEntry = { ...entry, path: undefined };
    render(<ChangesPanel changes={[noPath]} />);
    expect((screen.getByLabelText("打开文件") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("在文件夹中显示") as HTMLButtonElement).disabled).toBe(true);
  });

  it("多条变更显示计数徽标", () => {
    render(<ChangesPanel changes={[entry, { ...entry, name: "export_md" }]} />);
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("带 diff 的条目显示增删统计徽标（+N/−M）与查看差异按钮", () => {
    const { container } = render(<ChangesPanel changes={[entryWithDiff]} />);
    const add = container.querySelector(".diff-add");
    const del = container.querySelector(".diff-del");
    expect(add).not.toBeNull();
    expect(del).not.toBeNull();
    expect(add!.textContent).toBe("+2");
    expect(del!.textContent).toBe("−1");
    expect(screen.getByLabelText("查看差异")).toBeTruthy();
  });

  it("diff 默认折叠，点击查看差异后展开逐行 diff（+/− 着色）", () => {
    const { container } = render(<ChangesPanel changes={[entryWithDiff]} />);
    // 折叠态不渲染 diff 区域
    expect(container.querySelector(".changes-panel__diff")).toBeNull();

    fireEvent.click(screen.getByLabelText("查看差异"));
    const diffWrap = container.querySelector(".changes-panel__diff");
    expect(diffWrap).not.toBeNull();
    // unified-diff 内容透传
    expect(screen.getByText("+new line2")).toBeTruthy();
    expect(screen.getByText("+new line3")).toBeTruthy();
    expect(screen.getByText("-old line2")).toBeTruthy();
    // 着色类生效
    expect(container.querySelector(".diff-line--add")).not.toBeNull();
    expect(container.querySelector(".diff-line--del")).not.toBeNull();
    expect(container.querySelector(".diff-line--hunk")).not.toBeNull();
    // 按钮切换为收起
    expect(screen.getByLabelText("收起差异")).toBeTruthy();
  });

  it("无 diff 的条目不显示查看差异按钮", () => {
    const { container } = render(<ChangesPanel changes={[entry]} />);
    expect(container.querySelector(".diff-add")).toBeNull();
    expect(screen.queryByLabelText("查看差异")).toBeNull();
  });
});
