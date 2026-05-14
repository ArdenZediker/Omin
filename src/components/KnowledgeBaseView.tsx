import { Component, useEffect, useMemo, useRef, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import mammoth from "mammoth/mammoth.browser";
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
  Layers3,
  MessageSquare,
  Mic,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  PlaySquare,
  Search,
  Settings,
  Sparkles,
} from "lucide-react";
import type {
  KnowledgeCollection,
  KnowledgeDocumentBinaryPayload,
  KnowledgeDocumentDetail,
  KnowledgeLibraryPayload,
} from "../chat/knowledgeTypes";
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

type KnowledgeDocumentDetailView = "preview" | "chunks";
type KnowledgePageMode = "empty" | "list" | "detail";
type PreviewKind = "text" | "markdown" | "pdf" | "docx" | "image" | "unsupported";

const DEFAULT_COLLECTION_ID = "default";
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"]);
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
  if (["mp3", "wav", "ogg", "m4a", "flac", "aac"].includes(ext)) {
    return "audio";
  }
  if (["mp4", "mov", "webm", "mkv", "avi"].includes(ext)) {
    return "video";
  }
  return "docs";
}

function getPreviewKindFromDocument(document: KnowledgeLibraryPayload["documents"][number] | KnowledgeDocumentDetail["document"]) {
  const kind = (document.previewType ?? "").toLowerCase();
  const ext = (document.fileExtension ?? getExtension(document.sourceName)).toLowerCase();
  const mimeType = (document.mimeType ?? "").toLowerCase();

  if (kind === "image" || IMAGE_EXTENSIONS.has(ext) || mimeType.startsWith("image/")) {
    return "image";
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

  if (kind === "image") return "图片";
  if (kind === "pdf") return "PDF";
  if (kind === "docx") return "DOCX";
  if (kind === "markdown") return "MD";
  if (kind === "text") return ext ? ext.toUpperCase() : "TXT";

  return document.mimeType ? document.mimeType.split("/").pop()?.toUpperCase() ?? "文档" : "文档";
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

  context.shadowColor = "rgba(15, 23, 42, 0.08)";
  context.shadowBlur = 10;
  context.shadowOffsetY = 3;
  context.fillStyle = "#ffffff";
  roundRectPath(context, 16, 14, 288, 152, 14);
  context.fill();
  context.shadowColor = "transparent";
  context.strokeStyle = "#dbe3ee";
  context.lineWidth = 1;
  context.stroke();

  context.fillStyle = "#0f172a";
  roundRectPath(context, 30, 28, 76, 8, 4);
  context.fill();

  context.fillStyle = "#cbd5e1";
  roundRectPath(context, 30, 48, 160, 4, 2);
  context.fill();

  const lines = extractThumbnailPreviewLines(content, 5, 54);
  const lineTop = 64;
  lines.forEach((line, index) => {
    context.fillStyle = index === 0 ? "#0f172a" : "#334155";
    context.font = index === 0 ? "600 14px 'Segoe UI', sans-serif" : "12px 'Segoe UI', sans-serif";
    context.textAlign = "left";
    context.textBaseline = "top";
    context.fillText(line, 30, lineTop + index * 20);
  });

  context.fillStyle = "#e2e8f0";
  roundRectPath(context, 30, 146, 98, 6, 3);
  context.fill();

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

function openFilePicker(input: HTMLInputElement | null) {
  if (!input) {
    return;
  }

  const pickerInput = input as HTMLInputElement & { showPicker?: () => void };
  if (typeof pickerInput.showPicker === "function") {
    try {
      pickerInput.showPicker();
      return;
    } catch {
      // Fallback to click() below.
    }
  }

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
  return invoke<KnowledgeLibraryPayload>("load_knowledge_library_command");
}

async function ensureDefaultKnowledgeCollection() {
  return invoke<KnowledgeCollection>("ensure_default_knowledge_collection_command");
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

async function convertDocxBytesToHtml(bytes: Uint8Array) {
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const result = await mammoth.convertToHtml({ arrayBuffer });
  return result.value;
}

async function convertDocxBytesToText(bytes: Uint8Array) {
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const result = await mammoth.convertToMarkdown({ arrayBuffer });
  return result.value;
}

async function convertPdfBytesToText(bytes: Uint8Array) {
  const loadingTask = getDocument({ data: bytes });
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
  const loadingTask = getDocument({ data: bytes });
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
  const [docxHtml, setDocxHtml] = useState<string>("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const previewKind = useMemo(() => getPreviewKindFromDocument(document), [document]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }

      setError(null);
      setDocxHtml("");
      setImageUrl(null);
      setPdfBytes(null);

      const sourceText = (document.content ?? document.contentPreview ?? document.sourceName ?? "").trim();
      if (previewKind === "text" || previewKind === "markdown") {
        setTextPreview(sourceText);
        setIsLoading(false);
        return;
      }

      if (previewKind === "unsupported") {
        setTextPreview(sourceText || "该格式不支持内嵌预览，可以打开原文件查看。");
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
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
        } else if (previewKind === "docx") {
          const html = await convertDocxBytesToHtml(bytes);
          if (!cancelled) {
            setDocxHtml(html);
            if (!html.trim() && sourceText) {
              setTextPreview(sourceText);
            }
          }
        } else if (previewKind === "pdf") {
          setPdfBytes(bytes);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "预览加载失败");
          setTextPreview(sourceText);
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
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [document.id, document.content, document.contentPreview, document.mimeType, document.sourceName, previewKind]);

  if (error) {
    return (
      <div className="relative flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-none border border-slate-200 bg-white p-4">
        <button
          type="button"
          onClick={() => void onOpenExternal()}
          className="absolute right-3 top-3 rounded-none border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
        >
          打开原文件
        </button>
        <div className="space-y-3 pt-8">
          <div className="text-sm font-medium text-slate-950">预览失败</div>
          <div className="text-sm text-slate-500">{error}</div>
        </div>
      </div>
    );
  }

  if (isLoading && previewKind !== "text" && previewKind !== "markdown") {
    return (
      <div className="flex min-h-[18rem] items-center justify-center rounded-none border border-slate-200 bg-white px-4 py-10 text-sm text-slate-500">
        正在加载文档预览...
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-none border border-slate-200 bg-white">
      <button
        type="button"
        onClick={() => void onOpenExternal()}
        className="absolute right-3 top-3 z-10 rounded-none border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
      >
        打开原文件
      </button>

      <div className="min-h-0 flex-1 overflow-auto p-4 pt-12">
        {previewKind === "markdown" ? (
          <div className="markdown-body text-sm text-slate-700">{renderMarkdown(textPreview || document.contentPreview || document.sourceName)}</div>
        ) : null}

        {previewKind === "text" ? (
          <pre className="whitespace-pre-wrap rounded-none bg-slate-50 p-4 text-sm leading-6 text-slate-700">
            {textPreview || document.contentPreview || document.sourceName}
          </pre>
        ) : null}

        {previewKind === "docx" ? (
          docxHtml.trim() ? (
            <div className="docx-preview text-sm leading-7 text-slate-700" dangerouslySetInnerHTML={{ __html: docxHtml }} />
          ) : (
            <pre className="whitespace-pre-wrap rounded-none bg-slate-50 p-4 text-sm leading-6 text-slate-700">
              {textPreview || document.contentPreview || document.sourceName}
            </pre>
          )
        ) : null}

        {previewKind === "pdf" && pdfBytes ? <PdfFirstPagePreview bytes={pdfBytes} /> : null}

        {previewKind === "image" && imageUrl ? (
          <img src={imageUrl} alt={document.sourceName} className="max-h-[60vh] rounded-none border border-slate-200 object-contain" />
        ) : null}

        {previewKind === "unsupported" ? (
          <div className="space-y-3 text-sm text-slate-500">
            <div>{textPreview || "该格式不支持内嵌预览，可以打开原文件查看。"}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function KnowledgeBaseView({ onSettingsOpen, onBackToChat, windowControls }: KnowledgeBaseViewProps) {
  const { openPrompt } = usePromptDialog();
  const [activeCategory, setActiveCategory] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isUploadMenuOpen, setIsUploadMenuOpen] = useState(false);
  const [isCollectionMenuOpen, setIsCollectionMenuOpen] = useState<string | null>(null);
  const [isDocumentMenuOpen, setIsDocumentMenuOpen] = useState<string | null>(null);
  const [library, setLibrary] = useState<KnowledgeLibraryPayload>({ collections: [], documents: [] });
  const [isKnowledgeLibraryReady, setIsKnowledgeLibraryReady] = useState(false);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string>(DEFAULT_COLLECTION_ID);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [selectedDocumentDetail, setSelectedDocumentDetail] = useState<KnowledgeDocumentDetail | null>(null);
  const [selectedDocumentDetailView, setSelectedDocumentDetailView] = useState<KnowledgeDocumentDetailView>("preview");
  const [isLoadingDocumentDetail, setIsLoadingDocumentDetail] = useState(false);
  const [documentDetailError, setDocumentDetailError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const activeCollection = useMemo(
    () => library.collections.find((collection) => collection.id === selectedCollectionId) ?? library.collections[0] ?? null,
    [library.collections, selectedCollectionId]
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
  const activeCollectionName = activeCollection?.name ?? "默认知识库";
  const selectedDocumentCollectionName = useMemo(() => {
    if (!selectedDocument) {
      return activeCollectionName;
    }
    return (
      library.collections.find((collection) => collection.id === selectedDocument.collectionId)?.name ??
      (selectedDocument.collectionId === DEFAULT_COLLECTION_ID ? "默认知识库" : "未命名知识库")
    );
  }, [activeCollectionName, library.collections, selectedDocument]);
  const pageMode: KnowledgePageMode = selectedDocumentId ? "detail" : activeCollectionDocuments.length > 0 ? "list" : "empty";

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

  useEffect(() => {
    if (library.collections.length === 0) {
      setSelectedCollectionId(DEFAULT_COLLECTION_ID);
      return;
    }

    if (!library.collections.some((collection) => collection.id === selectedCollectionId)) {
      const defaultCollection = library.collections.find((collection) => collection.id === DEFAULT_COLLECTION_ID);
      setSelectedCollectionId(defaultCollection?.id ?? library.collections[0].id);
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
    let cancelled = false;

    void (async () => {
      try {
        await ensureDefaultKnowledgeCollection();
        const payload = await loadKnowledgeLibrary();
        if (!cancelled) {
          setLibrary(payload);
          setSelectedCollectionId((current) => {
            if (current === DEFAULT_COLLECTION_ID || !payload.collections.some((collection) => collection.id === current)) {
              return payload.collections.find((collection) => collection.id === DEFAULT_COLLECTION_ID)?.id ?? payload.collections[0]?.id ?? DEFAULT_COLLECTION_ID;
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
    if (!isUploadMenuOpen) {
      return;
    }

    const handlePointerDown = () => setIsUploadMenuOpen(false);
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [isUploadMenuOpen]);

  useEffect(() => {
    if (!isCollectionMenuOpen) {
      return;
    }

    const handlePointerDown = () => setIsCollectionMenuOpen(null);
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [isCollectionMenuOpen]);

  useEffect(() => {
    if (!isDocumentMenuOpen) {
      return;
    }

    const handlePointerDown = () => setIsDocumentMenuOpen(null);
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [isDocumentMenuOpen]);

  async function refreshLibrary() {
    const payload = await loadKnowledgeLibrary();
    setLibrary(payload);
    return payload;
  }

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
      }
    } catch (error) {
      console.error(error);
      content = "";
    }

    const thumbnailDataUrl = (await createThumbnailDataUrl(file, content || file.name)) ?? undefined;
    await invoke("import_knowledge_document_command", {
      input: {
        collectionId,
        sourceName: file.name,
        sourcePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
        content,
        contentBytes: bytes,
        mimeType: file.type || null,
        fileExtension: extension,
        previewType,
        thumbnailDataUrl,
      },
    });
  }

  async function handleKnowledgeUploadSelection(files: FileList | File[]) {
    const items = Array.from(files);
    if (items.length === 0) {
      return;
    }

    try {
      const targetCollectionId = DEFAULT_COLLECTION_ID;
      for (const file of items) {
        await importFile(file, targetCollectionId);
      }

      await refreshLibrary();
      setSelectedCollectionId(DEFAULT_COLLECTION_ID);
      setSelectedDocumentId(null);
      setSelectedDocumentDetail(null);
      setDocumentDetailError(null);
      setSelectedDocumentDetailView("preview");
      setActiveCategory("all");
      setSearchQuery("");
    } catch (error) {
      console.error(error);
    }
  }

  async function createCollection() {
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
  }

  async function deleteCollection(collectionId: string) {
    if (collectionId === DEFAULT_COLLECTION_ID) {
      return;
    }

    await invoke("delete_knowledge_collection_command", { collectionId });
    await refreshLibrary();
    setSelectedCollectionId((current) => {
      if (current !== collectionId) {
        return current;
      }
      const defaultCollection = library.collections.find((collection) => collection.id === DEFAULT_COLLECTION_ID);
      return defaultCollection?.id ?? DEFAULT_COLLECTION_ID;
    });
    setSelectedDocumentId(null);
    setSelectedDocumentDetail(null);
    setSelectedDocumentDetailView("preview");
  }

  async function deleteDocument(documentId: string) {
    await invoke("delete_knowledge_document_command", { documentId });
    await refreshLibrary();
    setSelectedDocumentId(null);
    setSelectedDocumentDetail(null);
    setSelectedDocumentDetailView("preview");
  }

  function openDocument(documentId: string) {
    setSelectedDocumentDetail(null);
    setDocumentDetailError(null);
    setSelectedDocumentDetailView("preview");
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
  }

  async function openSelectedDocumentExternal() {
    const path = selectedDocument?.storedFilePath ?? selectedDocument?.sourcePath ?? null;
    if (!path) {
      throw new Error("没有可打开的原文件路径");
    }
    await openPath(path);
  }

  const detailView = pageMode === "detail";

  return (
    <div className="omni-knowledge-root flex h-full min-h-0 flex-col bg-white text-slate-900">
      <div className="omni-knowledge-layout flex min-h-0 flex-1">
        <aside className="main-chat-nav drag-region">
          <button type="button" className="main-chat-nav__brand no-drag" title="Omni">
            <Bot size={20} strokeWidth={1.9} />
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
            <button
              type="button"
              onClick={() => setIsSidebarCollapsed((current) => !current)}
              className="no-drag inline-flex h-8 w-8 items-center justify-center rounded-none border border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
              title={isSidebarCollapsed ? "展开侧栏" : "收起侧栏"}
            >
              {isSidebarCollapsed ? <PanelLeftOpen size={16} strokeWidth={2} /> : <PanelLeftClose size={16} strokeWidth={2} />}
            </button>
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <div className={isSidebarCollapsed ? "space-y-2 px-2 py-2" : "space-y-1 px-3 py-3"}>
              {activeCategories.map((category) => {
                const Icon = category.icon;
                const isActive = category.id === activeCategory;

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
                      <Icon size={13} strokeWidth={1.8} />
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
                  <button type="button" className="rounded-none p-1 text-slate-400 hover:bg-white hover:text-slate-700" title="新建知识库" onClick={createCollection}>
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

                      {!isSidebarCollapsed && collection.id !== DEFAULT_COLLECTION_ID ? (
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
                            <div className="absolute right-0 top-8 z-20 w-32 overflow-hidden rounded-none border border-slate-200 bg-white py-1 shadow-lg shadow-slate-200/70">
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

                {library.collections.length === 0 ? null : null}
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

        <main className="omni-knowledge-main flex min-h-0 min-w-0 flex-1 flex-col bg-white">
          <header className="drag-region flex min-h-20 shrink-0 flex-col border-b border-slate-200 bg-white">
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
                  </div>
                </div>

                <div className="drag-region flex items-center gap-2">
                  <div className="no-drag inline-flex items-center gap-1 rounded-none border border-slate-200 bg-white p-1">
                    <button
                      type="button"
                      onClick={() => setSelectedDocumentDetailView("preview")}
                      className={`inline-flex h-8 w-8 items-center justify-center rounded-none transition ${
                        selectedDocumentDetailView === "preview" ? "bg-slate-950 text-white" : "text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                      }`}
                      title="预览"
                      aria-pressed={selectedDocumentDetailView === "preview"}
                    >
                      <LucideFileText size={15} strokeWidth={2} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedDocumentDetailView("chunks")}
                      className={`inline-flex h-8 w-8 items-center justify-center rounded-none transition ${
                        selectedDocumentDetailView === "chunks" ? "bg-slate-950 text-white" : "text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                      }`}
                      title="分片"
                      aria-pressed={selectedDocumentDetailView === "chunks"}
                    >
                      <Layers3 size={15} strokeWidth={2} />
                    </button>
                  </div>

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

                    <div className="no-drag flex h-10 min-w-0 flex-1 items-center gap-2 rounded-none border border-slate-200 bg-white px-3 text-sm shadow-sm">
                      <Search size={14} strokeWidth={1.8} className="shrink-0 text-slate-400" />
                      <input
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}
                        placeholder="搜索文档"
                        className="w-full min-w-0 border-0 bg-transparent text-sm outline-none placeholder:text-slate-400"
                      />
                    </div>
                  </div>

                <div className="drag-region flex shrink-0 items-center gap-3">
                    <div className="no-drag relative">
                      <button
                        type="button"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => setIsUploadMenuOpen((current) => !current)}
                        className="inline-flex h-10 items-center gap-2 rounded-none border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
                      >
                        <span className="flex h-4 w-4 items-center justify-center rounded-none border border-slate-400">
                          <Plus size={10} strokeWidth={2.2} />
                        </span>
                        上传
                      </button>

                      {isUploadMenuOpen ? (
                        <div
                          className="absolute right-0 top-12 z-20 w-40 rounded-none border border-slate-200 bg-white py-2 shadow-lg shadow-slate-200/70"
                          onPointerDown={(event) => event.stopPropagation()}
                        >
                          <button
                            type="button"
                            className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                            onClick={() => {
                              setIsUploadMenuOpen(false);
                              openFilePicker(fileInputRef.current);
                            }}
                          >
                            <LucideFileText size={15} strokeWidth={1.8} className="text-slate-500" />
                            上传文件
                          </button>
                          <button
                            type="button"
                            className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                            onClick={() => {
                              setIsUploadMenuOpen(false);
                              openFilePicker(folderInputRef.current);
                            }}
                          >
                            <FolderOpen size={15} strokeWidth={1.8} className="text-slate-500" />
                            上传文件夹
                          </button>
                        </div>
                      ) : null}
                    </div>

                    <div className="no-drag">{windowControls}</div>
                  </div>
                </div>

                <div className="drag-region flex min-h-14 items-center justify-between gap-3 px-4 pb-3 md:px-6">
                  <div className="min-w-0">
                    <div className="truncate text-base font-semibold text-slate-950">{activeCollectionName}</div>
                    <div className="mt-1 text-sm text-slate-500">
                      {pageMode === "empty" ? "当前知识库还没有文档" : `${activeCategoryData.title} · ${visibleDocuments.length} 个文档`}
                    </div>
                  </div>
                </div>
              </>
            )}
          </header>

          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,.md,.markdown,.json,.csv,.tsv,.log,.html,.htm,.js,.ts,.tsx,.py,.rs,.css,.xml,.yaml,.yml,.pdf,.docx,.png,.jpg,.jpeg,.gif,.webp,.bmp,.svg,.avif"
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

          <div className="drag-region flex min-h-0 flex-1 px-5 py-4">
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
                    ) : (
                      <section className="flex min-h-0 flex-1 flex-col rounded-none border border-slate-200 bg-white p-4">
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-slate-950">分片</div>
                            <div className="mt-1 text-xs text-slate-500">共 {selectedDocumentDetail.chunks.length} 个分片</div>
                          </div>
                        </div>

                        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
                          {selectedDocumentDetail.chunks.map((chunk) => (
                            <div key={chunk.id} className="rounded-none border border-slate-200 bg-slate-50 px-4 py-3">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="truncate text-sm font-medium text-slate-950">
                                    第 {chunk.chunkIndex + 1} 片{chunk.title ? ` · ${chunk.title}` : ""}
                                  </div>
                                </div>
                                <div className="shrink-0 text-xs text-slate-400">{formatTimestamp(chunk.createdAt)}</div>
                              </div>
                              <div className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-600">{chunk.content}</div>
                            </div>
                          ))}

                          {selectedDocumentDetail.chunks.length === 0 ? (
                            <div className="rounded-none border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-500">
                              当前文档还没有分片
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
                <div className="flex min-h-0 flex-1 overflow-y-auto">
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,140px))] content-start gap-3">
                    {visibleDocuments.map((document) => {
                      const isActive = document.id === selectedDocumentId;
                      const fileBadge = document.thumbnailDataUrl ? (
                        <img src={document.thumbnailDataUrl} alt={document.sourceName} className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-slate-900 via-slate-700 to-slate-500 text-[10px] font-semibold text-white">
                          {document.sourceName.slice(0, 2).toUpperCase()}
                        </div>
                      );

                      return (
                        <div
                          key={document.id}
                          className={`group relative flex h-[155px] w-[140px] flex-col rounded-none border p-2 text-left transition ${
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
                            <div className="h-[86px] w-full overflow-hidden rounded-none bg-slate-100">{fileBadge}</div>
                            <div className="min-w-0">
                              <div className="truncate text-[12px] font-medium leading-4">{document.sourceName}</div>
                              <div className="mt-1 truncate text-[10px] leading-4 text-slate-500" title={document.contentPreview || "暂无内容摘要"}>
                                {document.contentPreview?.replace(/\s+/g, " ").trim() || "暂无内容摘要"}
                              </div>
                            </div>
                          </button>

                          {isDocumentMenuOpen === document.id ? (
                            <div
                              className="absolute right-0 top-6 z-20 w-32 overflow-hidden rounded-none border border-slate-200 bg-white py-1 shadow-lg shadow-slate-200/70"
                              onPointerDown={(event) => event.stopPropagation()}
                            >
                              <button
                                type="button"
                                className="flex w-full items-center px-3 py-2 text-left text-sm text-rose-600 hover:bg-rose-50"
                                onClick={() => {
                                  setIsDocumentMenuOpen(null);
                                  void deleteDocument(document.id);
                                }}
                              >
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
                    <div className="text-lg font-semibold tracking-[-0.02em] text-slate-950">正在准备默认知识库</div>
                    <div className="mt-2 text-sm text-slate-500">请稍候，系统会自动创建默认知识库。</div>
                  </div>
                ) : library.collections.length === 0 ? (
                  <div className="flex w-full max-w-4xl flex-col items-center justify-center px-6 py-14 text-center">
                    <div className="text-2xl font-semibold tracking-[-0.03em] text-slate-950">还没有知识库</div>
                    <div className="mt-2 text-sm text-slate-500">先新建一个知识库，再上传文件或文件夹。</div>
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
                  </div>
                )}
              </section>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
