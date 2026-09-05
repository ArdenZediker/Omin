import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { File, FileArchive, FileAudio, FileCode, FileSpreadsheet, FileText, FileVideo, Image, Presentation, X } from "lucide-react";
import { attachmentKindOf, formatFileSize, type AttachmentKind } from "./attachmentFormat";

export interface AttachmentChipProps {
  /** 图片为 base64 DataURL；本地文件为绝对路径 */
  src: string;
  name?: string;
  index?: number;
  removable?: boolean;
  onRemove?: () => void;
  /** 字节数；文件类附件展示体积，未知可省略 */
  size?: number | null;
  /** 点击整个 chip 时的回调（例如在历史消息中点击附件，在产物面板打开） */
  onClick?: () => void;
}

const KIND_ICON: Record<AttachmentKind, typeof File> = {
  image: Image,
  markdown: FileText,
  text: FileText,
  document: FileText,
  spreadsheet: FileSpreadsheet,
  presentation: Presentation,
  code: FileCode,
  archive: FileArchive,
  audio: FileAudio,
  video: FileVideo,
  file: File,
};

function getFileName(src: string, name: string | undefined, index: number): string {
  if (name?.trim()) return name.trim();
  try {
    const url = new URL(src);
    const pathname = decodeURIComponent(url.pathname);
    const base = pathname.split("/").pop();
    if (base) return base;
  } catch {
    // ignore
  }
  // 本地绝对路径（Windows 的 C:/... 或 POSIX 的 /...）取末段
  const segments = src.split(/[\\/]/);
  const last = segments[segments.length - 1];
  return last || `attachment_${index + 1}`;
}

function resolveImageUrl(src: string): string {
  if (src.startsWith("data:")) return src;
  return `data:image/png;base64,${src}`;
}

export default function AttachmentChip({
  src,
  name,
  index = 0,
  removable = false,
  onRemove,
  size,
  onClick,
}: AttachmentChipProps) {
  const chipRef = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [previewStyle, setPreviewStyle] = useState<React.CSSProperties>({});
  const fileName = getFileName(src, name, index);
  // 只有内联的 data: 图片才做 hover 预览——绝对路径的图片在 webview 里无法直接
  // 当 img.src 用（得先转 asset 协议），宁可不预览也不出坏图。
  const canPreview = src.startsWith("data:image/");
  const kind: AttachmentKind = canPreview ? "image" : attachmentKindOf(name ?? fileName);
  const Icon = KIND_ICON[kind];
  const sizeLabel = formatFileSize(size);
  const clickable = Boolean(onClick);

  useLayoutEffect(() => {
    if (!hovered || !chipRef.current) {
      setPreviewStyle({});
      return;
    }
    const rect = chipRef.current.getBoundingClientRect();
    setPreviewStyle({
      position: "fixed",
      left: rect.left + rect.width / 2,
      top: rect.top - 8,
      transform: "translate(-50%, -100%)",
      zIndex: 9999,
    });
  }, [hovered]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLSpanElement>) => {
    if (!clickable) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onClick?.();
    }
  };

  return (
    <span
      ref={chipRef}
      className={`attachment-chip ${clickable ? "attachment-chip--clickable" : ""}`}
      title={sizeLabel ? `点击在产物栏打开 · ${fileName} · ${sizeLabel}` : `点击在产物栏打开 · ${fileName}`}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => canPreview && setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Icon size={14} strokeWidth={1.9} className="attachment-chip__icon" />
      <span className="attachment-chip__name">{fileName}</span>
      {sizeLabel ? <span className="attachment-chip__size">{sizeLabel}</span> : null}
      {removable && (
        <button
          type="button"
          className="attachment-chip__remove"
          title="移除"
          onClick={(event) => {
            event.stopPropagation();
            onRemove?.();
          }}
        >
          <X size={12} strokeWidth={2.2} />
        </button>
      )}
      {canPreview && hovered &&
        createPortal(
          <span className="attachment-chip__preview attachment-chip__preview--portal" style={previewStyle}>
            <img src={resolveImageUrl(src)} alt={fileName} />
          </span>,
          document.body
        )}
    </span>
  );
}
