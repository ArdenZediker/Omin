import { useEffect, useMemo, useRef, useState } from "react";
import type { Options as DocxPreviewOptions } from "docx-preview";
import type { RenderParameters } from "pdfjs-dist/types/src/display/api";
import type { KnowledgeDocumentBinaryPayload, KnowledgeDocumentDetail } from "../../chat/knowledgeTypes";
import { renderMarkdown } from "../../app/renderMarkdown";
import { getPreviewKindFromDocument } from "./knowledgeViewHelpers";

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

type KnowledgeDocumentPreviewProps = {
  document: KnowledgeDocumentDetail["document"];
  onOpenExternal: () => Promise<void> | void;
  loadDocumentBinary: (documentId: string) => Promise<KnowledgeDocumentBinaryPayload>;
};

async function loadPdfJs() {
  const [{ getDocument, GlobalWorkerOptions }, workerModule] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  GlobalWorkerOptions.workerSrc = workerModule.default;
  return { getDocument };
}

async function renderDocxBytesIntoContainer(bytes: Uint8Array, container: HTMLElement) {
  const { renderAsync } = await import("docx-preview");
  const blob = new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });

  container.innerHTML = "";
  await renderAsync(blob, container, undefined, DOCX_PREVIEW_OPTIONS);
}

async function renderPdfFirstPage(bytes: Uint8Array, canvas: HTMLCanvasElement) {
  const { getDocument } = await loadPdfJs();
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
  const renderParameters: RenderParameters = { canvasContext: context, canvas, viewport };
  const renderTask = page.render(renderParameters);
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

export default function KnowledgeDocumentPreview({
  document,
  onOpenExternal,
  loadDocumentBinary,
}: KnowledgeDocumentPreviewProps) {
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
        setTextPreview(sourceText || "该格式不支持内嵌预览，可以打开原文文件查看。");
        setIsLoading(false);
        return;
      }

      setTextPreview(sourceText);
      setIsLoading(true);
      let needsDocxRender = false;
      try {
        const payload = await loadDocumentBinary(document.id);
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
          setError(err instanceof Error ? err.message : "预览加载失败");
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
  }, [document.id, document.content, document.contentPreview, document.mimeType, document.sourceName, loadDocumentBinary, previewKind]);

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
          setError(err instanceof Error ? err.message : "预览加载失败");
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
          打开原文文件
        </button>
        <div className="space-y-3 pt-8">
          <div className="text-sm font-medium text-slate-950">预览失败</div>
          <div className="text-sm text-slate-500">{error}</div>
        </div>
      </div>
    );
  }

  if (isLoading && previewKind !== "text" && previewKind !== "markdown" && previewKind !== "docx") {
    return (
      <div className="flex min-h-[18rem] items-center justify-center px-4 py-10 text-sm text-slate-500">
        正在加载文档预览...
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
                  正在加载文档预览...
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
                    当前环境无法直接预览 PDF，已切换为首页图像预览，也可以点击右上角打开原文文件。
                  </div>
                  <PdfFirstPagePreview bytes={pdfBytes} />
                </div>
              ) : (
                <div className="p-4 text-sm text-slate-500">
                  当前环境无法直接预览 PDF，请点击右上角打开原文文件。
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
            <div>{textPreview || "该格式不支持内嵌预览，可以打开原文文件查看。"}</div>
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
        打开原文文件
      </button>

      <div className="min-h-0 flex-1 overflow-hidden p-4 pt-12">{renderPreviewContent()}</div>
    </div>
  );
}
