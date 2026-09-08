import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { FileCode2 } from "lucide-react";
import ChangesPanel from "./ChangesPanel";
import type { ChangeEntry } from "../chat/toolActionMap";

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

function getFileButton(container: HTMLElement) {
  return container.querySelector(".changes-panel__file") as HTMLButtonElement;
}

function getBackButton(container: HTMLElement) {
  return container.querySelector(".changes-panel__diff-back") as HTMLButtonElement;
}

describe("ChangesPanel（非 git 任务级文件清单）", () => {
  it("无变更时显示空态引导", () => {
    render(<ChangesPanel changes={[]} />);
    expect(screen.getByText("暂无变更")).toBeTruthy();
  });

  it("文件列表只显示文件名与 diff 统计", () => {
    render(<ChangesPanel changes={[entry, entryWithDiff]} />);
    expect(screen.getByText("report.docx")).toBeTruthy();
    expect(screen.getByText("report.md")).toBeTruthy();
    // 右侧统计
    expect(screen.getByText("+2")).toBeTruthy();
    expect(screen.getByText("−1")).toBeTruthy();
    // 不渲染工具名 / badge / 结果预览
    expect(screen.queryByText("export_docx")).toBeNull();
    expect(screen.queryByText("已导出")).toBeNull();
    expect(screen.queryByText(entry.resultPreview)).toBeNull();
  });

  it("点击文件进入 diff 详情视图", () => {
    const { container } = render(<ChangesPanel changes={[entryWithDiff]} />);
    expect(container.querySelector(".changes-panel__diff-body")).toBeNull();

    fireEvent.click(getFileButton(container));

    // 详情头部显示文件名与返回按钮
    expect(container.querySelector(".changes-panel__diff-head")).not.toBeNull();
    expect(screen.getByText("report.md")).toBeTruthy();
    expect(container.querySelector(".changes-panel__diff-body")).not.toBeNull();
    // 行号 + 差异行渲染
    expect(screen.getByText("new line2")).toBeTruthy();
    expect(screen.getByText("old line2")).toBeTruthy();
    expect(container.querySelector(".changes-panel__line--add")).not.toBeNull();
    expect(container.querySelector(".changes-panel__line--del")).not.toBeNull();
  });

  it("diff 详情页点击返回回到文件列表", () => {
    const { container } = render(<ChangesPanel changes={[entryWithDiff]} />);
    fireEvent.click(getFileButton(container));
    expect(container.querySelector(".changes-panel__diff-body")).not.toBeNull();

    fireEvent.click(getBackButton(container));
    expect(container.querySelector(".changes-panel__diff-body")).toBeNull();
    expect(container.querySelector(".changes-panel__list")).not.toBeNull();
  });

  it("优先使用返回的真实 path 显示文件名，而非 arguments 里的路径", () => {
    const fromResult: ChangeEntry = {
      ...entry,
      path: "D:/workspace/final/report.docx",
      argsSummary: '{ path: "/tmp/old.docx" }',
    };
    render(<ChangesPanel changes={[fromResult]} />);
    expect(screen.getByText("report.docx")).toBeTruthy();
    expect(screen.queryByText("old.docx")).toBeNull();
  });

  it("无 diff 的文件点击后显示空提示", () => {
    const noDiff: ChangeEntry = { ...entry, path: "D:/out/binary.bin" };
    const { container } = render(<ChangesPanel changes={[noDiff]} />);
    fireEvent.click(getFileButton(container));
    expect(screen.getByText("该文件无 diff 预览")).toBeTruthy();
  });
});

describe("ChangesPanel 撤销按钮", () => {
  it("write_file/edit_file 且传 onRevert 时显示撤销按钮，点击成功显示已撤销", async () => {
    const revertEntry = {
      ...entryWithDiff,
      name: "edit_file",
      verb: "修改",
      title: "Edit File",
    };
    let reverted: ChangeEntry | null = null;
    const { container } = render(
      <ChangesPanel
        changes={[revertEntry]}
        onRevert={async (e) => {
          reverted = e;
          return true;
        }}
      />,
    );
    fireEvent.click(getFileButton(container));
    const revertBtn = container.querySelector(".changes-panel__iconbtn[aria-label='撤销本次修改']") as HTMLButtonElement;
    expect(revertBtn).toBeTruthy();
    fireEvent.click(revertBtn);
    await waitFor(() => expect(screen.getByText("已撤销")).toBeTruthy());
    expect(reverted).not.toBeNull();
  });

  it("非文件修改工具（export_docx）不显示撤销按钮", () => {
    const { container } = render(<ChangesPanel changes={[entryWithDiff]} />);
    fireEvent.click(getFileButton(container));
    expect(container.querySelector(".changes-panel__iconbtn[aria-label='撤销本次修改']")).toBeNull();
  });
});
