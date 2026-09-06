import type { Message } from "../adapters/types";
import { invoke } from "@tauri-apps/api/core";

/**
 * 把一条消息渲染成适合复制到剪贴板的纯文本。
 *
 * 仅保留用户可见正文；不再把 `[图片]` / `[文件]` 占位符写进 text/plain，
 * 避免把消息复制后再粘贴回聊天输入框时，这些占位符也变成可发送文字。
 *
 * 真实文件/图片仍会通过系统级文件剪贴板（CF_HDROP / NSFilenamesPboardType）
 * 随文字一起提供，可在文件管理器中 Ctrl+V 直接粘贴出文件。
 */
export function formatMessageClipboardText(message: Message): string {
  return message.content?.trim() ?? "";
}

export interface ClipboardImageInput {
  name: string | null;
  src: string;
}

/**
 * 把「文字 + 真实文件路径 + base64 图片」一起写入系统剪贴板。
 *
 * - 有文件/图片时优先走 Tauri 系统级命令 `write_clipboard_with_files`，
 *   让文字与文件（CF_HDROP）同时存在于剪贴板：既能粘贴到文本编辑器，
 *   也能在文件管理器里 Ctrl+V 粘贴出文件。
 * - 没有任何文件且不在 Tauri 环境时，退回浏览器 `navigator.clipboard.writeText`，至少保留文字。
 */
export async function writeClipboardWithFiles(
  text: string,
  paths: string[],
  images: ClipboardImageInput[],
): Promise<void> {
  if (paths.length > 0 || images.length > 0) {
    try {
      await invoke("write_clipboard_with_files", { text, paths, images });
      return;
    } catch {
      // 系统级文件剪贴板不可用（如不支持的平台）时，退回纯文本，至少保留文字信息。
    }
  }
  await navigator.clipboard.writeText(text);
}
