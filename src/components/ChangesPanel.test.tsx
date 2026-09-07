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
});
