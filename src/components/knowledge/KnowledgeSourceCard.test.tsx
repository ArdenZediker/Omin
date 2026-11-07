import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeContextSource, KnowledgeDocumentDetail } from "../../chat/knowledgeTypes";
import KnowledgeSourceCard from "./KnowledgeSourceCard";

const { loadDetail, loadBinary, openPathMock } = vi.hoisted(() => ({
  loadDetail: vi.fn(),
  loadBinary: vi.fn(),
  openPathMock: vi.fn(),
}));

vi.mock("./knowledgeApi", () => ({
  loadKnowledgeDocumentDetail: loadDetail,
  loadKnowledgeDocumentBinary: loadBinary,
}));

vi.mock("../../app/storageApi", () => ({ openPath: openPathMock }));

// Keep the existing KnowledgeDocumentPreview real; isolate only its heavy Office renderer.
vi.mock("../FilePreview", () => ({
  canPreviewWithViewer: (name: string) => name.endsWith(".pdf"),
  ViewerFrame: ({ filename }: { filename: string }) => <div>Office 预览：{filename}</div>,
}));

const source: KnowledgeContextSource = {
  chunkId: "chunk-1",
  documentId: "document-1",
  sourceName: "归档资料.md",
  sourcePath: "C:/changed/source.md",
  collectionName: "项目资料",
  chunkTitle: "实施范围",
  chunkIndex: 0,
  score: 0.91,
  excerpt: "回答生成时保存的历史摘录。",
  tags: [],
  favorite: false,
  accessCount: 0,
};

function detail(overrides: Partial<KnowledgeDocumentDetail> = {}): KnowledgeDocumentDetail {
  return {
    document: {
      id: source.documentId,
      collectionId: "collection-1",
      sourceName: source.sourceName,
      storedFilePath: "D:/Omni/archive/归档资料.md",
      fileExtension: "md",
      mimeType: "text/markdown",
      previewType: "markdown",
      content: "文档正文",
      contentPreview: "文档正文",
      chunkCount: 1,
      tags: [],
      favorite: false,
      accessCount: 0,
    },
    assets: [],
    chunks: [{
      id: source.chunkId,
      documentId: source.documentId,
      collectionId: "collection-1",
      chunkIndex: 0,
      title: source.chunkTitle,
      content: "归档中的完整片段内容，包含历史摘录。",
      createdAt: 1,
    }],
    ...overrides,
  };
}

