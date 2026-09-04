// 知识库文档预览：与产物栏统一走 @file-viewer（preset-office）。
// - Office 家族（pdf/doc/docx/xls/xlsx/ppt/pptx/ofd/rtf/odt/ods/odp…）→ ViewerFrame（flyfish 渲染）
// - 图片/音频 → 浏览器原生标签
// - text/markdown → 数据库里的 content 直显（无需读二进制）
// 旧方案（docx-preview + <object>/pdfjs 首页兜底）已移除；pdfjs-dist 仍由
// knowledgeFileConversion.ts 在摄取链路使用，不能卸载。
import { useEffect, useMemo, useRef, useState } from "react";
import type { KnowledgeDocumentBinaryPayload, KnowledgeDocumentDetail } from "../../chat/knowledgeTypes";
import { renderMarkdown } from "../../app/renderMarkdown";
import { ViewerFrame, canPreviewWithViewer } from "../FilePreview";
import { getPreviewKindFromDocument } from "./knowledgeViewHelpers";

type KnowledgeDocumentPreviewProps = {
  document: KnowledgeDocumentDetail["document"];
  onOpenExternal: () => Promise<void> | void;
  loadDocumentBinary: (documentId: string) => Promise<KnowledgeDocumentBinaryPayload>;
};

export default function KnowledgeDocumentPreview({
  document,
  onOpenExternal,
  loadDocumentBinary,
}: KnowledgeDocumentPreviewProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewerBlob, setViewerBlob] = useState<Blob | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const previewKind = useMemo(() => getPreviewKindFromDocument(document), [document]);
  const fallbackText = document.content || document.contentPreview || document.sourceName;

  // sourceName 缺扩展名时用 fileExtension 补上，交给 canPreviewWithViewer 判断
  const viewerFilename = useMemo(() => {
    const name = document.sourceName || "document";
    if (name.includes(".") || !document.fileExtension) {
      return name;
    }
    return `${name}.${document.fileExtension}`;
  }, [document.sourceName, document.fileExtension]);
  const useViewer =
    previewKind === "pdf" || previewKind === "docx" || canPreviewWithViewer(viewerFilename);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }

      setError(null);
      setViewerBlob(null);
      setImageUrl(null);
      setAudioUrl(null);

      if (previewKind === "text" || previewKind === "markdown" || previewKind === "unsupported") {
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      try {
        const payload = await loadDocumentBinary(document.id);
        if (cancelled) {
          return;
        }

        const bytes = new Uint8Array(payload.bytes);
        if (useViewer) {
          setViewerBlob(new Blob([bytes], { type: document.mimeType || undefined }));
        } else if (previewKind === "image") {
          const url = URL.createObjectURL(new Blob([bytes], { type: document.mimeType ?? "application/octet-stream" }));
          objectUrlRef.current = url;
          setImageUrl(url);
        } else if (previewKind === "audio") {
          const url = URL.createObjectURL(new Blob([bytes], { type: document.mimeType ?? "audio/mpeg" }));
          objectUrlRef.current = url;
          setAudioUrl(url);
        } else {
          setIsLoading(false);
          return;
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "预览加载失败");
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
  }, [document.id, document.mimeType, loadDocumentBinary, previewKind, useViewer]);

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

  function renderPreviewContent() {
    if (useViewer) {
      if (isLoading || !viewerBlob) {
        return <div className="flex h-full items-center justify-center text-sm text-slate-500">正在加载文档预览...</div>;
      }
      return <ViewerFrame blob={viewerBlob} filename={viewerFilename} />;
    }

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
      default:
        return (
          <div className="space-y-3 text-sm text-slate-500">
            <div>{fallbackText || "该格式不支持内嵌预览，可以打开原文文件查看。"}</div>
          </div>
        );
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
