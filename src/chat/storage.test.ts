import { describe, expect, it } from "vitest";
import {
  createEmptyUsageStats,
  parseChatSessionsSnapshot,
  serializeChatSessionsSnapshot,
  stripPendingPlaceholder,
} from "./storage";
import type { ChatSession } from "./types";
import type { Message } from "../adapters/types";

const userMessage: Message = { role: "user", content: "你好" };
/** 流式进行中短暂存在的空 assistant 占位（模型还没吐出任何内容）。 */
const blankPlaceholder: Message = { role: "project", content: "" };
const realReply: Message = { role: "project", content: "你好，有什么可以帮你？" };

function sessionWith(messages: Message[]): ChatSession {
  return {
    id: "session-1",
    projectId: "project-basic-chat",
    title: "你好",
    messages,
    pinned: false,
    favorite: false,
    createdAt: 1,
    updatedAt: 1,
    usage: createEmptyUsageStats(),
  };
}

describe("空 assistant 占位消息的清理", () => {
  it("stripPendingPlaceholder 丢掉末尾的空占位", () => {
    const messages = [userMessage, blankPlaceholder];
    expect(stripPendingPlaceholder(messages)).toEqual([userMessage]);
  });

  it("stripPendingPlaceholder 不动有内容的回复（返回原引用）", () => {
    const messages = [userMessage, realReply];
    expect(stripPendingPlaceholder(messages)).toBe(messages);
  });

  it("落盘时不写入末尾空占位——否则重启后 UI 会把会话当成仍在流式，永远「正在思考」", () => {
    const raw = serializeChatSessionsSnapshot([sessionWith([userMessage, blankPlaceholder])]);
    const parsed = JSON.parse(raw) as Array<{ messages: Message[] }>;
    expect(parsed[0].messages).toEqual([userMessage]);
  });

  it("加载时同样剔除存量脏数据", () => {
    const sessions = parseChatSessionsSnapshot(
      JSON.stringify([sessionWith([userMessage, blankPlaceholder])])
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0].messages).toEqual([userMessage]);
  });

  it("正常回复完整保留（不误伤）", () => {
    const raw = serializeChatSessionsSnapshot([sessionWith([userMessage, realReply])]);
    const parsed = JSON.parse(raw) as Array<{ messages: Message[] }>;
    expect(parsed[0].messages).toEqual([userMessage, realReply]);
  });
});
