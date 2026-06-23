import type { KnowledgeDocument } from "../../chat/knowledgeTypes";

export type PreviewKind = "text" | "markdown" | "pdf" | "docx" | "image" | "audio" | "video" | "unsupported";
export type KnowledgeResourceCategory = "docs" | "images" | "audio" | "video";

export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"]);
export const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "oga", "m4a", "flac", "aac"]);
export const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "mkv", "avi", "m4v", "mpeg", "mpg"]);
export const TEXT_EXTENSIONS = new Set([
  "txt",
  "log",
  "json",
  "csv",
  "tsv",
  "html",
  "htm",
  "xml",
  "yml",
  "yaml",
  "js",
  "jsx",
  "ts",
  "tsx",
  "py",
  "rs",
  "css",
  "toml",
  "ini",
  "sql",
  "sh",
  "bat",
  "cmd",
]);

export const KNOWLEDGE_UPLOAD_ACCEPT = [
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".csv",
  ".tsv",
  ".log",
  ".html",
  ".htm",
  ".js",
  ".ts",
  ".tsx",
  ".py",
  ".rs",
  ".css",
  ".xml",
  ".yaml",
  ".yml",
  ".pdf",
  ".docx",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
  ".avif",
  ".mp3",
  ".wav",
  ".ogg",
  ".oga",
  ".m4a",
  ".flac",
  ".aac",
  ".mp4",
  ".mov",
  ".webm",
  ".mkv",
  ".avi",
  ".m4v",
  ".mpeg",
  ".mpg",
  "audio/*",
  "video/*",
].join(",");

type PreviewableDocument = Pick<KnowledgeDocument, "sourceName" | "sourcePath" | "fileExtension" | "mimeType" | "previewType">;

export function getExtension(value?: string | null) {
  if (!value) {
    return "";
  }
  const base = value.split(/[?#]/)[0];
  const dotIndex = base.lastIndexOf(".");
  if (dotIndex < 0) {
    return "";
  }
  return base.slice(dotIndex + 1).toLowerCase();
}

export function getPreviewKindFromFile(file: Pick<File, "name" | "type">): PreviewKind {
  const ext = getExtension(file.name);
  const mimeType = file.type.toLowerCase();

  if (IMAGE_EXTENSIONS.has(ext) || mimeType.startsWith("image/")) {
    return "image";
  }
  if (AUDIO_EXTENSIONS.has(ext) || mimeType.startsWith("audio/")) {
    return "audio";
  }
  if (VIDEO_EXTENSIONS.has(ext) || mimeType.startsWith("video/")) {
    return "video";
  }
  if (ext === "pdf" || mimeType === "application/pdf") {
    return "pdf";
  }
  if (ext === "docx" || mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return "docx";
  }
  if (ext === "md" || ext === "markdown") {
    return "markdown";
  }
  if (TEXT_EXTENSIONS.has(ext) || mimeType.startsWith("text/") || mimeType === "application/json") {
    return "text";
  }
  return "unsupported";
}

export function classifyResource(sourceName: string, sourcePath?: string | null): KnowledgeResourceCategory {
  const ext = getExtension(sourcePath ?? sourceName);
  if (IMAGE_EXTENSIONS.has(ext)) {
    return "images";
  }
  if (AUDIO_EXTENSIONS.has(ext)) {
    return "audio";
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    return "video";
  }
  return "docs";
}

export function getPreviewKindFromDocument(document: PreviewableDocument): PreviewKind {
  const kind = (document.previewType ?? "").toLowerCase();
  const ext = (document.fileExtension ?? getExtension(document.sourceName)).toLowerCase();
  const mimeType = (document.mimeType ?? "").toLowerCase();

  if (kind === "image" || IMAGE_EXTENSIONS.has(ext) || mimeType.startsWith("image/")) {
    return "image";
  }
  if (kind === "audio" || AUDIO_EXTENSIONS.has(ext) || mimeType.startsWith("audio/")) {
    return "audio";
  }
  if (kind === "pdf" || ext === "pdf" || mimeType === "application/pdf") {
    return "pdf";
  }
  if (kind === "docx" || ext === "docx" || mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return "docx";
  }
  if (kind === "markdown" || ext === "md" || ext === "markdown") {
    return "markdown";
  }
  if (kind === "text" || TEXT_EXTENSIONS.has(ext) || mimeType.startsWith("text/") || mimeType === "application/json") {
    return "text";
  }
  return "unsupported";
}

export function getDocumentTypeLabel(document?: PreviewableDocument | null) {
  if (!document) {
    return "文档";
  }

  const ext = (document.fileExtension ?? getExtension(document.sourceName)).toLowerCase();
  const kind = getPreviewKindFromDocument(document);
  const resourceCategory = classifyResource(document.sourceName, document.sourcePath);

  if (kind === "image") return "图片";
  if (resourceCategory === "audio") return "音频";
  if (resourceCategory === "video") return "视频";
  if (kind === "pdf") return "PDF";
  if (kind === "docx") return "DOCX";
  if (kind === "markdown") return "MD";
  if (kind === "text") return ext ? ext.toUpperCase() : "TXT";

  return document.mimeType ? document.mimeType.split("/").pop()?.toUpperCase() ?? "文档" : "文档";
}

export function getVectorizationLabel(state?: KnowledgeDocument["vectorizationState"] | string | null) {
  switch (state) {
    case "vectorized":
      return "已向量化";
    case "partial":
    case "partially vectorized":
      return "部分向量化";
    case "unvectorized":
      return "未向量化";
    case "empty":
      return "无内容";
    default:
      return "未知状态";
  }
}

export function getProcessingStatusLabel(status?: KnowledgeDocument["processingStatus"] | null) {
  switch (status) {
    case "pending":
      return "等待处理";
    case "processing":
      return "处理中";
    case "searchable":
      return "可检索";
    case "partial":
      return "部分可用";
    case "failed":
      return "处理失败";
    case "canceled":
      return "已取消";
    case "unsupported":
      return "仅保存";
    default:
      return "可检索";
  }
}

export function trimContentPreview(content: string) {
  return content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[#>*_\-\[\](){}/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function splitPreviewLines(value: string, maxLines: number, maxChars: number) {
  const text = value.trim().replace(/\s+/g, " ");
  if (!text) {
    return [];
  }

  const lines: string[] = [];
  let current = "";

  for (const token of text.split(/(\s+)/)) {
    const candidate = `${current}${token}`.trimStart();
    if (candidate.replace(/\s+/g, " ").length > maxChars && current) {
      lines.push(current.trim());
      current = token.trimStart();
    } else {
      current = candidate;
    }

    if (lines.length >= maxLines) {
      break;
    }
  }

  if (current && lines.length < maxLines) {
    lines.push(current.trim());
  }

  return lines.slice(0, maxLines).map((line) => line.slice(0, maxChars));
}
