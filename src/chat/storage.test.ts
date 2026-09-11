import { describe, expect, it } from "vitest";
import {
  createEmptyUsageStats,
  isPendingProjectPlaceholder,
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

  it("回归：已渲染出工具调用但正文还没开始的回复必须保留，不能当空占位删掉", () => {
    // 模型先吐工具调用（此时 content 仍为 ""），随后报错或被停止。
    // 这条消息是用户唯一能看到的东西，此前判据只看 content，会把它整条删除
    // ——表现为「工具调用一闪而过然后消失」。
    const toolOnlyReply: Message = {
      role: "project",
      content: "",
      steps: [
        { type: "reasoning", text: "先查一下天气" },
        { type: "tool_call", name: "web_search", arguments: '{"query":"宜宾天气"}', result: "", status: "running" },
      ],
    };
    const messages = [userMessage, toolOnlyReply];
    expect(stripPendingPlaceholder(messages)).toBe(messages);
    expect(isPendingProjectPlaceholder(toolOnlyReply)).toBe(false);
  });

  it("回归：只有思考链、正文未开始的回复同样保留", () => {
    const reasoningOnlyReply: Message = { role: "project", content: "", reasoning: "让我想想……" };
    const messages = [userMessage, reasoningOnlyReply];
    expect(stripPendingPlaceholder(messages)).toBe(messages);
    expect(isPendingProjectPlaceholder(reasoningOnlyReply)).toBe(false);
  });

  it("isPendingProjectPlaceholder 只认「正文/思考/步骤三者皆空」", () => {
    expect(isPendingProjectPlaceholder(blankPlaceholder)).toBe(true);
    expect(isPendingProjectPlaceholder(undefined)).toBe(false);
    expect(isPendingProjectPlaceholder(userMessage)).toBe(false);
    expect(isPendingProjectPlaceholder(realReply)).toBe(false);
    // 纯空白正文不算内容
    expect(isPendingProjectPlaceholder({ role: "project", content: "   \n " })).toBe(true);
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
