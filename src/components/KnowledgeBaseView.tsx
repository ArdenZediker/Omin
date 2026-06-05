import { Component, useEffect, useMemo, useRef, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openPath } from "@tauri-apps/plugin-opener";
import mammoth from "mammoth/mammoth.browser";
import type { Options as DocxPreviewOptions } from "docx-preview";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  ArrowLeft,
  Bot,
  EllipsisVertical,
  FileImage as LucideFileImage,
  FileText as LucideFileText,
  FolderOpen,
  Grid2x2,
  History,
  Layers3,
  MessageSquare,
  Mic,
  X,
  RotateCcw,
  TriangleAlert,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  PlaySquare,
  Trash2,
  SquarePlus,
  Search,
  Settings,
  ChevronDown,
  ChevronUp,
  Sparkles,
} from "lucide-react";
import type {
  KnowledgeCollection,
  DeadLetterQueryInput,
  KnowledgeProcessingDeadLetter,
  DeadLetterQueryResult,
  KnowledgeDocumentBinaryPayload,
  KnowledgeDocumentDetail,
  KnowledgeLibraryPayload,
  KnowledgePipelineSettings,
  KnowledgeProcessingStatusSummary,
  PipelineImportResult,
  ReplayDeadLettersResult,
  RetryFailedJobsResult,
} from "../chat/knowledgeTypes";
import {
  getDefaultCollectionMultimodalConfig,
  getKnowledgeMultimodalModelsByCapability,
  loadKnowledgeMultimodalConfig,
  type KnowledgeCollectionMultimodalConfig,
  type KnowledgeMultimodalConfig,
} from "../chat/knowledgeMultimodal";
import { renderMarkdown } from "../app/renderMarkdown";
import { usePromptDialog } from "./PromptDialog";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type KnowledgeCategory = {
  id: string;
  title: string;
  icon: typeof LucideFileText;
  count: number;
  description: string;
};

type KnowledgeBaseViewProps = {
  onSettingsOpen: () => void;
  onBackToChat: () => void;
  windowControls?: ReactNode;
};