describe("KnowledgeSourceCard archive citation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    openPathMock.mockResolvedValue(undefined);
  });

  it("按 documentId 读取存档，定位 chunkId 并复用原文预览", async () => {
    loadDetail.mockResolvedValue(detail());
    render(<KnowledgeSourceCard source={source} />);

    fireEvent.click(screen.getByRole("button", { name: "打开存档并定位片段" }));
    expect(await screen.findByText("已定位到存档片段 1 · 实施范围")).toBeInTheDocument();
    expect(screen.getByText("归档中的完整片段内容，包含历史摘录。")).toBeInTheDocument();
    expect(screen.getByText("回答生成时保存的历史摘录。")).toBeInTheDocument();
    expect(await screen.findByText("文档正文")).toBeInTheDocument();
    expect(loadDetail).toHaveBeenCalledWith("document-1");

    fireEvent.click(screen.getByRole("button", { name: "打开原文文件" }));
    await waitFor(() => expect(openPathMock).toHaveBeenCalledWith("D:/Omni/archive/归档资料.md"));
    expect(openPathMock).not.toHaveBeenCalledWith("C:/changed/source.md");
  });

  it("chunk 已失效时解释无法定位并保留历史摘录及当前存档", async () => {
    loadDetail.mockResolvedValue(detail({ chunks: [] }));
    render(<KnowledgeSourceCard source={source} />);

    fireEvent.click(screen.getByRole("button", { name: "打开存档并定位片段" }));
    expect(await screen.findByText(/原引用片段已不存在，无法精确定位/)).toBeInTheDocument();
    expect(screen.getByText("回答生成时保存的历史摘录。")).toBeInTheDocument();
    expect(await screen.findByText("文档正文")).toBeInTheDocument();
  });

  it("存档已删除时显示可重试错误，同时保留历史摘录", async () => {
    loadDetail.mockRejectedValueOnce(new Error("document not found"));
    render(<KnowledgeSourceCard source={source} />);

    fireEvent.click(screen.getByRole("button", { name: "打开存档并定位片段" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("文档可能已删除");
    expect(screen.getByText("回答生成时保存的历史摘录。")).toBeInTheDocument();

    loadDetail.mockResolvedValueOnce(detail());
    fireEvent.click(screen.getByRole("button", { name: "重试读取存档" }));
    expect(await screen.findByText("已定位到存档片段 1 · 实施范围")).toBeInTheDocument();
  });

  it("不使用失效或缺失的 documentId 访问其他文档", async () => {
    const noDocumentId = { ...source, documentId: "" };
    render(<KnowledgeSourceCard source={noDocumentId} />);

    fireEvent.click(screen.getByRole("button", { name: "打开存档并定位片段" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("缺少文档标识");
    expect(screen.getByText("回答生成时保存的历史摘录。")).toBeInTheDocument();
    expect(loadDetail).not.toHaveBeenCalled();
  });

  it("同一 chunkId 属于其他文档时不会误定位", async () => {
    const payload = detail();
    payload.chunks[0].documentId = "other-document";
    loadDetail.mockResolvedValue(payload);
    render(<KnowledgeSourceCard source={source} />);
    fireEvent.click(screen.getByRole("button", { name: "打开存档并定位片段" }));
    expect(await screen.findByText(/原引用片段已不存在/)).toBeInTheDocument();
    expect(screen.queryByText(/已定位到存档片段/)).not.toBeInTheDocument();
  });

  it("返回的文档不匹配时显示错误且不预览错误存档", async () => {
    const payload = detail();
    payload.document.id = "other-document";
    loadDetail.mockResolvedValue(payload);
    render(<KnowledgeSourceCard source={source} />);
    fireEvent.click(screen.getByRole("button", { name: "打开存档并定位片段" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("文档不匹配");
    expect(screen.queryByText("文档正文")).not.toBeInTheDocument();
  });

  it("旧消息缺少 chunkId 时保留摘录并说明定位限制", async () => {
    loadDetail.mockResolvedValue(detail());
    render(<KnowledgeSourceCard source={{ ...source, chunkId: "" }} />);
    fireEvent.click(screen.getByRole("button", { name: "打开存档并定位片段" }));
    expect(await screen.findByText(/缺少片段标识/)).toBeInTheDocument();
    expect(await screen.findByText("文档正文")).toBeInTheDocument();
  });

  it("存档文件缺失时显示错误，不退回历史源路径", async () => {
    const payload = detail();
    payload.document.storedFilePath = null;
    payload.document.sourcePath = source.sourcePath;
    loadDetail.mockResolvedValue(payload);
    render(<KnowledgeSourceCard source={source} />);
    fireEvent.click(screen.getByRole("button", { name: "打开存档并定位片段" }));
    fireEvent.click(await screen.findByRole("button", { name: "打开原文文件" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("没有存档原文件");
    expect(openPathMock).not.toHaveBeenCalled();
    expect(screen.getByText(source.excerpt)).toBeInTheDocument();
  });

  it("系统打开失败可见，并允许再试", async () => {
    loadDetail.mockResolvedValue(detail());
    openPathMock.mockRejectedValueOnce("文件已被删除");
    render(<KnowledgeSourceCard source={source} />);
    fireEvent.click(screen.getByRole("button", { name: "打开存档并定位片段" }));
    fireEvent.click(await screen.findByRole("button", { name: "打开原文文件" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("文件已被删除");
    fireEvent.click(screen.getByRole("button", { name: "打开原文文件" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(openPathMock).toHaveBeenCalledTimes(2);
  });

  it("二进制预览按文档 ID 读取，文件失效仍显示片段与历史摘录", async () => {
    const payload = detail();
    Object.assign(payload.document, { sourceName: "存档.pdf", fileExtension: "pdf", mimeType: "application/pdf", previewType: "pdf" });
    loadDetail.mockResolvedValue(payload);
    loadBinary.mockRejectedValue(new Error("归档文件不存在"));
    render(<KnowledgeSourceCard source={source} />);
    fireEvent.click(screen.getByRole("button", { name: "打开存档并定位片段" }));
    expect(await screen.findByText("归档文件不存在")).toBeInTheDocument();
    expect(loadBinary).toHaveBeenCalledWith(source.documentId);
    expect(screen.getByText("已定位到存档片段 1 · 实施范围")).toBeInTheDocument();
    expect(screen.getByText(source.excerpt)).toBeInTheDocument();
  });

  it("Escape 收起预览并将焦点还给入口；重新打开会重新读取", async () => {
    loadDetail.mockResolvedValue(detail());
    render(<KnowledgeSourceCard source={source} />);
    const trigger = screen.getByRole("button", { name: "打开存档并定位片段" });
    fireEvent.click(trigger);
    await screen.findByText("已定位到存档片段 1 · 实施范围");
    const location = screen.getByLabelText("引用片段定位");
    expect(location).toHaveFocus();
    fireEvent.keyDown(location, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("引用片段定位")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    await screen.findByText("已定位到存档片段 1 · 实施范围");
    expect(loadDetail).toHaveBeenCalledTimes(2);
  });

  it("切换引用后忽略旧请求，避免迟到的旧存档替换当前内容", async () => {
    let resolveOld!: (value: KnowledgeDocumentDetail) => void;
    loadDetail.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const { rerender } = render(<KnowledgeSourceCard source={source} />);
    fireEvent.click(screen.getByRole("button", { name: "打开存档并定位片段" }));
    expect(screen.getByRole("status")).toHaveTextContent("正在读取存档");

    const nextSource = { ...source, documentId: "document-2", chunkId: "chunk-2", excerpt: "新引用的历史摘录" };
    const nextDetail = detail({ chunks: [] });
    nextDetail.document.id = nextSource.documentId;
    nextDetail.document.content = "新文档正文";
    loadDetail.mockResolvedValueOnce(nextDetail);
    rerender(<KnowledgeSourceCard source={nextSource} />);
    fireEvent.click(screen.getByRole("button", { name: "打开存档并定位片段" }));
    await screen.findByText("新文档正文");
    await act(async () => { resolveOld(detail()); });
    expect(screen.getByText("新文档正文")).toBeInTheDocument();
    expect(screen.queryByText("文档正文")).not.toBeInTheDocument();
    expect(screen.getByText(nextSource.excerpt)).toBeInTheDocument();
  });
});
