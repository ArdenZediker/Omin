import { describe, expect, it } from "vitest";
import type { ChatSession } from "../chat/types";
import {
  isAbsolutePath,
  sanitizeDirName,
  sessionDirName,
  buildSessionOutputDir,
  renderSessionMarkdown,
} from "./outputStorage";

describe("outputStorage 路径工具", () => {
  it("isAbsolutePath 识别绝对路径", () => {
    expect(isAbsolutePath("C:/Users/me/Documents")).toBe(true);
    expect(isAbsolutePath("D:\\proj\\a")).toBe(true);
    expect(isAbsolutePath("/Users/me")).toBe(true);
    expect(isAbsolutePath("相对/路径")).toBe(false);
    expect(isAbsolutePath("file.txt")).toBe(false);
  });

  it("sanitizeDirName 清洗非法字符并截断", () => {
    expect(sanitizeDirName("周 报/2026:*?")).toBe("周 报 2026");
    expect(sanitizeDirName("   ")).toBe("untitled");
    expect(sanitizeDirName("a".repeat(100)).length).toBeLessThanOrEqual(40);
    expect(sanitizeDirName("结尾. ")).toBe("结尾");
  });

  it("sessionDirName 由标题加短 id 组成", () => {
    expect(sessionDirName("当前会话", "session-1")).toBe("当前会话_session-");
    expect(sessionDirName("", "abc12345")).toBe("session_abc12345");
  });

  it("buildSessionOutputDir 拼出 根/项目/会话 三级目录", () => {
    const dir = buildSessionOutputDir("C:/Out", "我的项目", "测试会话", "sess-1234");
    expect(dir).toBe("C:/Out/我的项目/测试会话_sess-123");
  });

  it("buildSessionOutputDir 项目为空时回退 no-project", () => {
    const dir = buildSessionOutputDir("C:/Out", null, "x", "y");
    expect(dir).toBe("C:/Out/no-project/x_y");
  });
});

describe("renderSessionMarkdown", () => {
  const session = {
    id: "chat-abc123",
    projectId: "p1",
    title: "测试对话",
    messages: [
      { role: "user", content: "你好" },
      { role: "project", content: "你好，有什么可以帮你？" },
    ],
    createdAt: Date.parse("2026-01-01T10:00:00Z"),
    updatedAt: Date.parse("2026-01-01T10:05:00Z"),
  } as unknown as ChatSession;

  it("包含标题、项目、会话ID 与按角色分节的消息", () => {
    const md = renderSessionMarkdown(session, "我的项目");
    expect(md).toContain("# 测试对话");
    expect(md).toContain("> 项目：我的项目");
    expect(md).toContain("会话ID：chat-abc123");
    expect(md).toContain("## 用户");
    expect(md).toContain("你好");
    expect(md).toContain("## Omni");
    expect(md).toContain("你好，有什么可以帮你？");
  });

  it("未传项目标题时不渲染项目行", () => {
    const md = renderSessionMarkdown(session, null);
    expect(md).not.toContain("> 项目：");
  });
});
