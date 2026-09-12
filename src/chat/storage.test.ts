import { describe, expect, it } from "vitest";
import {
  createCustomProject,
  createEmptyUsageStats,
  isPendingProjectPlaceholder,
  parseChatSessionsSnapshot,
  parseProjectsSnapshot,
  serializeChatSessionsSnapshot,
  serializeProjectsSnapshot,
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

/**
 * 项目级连接器白名单（`allowedConnectorIds`）的落盘 / 读回。
 *
 * 这条链路比「技能白名单」更要紧：它是**收窄**权限的字段，丢掉不会回到「默认」，
 * 而是**放开** —— 空 = 不限 ⇒ 重启后这个项目突然能看见全部已信任连接器。
 */
describe("项目连接器白名单的持久化", () => {
  it("serialize → parse 之后白名单仍在", () => {
    const project = {
      ...createCustomProject({ title: "带连接器的项目" }),
      allowedConnectorIds: ["mcp-a", "mcp-b"],
    };

    const parsed = parseProjectsSnapshot(serializeProjectsSnapshot([project]));
    // ⚠️ 不能按下标取：parseProjectsSnapshot 发现快照里没有 `DEFAULT_PROJECT_ID` 时
    // 会**补一个默认项目到最前面**，于是 index 0 根本不是我们塞进去的这个项目。
    const restored = parsed.find((item) => item.title === "带连接器的项目");

    expect(restored?.allowedConnectorIds).toEqual(["mcp-a", "mcp-b"]);
  });

  it("空数组归一化为 undefined，让「未设置」只有一种表示", () => {
    const project = { ...createCustomProject({ title: "无限制项目" }), allowedConnectorIds: [] };

    const parsed = parseProjectsSnapshot(serializeProjectsSnapshot([project]));
    const restored = parsed.find((item) => item.title === "无限制项目");

    // 先确认真的找到了这个项目 —— 否则「读不到字段」和「根本没这个项目」都是 undefined，
    // 断言会假通过（这一版最初就踩了）。
    expect(restored).toBeTruthy();
    expect(restored?.allowedConnectorIds).toBeUndefined();
  });

  it("新建项目不预设连接器白名单（留空 = 不限制）", () => {
    expect(createCustomProject({ title: "新项目" }).allowedConnectorIds).toBeUndefined();
  });

  it("createCustomProject 透传白名单", () => {
    expect(createCustomProject({ title: "x", allowedConnectorIds: ["mcp-a"] }).allowedConnectorIds).toEqual([
      "mcp-a",
    ]);
  });
});
