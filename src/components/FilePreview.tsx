// 通用本地文件预览：读字节 → Blob → @file-viewer（preset-office）渲染。
// 覆盖用户上传的 Office 家族（PDF/Word/Excel/PPT/OFD/RTF/OpenDocument）；
// 图片/纯文本由 ArtifactsPanel 原有路径处理，不经过这里。
// 文件以 ArrayBuffer 从 Rust 读取（asset protocol scope 不含任意路径，故不走 convertFileSrc）。
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import FileViewer from "@file-viewer/react";

/** 预览字节上限：超过则不内嵌预览（防止超大文件撑爆内存） */
const MAX_PREVIEW_BYTES = 200 * 1024 * 1024;

/** 可交给 file-viewer（preset-office）内嵌预览的扩展名 */
const VIEWER_PREVIEW_EXTS = new Set([
  "pdf", "doc", "docx", "dot", "dotx", "dotm", "docm", "rtf", "odt",
  "xls", "xlsx", "xlsm", "xlsb", "ods",
  "ppt", "pptx", "pps", "ppsx", "pptm", "ppsm", "odp",
  "ofd",
]);

/** 该文件名是否能交给 file-viewer 内嵌预览 */
export function canPreviewWithViewer(title: string): boolean {
  const idx = title.lastIndexOf(".");
  const ext = idx >= 0 ? title.slice(idx + 1).toLowerCase() : "";
  return VIEWER_PREVIEW_EXTS.has(ext);
}

/** 已有 Blob 时的渲染壳：供本组件与知识库预览等处复用 */
export function ViewerFrame({ blob, filename, size }: { blob: Blob; filename: string; size?: number | null }) {
  return (
    <div className="file-preview__frame">
      <FileViewer file={blob} filename={filename} size={size ?? undefined} />
    </div>
  );
}

interface FilePreviewProps {
  path: string;
  title: string;
  size?: number | null;
}

export default function FilePreview({ path, title, size }: FilePreviewProps) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setBlob(null);
    setError(null);
    setLoading(true);

    if (typeof size === "number" && size > MAX_PREVIEW_BYTES) {
      setError(`文件过大（${(size / 1024 / 1024).toFixed(0)} MB），不支持内嵌预览`);
      setLoading(false);
      return;
    }

    invoke<ArrayBuffer>("read_file_bytes", { path, projectPath: null })
      .then((buffer) => {
        if (cancelled) return;
        setBlob(new Blob([buffer]));
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(typeof e === "string" ? e : String(e ?? "读取失败"));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [path, size]);

  if (loading) {
    return <p className="artifacts-panel__empty-hint">正在加载文件预览…</p>;
  }
  if (error || !blob) {
    return (
      <div className="artifacts-panel__fileinfo">
        <p>无法预览该文件：{error ?? "未知错误"}</p>
        <code>{path}</code>
      </div>
    );
  }
  return <ViewerFrame blob={blob} filename={title} size={size} />;
}
