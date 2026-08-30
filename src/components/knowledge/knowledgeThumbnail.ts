import { extractThumbnailPreviewLines, getExtension } from "./knowledgeViewHelpers";

/**
 * 把文本裁到不超过 maxWidth，超长时用省略号收尾。
 *
 * 用二分查找定位最长可容纳前缀，避免逐字符 measureText 的 O(n) 开销。
 */
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

/** 画一个圆角矩形路径（不填充、不描边，由调用方决定）。 */
function roundRectPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

/**
 * 用文本内容合成一张「纸张预览」缩略图（data URL）。
 *
 * 纯文档没有天然封面，这里在 canvas 上画白卡片 + 前几行正文，
 * 让列表里的文档卡片有一致的视觉占位。
 */
export function createThumbnailDataUrlFromContent(content: string) {
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

/**
 * 生成上传文件的缩略图。
 *
 * 图片走等比裁切后重绘（失败则退回原始 data URL），其余类型合成文本预览图。
 */
export async function createThumbnailDataUrl(file: File, content: string) {
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
          context.drawImage(
            image,
            offsetX,
            offsetY,
            drawWidth,
            drawHeight,
            inset,
            inset,
            width - inset * 2,
            height - inset * 2,
          );
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

/**
 * 为图片文件生成可检索的文字描述。
 *
 * 图片本身无法进全文索引，这里落一段结构化元信息（文件名/格式/尺寸/大小），
 * 让用户至少能按这些字段搜到它。
 */
export async function createImageKnowledgeContent(file: File) {
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
            .join("\n"),
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
            .join("\n"),
        );
      };
      image.src = source;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}
