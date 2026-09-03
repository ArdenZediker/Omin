// 附件展示纯函数单测：类型归类 + 体积格式化（含路径型附件 size=null 的兼容分支）
import { describe, it, expect } from "vitest";
import { attachmentKindOf, formatFileSize } from "./attachmentFormat";

describe("attachmentKindOf", () => {
  it("按扩展名归类图片/文档/代码等已知类型", () => {
    expect(attachmentKindOf("photo.PNG")).toBe("image");
    expect(attachmentKindOf("report.pdf")).toBe("document");
    expect(attachmentKindOf("data.xlsx")).toBe("spreadsheet");
    expect(attachmentKindOf("slide.pptx")).toBe("presentation");
    expect(attachmentKindOf("app.tsx")).toBe("code");
    expect(attachmentKindOf("notes.md")).toBe("markdown");
    expect(attachmentKindOf("log.txt")).toBe("text");
    expect(attachmentKindOf("src.zip")).toBe("archive");
    expect(attachmentKindOf("song.mp3")).toBe("audio");
    expect(attachmentKindOf("clip.mp4")).toBe("video");
  });

  it("未识别扩展名或无扩展名回退为 file", () => {
    expect(attachmentKindOf("weird.xyz")).toBe("file");
    expect(attachmentKindOf("noextension")).toBe("file");
    expect(attachmentKindOf(".gitignore")).toBe("file");
    expect(attachmentKindOf("trailing.")).toBe("file");
  });

  it("空值/undefined 安全回退为 file", () => {
    expect(attachmentKindOf(undefined)).toBe("file");
    expect(attachmentKindOf("")).toBe("file");
  });

  it("大小写不敏感", () => {
    expect(attachmentKindOf("README.MD")).toBe("markdown");
    expect(attachmentKindOf("Main.JSX")).toBe("code");
  });
});

describe("formatFileSize", () => {
  it("null/undefined/非法值返回空串（路径型附件无 size）", () => {
    expect(formatFileSize(null)).toBe("");
    expect(formatFileSize(undefined)).toBe("");
    expect(formatFileSize(-1)).toBe("");
    expect(formatFileSize(Number.NaN)).toBe("");
  });

  it("字节与 KB/MB 换算", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(1048576)).toBe("1.0 MB");
    expect(formatFileSize(5242880)).toBe("5.0 MB");
  });
});
