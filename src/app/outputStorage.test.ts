import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "../chat/types";
import {
  isAbsolutePath,
  sanitizeDirName,
  sessionDirName,
  buildSessionOutputDir,
  renderSessionMarkdown,
  sanitizeAttachmentFileName,
  buildAttachmentSnapshotDir,
  snapshotAttachments,
} from "./outputStorage";

const mockedInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockedInvoke,
}));

/** 让 getEffectiveOutputRoot 拿到固定的产出根：屏蔽 sqlite 设置，只走 invoke 回退。 */
vi.mock("./sqliteStorage", () => ({
  readSqliteBackedValue: () => null,
  saveSqliteBackedValue: () => {},
}));

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

describe("会话附件快照", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it("sanitizeAttachmentFileName 去掉路径分隔符与非法字符但保留扩展名", () => {
    expect(sanitizeAttachmentFileName("report.md")).toBe("report.md");
    expect(sanitizeAttachmentFileName("../../etc/passwd")).toBe(".. .. etc passwd");
    expect(sanitizeAttachmentFileName("周报:2026?.docx")).toBe("周报 2026 .docx");
    expect(sanitizeAttachmentFileName("   ")).toBe("attachment");
    expect(sanitizeAttachmentFileName("a".repeat(200)).length).toBeLessThanOrEqual(80);
  });

  it("buildAttachmentSnapshotDir 落在会话目录下的 attachments 子目录", () => {
    const dir = buildAttachmentSnapshotDir("C:/Out", "我的项目", "测试会话", "sess-1234");
    expect(dir).toBe("C:/Out/我的项目/测试会话_sess-123/attachments");
  });

  it("snapshotAttachments 复制成功后把路径改写成快照路径并回填真实大小", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "default_artifact_dir") return Promise.resolve("C:/Docs");
      if (cmd === "copy_file_to_store") {
        return Promise.resolve({
          path: "C:/Docs/Omni/我的项目/测试会话_sess-123/attachments/report.md",
          size: 2048,
        });
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });

    const result = await snapshotAttachments(
      [{ path: "D:\\用户\\桌面\\report.md", name: "report.md", size: null }],
      { projectTitle: "我的项目", sessionTitle: "测试会话", sessionId: "sess-123" }
    );

    expect(result).toHaveLength(1);
    // path 指向快照，name 仍是用户看到的原始文件名
    expect(result[0].path).toContain("/attachments/report.md");
    expect(result[0].name).toBe("report.md");
    expect(result[0].size).toBe(2048);

    const copyCall = mockedInvoke.mock.calls.find((call) => call[0] === "copy_file_to_store");
    expect(copyCall).toBeTruthy();
    expect(copyCall![1].src).toBe("D:\\用户\\桌面\\report.md");
    expect(copyCall![1].dst).toContain("/attachments/report.md");
  });

  it("复制失败时回退原始路径，不阻断发送", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "default_artifact_dir") return Promise.resolve("C:/Docs");
      if (cmd === "copy_file_to_store") return Promise.reject(new Error("磁盘已满"));
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });

    const original = { path: "D:\\report.md", name: "report.md", size: null };
    const result = await snapshotAttachments([original], {
      projectTitle: "p",
      sessionTitle: "s",
      sessionId: "sess-1",
    });

    expect(result).toEqual([original]);
  });

  it("产出根目录无法确定时原样返回", async () => {
    mockedInvoke.mockImplementation(() => Promise.reject(new Error("非 Tauri 环境")));

    const original = { path: "D:\\report.md", name: "report.md", size: null };
    const result = await snapshotAttachments([original], {
      projectTitle: "p",
      sessionTitle: "s",
      sessionId: "sess-1",
    });

    expect(result).toEqual([original]);
    expect(mockedInvoke).not.toHaveBeenCalledWith("copy_file_to_store", expect.anything());
  });

  it("没有附件时直接返回空数组且不调用后端", async () => {
    const result = await snapshotAttachments([], { projectTitle: "p", sessionTitle: "s", sessionId: "sess-1" });
    expect(result).toEqual([]);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });
});