type KnowledgeDocumentDetailView = "preview" | "assets" | "chunks" | "processing";
type KnowledgePageMode = "empty" | "list" | "detail";
type PreviewKind = "text" | "markdown" | "pdf" | "docx" | "image" | "audio" | "video" | "unsupported";
type DeadLetterScope = "all" | "activeCollection";
type CollectionSettingsDraft = {
  id: string;
  name: string;
  description: string;
  retrievalMode: string;
  multimodalConfig: KnowledgeCollectionMultimodalConfig;
};
type UploadNotice = {
  tone: "success" | "error";
  message: string;
};
const UPLOAD_NOTICE_AUTO_DISMISS_MS = 4000;
const DOCX_PREVIEW_OPTIONS = {
  className: "docx-preview-wrapper",
  inWrapper: true,
  ignoreWidth: false,
  ignoreHeight: false,
  ignoreFonts: false,
  breakPages: true,
  ignoreLastRenderedPageBreak: true,
  experimental: false,
  trimXmlDeclaration: true,
  useBase64URL: true,
} satisfies Partial<DocxPreviewOptions>;
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "oga", "m4a", "flac", "aac"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "mkv", "avi", "m4v", "mpeg", "mpg"]);
const KNOWLEDGE_UPLOAD_ACCEPT = [
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
const TEXT_EXTENSIONS = new Set([
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

const CATEGORIES: Omit<KnowledgeCategory, "count">[] = [
  { id: "all", title: "全部文件", description: "当前知识库中的全部文档", icon: Grid2x2 },
  { id: "docs", title: "文档", description: "Markdown、PDF、Word、文本", icon: LucideFileText },
  { id: "images", title: "图片", description: "图片类资源", icon: LucideFileImage },
  { id: "audio", title: "音频", description: "音频类资源", icon: Mic },
  { id: "video", title: "视频", description: "视频类资源", icon: PlaySquare },
];

class KnowledgeBaseDetailBoundary extends Component<
  {
    onBackToList: () => void;
    onRetry: () => void;
    children: ReactNode;
  },
  {
    hasError: boolean;
    errorMessage: string | null;
  }
> {
  state = {
    hasError: false,
    errorMessage: null,
  };

  static getDerivedStateFromError(error: unknown) {
    return {
      hasError: true,
      errorMessage: error instanceof Error ? error.message : "文档详情渲染失败",
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("知识库详情页渲染失败", error, errorInfo);
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <section className="flex min-h-0 flex-1 items-center justify-center rounded-none border border-slate-200 bg-white p-6">
        <div className="max-w-md space-y-4 text-center">
          <div className="text-lg font-semibold text-slate-950">文档详情渲染失败</div>
          <div className="text-sm leading-6 text-slate-500">{this.state.errorMessage ?? "请返回列表后重新打开。"}</div>
          <div className="flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => {
                this.setState({ hasError: false, errorMessage: null });
                this.props.onRetry();
              }}
              className="rounded-none border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
            >
              重新打开
            </button>
            <button
              type="button"
              onClick={this.props.onBackToList}
              className="rounded-none border border-slate-200 bg-slate-950 px-3 py-1.5 text-sm text-white hover:bg-slate-800"
            >
              返回列表
            </button>
          </div>
        </div>
      </section>
    );
  }
}

function getExtension(value?: string | null) {
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

function getPreviewKindFromFile(file: File): PreviewKind {
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

function classifyResource(sourceName: string, sourcePath?: string | null) {
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

function hasUsableKnowledgeMultimodalModel(
  config: KnowledgeMultimodalConfig,
  capability: "image" | "audio",
  modelId: string
) {
  const normalizedModelId = modelId.trim();
  if (!config.enabled || !normalizedModelId) {
    return false;
  }

  return config.models.some(
    (model) =>
      model.id === normalizedModelId &&
      model.capability === capability &&
      model.baseUrl.trim() &&
      model.model.trim() &&
      model.apiKey.trim()
  );
}

function getKnowledgeUploadBlockMessage(
  file: File,
  collection: KnowledgeCollection,
  globalMultimodalConfig: KnowledgeMultimodalConfig
) {
  const previewKind = getPreviewKindFromFile(file);
  const collectionMultimodalConfig = normalizeCollectionMultimodalConfig(collection.multimodalConfig);

  if (previewKind === "video") {
    return "已阻止本次上传：当前版本暂不支持视频上传到知识库，请先移除视频文件后再上传。";
  }

  if (previewKind !== "image" && previewKind !== "audio") {
    return null;
  }

  const label = previewKind === "image" ? "图片" : "音频";
  const capabilityConfig = previewKind === "image" ? collectionMultimodalConfig.image : collectionMultimodalConfig.audio;

  if (!collectionMultimodalConfig.enabled) {
    return `已阻止本次上传：当前知识库未开启多模态分析，请先到知识库设置 -> 多模态中启用并配置${label}模型后再上传${label}。`;
  }

  if (!capabilityConfig.enabled) {
    return `已阻止本次上传：当前知识库未开启${label}多模态分析，请先到知识库设置 -> 多模态中开启并配置${label}模型后再上传${label}。`;
  }

  if (!capabilityConfig.modelId.trim()) {
    return `已阻止本次上传：当前知识库尚未选择${label}模型，请先到知识库设置 -> 多模态中完成${label}模型配置后再上传${label}。`;
  }

  if (!hasUsableKnowledgeMultimodalModel(globalMultimodalConfig, previewKind, capabilityConfig.modelId)) {
    return `已阻止本次上传：当前知识库缺少可用的${label}多模态模型，请先到设置 -> 模型配置 -> 多模态中补充可用模型，并确认知识库设置里已选中对应${label}模型后再上传。`;
  }

  return null;
}

function getPreviewKindFromDocument(document: KnowledgeLibraryPayload["documents"][number] | KnowledgeDocumentDetail["document"]) {
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

function getDocumentTypeLabel(document?: KnowledgeLibraryPayload["documents"][number] | KnowledgeDocumentDetail["document"] | null) {
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

function getVectorizationLabel(state?: string | null) {
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

function getProcessingStatusLabel(status?: KnowledgeLibraryPayload["documents"][number]["processingStatus"] | null) {
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

function normalizeCollectionMultimodalConfig(
  config?: KnowledgeCollection["multimodalConfig"] | null
): KnowledgeCollectionMultimodalConfig {
  const defaults = getDefaultCollectionMultimodalConfig();
  return {
    ...defaults,
    ...config,
    image: {
      ...defaults.image,
      ...(config?.image ?? {}),
    },
    audio: {
      ...defaults.audio,
      ...(config?.audio ?? {}),
    },
    mergeMode: "append",
  };
}

function createCollectionSettingsDraft(collection: KnowledgeCollection): CollectionSettingsDraft {
  return {
    id: collection.id,
    name: collection.name,
    description: collection.description,
    retrievalMode: collection.retrievalMode ?? "hybrid",
    multimodalConfig: normalizeCollectionMultimodalConfig(collection.multimodalConfig),
  };
}

function formatTimestamp(timestamp?: number | null) {
  if (!timestamp) {
    return "未知时间";
  }

  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function normalizeSearchText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getSearchHighlightTerms(query: string) {
  const terms = query
    .trim()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);

  return Array.from(new Map(terms.map((term) => [term.toLowerCase(), term])).values());
}

function renderHighlightedSearchText(text: string, query: string) {
  if (!text) {
    return text;
  }

  const terms = getSearchHighlightTerms(query);
  if (terms.length === 0) {
    return text;
  }

  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  const parts = text.split(pattern);
  if (parts.length === 1) {
    return text;
  }

  const normalizedTerms = new Set(terms.map((term) => term.toLowerCase()));
  return parts.map((part, index) => {
    if (!part) {
      return null;
    }
    if (normalizedTerms.has(part.toLowerCase())) {
      return (
        <mark key={`match-${index}`} className="rounded bg-amber-100 px-0.5 text-slate-900">
          {part}
        </mark>
      );
    }
    return <span key={`text-${index}`}>{part}</span>;
  });
}

function trimContentPreview(content: string) {
  return content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[#>*_\-\[\](){}/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitPreviewLines(value: string, maxLines: number, maxChars: number) {
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

function getDeadLetterDisplayName(item: KnowledgeProcessingDeadLetter, documentNameById: Map<string, string>) {
  return item.documentName?.trim() || documentNameById.get(item.documentId) || `文档 ${item.documentId.slice(0, 8)}`;
}

function getDeadLetterStatusClassName(status: string) {
  return status === "failed" ? "chat-topic-panel__task-status--failed" : "chat-topic-panel__task-status--completed";
}

function formatDeadLetterAttempts(item: KnowledgeProcessingDeadLetter) {
  return `第 ${Math.max(1, item.attempt)}/${Math.max(1, item.maxAttempts)} 次尝试`;
}

function fitCanvasTextToWidth(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (context.measureText(normalized).width <= maxWidth) {
    return normalized;
  }

  const ellipsis = "...";
  if (context.measureText(ellipsis).width > maxWidth) {
    return "";
  }

  let low = 0;
  let high = normalized.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${normalized.slice(0, mid).trimEnd()}${ellipsis}`;
    if (context.measureText(candidate).width <= maxWidth) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return `${normalized.slice(0, Math.max(0, low)).trimEnd()}${ellipsis}`;
}

function extractThumbnailPreviewLines(content: string, maxLines: number, maxChars: number) {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const lines: string[] = [];

  for (const rawLine of normalized.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    lines.push(line.slice(0, maxChars));
    if (lines.length >= maxLines) {
      return lines;
    }
  }

  if (lines.length === 0) {
    return splitPreviewLines(trimContentPreview(content), maxLines, maxChars);
  }

  return lines.slice(0, maxLines);
}

function roundRectPath(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function createThumbnailDataUrlFromContent(content: string) {
  const canvas = document.createElement("canvas");
  const scale = 2;
  const width = 320;
  const height = 180;
  canvas.width = width * scale;
  canvas.height = height * scale;
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }

  context.scale(scale, scale);
  context.fillStyle = "#f8fafc";
  context.fillRect(0, 0, width, height);

  const cardX = 16;
  const cardY = 14;
  const cardWidth = 288;
  const cardHeight = 152;

  context.shadowColor = "rgba(15, 23, 42, 0.08)";
  context.shadowBlur = 10;
  context.shadowOffsetY = 3;
  context.fillStyle = "#ffffff";
  roundRectPath(context, cardX, cardY, cardWidth, cardHeight, 14);
  context.fill();
  context.shadowColor = "transparent";
  context.strokeStyle = "#dbe3ee";
  context.lineWidth = 1;
  context.stroke();

  const lineHeight = 16;
  const lineTop = 30;
  const lineLeft = 30;
  const maxLines = 7;
  const maxLineWidth = 248;
  const lines = extractThumbnailPreviewLines(content, maxLines, 96);

  context.save();
  roundRectPath(context, cardX + 10, cardY + 10, cardWidth - 20, cardHeight - 20, 10);
  context.clip();

  lines.forEach((line, index) => {
    context.fillStyle = index === 0 ? "#111827" : "#374151";
    context.font = index === 0 ? "600 12px 'Segoe UI', sans-serif" : "11px 'Segoe UI', sans-serif";
    context.textAlign = "left";
    context.textBaseline = "top";
    const fittedLine = fitCanvasTextToWidth(context, line, maxLineWidth);
    context.fillText(fittedLine, lineLeft, lineTop + index * lineHeight);
  });
  context.restore();

  return canvas.toDataURL("image/png");
}

async function createThumbnailDataUrl(file: File, content: string) {
  if (file.type.startsWith("image/")) {
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const source = String(reader.result ?? "");
        const image = new Image();
        image.onload = () => {
          const canvas = document.createElement("canvas");
          const width = 320;
          const height = 180;
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext("2d");
          if (!context) {
            resolve(source);
            return;
          }

          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, width, height);
          context.imageSmoothingEnabled = true;
          context.imageSmoothingQuality = "high";

          const sourceRatio = image.width / image.height;
          const targetRatio = width / height;
          let drawWidth = image.width;
          let drawHeight = image.height;
          let offsetX = 0;
          let offsetY = 0;

          if (sourceRatio > targetRatio) {
            drawHeight = image.height;
            drawWidth = drawHeight * targetRatio;
            offsetX = (image.width - drawWidth) / 2;
          } else {
            drawWidth = image.width;
            drawHeight = drawWidth / targetRatio;
            offsetY = (image.height - drawHeight) / 2;
          }

          const inset = 10;
          context.drawImage(image, offsetX, offsetY, drawWidth, drawHeight, inset, inset, width - inset * 2, height - inset * 2);
          resolve(canvas.toDataURL("image/png"));
        };
        image.onerror = () => resolve(source);
        image.src = source;
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  return createThumbnailDataUrlFromContent(content || file.name);
}

async function createImageKnowledgeContent(file: File) {
  if (!file.type.startsWith("image/")) {
    return null;
  }

  return await new Promise<string | null>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const source = String(reader.result ?? "");
      const image = new Image();
      image.onload = () => {
        const extension = (getExtension(file.name) || "image").toUpperCase();
        const sizeKb = Math.max(1, Math.round(file.size / 1024));
        const mimeLine = file.type ? `MIME: ${file.type}` : null;
        resolve(
          [
            "图片文件",
            `文件名: ${file.name}`,
            `格式: ${extension}`,
            mimeLine,
            `尺寸: ${image.width} x ${image.height} 像素`,
            `大小: ${sizeKb} KB`,
            "说明: 该图片已上传到知识库，可按文件名、格式、尺寸等信息检索。",
          ]
            .filter(Boolean)
            .join("\n")
        );
      };
      image.onerror = () => {
        const extension = (getExtension(file.name) || "image").toUpperCase();
        const sizeKb = Math.max(1, Math.round(file.size / 1024));
        resolve(
          [
            "图片文件",
            `文件名: ${file.name}`,
            `格式: ${extension}`,
            file.type ? `MIME: ${file.type}` : null,
            `大小: ${sizeKb} KB`,
            "说明: 该图片已上传到知识库，可按文件名和格式信息检索。",
          ]
            .filter(Boolean)
            .join("\n")
        );
      };
      image.src = source;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function openFilePicker(input: HTMLInputElement | null) {
  if (!input) {
    return;
  }
  // In desktop webviews, showPicker() may exist but fail silently for file inputs.
  // click() is the most reliable way to trigger the native file chooser.
  input.click();
}

function KnowledgeCollectionIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M4.25 2.5h6.2L12.25 4.3v9.2H4.25z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M10.45 2.5V4.25h1.8" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M5.1 6.35h5.1" stroke="currentColor" strokeWidth="1.05" strokeLinecap="round" />
      <path d="M5.1 8.45h3.8" stroke="currentColor" strokeWidth="1.05" strokeLinecap="round" />
    </svg>
  );
}

async function loadKnowledgeLibrary() {
  const payload = await invoke<
    Omit<KnowledgeLibraryPayload, "collections"> & {
      collections: Array<KnowledgeCollection & { multimodalConfigJson?: string | null }>;
    }
  >("load_knowledge_library_command");

  return {
    ...payload,
    collections: payload.collections.map((collection) => {
      const parsed =
        collection.multimodalConfig ??
        (() => {
          const raw = collection.multimodalConfigJson;
          if (!raw) {
            return null;
          }
          try {
            return normalizeCollectionMultimodalConfig(JSON.parse(raw) as KnowledgeCollectionMultimodalConfig);
          } catch {
            return normalizeCollectionMultimodalConfig();
          }
        })();

      return {
        ...collection,
        multimodalConfig: parsed ? normalizeCollectionMultimodalConfig(parsed) : normalizeCollectionMultimodalConfig(),
      };
    }),
  };
}

async function loadKnowledgeDocumentDetail(documentId: string) {
  return invoke<KnowledgeDocumentDetail>("load_knowledge_document_command", {
    input: { documentId },
  });
}

async function loadKnowledgeDocumentBinary(documentId: string) {
  return invoke<KnowledgeDocumentBinaryPayload>("load_knowledge_document_file_command", {
    input: { documentId },
  });
}

async function loadKnowledgeProcessingStatusSummary(collectionId?: string | null) {
  return invoke<KnowledgeProcessingStatusSummary>("load_knowledge_processing_status_summary_command", {
    collectionId: collectionId ?? null,
  });
}

async function loadKnowledgePipelineSettings() {
  return invoke<KnowledgePipelineSettings>("load_knowledge_pipeline_settings_command");
}

async function saveKnowledgePipelineSettings(settings: KnowledgePipelineSettings) {
  return invoke<KnowledgePipelineSettings>("save_knowledge_pipeline_settings_command", { settings });
}

async function loadKnowledgeProcessingDeadLetters(input: DeadLetterQueryInput) {
  return invoke<DeadLetterQueryResult>("load_knowledge_processing_dead_letters_command", { input });
}

async function convertDocxBytesToText(bytes: Uint8Array) {
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}

async function renderDocxBytesIntoContainer(bytes: Uint8Array, container: HTMLElement) {
  const { renderAsync } = await import("docx-preview");
  const blob = new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });

  container.innerHTML = "";
  await renderAsync(blob, container, undefined, DOCX_PREVIEW_OPTIONS);
}

async function convertPdfBytesToText(bytes: Uint8Array) {
  const loadingTask = getDocument({ data: bytes.slice() });
  const pdf = await loadingTask.promise;
  const parts: string[] = [];

  for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex += 1) {
    const page = await pdf.getPage(pageIndex);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => {
        if (typeof item === "object" && item && "str" in item) {
          return String((item as { str: string }).str);
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
    if (pageText.trim()) {
      parts.push(pageText);
    }
  }

  return parts.join("\n\n");
}

async function renderPdfFirstPage(bytes: Uint8Array, canvas: HTMLCanvasElement) {
  const loadingTask = getDocument({ data: bytes.slice() });
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1.2 });
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("无法创建 PDF 画布");
  }

  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const renderTask = page.render({ canvasContext: context, canvas, viewport } as never);
  await renderTask.promise;
}

function PdfFirstPagePreview({ bytes }: { bytes: Uint8Array }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setIsLoading(true);
      setError(null);
      try {
        const canvas = canvasRef.current;
        if (!canvas) {
          return;
        }
        await renderPdfFirstPage(bytes, canvas);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "PDF 预览失败");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void run();

    return () => {
      cancelled = true;
    };
  }, [bytes]);

  if (error) {
    return <div className="text-sm text-rose-600">{error}</div>;
  }

  return (
    <div className="flex flex-col gap-3">
      {isLoading ? <div className="text-sm text-slate-500">正在渲染 PDF 预览...</div> : null}
      <canvas ref={canvasRef} className="max-w-full rounded-none border border-slate-200 bg-white shadow-none" />
    </div>
  );
}

function DocumentPreviewArea({
  document,
  onOpenExternal,
}: {
  document: KnowledgeDocumentDetail["document"];
  onOpenExternal: () => Promise<void> | void;
}) {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [textPreview, setTextPreview] = useState<string>("");
  const [docxBytes, setDocxBytes] = useState<Uint8Array | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [pdfObjectUrl, setPdfObjectUrl] = useState<string | null>(null);
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const docxContainerRef = useRef<HTMLDivElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const previewKind = useMemo(() => getPreviewKindFromDocument(document), [document]);
  const fallbackText = textPreview || document.contentPreview || document.sourceName;

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }

      setError(null);
      setDocxBytes(null);
      setImageUrl(null);
      setAudioUrl(null);
      setPdfObjectUrl(null);
      setPdfBytes(null);
      if (docxContainerRef.current) {
        docxContainerRef.current.innerHTML = "";
      }

      const sourceText = (document.content ?? document.contentPreview ?? document.sourceName ?? "").trim();
      if (previewKind === "text" || previewKind === "markdown") {
        setTextPreview(sourceText);
        setIsLoading(false);
        return;
      }

      if (previewKind === "unsupported") {
        setTextPreview(sourceText || "\u8be5\u683c\u5f0f\u4e0d\u652f\u6301\u5185\u5d4c\u9884\u89c8\uff0c\u53ef\u4ee5\u6253\u5f00\u539f\u6587\u4ef6\u67e5\u770b\u3002");
        setIsLoading(false);
        return;
      }

      setTextPreview(sourceText);
      setIsLoading(true);
      let needsDocxRender = false;
      try {
        const payload = await loadKnowledgeDocumentBinary(document.id);
        if (cancelled) {
          return;
        }

        const bytes = new Uint8Array(payload.bytes);
        if (previewKind === "image") {
          const url = URL.createObjectURL(new Blob([bytes], { type: document.mimeType ?? "application/octet-stream" }));
          objectUrlRef.current = url;
          setImageUrl(url);
        } else if (previewKind === "audio") {
          const url = URL.createObjectURL(new Blob([bytes], { type: document.mimeType ?? "audio/mpeg" }));
          objectUrlRef.current = url;
          setAudioUrl(url);
        } else if (previewKind === "docx") {
          needsDocxRender = true;
          setDocxBytes(bytes);
        } else if (previewKind === "pdf") {
          const url = URL.createObjectURL(new Blob([bytes.slice()], { type: document.mimeType ?? "application/pdf" }));
          objectUrlRef.current = url;
          setPdfObjectUrl(url);
          setPdfBytes(bytes);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "\u9884\u89c8\u52a0\u8f7d\u5931\u8d25");
        }
      } finally {
        if (!cancelled && !needsDocxRender) {
          setIsLoading(false);
        }
      }
    }

    void run();

    return () => {
      cancelled = true;
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
      if (docxContainerRef.current) {
        docxContainerRef.current.innerHTML = "";
      }
    };
  }, [document.id, document.content, document.contentPreview, document.mimeType, document.sourceName, previewKind]);

  useEffect(() => {
    const bytes = docxBytes;
    if (previewKind !== "docx" || !bytes || !docxContainerRef.current) {
      return;
    }

    let cancelled = false;
    const container = docxContainerRef.current;

    async function run() {
      setError(null);
      setIsLoading(true);
      try {
        await renderDocxBytesIntoContainer(bytes!, container);
        if (!cancelled) {
          setIsLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          container.innerHTML = "";
          setError(err instanceof Error ? err.message : "\u9884\u89c8\u52a0\u8f7d\u5931\u8d25");
          setIsLoading(false);
        }
      }
    }

    void run();

    return () => {
      cancelled = true;
      container.innerHTML = "";
    };
  }, [docxBytes, previewKind]);

  if (error) {
    return (
      <div className="relative flex min-h-0 w-full flex-1 flex-col overflow-hidden p-4">
        <button
          type="button"
          onClick={() => void onOpenExternal()}
          className="absolute right-3 top-3 rounded-none border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
        >
          {"\u6253\u5f00\u539f\u6587\u4ef6"}
        </button>
        <div className="space-y-3 pt-8">
          <div className="text-sm font-medium text-slate-950">{"\u9884\u89c8\u5931\u8d25"}</div>
          <div className="text-sm text-slate-500">{error}</div>
        </div>
      </div>
    );
  }

  if (isLoading && previewKind !== "text" && previewKind !== "markdown" && previewKind !== "docx") {
    return (
      <div className="flex min-h-[18rem] items-center justify-center px-4 py-10 text-sm text-slate-500">
        {"\u6b63\u5728\u52a0\u8f7d\u6587\u6863\u9884\u89c8..."}
      </div>
    );
  }

  function renderPreviewContent() {
    switch (previewKind) {
      case "markdown":
        return (
          <div className="h-full overflow-auto pr-1">
            <div className="markdown-body text-sm text-slate-700">{renderMarkdown(fallbackText)}</div>
          </div>
        );
      case "text":
        return (
          <pre className="h-full overflow-auto whitespace-pre-wrap rounded-none bg-slate-50 p-4 text-sm leading-6 text-slate-700">
            {fallbackText}
          </pre>
        );
      case "docx":
        return (
          <div className="omni-knowledge-preview__docx relative h-full overflow-auto pr-1">
            {isLoading ? (
              <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center px-4 py-3">
                <div className="rounded-full border border-slate-200 bg-white/92 px-3 py-1 text-xs text-slate-500 shadow-sm backdrop-blur-sm">
                  {"\u6b63\u5728\u52a0\u8f7d\u6587\u6863\u9884\u89c8..."}
                </div>
              </div>
            ) : null}
            <div ref={docxContainerRef} className="omni-knowledge-preview__docx-container min-h-full" />
            {!isLoading && !docxBytes ? (
              <pre className="h-full overflow-auto whitespace-pre-wrap rounded-none bg-slate-50 p-4 text-sm leading-6 text-slate-700">
                {fallbackText}
              </pre>
            ) : null}
          </div>
        );
      case "pdf":
        return pdfObjectUrl ? (
          <div className="flex h-full min-h-0 flex-1 overflow-hidden rounded-none border border-slate-200 bg-white">
            <object data={pdfObjectUrl} type="application/pdf" className="h-full w-full">
              {pdfBytes ? (
                <div className="h-full overflow-auto p-4">
                  <div className="mb-3 text-sm text-slate-500">
                    {"\u5f53\u524d\u73af\u5883\u65e0\u6cd5\u76f4\u63a5\u9884\u89c8 PDF\uff0c\u5df2\u5207\u6362\u4e3a\u9996\u9875\u56fe\u50cf\u9884\u89c8\uff0c\u4e5f\u53ef\u4ee5\u70b9\u51fb\u53f3\u4e0a\u89d2\u6253\u5f00\u539f\u6587\u4ef6\u3002"}
                  </div>
                  <PdfFirstPagePreview bytes={pdfBytes} />
                </div>
              ) : (
                <div className="p-4 text-sm text-slate-500">
                  {"\u5f53\u524d\u73af\u5883\u65e0\u6cd5\u76f4\u63a5\u9884\u89c8 PDF\uff0c\u8bf7\u70b9\u51fb\u53f3\u4e0a\u89d2\u6253\u5f00\u539f\u6587\u4ef6\u3002"}
                </div>
              )}
            </object>
          </div>
        ) : pdfBytes ? (
          <PdfFirstPagePreview bytes={pdfBytes} />
        ) : null;
      case "image":
        return imageUrl ? (
          <div className="flex h-full w-full items-center justify-center overflow-auto">
            <img
              src={imageUrl}
              alt={document.sourceName}
              className="max-h-full max-w-full rounded-none border border-slate-200 object-contain"
            />
          </div>
        ) : null;
      case "audio":
        return (
          <div className="flex h-full flex-col gap-4">
            {audioUrl ? (
              <audio controls className="w-full">
                <source src={audioUrl} type={document.mimeType ?? "audio/mpeg"} />
              </audio>
            ) : null}
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-none bg-slate-50 p-4 text-sm leading-6 text-slate-700">
              {fallbackText}
            </pre>
          </div>
        );
      case "unsupported":
        return (
          <div className="space-y-3 text-sm text-slate-500">
            <div>{textPreview || "\u8be5\u683c\u5f0f\u4e0d\u652f\u6301\u5185\u5d4c\u9884\u89c8\uff0c\u53ef\u4ee5\u6253\u5f00\u539f\u6587\u4ef6\u67e5\u770b\u3002"}</div>
          </div>
        );
      default:
        return null;
    }
  }

  return (
    <div className="relative flex min-h-0 w-full flex-1 flex-col overflow-hidden">
      <button
        type="button"
        onClick={() => void onOpenExternal()}
        className="absolute right-3 top-3 z-10 rounded-none border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
      >
        {"\u6253\u5f00\u539f\u6587\u4ef6"}
      </button>

      <div className="min-h-0 flex-1 overflow-hidden p-4 pt-12">{renderPreviewContent()}</div>
    </div>
  );
}

export default function KnowledgeBaseView({ onSettingsOpen, onBackToChat, windowControls }: KnowledgeBaseViewProps) {
  const { openPrompt } = usePromptDialog();
  const [activeCategory, setActiveCategory] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [chunkSearchQuery, setChunkSearchQuery] = useState("");
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isUploadMenuOpen, setIsUploadMenuOpen] = useState(false);
  const [isCollectionMenuOpen, setIsCollectionMenuOpen] = useState<string | null>(null);
  const [isDocumentMenuOpen, setIsDocumentMenuOpen] = useState<string | null>(null);
  const [createCollectionError, setCreateCollectionError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<UploadNotice | null>(null);
  const [library, setLibrary] = useState<KnowledgeLibraryPayload>({ collections: [], documents: [] });
  const [isKnowledgeLibraryReady, setIsKnowledgeLibraryReady] = useState(false);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string>("");
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [selectedDocumentDetail, setSelectedDocumentDetail] = useState<KnowledgeDocumentDetail | null>(null);
  const [selectedDocumentDetailView, setSelectedDocumentDetailView] = useState<KnowledgeDocumentDetailView>("preview");
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [isLoadingDocumentDetail, setIsLoadingDocumentDetail] = useState(false);
  const [documentDetailError, setDocumentDetailError] = useState<string | null>(null);
  const [globalTaskSummary, setGlobalTaskSummary] = useState<KnowledgeProcessingStatusSummary>({
    scope: "global",
    collectionId: null,
    queued: 0,
    running: 0,
    failed: 0,
  });
  const [activeCollectionTaskSummary, setActiveCollectionTaskSummary] = useState<KnowledgeProcessingStatusSummary>({
    scope: "collection",
    collectionId: null,
    queued: 0,
    running: 0,
    failed: 0,
  });
  const [taskCenterError, setTaskCenterError] = useState<string | null>(null);
  const [taskCenterNotice, setTaskCenterNotice] = useState<string | null>(null);
  const [isTaskCenterBusy, setIsTaskCenterBusy] = useState(false);
  const [globalDeadLetterCount, setGlobalDeadLetterCount] = useState(0);
  const [activeCollectionDeadLetterCount, setActiveCollectionDeadLetterCount] = useState(0);
  const [pipelineSettings, setPipelineSettings] = useState<KnowledgePipelineSettings | null>(null);
  const [isSavingPipelineSettings, setIsSavingPipelineSettings] = useState(false);
  const [knowledgeMultimodalConfig, setKnowledgeMultimodalConfig] = useState<KnowledgeMultimodalConfig>(loadKnowledgeMultimodalConfig);
  const [isCollectionSettingsOpen, setIsCollectionSettingsOpen] = useState(false);
  const [editingCollection, setEditingCollection] = useState<KnowledgeCollection | null>(null);
  const [collectionSettingsDraft, setCollectionSettingsDraft] = useState<CollectionSettingsDraft | null>(null);
  const [collectionSettingsError, setCollectionSettingsError] = useState<string | null>(null);
  const [isSavingCollectionSettings, setIsSavingCollectionSettings] = useState(false);
  const [deadLetterScope, setDeadLetterScope] = useState<DeadLetterScope>("activeCollection");
  const [deadLetterStatusFilter, setDeadLetterStatusFilter] = useState<"failed" | "replayed" | "all">("failed");
  const [deadLetterItems, setDeadLetterItems] = useState<KnowledgeProcessingDeadLetter[]>([]);
  const [deadLetterTotal, setDeadLetterTotal] = useState(0);
  const [deadLetterPage, setDeadLetterPage] = useState(1);
  const [isDeadLetterLoading, setIsDeadLetterLoading] = useState(false);
  const [deadLetterReplayBusyId, setDeadLetterReplayBusyId] = useState<string | null>(null);
  const [isTaskSettingsOpen, setIsTaskSettingsOpen] = useState(false);
  const [expandedDeadLetterId, setExpandedDeadLetterId] = useState<string | null>(null);
  const [isTaskCenterPanelOpen, setIsTaskCenterPanelOpen] = useState(false);
  const [isSearchToolbarOpen, setIsSearchToolbarOpen] = useState(false);
  const settingsSaveTimerRef = useRef<number | null>(null);
  const uploadNoticeTimerRef = useRef<number | null>(null);
  const pendingPipelineSettingsRef = useRef<KnowledgePipelineSettings | null>(null);
  const isSavingPipelineSettingsRef = useRef(false);
  const deadLetterListRequestSeqRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const uploadMenuRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const chunkSearchInputRef = useRef<HTMLInputElement | null>(null);
  const activeCollection = useMemo(() => {
    if (selectedCollectionId) {
      const selected = library.collections.find((collection) => collection.id === selectedCollectionId);
      if (selected) {
        return selected;
      }
    }

    return library.collections[0] ?? null;
  }, [library.collections, selectedCollectionId]);
  const imageMultimodalModels = useMemo(
    () => getKnowledgeMultimodalModelsByCapability(knowledgeMultimodalConfig, "image"),
    [knowledgeMultimodalConfig]
  );
  const audioMultimodalModels = useMemo(
    () => getKnowledgeMultimodalModelsByCapability(knowledgeMultimodalConfig, "audio"),
    [knowledgeMultimodalConfig]
  );

  const activeCollectionDocuments = useMemo(() => {
    if (!activeCollection) {
      return [];
    }
    return library.documents.filter((document) => document.collectionId === activeCollection.id);
  }, [activeCollection?.id, library.documents]);

  const selectedDocumentRecord = useMemo(
    () => (selectedDocumentId ? library.documents.find((document) => document.id === selectedDocumentId) ?? null : null),
    [library.documents, selectedDocumentId]
  );

  const selectedDocument = selectedDocumentDetail?.document ?? selectedDocumentRecord;
  const activeCollectionName = activeCollection?.name ?? "未选择知识库";
  const selectedVectorizationLabel = getVectorizationLabel(selectedDocument?.vectorizationState ?? null);
  const documentDetailViewOptions: Array<{
    id: "preview" | "assets" | "chunks";
    label: string;
    icon: typeof LucideFileText;
  }> = [
    { id: "preview", label: "原文", icon: LucideFileText },
    { id: "assets", label: "图片资产", icon: LucideFileImage },
    { id: "chunks", label: "知识结果", icon: Layers3 },
  ];
  const documentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const document of library.documents) {
      map.set(document.id, document.sourceName);
    }
    return map;
  }, [library.documents]);
  const selectedDocumentCollectionName = useMemo(() => {
    if (!selectedDocument) {
      return activeCollectionName;
    }
    return (
      library.collections.find((collection) => collection.id === selectedDocument.collectionId)?.name ??
      "未命名知识库"
    );
  }, [activeCollectionName, library.collections, selectedDocument]);
  const selectedDocumentCollection = useMemo(() => {
    if (!selectedDocument) {
      return activeCollection;
    }
    return library.collections.find((collection) => collection.id === selectedDocument.collectionId) ?? null;
  }, [activeCollection, library.collections, selectedDocument]);
  const pageMode: KnowledgePageMode = selectedDocumentId ? "detail" : activeCollectionDocuments.length > 0 ? "list" : "empty";
  const taskCounts = globalTaskSummary;
  const activeCollectionTaskCounts = activeCollectionTaskSummary;
  const deadLetterPageSize = 6;

  const activeCategories = useMemo(() => {
    const counts = { all: activeCollectionDocuments.length, docs: 0, images: 0, audio: 0, video: 0 };
    for (const document of activeCollectionDocuments) {
      const categoryId = classifyResource(document.sourceName, document.sourcePath);
      counts[categoryId as keyof typeof counts] += 1;
    }

    return CATEGORIES.map((category) => ({
      ...category,
      count: counts[category.id as keyof typeof counts] ?? 0,
    }));
  }, [activeCollectionDocuments]);

  const activeCategoryData = useMemo(
    () => activeCategories.find((category) => category.id === activeCategory) ?? activeCategories[0],
    [activeCategory, activeCategories]
  );

  const visibleDocuments = useMemo(() => {
    const normalizedQuery = normalizeSearchText(searchQuery);
    return activeCollectionDocuments.filter((document) => {
      const documentCategory = classifyResource(document.sourceName, document.sourcePath);
      if (activeCategory !== "all" && documentCategory !== activeCategory) {
        return false;
      }

      if (!normalizedQuery) {
        return true;
      }

      return normalizeSearchText(
        [document.sourceName, document.sourcePath ?? "", document.contentPreview, document.titleHierarchy ?? "", ...(document.tags ?? [])].join(" ")
      ).includes(normalizedQuery);
    });
  }, [activeCategory, activeCollectionDocuments, searchQuery]);

  const visibleDocumentChunks = useMemo(() => {
    const chunks = selectedDocumentDetail?.chunks ?? [];
    const textChunks = chunks.filter((chunk) => (chunk.chunkType ?? "text") === "text");
    const normalizedQuery = normalizeSearchText(chunkSearchQuery);
    if (!normalizedQuery) {
      return textChunks;
    }

    return textChunks.filter((chunk) =>
      normalizeSearchText([`第 ${chunk.chunkIndex + 1} 片`, chunk.title ?? "", chunk.content].join(" ")).includes(normalizedQuery)
    );
  }, [chunkSearchQuery, selectedDocumentDetail?.chunks]);

  const selectedAsset = useMemo(
    () => selectedDocumentDetail?.assets.find((asset) => asset.id === selectedAssetId) ?? null,
    [selectedAssetId, selectedDocumentDetail?.assets]
  );

  const textOnlyDocumentChunkCount = useMemo(
    () => selectedDocumentDetail?.chunks.filter((chunk) => (chunk.chunkType ?? "text") === "text").length ?? 0,
    [selectedDocumentDetail?.chunks]
  );

  const listThumbnailDataUrlById = useMemo(() => {
    const map = new Map<string, string | undefined>();
    for (const document of visibleDocuments) {
      const previewKind = (document.previewType ?? "").toLowerCase();
      const mimeType = (document.mimeType ?? "").toLowerCase();
      const isImageDocument = previewKind === "image" || mimeType.startsWith("image/");
      if (isImageDocument) {
        map.set(document.id, document.thumbnailDataUrl ?? undefined);
        continue;
      }

      const previewSeed = [document.titleHierarchy ?? "", document.contentPreview ?? "", document.sourceName].filter(Boolean).join("\n");
      const regenerated = createThumbnailDataUrlFromContent(previewSeed);
      map.set(document.id, regenerated ?? document.thumbnailDataUrl ?? undefined);
    }
    return map;
  }, [visibleDocuments]);

  useEffect(() => {
    if (library.collections.length === 0) {
      setSelectedCollectionId("");
      return;
    }

    if (!selectedCollectionId || !library.collections.some((collection) => collection.id === selectedCollectionId)) {
      setSelectedCollectionId(library.collections[0].id);
    }
  }, [library.collections, selectedCollectionId]);

  useEffect(() => {
    if (!selectedDocumentId) {
      return;
    }

    const selectedDocument = library.documents.find((document) => document.id === selectedDocumentId);
    if (!selectedDocument || selectedDocument.collectionId !== selectedCollectionId) {
      setSelectedDocumentId(null);
      setSelectedDocumentDetail(null);
      setDocumentDetailError(null);
      setSelectedDocumentDetailView("preview");
    }
  }, [library.documents, selectedCollectionId, selectedDocumentId]);

  useEffect(() => {
    if (!selectedDocumentId) {
      setSelectedDocumentDetail(null);
      setDocumentDetailError(null);
      setSelectedAssetId(null);
      return;
    }

    let cancelled = false;
    setIsLoadingDocumentDetail(true);
    setDocumentDetailError(null);

    void loadKnowledgeDocumentDetail(selectedDocumentId)
      .then((detail) => {
        if (!cancelled) {
          setSelectedDocumentDetail(detail);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setSelectedDocumentDetail(null);
          setDocumentDetailError(error instanceof Error ? error.message : "加载文档详情失败");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingDocumentDetail(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedDocumentId]);

  useEffect(() => {
    const firstAssetId = selectedDocumentDetail?.assets[0]?.id ?? null;
    setSelectedAssetId(firstAssetId);
  }, [selectedDocumentDetail?.document.id, selectedDocumentDetail?.assets]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;

    void listen("omni-knowledge-multimodal-profile-changed", () => {
      setKnowledgeMultimodalConfig(loadKnowledgeMultimodalConfig());
    }).then((unlisten) => {
      cleanup = unlisten;
    });

    return () => {
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const [payload, globalSummary] = await Promise.all([
          loadKnowledgeLibrary(),
          loadKnowledgeProcessingStatusSummary(null),
        ]);
        const initialCollectionId = payload.collections[0]?.id ?? null;
        const initialCollectionSummary = initialCollectionId
          ? await loadKnowledgeProcessingStatusSummary(initialCollectionId)
          : {
              scope: "collection" as const,
              collectionId: null,
              queued: 0,
              running: 0,
              failed: 0,
            };
        if (!cancelled) {
          setLibrary(payload);
          setGlobalTaskSummary(globalSummary);
          const settings = await loadKnowledgePipelineSettings();
          if (!cancelled) {
            setPipelineSettings(settings);
          }
          const globalDeadLetters = await loadKnowledgeProcessingDeadLetters({
            collectionId: null,
            status: "failed",
            limit: 1,
            offset: 0,
          });
          if (!cancelled) {
            setGlobalDeadLetterCount(globalDeadLetters.total);
          }
          setActiveCollectionTaskSummary(initialCollectionSummary);
          setSelectedCollectionId((current) => {
            if (!current || !payload.collections.some((collection) => collection.id === current)) {
              return payload.collections[0]?.id ?? "";
            }
            return current;
          });
          setIsKnowledgeLibraryReady(true);
        }
      } catch (error) {
        console.error(error);
        if (!cancelled) {
          setIsKnowledgeLibraryReady(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshProcessingJobs({ syncLibrary: true });
    }, 2500);

    return () => window.clearInterval(interval);
  }, [activeCollection?.id]);

  useEffect(() => {
    if (!isUploadMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const targetNode = event.target as Node | null;
      if (targetNode && uploadMenuRef.current?.contains(targetNode)) {
        return;
      }
      setIsUploadMenuOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [isUploadMenuOpen]);

  useEffect(() => {
    if (!isSearchToolbarOpen || searchQuery) {
      return;
    }

    const handlePointerDown = () => {
      setIsSearchToolbarOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [isSearchToolbarOpen, searchQuery]);

  useEffect(() => {
    if (!isSearchToolbarOpen) {
      return;
    }
    const timer = window.setTimeout(() => searchInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [isSearchToolbarOpen]);

  useEffect(() => {
    if (uploadNoticeTimerRef.current !== null) {
      window.clearTimeout(uploadNoticeTimerRef.current);
      uploadNoticeTimerRef.current = null;
    }

    if (!uploadNotice || uploadNotice.tone !== "success") {
      return;
    }

    uploadNoticeTimerRef.current = window.setTimeout(() => {
      setUploadNotice(null);
      uploadNoticeTimerRef.current = null;
    }, UPLOAD_NOTICE_AUTO_DISMISS_MS);

    return () => {
      if (uploadNoticeTimerRef.current !== null) {
        window.clearTimeout(uploadNoticeTimerRef.current);
        uploadNoticeTimerRef.current = null;
      }
    };
  }, [uploadNotice]);

  useEffect(() => {
    setChunkSearchQuery("");
  }, [selectedDocumentId]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && selectedDocumentId && selectedDocumentDetailView === "chunks") {
        event.preventDefault();
        chunkSearchInputRef.current?.focus();
        chunkSearchInputRef.current?.select();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedDocumentDetailView, selectedDocumentId]);

  useEffect(() => {
    if (!isCollectionMenuOpen) {
      return;
    }

    const handlePointerDown = () => setIsCollectionMenuOpen(null);
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [isCollectionMenuOpen]);

  useEffect(() => {
    if (!isCollectionSettingsOpen) {
      return;
    }

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !isSavingCollectionSettings) {
        setIsCollectionSettingsOpen(false);
        setEditingCollection(null);
        setCollectionSettingsDraft(null);
        setCollectionSettingsError(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isCollectionSettingsOpen, isSavingCollectionSettings]);

  useEffect(() => {
    if (!isDocumentMenuOpen) {
      return;
    }

    const handlePointerDown = () => setIsDocumentMenuOpen(null);
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [isDocumentMenuOpen]);

  useEffect(() => {
    deadLetterListRequestSeqRef.current += 1;
    setIsDeadLetterLoading(false);
    return () => {
      if (settingsSaveTimerRef.current) {
        window.clearTimeout(settingsSaveTimerRef.current);
        settingsSaveTimerRef.current = null;
      }
    };
  }, []);

  async function refreshLibrary() {
    const [payload, globalSummary] = await Promise.all([
      loadKnowledgeLibrary(),
      loadKnowledgeProcessingStatusSummary(null),
    ]);
    const collectionId = selectedCollectionId || payload.collections[0]?.id || null;
    const collectionSummary = collectionId
      ? await loadKnowledgeProcessingStatusSummary(collectionId)
      : {
          scope: "collection" as const,
          collectionId: null,
          queued: 0,
          running: 0,
          failed: 0,
        };
    setLibrary(payload);
    setGlobalTaskSummary(globalSummary);
    setActiveCollectionTaskSummary(collectionSummary);
    const settings = await loadKnowledgePipelineSettings();
    if (!settingsSaveTimerRef.current && !pendingPipelineSettingsRef.current && !isSavingPipelineSettingsRef.current) {
      setPipelineSettings(settings);
    }
    const [globalDeadLetters, collectionDeadLetters] = await Promise.all([
      loadKnowledgeProcessingDeadLetters({
        collectionId: null,
        status: "failed",
        limit: 1,
        offset: 0,
      }),
      collectionId
        ? loadKnowledgeProcessingDeadLetters({
            collectionId,
            status: "failed",
            limit: 1,
            offset: 0,
          })
        : Promise.resolve({
            scope: "collection" as const,
            collectionId: null,
            status: "failed",
            total: 0,
            hasMore: false,
            items: [],
          }),
    ]);
    setGlobalDeadLetterCount(globalDeadLetters.total);
    setActiveCollectionDeadLetterCount(collectionDeadLetters.total);
    return payload;
  }

  async function refreshProcessingJobs(options?: { syncLibrary?: boolean }) {
    try {
      const [globalSummary, collectionSummary] = await Promise.all([
        loadKnowledgeProcessingStatusSummary(null),
        activeCollection?.id
          ? loadKnowledgeProcessingStatusSummary(activeCollection.id)
          : Promise.resolve({
              scope: "collection" as const,
              collectionId: null,
              queued: 0,
              running: 0,
              failed: 0,
            }),
      ]);
      setGlobalTaskSummary(globalSummary);
      setActiveCollectionTaskSummary(collectionSummary);
      const settings = await loadKnowledgePipelineSettings();
      if (!settingsSaveTimerRef.current && !pendingPipelineSettingsRef.current && !isSavingPipelineSettingsRef.current) {
        setPipelineSettings(settings);
      }
      const [globalDeadLetters, collectionDeadLetters] = await Promise.all([
        loadKnowledgeProcessingDeadLetters({
          collectionId: null,
          status: "failed",
          limit: 1,
          offset: 0,
        }),
        activeCollection?.id
          ? loadKnowledgeProcessingDeadLetters({
              collectionId: activeCollection.id,
              status: "failed",
              limit: 1,
              offset: 0,
            })
          : Promise.resolve({
              scope: "collection" as const,
              collectionId: null,
              status: "failed",
              total: 0,
              hasMore: false,
              items: [],
            }),
      ]);
      setGlobalDeadLetterCount(globalDeadLetters.total);
      setActiveCollectionDeadLetterCount(collectionDeadLetters.total);
      setTaskCenterError(null);
      if (options?.syncLibrary) {
        try {
          const payload = await loadKnowledgeLibrary();
          setLibrary(payload);
        } catch (error) {
          console.error(error);
        }
      }
    } catch (error) {
      console.error(error);
      setTaskCenterError(error instanceof Error ? error.message : "加载处理队列失败");
    }
  }

  async function refreshDeadLetterList(options?: { resetPage?: boolean }) {
    const requestSeq = deadLetterListRequestSeqRef.current + 1;
    deadLetterListRequestSeqRef.current = requestSeq;
    const pageSize = deadLetterPageSize;
    const nextPage = options?.resetPage ? 1 : deadLetterPage;
    const scopeCollectionId = deadLetterScope === "activeCollection" ? activeCollection?.id ?? null : null;
    const statusFilter = deadLetterStatusFilter === "all" ? null : deadLetterStatusFilter;
    if (deadLetterScope === "activeCollection" && !activeCollection?.id) {
      setDeadLetterItems([]);
      setDeadLetterTotal(0);
      if (options?.resetPage) {
        setDeadLetterPage(1);
      }
      return;
    }

    setIsDeadLetterLoading(true);
    try {
      const result = await loadKnowledgeProcessingDeadLetters({
        collectionId: scopeCollectionId,
        status: statusFilter,
        limit: pageSize,
        offset: (nextPage - 1) * pageSize,
      });
      if (requestSeq !== deadLetterListRequestSeqRef.current) {
        return;
      }
      const totalPages = Math.max(1, Math.ceil(result.total / pageSize));
      if (result.total <= 0 && nextPage !== 1) {
        setDeadLetterPage(1);
        return;
      }
      if (result.total > 0 && nextPage > totalPages) {
        setDeadLetterPage(totalPages);
        return;
      }
      setDeadLetterItems(result.items);
      setDeadLetterTotal(result.total);
      setTaskCenterError(null);
      if (options?.resetPage) {
        setDeadLetterPage(1);
      }
    } catch (error) {
      console.error(error);
      if (requestSeq === deadLetterListRequestSeqRef.current) {
        setTaskCenterError(error instanceof Error ? error.message : "加载死信列表失败");
      }
    } finally {
      if (requestSeq === deadLetterListRequestSeqRef.current) {
        setIsDeadLetterLoading(false);
      }
    }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const summary = activeCollection?.id
          ? await loadKnowledgeProcessingStatusSummary(activeCollection.id)
          : {
              scope: "collection" as const,
              collectionId: null,
              queued: 0,
              running: 0,
              failed: 0,
            };
        if (!cancelled) {
          setActiveCollectionTaskSummary(summary);
        }
        const collectionDeadLetters = activeCollection?.id
          ? await loadKnowledgeProcessingDeadLetters({
              collectionId: activeCollection.id,
              status: "failed",
              limit: 1,
              offset: 0,
            })
          : {
              scope: "collection" as const,
              collectionId: null,
              status: "failed",
              total: 0,
              hasMore: false,
              items: [],
            };
        if (!cancelled) {
          setActiveCollectionDeadLetterCount(collectionDeadLetters.total);
        }
      } catch (error) {
        console.error(error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeCollection?.id]);

  useEffect(() => {
    if (!isKnowledgeLibraryReady) {
      return;
    }
    void refreshDeadLetterList();
  }, [deadLetterScope, deadLetterStatusFilter, deadLetterPage, activeCollection?.id, isKnowledgeLibraryReady]);

  async function importFile(file: File, collectionId: string) {
    const extension = getExtension(file.name) || null;
    const previewType = getPreviewKindFromFile(file);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let content = "";

    try {
      if (previewType === "markdown" || previewType === "text") {
        content = await file.text();
      } else if (previewType === "docx") {
        content = await convertDocxBytesToText(bytes);
      } else if (previewType === "pdf") {
        content = await convertPdfBytesToText(bytes);
      } else if (previewType === "image") {
        content = (await createImageKnowledgeContent(file)) ?? "";
      }
    } catch (error) {
      console.error(error);
      content = "";
    }

    const thumbnailDataUrl = (await createThumbnailDataUrl(file, content || file.name)) ?? undefined;
    return await invoke<PipelineImportResult>("import_knowledge_document_pipeline_command", {
      input: {
        collectionId,
        sourceName: file.name,
        sourcePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
        content: content || null,
        contentBytes: Array.from(bytes),
        mimeType: file.type || null,
        fileExtension: extension,
        previewType,
        thumbnailDataUrl,
        parserProfileId: null,
      },
    });
  }

  async function handleKnowledgeUploadSelection(files: FileList | File[]) {
    const items = Array.from(files);
    if (items.length === 0) {
      return;
    }

    setUploadError(null);
    setUploadNotice(null);

    try {
      const targetCollection = activeCollection;
      const targetCollectionId = targetCollection?.id;
      if (!targetCollectionId || !targetCollection) {
        throw new Error("请先创建知识库后再上传文件");
      }
      for (const file of items) {
        const blockedMessage = getKnowledgeUploadBlockMessage(file, targetCollection, knowledgeMultimodalConfig);
        if (blockedMessage) {
          setUploadError(blockedMessage);
          setUploadNotice({ tone: "error", message: blockedMessage });
          return;
        }
      }
      let queuedCount = 0;
      let duplicateCount = 0;
      for (const file of items) {
        const result = await importFile(file, targetCollectionId);
        if (result.status === "duplicate") {
          duplicateCount += 1;
        } else {
          queuedCount += 1;
        }
      }

      await refreshLibrary();
      setSelectedCollectionId(targetCollectionId);
      setSelectedDocumentId(null);
      setSelectedDocumentDetail(null);
      setDocumentDetailError(null);
      setSelectedDocumentDetailView("preview");
      setActiveCategory("all");
      setSearchQuery("");
      if (duplicateCount > 0 && queuedCount > 0) {
        setUploadNotice({ tone: "success", message: `上传完成：新增 ${queuedCount} 个，重复跳过 ${duplicateCount} 个` });
      } else if (duplicateCount > 0) {
        setUploadNotice({ tone: "success", message: `未新增文档：所选 ${duplicateCount} 个文件在当前知识库中已存在` });
      } else {
        setUploadNotice({ tone: "success", message: `上传完成：新增 ${queuedCount} 个文档` });
      }
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : "文件上传失败";
      setUploadError(message);
      setUploadNotice({ tone: "error", message });
    }
  }

  async function createCollection() {
    setCreateCollectionError(null);

    try {
      const values = await openPrompt({
        title: "新建知识库",
        description: "先输入名称，再补充简介，便于后续检索和管理。",
        confirmLabel: "创建",
        fields: [
          { label: "知识库名称", defaultValue: "新知识库", placeholder: "请输入知识库名称", autoFocus: true },
          { label: "知识库描述", defaultValue: "用于组织上传文件", placeholder: "请输入知识库描述", required: false },
        ],
      });

      const name = values?.[0]?.trim();
      if (!name) {
        return;
      }

      const description = values?.[1]?.trim() || "用于组织上传文件";
      const createdCollection = await invoke<KnowledgeCollection>("create_knowledge_collection_command", { name, description });
      await refreshLibrary();
      setSelectedCollectionId(createdCollection.id);
    } catch (error) {
      console.error(error);
      setCreateCollectionError(error instanceof Error ? error.message : "创建知识库失败");
    }
  }

  async function deleteCollection(collectionId: string) {
    await invoke("delete_knowledge_collection_command", { collectionId });
    const payload = await refreshLibrary();
    setSelectedCollectionId((current) => {
      if (current !== collectionId) {
        return current;
      }
      return payload.collections[0]?.id ?? "";
    });
    setSelectedDocumentId(null);
    setSelectedDocumentDetail(null);
    setSelectedDocumentDetailView("preview");
  }

  function openCollectionSettings(collection: KnowledgeCollection) {
    setKnowledgeMultimodalConfig(loadKnowledgeMultimodalConfig());
    setIsCollectionMenuOpen(null);
    setEditingCollection(collection);
    setCollectionSettingsDraft(createCollectionSettingsDraft(collection));
    setCollectionSettingsError(null);
    setIsCollectionSettingsOpen(true);
  }

  function closeCollectionSettings() {
    if (isSavingCollectionSettings) {
      return;
    }
    setIsCollectionSettingsOpen(false);
    setEditingCollection(null);
    setCollectionSettingsDraft(null);
    setCollectionSettingsError(null);
  }

  function updateCollectionDraft(patch: Partial<CollectionSettingsDraft>) {
    setCollectionSettingsDraft((current) => (current ? { ...current, ...patch } : current));
  }

  function updateCollectionImageConfig(patch: Partial<KnowledgeCollectionMultimodalConfig["image"]>) {
    setCollectionSettingsDraft((current) =>
      current
        ? {
            ...current,
            multimodalConfig: {
              ...current.multimodalConfig,
              image: {
                ...current.multimodalConfig.image,
                ...patch,
              },
            },
          }
        : current
    );
  }

  function updateCollectionAudioConfig(patch: Partial<KnowledgeCollectionMultimodalConfig["audio"]>) {
    setCollectionSettingsDraft((current) =>
      current
        ? {
            ...current,
            multimodalConfig: {
              ...current.multimodalConfig,
              audio: {
                ...current.multimodalConfig.audio,
                ...patch,
              },
            },
          }
        : current
    );
  }

  async function saveCollectionSettings() {
    if (!collectionSettingsDraft) {
      return;
    }

    const draft = collectionSettingsDraft;
    const trimmedName = draft.name.trim();
    if (!trimmedName) {
      setCollectionSettingsError("知识库名称不能为空");
      return;
    }

    if (
      draft.multimodalConfig.enabled &&
      draft.multimodalConfig.image.enabled &&
      !imageMultimodalModels.some((model) => model.id === draft.multimodalConfig.image.modelId)
    ) {
      setCollectionSettingsError("已开启图片分析，但当前知识库还没有选择可用的图片模型");
      return;
    }

    if (
      draft.multimodalConfig.enabled &&
      draft.multimodalConfig.audio.enabled &&
      !audioMultimodalModels.some((model) => model.id === draft.multimodalConfig.audio.modelId)
    ) {
      setCollectionSettingsError("已开启音频分析，但当前知识库还没有选择可用的音频模型");
      return;
    }

    setCollectionSettingsError(null);
    setIsSavingCollectionSettings(true);
    try {
      await invoke<KnowledgeCollection>("update_knowledge_collection_command", {
        input: {
          collectionId: draft.id,
          name: trimmedName,
          description: draft.description.trim() || "用于组织上传文件",
          retrievalMode: draft.retrievalMode,
          multimodalConfigJson: JSON.stringify(draft.multimodalConfig),
        },
      });
      await refreshLibrary();
      setUploadNotice({ tone: "success", message: `知识库设置已保存：${trimmedName}` });
      setIsCollectionSettingsOpen(false);
      setEditingCollection(null);
      setCollectionSettingsDraft(null);
      setCollectionSettingsError(null);
    } catch (error) {
      console.error(error);
      setCollectionSettingsError(error instanceof Error ? error.message : "保存知识库设置失败");
    } finally {
      setIsSavingCollectionSettings(false);
    }
  }

  async function deleteDocument(documentId: string) {
    await invoke("delete_knowledge_document_command", { documentId });
    await refreshLibrary();
    setSelectedDocumentId(null);
    setSelectedDocumentDetail(null);
    setSelectedDocumentDetailView("preview");
  }

  async function refreshSelectedDocumentDetail(documentId: string) {
    await refreshLibrary();
    const detail = await loadKnowledgeDocumentDetail(documentId);
    setSelectedDocumentDetail(detail);
  }

  async function runSelectedDocumentAction(action: () => Promise<unknown>, fallbackMessage: string) {
    if (!selectedDocument) {
      return;
    }

    setDocumentDetailError(null);
    setIsLoadingDocumentDetail(true);
    try {
      await action();
      await refreshSelectedDocumentDetail(selectedDocument.id);
    } catch (error) {
      setDocumentDetailError(error instanceof Error ? error.message : fallbackMessage);
    } finally {
      setIsLoadingDocumentDetail(false);
    }
  }

  async function reprocessFailedItems(scope: "all" | "activeCollection") {
    if (scope === "activeCollection" && !activeCollection?.id) {
      setTaskCenterNotice("当前没有可用知识库");
      setTaskCenterError(null);
      return;
    }
    setTaskCenterError(null);
    setTaskCenterNotice(null);
    setIsTaskCenterBusy(true);
    try {
      const retryResult = await invoke<RetryFailedJobsResult>("retry_failed_knowledge_processing_jobs_command", {
        input: {
          collectionId: scope === "activeCollection" ? activeCollection?.id ?? null : null,
          limit: 500,
        },
      });
      const replayResult = await invoke<ReplayDeadLettersResult>("replay_knowledge_processing_dead_letters_command", {
        input: {
          collectionId: scope === "activeCollection" ? activeCollection?.id ?? null : null,
          status: "failed",
          limit: 300,
        },
      });

      if (retryResult.attempted <= 0 && replayResult.attempted <= 0) {
        setTaskCenterNotice("没有可重新处理的失败项");
        return;
      }

      const retriedSummary =
        retryResult.attempted > 0 ? `队列重试 ${retryResult.retried}/${retryResult.attempted}` : "队列无需重试";
      const replayedSummary =
        replayResult.attempted > 0 ? `死信回投 ${replayResult.replayed}/${replayResult.attempted}` : "死信无需回投";
      setTaskCenterNotice(`已重新处理失败项：${retriedSummary}，${replayedSummary}`);

      const errors = [...retryResult.errors, ...replayResult.errors];
      if (errors.length > 0) {
        setTaskCenterError(errors.slice(0, 2).join(" | "));
      }
      await Promise.all([refreshProcessingJobs({ syncLibrary: true }), refreshDeadLetterList({ resetPage: true })]);
    } catch (error) {
      console.error(error);
      setTaskCenterError(error instanceof Error ? error.message : "重新处理失败项失败");
    } finally {
      setIsTaskCenterBusy(false);
    }
  }

  async function updatePipelineSettings(patch: Partial<KnowledgePipelineSettings>) {
    if (!pipelineSettings) {
      return;
    }
    setTaskCenterError(null);
    const nextSettings = {
      ...pipelineSettings,
      ...patch,
    };
    setPipelineSettings(nextSettings);
    pendingPipelineSettingsRef.current = nextSettings;
    if (settingsSaveTimerRef.current) {
      window.clearTimeout(settingsSaveTimerRef.current);
      settingsSaveTimerRef.current = null;
    }
    settingsSaveTimerRef.current = window.setTimeout(() => {
      settingsSaveTimerRef.current = null;
      void (async () => {
        try {
          isSavingPipelineSettingsRef.current = true;
          setIsSavingPipelineSettings(true);
          const draft = pendingPipelineSettingsRef.current ?? nextSettings;
          const saved = await saveKnowledgePipelineSettings(draft);
          setPipelineSettings(saved);
          pendingPipelineSettingsRef.current = null;
          setTaskCenterNotice("调度参数已保存");
        } catch (error) {
          console.error(error);
          setTaskCenterError(error instanceof Error ? error.message : "保存调度设置失败");
        } finally {
          isSavingPipelineSettingsRef.current = false;
          setIsSavingPipelineSettings(false);
        }
      })();
    }, 450);
  }

  async function replayDeadLetterItem(item: KnowledgeProcessingDeadLetter) {
    if (item.status !== "failed") {
      setTaskCenterNotice("仅失败状态的死信支持回放");
      return;
    }
    setTaskCenterError(null);
    setTaskCenterNotice(null);
    setDeadLetterReplayBusyId(item.id);
    try {
      await invoke("retry_knowledge_processing_job_command", { jobId: item.jobId });
      setTaskCenterNotice("单条死信已回放");
      await refreshLibrary();
      await refreshDeadLetterList();
    } catch (error) {
      console.error(error);
      setTaskCenterError(error instanceof Error ? error.message : "单条死信回放失败");
    } finally {
      setDeadLetterReplayBusyId(null);
    }
  }

  function openDocument(documentId: string) {
    setSelectedDocumentDetail(null);
    setDocumentDetailError(null);
    setSelectedDocumentDetailView("preview");
    setSelectedAssetId(null);
    setSelectedDocumentId(documentId);
  }

  function openDocumentMenu(documentId: string) {
    setIsDocumentMenuOpen(documentId);
  }

  function backToDocumentList() {
    setSelectedDocumentId(null);
    setSelectedDocumentDetail(null);
    setDocumentDetailError(null);
    setSelectedDocumentDetailView("preview");
    setSelectedAssetId(null);
  }

  async function openSelectedDocumentExternal() {
    const path = selectedDocument?.storedFilePath ?? selectedDocument?.sourcePath ?? null;
    if (!path) {
      throw new Error("没有可打开的原文件路径");
    }
    await openPath(path);
  }

  const detailView = pageMode === "detail";
  const shouldShowTaskCenterPanel = isTaskCenterPanelOpen && !detailView;
  const taskCenterPanel = (
    <aside className="chat-topic-panel no-drag !w-[360px] !min-w-[360px] !basis-[360px] omni-knowledge-task-panel">
      <div className="chat-topic-panel__body">
        <>
          <div className="chat-topic-panel__section chat-topic-panel__section--task">
            <div className="chat-topic-panel__section-title">
              <History size={13} strokeWidth={2} />
              <span>任务中心</span>
            </div>

            <div className="chat-topic-panel__task">
              <div className="chat-topic-panel__task-head">
                <strong>{deadLetterScope === "activeCollection" ? `当前知识库 · ${activeCollectionName}` : "全局处理概览"}</strong>
                <span
                  className={`chat-topic-panel__task-status ${
                    (deadLetterScope === "activeCollection" ? activeCollectionTaskCounts.failed : taskCounts.failed) > 0
                      ? "chat-topic-panel__task-status--failed"
                      : "chat-topic-panel__task-status--completed"
                  }`}
                >
                  失败 {deadLetterScope === "activeCollection" ? activeCollectionTaskCounts.failed : taskCounts.failed}
                </span>
              </div>
              <div className="chat-topic-panel__task-meta">
                <span>排队 {deadLetterScope === "activeCollection" ? activeCollectionTaskCounts.queued : taskCounts.queued}</span>
                <span>运行 {deadLetterScope === "activeCollection" ? activeCollectionTaskCounts.running : taskCounts.running}</span>
                <span>死信 {deadLetterScope === "activeCollection" ? activeCollectionDeadLetterCount : globalDeadLetterCount}</span>
              </div>
              <div className="mt-3 rounded-none border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-500">
                全局失败 {taskCounts.failed} · 当前库失败 {activeCollectionTaskCounts.failed} · 当前展示 {deadLetterScope === "activeCollection" ? "当前知识库" : "全局范围"}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-2">
              <select
                value={deadLetterScope}
                onChange={(event) => {
                  const nextScope = event.target.value as DeadLetterScope;
                  if (nextScope === "activeCollection" && !activeCollection?.id) {
                    setTaskCenterNotice("当前没有可用知识库");
                    return;
                  }
                  setDeadLetterPage(1);
                  setDeadLetterScope(nextScope);
                }}
                className="chat-topic-panel__form-input"
              >
                <option value="activeCollection">当前知识库</option>
                <option value="all">全局范围</option>
              </select>
              <button
                type="button"
                className="chat-topic-panel__inline-action"
                onClick={() => setIsTaskSettingsOpen((current) => !current)}
              >
                {isTaskSettingsOpen ? <ChevronUp size={14} strokeWidth={2} /> : <ChevronDown size={14} strokeWidth={2} />}
                <span>{isTaskSettingsOpen ? "收起调度设置" : "调度设置"}</span>
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={
                  isTaskCenterBusy ||
                  ((deadLetterScope === "activeCollection"
                    ? activeCollectionTaskCounts.failed + activeCollectionDeadLetterCount
                    : taskCounts.failed + globalDeadLetterCount) <= 0)
                }
                onClick={() => void reprocessFailedItems(deadLetterScope)}
                className="chat-topic-panel__inline-action"
              >
                <RotateCcw size={14} strokeWidth={2} />
                <span>重新处理失败项</span>
              </button>
            </div>
          </div>

          {pipelineSettings && isTaskSettingsOpen ? (
            <div className="chat-topic-panel__section">
              <div className="chat-topic-panel__section-title">
                <Settings size={13} strokeWidth={2} />
                <span>调度设置</span>
                <span className="chat-topic-panel__item-meta">{isSavingPipelineSettings ? "保存中..." : "自动保存"}</span>
              </div>
              <div className="chat-topic-panel__task chat-topic-panel__task--form">
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <label className="flex items-center justify-between gap-2 rounded-none border border-slate-200 bg-white px-2 py-1.5">
                    <span>总并发</span>
                    <input
                      type="number"
                      min={1}
                      max={4}
                      value={pipelineSettings.maxConcurrentJobs}
                      onChange={(event) => void updatePipelineSettings({ maxConcurrentJobs: Number(event.target.value || 1) })}
                      className="w-14 rounded-none border border-slate-200 px-1 py-0.5 text-right text-[11px] outline-none"
                    />
                  </label>
                  <label className="flex items-center justify-between gap-2 rounded-none border border-slate-200 bg-white px-2 py-1.5">
                    <span>单库并发</span>
                    <input
                      type="number"
                      min={1}
                      max={4}
                      value={pipelineSettings.perCollectionMaxRunning}
                      onChange={(event) => void updatePipelineSettings({ perCollectionMaxRunning: Number(event.target.value || 1) })}
                      className="w-14 rounded-none border border-slate-200 px-1 py-0.5 text-right text-[11px] outline-none"
                    />
                  </label>
                  <label className="flex items-center justify-between gap-2 rounded-none border border-slate-200 bg-white px-2 py-1.5">
                    <span>自动重试</span>
                    <input
                      type="number"
                      min={0}
                      max={10}
                      value={pipelineSettings.maxAutoRetries}
                      onChange={(event) => void updatePipelineSettings({ maxAutoRetries: Number(event.target.value || 0) })}
                      className="w-14 rounded-none border border-slate-200 px-1 py-0.5 text-right text-[11px] outline-none"
                    />
                  </label>
                  <label className="flex items-center justify-between gap-2 rounded-none border border-slate-200 bg-white px-2 py-1.5">
                    <span>任务超时(s)</span>
                    <input
                      type="number"
                      min={10}
                      max={3600}
                      value={Math.floor(pipelineSettings.jobTimeoutMs / 1000)}
                      onChange={(event) =>
                        void updatePipelineSettings({
                          jobTimeoutMs: Number(event.target.value || 10) * 1000,
                        })
                      }
                      className="w-14 rounded-none border border-slate-200 px-1 py-0.5 text-right text-[11px] outline-none"
                    />
                  </label>
                </div>
              </div>
            </div>
          ) : null}

          <div className="chat-topic-panel__section">
            <div className="chat-topic-panel__section-title">
              <TriangleAlert size={13} strokeWidth={2} />
              <span>待处理失败</span>
              <span className="chat-topic-panel__item-meta">{deadLetterTotal} 条</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <select
                value={deadLetterStatusFilter}
                onChange={(event) => {
                  setDeadLetterPage(1);
                  setDeadLetterStatusFilter(event.target.value as "failed" | "replayed" | "all");
                }}
                className="chat-topic-panel__form-input"
              >
                <option value="failed">仅失败</option>
                <option value="replayed">仅已回放</option>
                <option value="all">全部状态</option>
              </select>
              <div className="rounded-none border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-500">
                优先处理失败文档，再看详情排查原因
              </div>
            </div>
            <div className="chat-topic-panel__group-list">
              {isDeadLetterLoading ? (
                <div className="chat-topic-panel__empty">加载失败任务中...</div>
              ) : deadLetterItems.length === 0 ? (
                <div className="chat-topic-panel__empty">当前筛选下没有需要处理的失败任务</div>
              ) : (
                deadLetterItems.map((item) => {
                  const documentName = getDeadLetterDisplayName(item, documentNameById);
                  const isExpanded = expandedDeadLetterId === item.id;
                  return (
                    <div key={item.id} className="chat-topic-panel__task">
                      <div className="chat-topic-panel__task-head">
                        <strong title={documentName}>{documentName}</strong>
                        <span className={`chat-topic-panel__task-status ${getDeadLetterStatusClassName(item.status)}`}>
                          {item.statusLabel}
                        </span>
                      </div>
                      <div className="chat-topic-panel__task-meta">
                        <span>{item.collectionName ?? activeCollectionName}</span>
                        <span>{item.jobTypeLabel}</span>
                        <span>{formatTimestamp(item.lastFailedAt)}</span>
                      </div>
                      <div className="mt-2 text-sm font-medium leading-6 text-slate-900">{item.userMessage}</div>
                      {item.userAction ? <div className="mt-1 text-xs leading-5 text-slate-500">{item.userAction}</div> : null}
                      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-slate-500">
                        <span>{formatDeadLetterAttempts(item)}</span>
                        <span>{item.documentName ? "已识别文档" : `文档 ID ${item.documentId.slice(0, 8)}`}</span>
                      </div>
                      <div className="mt-3 flex items-center gap-2">
                        <button
                          type="button"
                          disabled={deadLetterReplayBusyId === item.id || item.status !== "failed"}
                          onClick={() => void replayDeadLetterItem(item)}
                          className="chat-topic-panel__inline-action"
                        >
                          {deadLetterReplayBusyId === item.id ? "回放中" : "回放"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setExpandedDeadLetterId((current) => (current === item.id ? null : item.id))}
                          className="chat-topic-panel__inline-action"
                        >
                          {isExpanded ? "收起详情" : "查看详情"}
                        </button>
                      </div>
                      {isExpanded ? (
                        <div className="mt-3 space-y-2 rounded-none border border-slate-200 bg-slate-50 px-3 py-3 text-[11px] leading-5 text-slate-600">
                          <div><strong className="text-slate-900">原始错误：</strong>{item.errorMessage ?? "无原始错误详情"}</div>
                          <div><strong className="text-slate-900">文档 ID：</strong>{item.documentId}</div>
                          <div><strong className="text-slate-900">任务 ID：</strong>{item.jobId}</div>
                          <div><strong className="text-slate-900">知识库 ID：</strong>{item.collectionId}</div>
                        </div>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                disabled={deadLetterPage <= 1 || isDeadLetterLoading}
                onClick={() => setDeadLetterPage((current) => Math.max(1, current - 1))}
                className="chat-topic-panel__inline-action"
              >
                上一页
              </button>
              <span className="chat-topic-panel__item-meta">第 {deadLetterPage} 页</span>
              <button
                type="button"
                disabled={deadLetterPage * deadLetterPageSize >= deadLetterTotal || isDeadLetterLoading}
                onClick={() => setDeadLetterPage((current) => current + 1)}
                className="chat-topic-panel__inline-action"
              >
                下一页
              </button>
            </div>
          </div>

          {taskCenterNotice ? (
            <div className="chat-topic-panel__task-status chat-topic-panel__task-status--completed">{taskCenterNotice}</div>
          ) : null}
          {taskCenterError ? (
            <div className="chat-topic-panel__task-status chat-topic-panel__task-status--failed">{taskCenterError}</div>
          ) : null}
        </>
      </div>
    </aside>
  );

  return (
    <div className="omni-knowledge-root flex h-full min-h-0 flex-col bg-white text-slate-900">
      <div className="omni-knowledge-layout flex min-h-0 flex-1">
        <aside className="main-chat-nav drag-region">
          <button type="button" className="main-chat-nav__brand no-drag" title="Omni">
            <Bot size={20} strokeWidth={1.9} className="text-sky-500" />
          </button>
          <div className="main-chat-nav__items">
            <button type="button" className="main-chat-nav__item no-drag" title="聊天" onClick={onBackToChat}>
              <MessageSquare size={18} strokeWidth={1.9} />
            </button>
            <button type="button" className="main-chat-nav__item no-drag" title="助手">
              <Sparkles size={18} strokeWidth={1.9} />
            </button>
            <button type="button" className="main-chat-nav__item main-chat-nav__item--active no-drag" title="知识库">
              <FolderOpen size={18} strokeWidth={1.9} />
            </button>
          </div>
          <button type="button" className="main-chat-nav__item main-chat-nav__item--bottom no-drag" title="设置" onClick={onSettingsOpen}>
            <Settings size={18} strokeWidth={1.9} />
          </button>
        </aside>

        <aside className={`omni-knowledge-sidebar flex min-h-0 shrink-0 flex-col border-r border-slate-200 bg-slate-50 ${isSidebarCollapsed ? "w-16" : "w-80"}`}>
          <div className="drag-region flex items-center justify-between gap-3 border-b border-slate-200 px-3 py-3">
            {!isSidebarCollapsed ? (
              <div className="min-w-0">
                <div className="truncate text-base font-semibold tracking-[-0.02em] text-slate-950">文件</div>
                <div className="mt-0.5 text-xs text-slate-500">知识库与分类</div>
              </div>
            ) : (
              <div className="h-8 w-8" />
            )}
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <div className={isSidebarCollapsed ? "space-y-2 px-2 py-2" : "space-y-1 px-3 py-3"}>
              {activeCategories.map((category) => {
                const Icon = category.icon;
                const isActive = category.id === activeCategory;
                const categoryIconColor =
                  category.id === "all"
                    ? "#2563eb"
                    : category.id === "docs"
                      ? "#3b82f6"
                      : category.id === "images"
                        ? "#f59e0b"
                        : category.id === "audio"
                          ? "#10b981"
                          : "#8b5cf6";

                return (
                  <button
                    key={category.id}
                    type="button"
                    onClick={() => setActiveCategory(category.id)}
                    className={
                      isSidebarCollapsed
                        ? `flex h-11 w-11 items-center justify-center rounded-none border transition ${
                            isActive
                              ? "border-slate-950 bg-slate-950 text-white shadow-sm"
                              : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                          }`
                        : `flex w-full items-center gap-2 rounded-none border px-3 py-2 text-left text-sm transition ${
                            isActive
                              ? "border-slate-950 bg-white text-slate-950 shadow-sm"
                              : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                          }`
                    }
                    title={category.title}
                  >
                    <span className={`flex h-5 w-5 items-center justify-center rounded-none ${isActive ? "text-slate-950" : "text-slate-500"}`}>
                      <Icon size={13} strokeWidth={1.8} stroke={categoryIconColor} color={categoryIconColor} />
                    </span>
                    {!isSidebarCollapsed ? (
                      <>
                        <span className="flex-1">{category.title}</span>
                        <span className="text-[11px] text-slate-400">{category.count}</span>
                      </>
                    ) : null}
                  </button>
                );
              })}
            </div>

            <div className={isSidebarCollapsed ? "mt-2 border-t border-slate-200 px-2 pt-2" : "mt-2 border-t border-slate-200 px-4 pt-3"}>
              {!isSidebarCollapsed ? (
                <div className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
                  <span>知识库</span>
                  <button
                    type="button"
                    className="no-drag rounded-none p-1 text-slate-400 hover:bg-white hover:text-slate-700"
                    title="新建知识库"
                    onClick={createCollection}
                  >
                    <Plus size={14} strokeWidth={2} />
                  </button>
                </div>
              ) : null}

              <div className="space-y-1">
                {library.collections.map((collection) => {
                  const isActive = collection.id === activeCollection?.id;
                  return (
                    <div
                      key={collection.id}
                      className={`flex items-center gap-1 rounded-none border px-1 py-0.5 text-sm transition ${
                        isActive ? "border-slate-950 bg-white text-slate-950 shadow-sm" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedCollectionId(collection.id)}
                        className={isSidebarCollapsed ? "flex h-10 w-10 items-center justify-center rounded-none" : "flex min-w-0 flex-1 items-center gap-2 rounded-none px-2 py-1 text-left"}
                        title={collection.name}
                      >
                        <KnowledgeCollectionIcon className="h-4 w-4 shrink-0 text-blue-600" />
                        {!isSidebarCollapsed ? <span className="flex-1 truncate">{collection.name}</span> : null}
                      </button>

                      {!isSidebarCollapsed ? (
                        <div className="relative">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setIsCollectionMenuOpen((current) => (current === collection.id ? null : collection.id));
                            }}
                            className="flex h-7 w-7 items-center justify-center rounded-none text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                            title="更多操作"
                          >
                            <EllipsisVertical size={14} strokeWidth={2} />
                          </button>

                          {isCollectionMenuOpen === collection.id ? (
                            <div
                              className="absolute right-0 top-8 z-20 w-32 overflow-hidden rounded-none border border-slate-200 bg-white py-1 shadow-lg shadow-slate-200/70"
                              onPointerDown={(event) => event.stopPropagation()}
                            >
                              <button
                                type="button"
                                className="flex w-full items-center px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                                onClick={() => openCollectionSettings(collection)}
                              >
                                设置
                              </button>
                              <button
                                type="button"
                                className="flex w-full items-center px-3 py-2 text-left text-sm text-rose-600 hover:bg-rose-50"
                                onClick={() => {
                                  setIsCollectionMenuOpen(null);
                                  void deleteCollection(collection.id);
                                }}
                              >
                                删除
                              </button>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="mt-auto border-t border-slate-200 p-3">
            <button
              type="button"
              className="flex w-full items-center justify-center gap-2 rounded-none border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              onClick={createCollection}
            >
              <Plus size={14} strokeWidth={2} />
              {!isSidebarCollapsed ? "新建知识库" : ""}
            </button>
          </div>
        </aside>

        <main className="omni-knowledge-main relative flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          <header className="drag-region relative z-40 flex min-h-20 shrink-0 flex-col overflow-visible bg-white">
            {detailView ? (
              <div className="flex items-center justify-between gap-3 px-4 py-3 md:px-6">
                <div className="drag-region flex min-w-0 flex-1 items-center gap-3">
                  <button
                    type="button"
                    onClick={backToDocumentList}
                    className="no-drag inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-none border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                    title="返回列表"
                  >
                    <ArrowLeft size={16} strokeWidth={2} />
                  </button>
                  <div className="min-w-0">
                    <div className="truncate text-base font-semibold text-slate-950">
                      {selectedDocument?.sourceName ?? selectedDocumentRecord?.sourceName ?? "文档详情"}
                    </div>
                    <div className="mt-1 truncate text-xs text-slate-500">
                      {selectedDocumentCollectionName}
                      {selectedDocument ? ` · ${getDocumentTypeLabel(selectedDocument)} · ${selectedDocument.chunkCount} 个分片` : ""}
                    </div>
                    {selectedDocument ? (
                      <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-slate-600">
                        <span>{getProcessingStatusLabel(selectedDocument.processingStatus)}</span>
                        <span>·</span>
                        <span>{selectedVectorizationLabel}</span>
                        {selectedDocument.vectorizedChunkCount !== undefined ? (
                          <span>· {selectedDocument.vectorizedChunkCount}/{selectedDocument.chunkCount}</span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="drag-region flex flex-wrap items-center justify-end gap-2">
                  <div className="no-drag inline-flex items-center gap-1 rounded-[20px] border border-slate-200/90 bg-white/90 p-1 shadow-sm shadow-slate-200/60 backdrop-blur">
                    {documentDetailViewOptions.map((option) => {
                      const Icon = option.icon;
                      const isActive = selectedDocumentDetailView === option.id;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          onClick={() => setSelectedDocumentDetailView(option.id)}
                          className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-2xl px-3 text-xs font-medium transition ${
                            isActive
                              ? "bg-slate-950 text-white shadow-sm shadow-slate-300/60"
                              : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                          }`}
                          title={option.label}
                          aria-pressed={isActive}
                        >
                          <Icon size={14} strokeWidth={2} />
                          <span>{option.label}</span>
                        </button>
                      );
                    })}
                  </div>

                  <button
                    type="button"
                    onClick={() => setSelectedDocumentDetailView("processing")}
                    className={`no-drag inline-flex h-10 items-center justify-center gap-1.5 rounded-[20px] border px-3 text-xs font-medium shadow-sm shadow-slate-200/40 transition ${
                      selectedDocumentDetailView === "processing"
                        ? "border-slate-950 bg-slate-950 text-white"
                        : "border-slate-200/90 bg-white/90 text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                    }`}
                    title="处理信息"
                    aria-pressed={selectedDocumentDetailView === "processing"}
                  >
                    <Settings size={14} strokeWidth={2} />
                    <span>处理信息</span>
                  </button>

                  {selectedDocument ? (
                    <div className="no-drag inline-flex items-center gap-1 rounded-[20px] border border-slate-200/90 bg-white/90 p-1 shadow-sm shadow-slate-200/50 backdrop-blur">
                      {selectedDocument.activeJobId ? (
                        <>
                          <button
                            type="button"
                            onClick={() =>
                              void runSelectedDocumentAction(
                                () => invoke("cancel_knowledge_processing_job_command", { jobId: selectedDocument.activeJobId }),
                                "取消处理任务失败"
                              )
                            }
                            className="inline-flex h-8 items-center justify-center rounded-2xl px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                          >
                            取消
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void runSelectedDocumentAction(
                                () => invoke("retry_knowledge_processing_job_command", { jobId: selectedDocument.activeJobId }),
                                "重试处理任务失败"
                              )
                            }
                            className="inline-flex h-8 items-center justify-center rounded-2xl px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                          >
                            重试
                          </button>
                        </>
                      ) : null}
                      <button
                        type="button"
                        onClick={() =>
                          void runSelectedDocumentAction(
                            () => invoke("reparse_knowledge_document_command", { documentId: selectedDocument.id }),
                            "重新解析文档失败"
                          )
                        }
                        className="inline-flex h-8 items-center justify-center rounded-2xl px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                      >
                        重解析
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void runSelectedDocumentAction(
                            () => invoke("revectorize_knowledge_document_command", { documentId: selectedDocument.id }),
                            "重新向量化失败"
                          )
                        }
                        className="inline-flex h-8 items-center justify-center rounded-2xl px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                      >
                        重向量化
                      </button>
                    </div>
                  ) : null}

                  <div className="no-drag">{windowControls}</div>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3 px-4 py-3 md:px-6">
                  <div className="drag-region flex min-w-0 flex-1 items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setIsSidebarCollapsed((current) => !current)}
                      className="no-drag inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-none border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                      title={isSidebarCollapsed ? "展开侧栏" : "收起侧栏"}
                    >
                      {isSidebarCollapsed ? <PanelLeftOpen size={16} strokeWidth={2} /> : <PanelLeftClose size={16} strokeWidth={2} />}
                    </button>
                    <div className="min-w-0">
                      <div className="truncate text-base font-semibold text-slate-950">{activeCollectionName}</div>
                      <div className="mt-1 text-sm text-slate-500">
                        {pageMode === "empty" ? "当前知识库还没有文档" : `${activeCategoryData.title} · ${visibleDocuments.length} 个文档`}
                      </div>
                    </div>
                  </div>

                <div className="drag-region flex shrink-0 items-center gap-3">
                    <div className="no-drag flex items-center gap-2" onPointerDown={(event) => event.stopPropagation()}>
                      {isSearchToolbarOpen || searchQuery ? (
                        <div className="flex h-8 w-64 items-center gap-2 rounded-none border border-slate-200 bg-white px-2.5 transition-all duration-150 md:w-72">
                          <Search size={14} strokeWidth={1.8} className="shrink-0 text-slate-400" />
                          <input
                            ref={searchInputRef}
                            value={searchQuery}
                            onChange={(event) => setSearchQuery(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                setIsSearchToolbarOpen(false);
                                event.currentTarget.blur();
                              }
                            }}
                            placeholder="搜索文档"
                            className="w-full min-w-0 border-0 bg-transparent text-sm outline-none placeholder:text-slate-400"
                          />
                        </div>
                      ) : null}

                      <button
                        type="button"
                        onClick={() => setIsSearchToolbarOpen((current) => !current)}
                        className={`inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent bg-transparent text-slate-500 hover:border-slate-200 hover:bg-slate-100 hover:text-slate-800 ${
                          searchQuery ? "text-slate-800" : ""
                        }`}
                        title="搜索文档"
                        aria-pressed={isSearchToolbarOpen || Boolean(searchQuery)}
                      >
                        <Search size={17} strokeWidth={1.9} />
                      </button>
                    </div>

                  <div className="no-drag relative">
                    <button
                      type="button"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => setIsUploadMenuOpen((current) => !current)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent bg-transparent text-slate-500 hover:border-slate-200 hover:bg-slate-100 hover:text-slate-800"
                        title="上传"
                      >
                        <SquarePlus size={17} strokeWidth={1.9} />
                      </button>

                      {isUploadMenuOpen ? (
                        <div
                          ref={uploadMenuRef}
                          className="no-drag absolute right-0 top-10 z-[130] w-40 rounded-none border border-slate-200 bg-white py-2 shadow-lg shadow-slate-200/70"
                          onPointerDown={(event) => event.stopPropagation()}
                        >
                          <button
                            type="button"
                            className="no-drag flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={() => {
                              openFilePicker(fileInputRef.current);
                              setIsUploadMenuOpen(false);
                            }}
                          >
                            <LucideFileText size={15} strokeWidth={1.8} className="text-slate-500" />
                            上传文件
                          </button>
                          <button
                            type="button"
                            className="no-drag flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={() => {
                              openFilePicker(folderInputRef.current);
                              setIsUploadMenuOpen(false);
                            }}
                          >
                            <FolderOpen size={15} strokeWidth={1.8} className="text-slate-500" />
                            上传文件夹
                          </button>
                        </div>
                      ) : null}
                    </div>

                    <button
                      type="button"
                      onClick={() => setIsTaskCenterPanelOpen((current) => !current)}
                      className="no-drag inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent bg-transparent text-slate-500 hover:border-slate-200 hover:bg-slate-100 hover:text-slate-800"
                      title={isTaskCenterPanelOpen ? "收起工作台" : "展开工作台"}
                    >
                    {isTaskCenterPanelOpen ? <PanelRightClose size={17} strokeWidth={1.9} /> : <PanelRightOpen size={17} strokeWidth={1.9} />}
                  </button>

                    <div className="no-drag">{windowControls}</div>
                  </div>
                </div>
              </>
            )}
          </header>

          {uploadNotice ? (
            <div className="no-drag px-4 pt-3 md:px-6">
              <div
                className={`flex items-start justify-between gap-3 rounded-none border px-4 py-3 text-sm ${
                  uploadNotice.tone === "error"
                    ? "border-rose-200 bg-rose-50 text-rose-700"
                    : "border-emerald-200 bg-emerald-50 text-emerald-700"
                }`}
              >
                <div className="min-w-0 flex-1 leading-6">{uploadNotice.message}</div>
                <button
                  type="button"
                  onClick={() => setUploadNotice(null)}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-none border border-current/15 bg-white/60 text-current hover:bg-white"
                  title="关闭提示"
                >
                  <X size={14} strokeWidth={2} />
                </button>
              </div>
            </div>
          ) : null}
          <input
            ref={fileInputRef}
            type="file"
            accept={KNOWLEDGE_UPLOAD_ACCEPT}
            multiple
            className="knowledge-upload-input"
            onChange={(event) => {
              const files = event.currentTarget.files;
              if (files) {
                void handleKnowledgeUploadSelection(files);
              }
              event.currentTarget.value = "";
            }}
          />
          <input
            ref={folderInputRef}
            type="file"
            accept={KNOWLEDGE_UPLOAD_ACCEPT}
            multiple
            className="knowledge-upload-input"
            {...({ webkitdirectory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
            onChange={(event) => {
              const files = event.currentTarget.files;
              if (files) {
                void handleKnowledgeUploadSelection(files);
              }
              event.currentTarget.value = "";
            }}
          />

          <div className="omni-knowledge-body-shell flex min-h-0 min-w-0 flex-1 gap-3">
            <section className="omni-knowledge-content-panel flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="drag-region flex min-h-0 flex-1 px-5 pb-4 pt-0">
                {detailView ? (
                  <div className="no-drag flex min-h-0 w-full flex-1 flex-col">
                    <KnowledgeBaseDetailBoundary
                      key={selectedDocumentId ?? "detail-empty"}
                      onBackToList={backToDocumentList}
                      onRetry={() => {
                        if (selectedDocumentId) {
                          openDocument(selectedDocumentId);
                        }
                      }}
                    >
                      <div className="flex min-h-0 flex-1 flex-col gap-4">
                        {documentDetailError ? (
                          <div className="flex min-h-0 flex-1 items-center justify-center rounded-none border border-dashed border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-500">
                            <div className="space-y-3">
                              <div>{documentDetailError}</div>
                              <button
                                type="button"
                                onClick={() => selectedDocumentId && openDocument(selectedDocumentId)}
                                className="rounded-none border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                              >
                                重新加载
                              </button>
                            </div>
                          </div>
                        ) : isLoadingDocumentDetail || !selectedDocument || !selectedDocumentDetail ? (
                          <div className="flex min-h-0 flex-1 items-center justify-center rounded-none border border-dashed border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-500">
                            正在加载文档详情...
                          </div>
                        ) : selectedDocumentDetailView === "preview" ? (
                          <div className="flex min-h-0 flex-1">
                            <DocumentPreviewArea key={selectedDocumentId} document={selectedDocument} onOpenExternal={openSelectedDocumentExternal} />
                          </div>
                        ) : selectedDocumentDetailView === "assets" ? (
                          <section className="omni-knowledge-assets-view flex min-h-0 flex-1 flex-col">
                            <div className="omni-knowledge-assets-view__header">
                              <div className="min-w-0">
                                <div className="omni-knowledge-assets-view__title">图片资产</div>
                                <div className="omni-knowledge-assets-view__subtitle">
                                  {selectedDocumentDetail.assets.length > 0
                                    ? `已提取 ${selectedDocumentDetail.assets.length} 张图片，可在左侧切换查看。`
                                    : "当前文档还没有提取到可浏览的图片资产。"}
                                </div>
                              </div>
                              {selectedDocumentDetail.assets.length > 0 ? (
                                <div className="omni-knowledge-assets-view__count">共 {selectedDocumentDetail.assets.length} 张</div>
                              ) : null}
                            </div>

                            {selectedDocumentDetail.assets.length === 0 ? (
                              <div className="omni-knowledge-assets-detail__empty">
                                <LucideFileImage size={24} strokeWidth={1.8} />
                                <span>当前文档还没有图片资产。</span>
                              </div>
                            ) : (
                              <div className="omni-knowledge-assets-layout min-h-0 flex-1">
                                <div className="omni-knowledge-assets-list">
                                  {selectedDocumentDetail.assets.map((asset) => (
                                    <button
                                      key={asset.id}
                                      type="button"
                                      onClick={() => setSelectedAssetId(asset.id)}
                                      aria-pressed={asset.id === selectedAssetId}
                                      className={`omni-knowledge-asset-card ${asset.id === selectedAssetId ? "omni-knowledge-asset-card--active" : ""}`}
                                    >
                                      <div className="omni-knowledge-asset-card__thumb">
                                        {asset.thumbnailDataUrl ? (
                                          <img src={asset.thumbnailDataUrl} alt={asset.sourceName} className="h-full w-full object-cover" />
                                        ) : (
                                          <div className="omni-knowledge-asset-card__thumb-empty">
                                            <LucideFileImage size={18} strokeWidth={1.8} />
                                            <span>暂无缩略图</span>
                                          </div>
                                        )}
                                      </div>
                                      <div className="omni-knowledge-asset-card__body">
                                        <div className="omni-knowledge-asset-card__name">{asset.sourceName}</div>
                                        <div className="omni-knowledge-asset-card__meta">
                                          资产 #{asset.assetIndex + 1}
                                          {typeof asset.pageIndex === "number" ? ` · 第 ${asset.pageIndex + 1} 页` : ""}
                                        </div>
                                        <div className="omni-knowledge-asset-card__preview">
                                          {asset.contentPreview?.trim() || asset.captionText?.trim() || asset.ocrText?.trim() || "暂无摘要"}
                                        </div>
                                      </div>
                                    </button>
                                  ))}
                                </div>

                                <div className="omni-knowledge-assets-detail">
                                  {selectedAsset ? (
                                    <div className="omni-knowledge-assets-workspace">
                                      <div className="omni-knowledge-assets-workspace__header">
                                        <div>
                                          <div className="omni-knowledge-assets-workspace__title">当前图片</div>
                                          <div className="omni-knowledge-assets-workspace__subtitle">先看预览，再看 OCR 和描述内容。</div>
                                        </div>
                                      </div>

                                      <div className="omni-knowledge-assets-detail__preview">
                                        {selectedAsset.thumbnailDataUrl ? (
                                          <img src={selectedAsset.thumbnailDataUrl} alt={selectedAsset.sourceName} className="max-h-[26rem] w-full object-contain" />
                                        ) : (
                                          <div className="omni-knowledge-assets-detail__preview-empty">
                                            <LucideFileImage size={24} strokeWidth={1.8} />
                                            <span>暂无可预览图片</span>
                                          </div>
                                        )}
                                      </div>

                                      <div className="omni-knowledge-assets-meta-grid">
                                        <div className="omni-knowledge-assets-meta-card">
                                          <div className="omni-knowledge-assets-meta-card__label">文件名</div>
                                          <div className="omni-knowledge-assets-meta-card__value">{selectedAsset.sourceName}</div>
                                        </div>
                                        <div className="omni-knowledge-assets-meta-card">
                                          <div className="omni-knowledge-assets-meta-card__label">资产序号</div>
                                          <div className="omni-knowledge-assets-meta-card__value">#{selectedAsset.assetIndex + 1}</div>
                                        </div>
                                        <div className="omni-knowledge-assets-meta-card">
                                          <div className="omni-knowledge-assets-meta-card__label">所在页</div>
                                          <div className="omni-knowledge-assets-meta-card__value">
                                            {typeof selectedAsset.pageIndex === "number" ? `第 ${selectedAsset.pageIndex + 1} 页` : "未记录"}
                                          </div>
                                        </div>
                                      </div>

                                      <div className="omni-knowledge-assets-reading-grid">
                                        <section className="omni-knowledge-assets-reading-card">
                                          <div className="omni-knowledge-assets-reading-card__label">OCR</div>
                                          <div className="omni-knowledge-assets-reading-card__content">
                                            {selectedAsset.ocrText?.trim() ? selectedAsset.ocrText : "暂无 OCR 文本"}
                                          </div>
                                        </section>
                                        <section className="omni-knowledge-assets-reading-card">
                                          <div className="omni-knowledge-assets-reading-card__label">图片描述</div>
                                          <div className="omni-knowledge-assets-reading-card__content">
                                            {selectedAsset.captionText?.trim() ? selectedAsset.captionText : "暂无图片描述"}
                                          </div>
                                        </section>
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="omni-knowledge-assets-detail__empty">
                                      <LucideFileImage size={22} strokeWidth={1.8} />
                                      <span>请先从左侧选择一张图片。</span>
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}
                          </section>
                        ) : selectedDocumentDetailView === "processing" ? (
                          <section className="flex min-h-0 flex-1 flex-col rounded-none border border-slate-200 bg-white p-4">
                            <div className="mb-4 flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-sm font-semibold text-slate-950">处理状态</div>
                                <div className="mt-1 text-xs text-slate-500">查看当前文档的处理进度与错误摘要</div>
                              </div>
                              <span className="rounded-none border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600">
                                {getProcessingStatusLabel(selectedDocument.processingStatus)}
                              </span>
                            </div>

                            <div className="grid gap-3 text-sm text-slate-600 sm:grid-cols-2">
                              <div className="rounded-none border border-slate-200 bg-slate-50 px-4 py-3">
                                <div className="text-xs text-slate-400">当前状态</div>
                                <div className="mt-1 font-medium text-slate-900">{getProcessingStatusLabel(selectedDocument.processingStatus)}</div>
                              </div>
                              <div className="rounded-none border border-slate-200 bg-slate-50 px-4 py-3">
                                <div className="text-xs text-slate-400">活动任务 ID</div>
                                <div className="mt-1 truncate font-medium text-slate-900" title={selectedDocument.activeJobId ?? "无"}>
                                  {selectedDocument.activeJobId ?? "无"}
                                </div>
                              </div>
                              <div className="rounded-none border border-slate-200 bg-slate-50 px-4 py-3">
                                <div className="text-xs text-slate-400">分片数</div>
                                <div className="mt-1 font-medium text-slate-900">{selectedDocument.chunkCount}</div>
                              </div>
                              <div className="rounded-none border border-slate-200 bg-slate-50 px-4 py-3">
                                <div className="text-xs text-slate-400">已向量化</div>
                                <div className="mt-1 font-medium text-slate-900">
                                  {selectedDocument.vectorizedChunkCount ?? 0}/{selectedDocument.chunkCount}
                                </div>
                              </div>
                            </div>

                            <div className="mt-3 rounded-none border border-slate-200 bg-white px-4 py-3 text-sm">
                              <div className="text-xs text-slate-400">错误信息</div>
                              <div className={selectedDocument.errorMessage ? "mt-1 text-red-500" : "mt-1 text-slate-500"}>
                                {selectedDocument.errorMessage ?? "无"}
                              </div>
                            </div>

                            <div className="mt-3 rounded-none border border-slate-200 bg-white px-4 py-3 text-sm">
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <div className="text-xs text-slate-400">多模态策略</div>
                                  <div className="mt-1 font-medium text-slate-900">
                                    {selectedDocumentCollection?.multimodalConfig?.enabled ? "已启用知识库多模态分析" : "当前知识库未启用多模态分析"}
                                  </div>
                                </div>
                                {selectedDocumentCollection?.multimodalConfig?.enabled ? (
                                  <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                                    多模态
                                  </span>
                                ) : null}
                              </div>
                              {selectedDocumentCollection?.multimodalConfig?.enabled ? (
                                <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-600">
                                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1">
                                    图片分析 {selectedDocumentCollection.multimodalConfig.image.enabled ? "开启" : "关闭"}
                                  </span>
                                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1">
                                    音频分析 {selectedDocumentCollection.multimodalConfig.audio.enabled ? "开启" : "关闭"}
                                  </span>
                                </div>
                              ) : null}
                            </div>
                          </section>
                        ) : (
                          <section className="flex min-h-0 flex-1 flex-col rounded-none border border-slate-200 bg-white p-4">
                            <div className="mb-3 flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-sm font-semibold text-slate-950">分片</div>
                                <div className="mt-1 text-xs text-slate-500">
                                  共 {textOnlyDocumentChunkCount} 个分片{chunkSearchQuery ? ` · 命中 ${visibleDocumentChunks.length} 个` : ""}
                                </div>
                              </div>
                              <div className="flex h-8 w-full max-w-xs items-center gap-2 rounded-none border border-slate-200 bg-white px-2.5">
                                <Search size={14} strokeWidth={1.8} className="shrink-0 text-slate-400" />
                                <input
                                  ref={chunkSearchInputRef}
                                  value={chunkSearchQuery}
                                  onChange={(event) => setChunkSearchQuery(event.target.value)}
                                  onKeyDown={(event) => {
                                    if (event.key === "Escape") {
                                      if (chunkSearchQuery) {
                                        setChunkSearchQuery("");
                                      } else {
                                        event.currentTarget.blur();
                                      }
                                    }
                                  }}
                                  placeholder="搜索当前分片"
                                  className="w-full min-w-0 border-0 bg-transparent text-sm outline-none placeholder:text-slate-400"
                                />
                                {chunkSearchQuery ? (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setChunkSearchQuery("");
                                      chunkSearchInputRef.current?.focus();
                                    }}
                                    className="inline-flex h-5 w-5 items-center justify-center rounded-none text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                                    aria-label="清空分片搜索"
                                  >
                                    <X size={12} strokeWidth={2} />
                                  </button>
                                ) : null}
                              </div>
                            </div>

                            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
                              {visibleDocumentChunks.map((chunk) => (
                                <div key={chunk.id} className="rounded-none border border-slate-200 bg-slate-50 px-4 py-3">
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="truncate text-sm font-medium text-slate-950">
                                        {renderHighlightedSearchText(`第 ${chunk.chunkIndex + 1} 片${chunk.title ? ` · ${chunk.title}` : ""}`, chunkSearchQuery)}
                                      </div>
                                    </div>
                                    <div className="shrink-0 text-xs text-slate-400">{formatTimestamp(chunk.createdAt)}</div>
                                  </div>
                                  <div className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-600">
                                    {renderHighlightedSearchText(chunk.content, chunkSearchQuery)}
                                  </div>
                                </div>
                              ))}

                              {textOnlyDocumentChunkCount === 0 ? (
                                <div className="rounded-none border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-500">
                                  当前文档还没有分片
                                </div>
                              ) : chunkSearchQuery && visibleDocumentChunks.length === 0 ? (
                                <div className="rounded-none border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-500">
                                  未找到匹配的分片
                                </div>
                              ) : null}
                            </div>
                          </section>
                        )}
                      </div>
                    </KnowledgeBaseDetailBoundary>
                  </div>
                ) : pageMode === "list" ? (
                  <section className="no-drag flex min-h-0 min-w-0 flex-1 flex-col">
                    <div className="flex min-h-0 flex-1 overflow-y-auto pt-3">
                      <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(168px,1fr))] content-start gap-3">
                    {visibleDocuments.map((document) => {
                      const isActive = document.id === selectedDocumentId;
                      const thumbnailDataUrl = listThumbnailDataUrlById.get(document.id);
                      const fileBadge = thumbnailDataUrl ? (
                        <img src={thumbnailDataUrl} alt={document.sourceName} className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-slate-900 via-slate-700 to-slate-500 text-[10px] font-semibold text-white">
                          {document.sourceName.slice(0, 2).toUpperCase()}
                        </div>
                      );

                      return (
                        <div
                          key={document.id}
                          className={`group relative flex h-[170px] min-w-0 flex-col rounded-lg border p-2 text-left transition ${
                            isActive ? "border-slate-950 bg-white text-slate-950 shadow-sm" : "border-slate-200 bg-white text-slate-900 hover:bg-slate-50"
                          }`}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            openDocumentMenu(document.id);
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => openDocument(document.id)}
                            className="flex min-w-0 flex-1 flex-col items-stretch gap-1.5 text-left"
                          >
                            <div className="h-[86px] w-full overflow-hidden rounded-md bg-slate-100">{fileBadge}</div>
                            <div className="flex min-w-0 flex-1 flex-col">
                              <div className="line-clamp-2 text-[12px] font-medium leading-4">{document.sourceName}</div>
                              {document.errorMessage ? <div className="mt-1 line-clamp-1 text-xs text-red-500">{document.errorMessage}</div> : null}
                              <div className="mt-auto flex items-center justify-between gap-2 pt-2">
                                <span className="shrink-0 rounded-none border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600">
                                  {getProcessingStatusLabel(document.processingStatus)}
                                </span>
                                <span className="shrink-0 rounded-full border border-slate-200 px-2 py-0.5 text-[10px] text-slate-500">
                                  {getVectorizationLabel(document.vectorizationState ?? null)}
                                </span>
                              </div>
                            </div>
                          </button>

                          {isDocumentMenuOpen === document.id ? (
                            <div
                              className="omni-knowledge-doc-menu no-drag absolute right-0 top-6 z-20 w-40 overflow-hidden"
                              onPointerDown={(event) => event.stopPropagation()}
                            >
                              <button
                                type="button"
                                className="omni-knowledge-doc-menu__danger no-drag"
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={() => {
                                  setIsDocumentMenuOpen(null);
                                  void deleteDocument(document.id);
                                }}
                              >
                                <Trash2 size={14} strokeWidth={1.9} />
                                删除
                              </button>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}

                    {visibleDocuments.length === 0 ? (
                      <div className="col-span-full rounded-none border border-dashed border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-500">
                        没有符合当前筛选条件的文档。你可以先上传文件，或者切换分类。
                      </div>
                    ) : null}
                      </div>
                    </div>
                  </section>
                ) : (
                  <section className="no-drag flex min-h-0 min-w-0 flex-1 items-center justify-center">
                    {!isKnowledgeLibraryReady ? (
                      <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
                        <div className="text-lg font-semibold tracking-[-0.02em] text-slate-950">正在加载知识库</div>
                        <div className="mt-2 text-sm text-slate-500">请稍候，系统会读取当前已有的知识库。</div>
                      </div>
                    ) : library.collections.length === 0 ? (
                      <div className="flex w-full max-w-4xl flex-col items-center justify-center px-6 py-14 text-center">
                        <div className="text-2xl font-semibold tracking-[-0.03em] text-slate-950">还没有知识库</div>
                        <div className="mt-2 text-sm text-slate-500">先新建一个知识库，再上传文件或文件夹。</div>
                        {uploadError ? (
                          <div className="mt-3 rounded-none border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
                            {uploadError}
                          </div>
                        ) : null}
                        {createCollectionError ? (
                          <div className="mt-3 rounded-none border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
                            {createCollectionError}
                          </div>
                        ) : null}
                        <button
                          type="button"
                          className="mt-8 inline-flex items-center gap-2 rounded-none border border-slate-200 bg-white px-5 py-3 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
                          onClick={createCollection}
                        >
                          <Plus size={16} strokeWidth={2} />
                          新建知识库
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
                        <div className="text-lg font-semibold tracking-[-0.02em] text-slate-950">当前知识库暂无文档</div>
                        <div className="mt-2 text-sm text-slate-500">请使用右上角上传按钮导入文件。</div>
                        {uploadError ? (
                          <div className="mt-3 rounded-none border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
                            {uploadError}
                          </div>
                        ) : null}
                        {createCollectionError ? (
                          <div className="mt-3 rounded-none border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
                            {createCollectionError}
                          </div>
                        ) : null}
                      </div>
                    )}
                  </section>
                )}
              </div>
            </section>
            {shouldShowTaskCenterPanel ? <div className="omni-knowledge-topic-shell flex min-h-0 shrink-0">{taskCenterPanel}</div> : null}
          </div>
        </main>
      </div>
      {isCollectionSettingsOpen && collectionSettingsDraft ? (
        <div
          className="omni-confirm-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeCollectionSettings();
            }
          }}
        >
          <div className="omni-knowledge-collection-settings">
            <div className="omni-knowledge-collection-settings__header">
              <div className="min-w-0">
                <div className="text-base font-semibold text-slate-950">
                  {editingCollection?.name ?? collectionSettingsDraft.name} · 知识库设置
                </div>
                <div className="mt-1 text-sm text-slate-500">
                  配置当前知识库的基础信息，以及图片 / 音频多模态分析策略。
                </div>
              </div>
              <button
                type="button"
                onClick={closeCollectionSettings}
                className="inline-flex h-9 w-9 items-center justify-center rounded-none border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                title="关闭"
              >
                <X size={16} strokeWidth={2} />
              </button>
            </div>

            <div className="omni-knowledge-collection-settings__body">
              <section className="omni-knowledge-collection-settings__section">
                <div className="omni-knowledge-collection-settings__section-title">基础信息</div>
                <div className="omni-knowledge-collection-settings__grid">
                  <label className="omni-knowledge-collection-settings__label">知识库名称</label>
                  <input
                    value={collectionSettingsDraft.name}
                    onChange={(event) => updateCollectionDraft({ name: event.target.value })}
                    className="rounded-none border border-slate-300 px-3 py-2 text-sm"
                    placeholder="请输入知识库名称"
                  />

                  <label className="omni-knowledge-collection-settings__label">知识库描述</label>
                  <textarea
                    value={collectionSettingsDraft.description}
                    onChange={(event) => updateCollectionDraft({ description: event.target.value })}
                    className="min-h-24 rounded-none border border-slate-300 px-3 py-2 text-sm"
                    placeholder="用于组织上传文件"
                  />
                </div>
              </section>

              <section className="omni-knowledge-collection-settings__section">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="omni-knowledge-collection-settings__section-title">多模态</div>
                    <div className="mt-1 text-sm text-slate-500">分析结果会并入知识内容，继续沿用当前的检索和问答链路。</div>
                  </div>
                  <label className="omni-knowledge-collection-settings__switch">
                    <input
                      type="checkbox"
                      checked={collectionSettingsDraft.multimodalConfig.enabled}
                      onChange={(event) =>
                        updateCollectionDraft({
                          multimodalConfig: {
                            ...collectionSettingsDraft.multimodalConfig,
                            enabled: event.target.checked,
                          },
                        })
                      }
                    />
                    <span>启用多模态</span>
                  </label>
                </div>

                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div className="omni-knowledge-collection-settings__capability-card">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <LucideFileImage size={16} strokeWidth={1.9} className="text-amber-600" />
                        <strong className="text-sm text-slate-900">图片分析</strong>
                      </div>
                      <label className="omni-knowledge-collection-settings__switch">
                        <input
                          type="checkbox"
                          checked={collectionSettingsDraft.multimodalConfig.image.enabled}
                          onChange={(event) => updateCollectionImageConfig({ enabled: event.target.checked })}
                          disabled={!collectionSettingsDraft.multimodalConfig.enabled}
                        />
                        <span>{collectionSettingsDraft.multimodalConfig.image.enabled ? "开启" : "关闭"}</span>
                      </label>
                    </div>

                    <div className="mt-3 space-y-3">
                      <label className="block text-xs font-medium text-slate-500">模型</label>
                      <select
                        value={collectionSettingsDraft.multimodalConfig.image.modelId}
                        onChange={(event) => updateCollectionImageConfig({ modelId: event.target.value })}
                        disabled={!collectionSettingsDraft.multimodalConfig.enabled || !collectionSettingsDraft.multimodalConfig.image.enabled}
                        className="w-full rounded-none border border-slate-300 px-3 py-2 text-sm"
                      >
                        <option value="">请选择图片模型</option>
                        {imageMultimodalModels.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.name} · {model.provider}
                          </option>
                        ))}
                      </select>

                      <label className="omni-knowledge-collection-settings__toggle">
                        <input
                          type="checkbox"
                          checked={collectionSettingsDraft.multimodalConfig.image.extractText}
                          onChange={(event) => updateCollectionImageConfig({ extractText: event.target.checked })}
                          disabled={!collectionSettingsDraft.multimodalConfig.enabled || !collectionSettingsDraft.multimodalConfig.image.enabled}
                        />
                        <span>提取图片文字</span>
                      </label>
                      <label className="omni-knowledge-collection-settings__toggle">
                        <input
                          type="checkbox"
                          checked={collectionSettingsDraft.multimodalConfig.image.generateSummary}
                          onChange={(event) => updateCollectionImageConfig({ generateSummary: event.target.checked })}
                          disabled={!collectionSettingsDraft.multimodalConfig.enabled || !collectionSettingsDraft.multimodalConfig.image.enabled}
                        />
                        <span>生成图片摘要</span>
                      </label>
                    </div>
                  </div>

                  <div className="omni-knowledge-collection-settings__capability-card">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <Mic size={16} strokeWidth={1.9} className="text-sky-600" />
                        <strong className="text-sm text-slate-900">音频分析</strong>
                      </div>
                      <label className="omni-knowledge-collection-settings__switch">
                        <input
                          type="checkbox"
                          checked={collectionSettingsDraft.multimodalConfig.audio.enabled}
                          onChange={(event) => updateCollectionAudioConfig({ enabled: event.target.checked })}
                          disabled={!collectionSettingsDraft.multimodalConfig.enabled}
                        />
                        <span>{collectionSettingsDraft.multimodalConfig.audio.enabled ? "开启" : "关闭"}</span>
                      </label>
                    </div>

                    <div className="mt-3 space-y-3">
                      <label className="block text-xs font-medium text-slate-500">模型</label>
                      <select
                        value={collectionSettingsDraft.multimodalConfig.audio.modelId}
                        onChange={(event) => updateCollectionAudioConfig({ modelId: event.target.value })}
                        disabled={!collectionSettingsDraft.multimodalConfig.enabled || !collectionSettingsDraft.multimodalConfig.audio.enabled}
                        className="w-full rounded-none border border-slate-300 px-3 py-2 text-sm"
                      >
                        <option value="">请选择音频模型</option>
                        {audioMultimodalModels.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.name} · {model.provider}
                          </option>
                        ))}
                      </select>

                      <label className="omni-knowledge-collection-settings__toggle">
                        <input
                          type="checkbox"
                          checked={collectionSettingsDraft.multimodalConfig.audio.keepTranscript}
                          onChange={(event) => updateCollectionAudioConfig({ keepTranscript: event.target.checked })}
                          disabled={!collectionSettingsDraft.multimodalConfig.enabled || !collectionSettingsDraft.multimodalConfig.audio.enabled}
                        />
                        <span>保留全文转写</span>
                      </label>
                      <label className="omni-knowledge-collection-settings__toggle">
                        <input
                          type="checkbox"
                          checked={collectionSettingsDraft.multimodalConfig.audio.generateSummary}
                          onChange={(event) => updateCollectionAudioConfig({ generateSummary: event.target.checked })}
                          disabled={!collectionSettingsDraft.multimodalConfig.enabled || !collectionSettingsDraft.multimodalConfig.audio.enabled}
                        />
                        <span>生成音频摘要</span>
                      </label>
                    </div>
                  </div>
                </div>

                <div className="mt-4 rounded-none border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                  <div className="flex items-center gap-2 font-medium text-slate-900">
                    <Sparkles size={15} strokeWidth={1.9} className="text-amber-600" />
                    <span>当前入库策略</span>
                  </div>
                  <div className="mt-2 leading-6">
                    原始文件照常保存，图片和音频分析结果会作为附加文本并入知识内容，再进入当前分片与向量检索链路。
                  </div>
                </div>
              </section>

              {collectionSettingsError ? (
                <div className="rounded-none border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                  {collectionSettingsError}
                </div>
              ) : null}
            </div>

            <div className="omni-knowledge-collection-settings__footer">
              <button
                type="button"
                onClick={closeCollectionSettings}
                disabled={isSavingCollectionSettings}
                className="rounded-none border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void saveCollectionSettings()}
                disabled={isSavingCollectionSettings}
                className="rounded-none border border-slate-950 bg-slate-950 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSavingCollectionSettings ? "保存中..." : "保存设置"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
