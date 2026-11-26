import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { buildAttachmentContext } from "./attachmentContext";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
const extractRawText = vi.fn();
vi.mock("mammoth/mammoth.browser", () => ({
  default: {
    extractRawText,
  },
}));

describe("buildAttachmentContext", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("没有附件时返回空", async () => {
    expect(await buildAttachmentContext([])).toBeUndefined();
  });

  it("直接提取 DOCX 正文，而不是让模型把压缩字节当文本读", async () => {
    vi.mocked(invoke).mockResolvedValue(new TextEncoder().encode("PK fake docx").buffer as ArrayBuffer);
    extractRawText.mockResolvedValueOnce({
      value: "附件 A 的正文内容。",
      messages: [],
    } as Awaited<ReturnType<typeof extractRawText>>);

    const context = await buildAttachmentContext([
      { path: "C:/attachments/a.docx", name: "a.docx", size: 20 },
    ]);

    expect(context).toContain("附件 A 的正文内容。");
    expect(context).toContain("优先分析附件内容");
  });

  it("读取失败时明确保留错误而不是让模型误读二进制", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("not found"));

    const context = await buildAttachmentContext([
      { path: "C:/attachments/a.docx", name: "a.docx", size: 20 },
    ]);

    expect(context).toContain("附件正文读取失败");
    expect(context).toContain("not found");
  });
});
