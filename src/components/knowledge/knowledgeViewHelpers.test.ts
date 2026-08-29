import { describe, expect, it } from "vitest";
import {
  classifyResource,
  extractThumbnailPreviewLines,
  formatTimestamp,
  getDocumentTypeLabel,
  getExtension,
  getPreviewKindFromDocument,
  getPreviewKindFromFile,
  getProcessingStatusLabel,
  getSearchHighlightTerms,
  normalizeSearchText,
  getVectorizationLabel,
  splitPreviewLines,
  trimContentPreview,
} from "./knowledgeViewHelpers";

describe("knowledgeViewHelpers", () => {
  it("从文件名、路径和查询串中提取小写扩展名", () => {
    expect(getExtension("Report.PDF")).toBe("pdf");
    expect(getExtension("folder/image.PNG?token=1")).toBe("png");
    expect(getExtension("no-extension")).toBe("");
    expect(getExtension(null)).toBe("");
  });

  it("根据文件名和 MIME 判断上传预览类型", () => {
    expect(getPreviewKindFromFile({ name: "note.md", type: "" })).toBe("markdown");
    expect(getPreviewKindFromFile({ name: "book.pdf", type: "" })).toBe("pdf");
    expect(getPreviewKindFromFile({ name: "draft.docx", type: "" })).toBe("docx");
    expect(getPreviewKindFromFile({ name: "photo.unknown", type: "image/png" })).toBe("image");
    expect(getPreviewKindFromFile({ name: "voice.bin", type: "audio/mpeg" })).toBe("audio");
    expect(getPreviewKindFromFile({ name: "clip.mp4", type: "" })).toBe("video");
    expect(getPreviewKindFromFile({ name: "archive.zip", type: "application/zip" })).toBe("unsupported");
  });

  it("根据文档元数据判断预览类型和中文类型标签", () => {
    expect(getPreviewKindFromDocument({ sourceName: "guide.md", previewType: null, fileExtension: null, mimeType: null })).toBe("markdown");
    expect(getDocumentTypeLabel({ sourceName: "guide.md", previewType: null, fileExtension: null, mimeType: null })).toBe("MD");
    expect(getDocumentTypeLabel({ sourceName: "paper.pdf", previewType: "pdf", fileExtension: null, mimeType: null })).toBe("PDF");
    expect(getDocumentTypeLabel({ sourceName: "photo.png", sourcePath: "photo.png", previewType: null, fileExtension: null, mimeType: null })).toBe("图片");
    expect(getDocumentTypeLabel({ sourceName: "voice.mp3", sourcePath: "voice.mp3", previewType: null, fileExtension: null, mimeType: null })).toBe("音频");
    expect(getDocumentTypeLabel(null)).toBe("文档");
  });

  it("分类资源到知识库侧栏类别", () => {
    expect(classifyResource("demo.md")).toBe("docs");
    expect(classifyResource("cover.webp")).toBe("images");
    expect(classifyResource("song.flac")).toBe("audio");
    expect(classifyResource("movie.webm")).toBe("video");
  });

  it("输出稳定的中文状态标签", () => {
    expect(getProcessingStatusLabel("pending")).toBe("等待处理");
    expect(getProcessingStatusLabel("searchable")).toBe("可检索");
    expect(getProcessingStatusLabel(undefined)).toBe("可检索");
    expect(getVectorizationLabel("vectorized")).toBe("已向量化");
    expect(getVectorizationLabel("partial")).toBe("部分向量化");
    expect(getVectorizationLabel(null)).toBe("未知状态");
  });

  it("清理 markdown 预览文本并拆成固定行数", () => {
    expect(trimContentPreview("# 标题\n\n```ts\nconst value = 1;\n```\n正文 `code` **加粗**")).toBe("标题 正文 code 加粗");

    const lines = splitPreviewLines("第一段 内容 很长 第二段 内容 继续 很长", 2, 8);
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.length <= 8)).toBe(true);
  });

  it("规范化搜索文本并按长度排序高亮词", () => {
    expect(normalizeSearchText("  Omni   知识库  ")).toBe("omni 知识库");
    expect(getSearchHighlightTerms("AI ai project")).toEqual(["project", "ai"]);
  });

  it("格式化时间戳并处理空时间", () => {
    expect(formatTimestamp(null)).toBe("未知时间");
    expect(formatTimestamp(new Date("2026-06-29T09:05:00+08:00").getTime())).toContain("06/29");
  });

  it("从原文中提取缩略图预览行", () => {
    expect(extractThumbnailPreviewLines("第一行\n\n第二行很长", 3, 3)).toEqual(["第一行", "第二行"]);
    expect(extractThumbnailPreviewLines("   ", 2, 6)).toEqual([]);
    expect(extractThumbnailPreviewLines("# 标题 **正文**", 2, 8)).toEqual(["# 标题 **正"]);
  });
});
