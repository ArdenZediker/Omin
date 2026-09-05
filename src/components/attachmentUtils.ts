// Omni - 附件选择、读取、分类相关的工具函数
// 被 ChatInput 与 ChatMessage 编辑态共享，避免重复实现 Tauri 文件选择与图片 base64 化。

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ChatAttachment } from "../adapters/types";

export function baseNameOf(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

/** 从路径取扩展名（不含点，小写） */
export function getExtension(path: string): string {
  const lastDot = path.lastIndexOf(".");
  return lastDot >= 0 ? path.slice(lastDot + 1).toLowerCase() : "";
}

export const IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "bmp",
  "svg",
  "ico",
  "tif",
  "tiff",
  "avif",
]);

/** 判断路径是否为常见图片文件 */
export function isImageFile(path: string): boolean {
  return IMAGE_EXTENSIONS.has(getExtension(path));
}

/** 根据扩展名推断图片 MIME 类型 */
export function mimeTypeForImage(ext: string): string {
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "svg":
      return "image/svg+xml";
    case "ico":
      return "image/x-icon";
    case "tif":
    case "tiff":
      return "image/tiff";
    case "avif":
      return "image/avif";
    default:
      return "image/png";
  }
}

/** 通过 Rust 读取本地图片字节并转为 base64 Data URL（供模型 vision 使用） */
export async function readLocalImageAsDataURL(path: string): Promise<string> {
  const buffer = await invoke<ArrayBuffer>("read_file_bytes", { path, projectPath: null });
  const mimeType = mimeTypeForImage(getExtension(path));
  const blob = new Blob([buffer], { type: mimeType });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => resolve(event.target?.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("图片读取失败"));
    reader.readAsDataURL(blob);
  });
}

export interface PickedAttachmentsResult {
  images: string[];
  attachments: ChatAttachment[];
}

/**
 * 通过 Tauri 文件对话框多选本地文件，自动把图片转成 base64 Data URL，
 * 非图片文件以绝对路径返回。与 ChatInput 的文件选择逻辑保持一致。
 */
export async function pickLocalAttachments(): Promise<PickedAttachmentsResult | null> {
  const selected = await open({ multiple: true, title: "选择要附带的本地文件" });
  if (!selected) {
    return null;
  }
  const paths = Array.isArray(selected) ? selected : [selected];
  const images: string[] = [];
  const attachments: ChatAttachment[] = [];
  await Promise.all(
    paths.map(async (path) => {
      const name = baseNameOf(path);
      if (isImageFile(path)) {
        images.push(await readLocalImageAsDataURL(path));
      } else {
        attachments.push({ path, name, size: null });
      }
    }),
  );
  return { images, attachments };
}

/**
 * 把从剪贴板粘贴得到的 File 对象（非图片）写到 Omni 应用数据目录，
 * 返回可用于 /read_file 的绝对路径。图片文件不需要走这里，直接 FileReader 转 base64 即可。
 * 落盘失败时返回 null，调用方按未粘贴处理，不阻断用户。
 */
export async function savePastedFileAttachment(file: File): Promise<ChatAttachment | null> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await invoke<{ path: string; size: number }>("write_pasted_attachment", {
      name: file.name || "pasted-file",
      bytes,
    });
    if (!result?.path) {
      return null;
    }
    return {
      path: result.path,
      name: file.name || "pasted-file",
      size: result.size ?? null,
    };
  } catch (error) {
    console.error("保存粘贴文件附件失败", error);
    return null;
  }
}
