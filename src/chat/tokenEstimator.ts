import type { Message } from "../adapters/types";

/**
 * token 估算：CJK 每字符约 1 token，其余按 4 字符 1 token。
 * （原 length/4 对中文低估约 4 倍，导致成本与压缩判断失真。）
 */
export function estimateTokens(text: string): number {
  const normalized = text.trim();
  if (!normalized) return 0;
  const cjk = (normalized.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const rest = normalized.length - cjk;
  return Math.max(1, Math.ceil(cjk * 1.1 + rest / 4));
}

/** 估算一组消息的 prompt token 数（含图片占位 token）。 */
export function estimatePromptTokens(messages: Message[]): number {
  return messages.reduce((total, message) => {
    const imageTokens = (message.images?.length ?? 0) * 256;
    return total + estimateTokens(message.content) + imageTokens;
  }, 0);
}
