// Omni - 附件展示相关的纯函数（类型归类 / 体积格式化）
// 供 AttachmentChip 等 UI 复用；保持无依赖，便于单测。

export type AttachmentKind =
  | "image"
  | "markdown"
  | "text"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "code"
  | "archive"
  | "audio"
  | "video"
  | "file";

const EXT_KIND: Record<string, AttachmentKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  svg: "image",
  ico: "image",
  avif: "image",

  md: "markdown",
  markdown: "markdown",

  txt: "text",
  log: "text",
  rtf: "text",

  pdf: "document",
  doc: "document",
  docx: "document",
  odt: "document",
  epub: "document",

  xls: "spreadsheet",
  xlsx: "spreadsheet",
  csv: "spreadsheet",
  tsv: "spreadsheet",
  ods: "spreadsheet",
  numbers: "spreadsheet",

  ppt: "presentation",
  pptx: "presentation",
  odp: "presentation",
  key: "presentation",

  zip: "archive",
  rar: "archive",
  "7z": "archive",
  tar: "archive",
  gz: "archive",
  tgz: "archive",

  mp3: "audio",
  wav: "audio",
  flac: "audio",
  m4a: "audio",
  ogg: "audio",
  aac: "audio",

  mp4: "video",
  mov: "video",
  mkv: "video",
  webm: "video",
  avi: "video",

  ts: "code",
  tsx: "code",
  js: "code",
  jsx: "code",
  mjs: "code",
  json: "code",
  yaml: "code",
  yml: "code",
  toml: "code",
  ini: "code",
  py: "code",
  go: "code",
  rs: "code",
  java: "code",
  kt: "code",
  swift: "code",
  c: "code",
  h: "code",
  cpp: "code",
  cs: "code",
  rb: "code",
  php: "code",
  sh: "code",
  bash: "code",
  sql: "code",
  html: "code",
  css: "code",
  scss: "code",
  vue: "code",
  svelte: "code",
  xml: "code",
};

function extOf(fileName: string): string {
  const lower = fileName.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot <= 0 || dot === lower.length - 1) return "";
  return lower.slice(dot + 1);
}

export function attachmentKindOf(fileName: string | undefined): AttachmentKind {
  return EXT_KIND[extOf(fileName ?? "")] ?? "file";
}

export function formatFileSize(size: number | null | undefined): string {
  if (size === null || size === undefined || !Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
