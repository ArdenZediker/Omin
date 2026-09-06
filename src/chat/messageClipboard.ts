import type { Message } from "../adapters/types";

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
