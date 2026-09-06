import type { Message } from "../adapters/types";

/**
 * 把一条消息渲染成适合复制到剪贴板的纯文本。
 * 包含：
 * - 每条图片的展示名
 * - 每个附件的展示名与本地绝对路径
 * - 消息正文
 *
 * 这样「复制消息」不会只丢掉文件信息；粘贴到笔记/聊天/文档里都能看到
 * 带了哪些文件。若需要把真实文件字节放到系统剪贴板（可粘贴到文件管理器），
 * 那是另一层能力，需额外 OS 级支持。
 */
export function formatMessageClipboardText(message: Message): string {
  const lines: string[] = [];

  for (const image of message.images ?? []) {
    lines.push(`[图片] ${image.name?.trim() || "image"}`);
  }

  for (const attachment of message.attachments ?? []) {
    const name = attachment.name?.trim() || "文件";
    if (attachment.path) {
      lines.push(`[文件] ${name} (${attachment.path})`);
    } else {
      lines.push(`[文件] ${name}`);
    }
  }

  const content = message.content?.trim();
  if (content) {
    lines.push(content);
  }

  return lines.join("\n");
}
