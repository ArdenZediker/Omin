import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isAbsolutePath,
  sanitizeDirName,
  sessionDirName,
  buildSessionOutputDir,
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

  it("buildAttachmentSnapshotDir 纯 sessionId 分桶（不含标题 slug，标题变化不再散落目录）", () => {
    const dir = buildAttachmentSnapshotDir("C:/Out", "我的项目", "sess-1234");
    expect(dir).toBe("C:/Out/我的项目/sessions/sess-1234/attachments");
  });

  it("snapshotAttachments 复制成功后把路径改写成快照路径并回填真实大小", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "default_artifact_dir") return Promise.resolve("C:/Docs");
      if (cmd === "copy_file_to_store") {
        return Promise.resolve({
          path: "C:/Docs/Omni/我的项目/sessions/sess-123/attachments/report.md",
          size: 2048,
        });
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });

    const result = await snapshotAttachments(
      [{ path: "D:\\用户\\桌面\\report.md", name: "report.md", size: null }],
      { projectTitle: "我的项目", sessionId: "sess-123" }
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
      sessionId: "sess-1",
    });

    expect(result).toEqual([original]);
  });

  it("产出根目录无法确定时原样返回", async () => {
    mockedInvoke.mockImplementation(() => Promise.reject(new Error("非 Tauri 环境")));

    const original = { path: "D:\\report.md", name: "report.md", size: null };
    const result = await snapshotAttachments([original], {
      projectTitle: "p",
      sessionId: "sess-1",
    });

    expect(result).toEqual([original]);
    expect(mockedInvoke).not.toHaveBeenCalledWith("copy_file_to_store", expect.anything());
  });

  it("没有附件时直接返回空数组且不调用后端", async () => {
    const result = await snapshotAttachments([], { projectTitle: "p", sessionId: "sess-1" });
    expect(result).toEqual([]);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });
});
