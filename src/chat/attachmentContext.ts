import { invoke } from "@tauri-apps/api/core";
import type { ChatAttachment } from "../adapters/types";
import { convertDocxBytesToText, convertPdfBytesToText } from "../components/knowledge/knowledgeFileConversion";

const MAX_ATTACHMENT_TEXT_CHARS = 18_000;

function isDocx(path: string) {
  return path.toLowerCase().endsWith(".docx");
}

function isPdf(path: string) {
  return path.toLowerCase().endsWith(".pdf");
}

function clipText(text: string, maxChars = MAX_ATTACHMENT_TEXT_CHARS) {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, maxChars - 3)}...`;
}

async function readBinaryText(attachment: ChatAttachment) {
  const bytes = await invoke<ArrayBuffer>("read_file_bytes", {
    path: attachment.path,
    projectPath: null,
  });
  const uint8 = new Uint8Array(bytes);
  return isDocx(attachment.path)
    ? convertDocxBytesToText(uint8)
    : convertPdfBytesToText(uint8);
}

/**
 * Build the direct attachment context for the current turn.
 *
 * Binary Word/PDF attachments are converted here instead of relying on
 * /read_file, which is text-only and would otherwise return compressed bytes.
 * The result is prompt data, not a knowledge-base source.
 */
export async function buildAttachmentContext(attachments: ChatAttachment[]): Promise<string | undefined> {
  if (attachments.length === 0) {
    return undefined;
  }

  const lines: string[] = [];
  for (const attachment of attachments) {
    lines.push(`- ${attachment.path}${attachment.size != null ? `（${attachment.size} 字节）` : ""}`);
    if (!isDocx(attachment.path) && !isPdf(attachment.path)) {
      continue;
    }
    try {
      const text = clipText(await readBinaryText(attachment));
      if (text) {
        lines.push(`【附件正文】${attachment.name}`, text, "");
      }
    } catch (error) {
      lines.push(
        `【附件正文读取失败】${attachment.name}: ${error instanceof Error ? error.message : String(error)}`,
        "",
      );
    }
  }

  return [
    "以下为用户随本条消息附带的本地文件。这些附件是本轮问题的直接材料；如同时存在知识库检索结果，与附件直接相关的问题优先分析附件内容，知识库材料只作补充，不要混淆来源。",
    "非图片文件只提供绝对路径；Word/PDF 正文已在下方给出。普通文本文件如需内容，调用 /read_file 传入路径读取。",
    ...lines,
  ].join("\n");
}
