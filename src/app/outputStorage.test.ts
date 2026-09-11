import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isAbsolutePath,
  sanitizeDirName,
  sessionDirName,
  dateFolderName,
  resolveSessionDir,
  resolveSessionOutputDir,
  resolveAttachmentSnapshotDir,
  sanitizeAttachmentFileName,
  snapshotAttachments,
} from "./outputStorage";

const mockedInvoke = vi.hoisted(() => vi.fn());
/** 「固定归档目录」覆盖设置；空串 = 产物默认落会话工作目录。 */
const overrideState = vi.hoisted(() => ({ value: "" as string }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockedInvoke,
}));

vi.mock("./sqliteStorage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sqliteStorage")>();
  return {
    ...actual,
    readSqliteBackedValue: () => overrideState.value,
    saveSqliteBackedValue: () => {},
  };
});

const FIXED_DAY = new Date(2026, 8, 10, 12, 0, 0).getTime();
/** Rust 侧解析出的会话目录（含项目分桶），前端不自行拼接。 */
const SESSION_DIR = "C:/Data/chat-sessions/我的项目_abc12345/sess-1234";

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

  it("dateFolderName 输出本地时区的 YYYY-MM-DD 并补零", () => {
    expect(dateFolderName(FIXED_DAY)).toBe("2026-09-10");
    expect(dateFolderName(new Date(2026, 0, 3, 0, 0, 0).getTime())).toBe("2026-01-03");
  });
});

describe("会话数据目录（路径由 Rust 解析）", () => {
  beforeEach(() => {
    overrideState.value = "";
    mockedInvoke.mockReset();
    mockedInvoke.mockResolvedValue(SESSION_DIR);
  });

  it("resolveSessionDir 直接取 Rust 解析结果，前端不复制分桶规则", async () => {
    expect(await resolveSessionDir("sess-1234")).toBe(SESSION_DIR);
    expect(mockedInvoke).toHaveBeenCalledWith("resolve_session_dir", { sessionId: "sess-1234" });
  });

  it("sessionId 为空或 Rust 解析失败时返回空串，由调用方退化", async () => {
    expect(await resolveSessionDir("")).toBe("");
    mockedInvoke.mockRejectedValueOnce(new Error("会话不存在"));
    expect(await resolveSessionDir("sess-1")).toBe("");
  });

  it("附件快照恒定落在会话目录内的 attachments/", async () => {
    expect(await resolveAttachmentSnapshotDir("sess-1234")).toBe(`${SESSION_DIR}/attachments`);
  });
});

describe("产物目录（落在会话的工作目录）", () => {
  beforeEach(() => {
    overrideState.value = "";
    mockedInvoke.mockReset();
  });

  it("默认落到 <cwd>/Omni-导出/<日期>/<项目>/<会话>", async () => {
    const dir = await resolveSessionOutputDir({
      sessionId: "sess-1234",
      workspacePath: "D:/proj",
      projectTitle: "我的项目",
      sessionTitle: "测试会话",
      createdAt: FIXED_DAY,
    });
    expect(dir).toBe("D:/proj/Omni-导出/2026-09-10/我的项目/测试会话_sess-123");
  });

  it("会话没有可用工作目录时返回空串，调用方退化为裸文件名", async () => {
    const dir = await resolveSessionOutputDir({
      sessionId: "sess-1234",
      workspacePath: "   ",
      projectTitle: "我的项目",
      sessionTitle: "测试会话",
      createdAt: FIXED_DAY,
    });
    expect(dir).toBe("");
  });

  it("项目为空时回退 no-project 目录名", async () => {
    const dir = await resolveSessionOutputDir({
      sessionId: "sess-1234",
      workspacePath: "D:/proj",
      projectTitle: null,
      sessionTitle: "x",
      createdAt: FIXED_DAY,
    });
    expect(dir).toBe("D:/proj/Omni-导出/2026-09-10/no-project/x_sess-123");
  });

  it("设了「固定归档目录」时改归档到该目录，覆盖默认工作目录位置", async () => {
    overrideState.value = "D:/Archive";
    const dir = await resolveSessionOutputDir({
      sessionId: "sess-1234",
      workspacePath: "D:/proj",
      projectTitle: "我的项目",
      sessionTitle: "测试会话",
      createdAt: FIXED_DAY,
    });
    expect(dir).toBe("D:/Archive/2026-09-10/我的项目/测试会话_sess-123");
  });

  it("固定归档目录为相对路径时视为无效，回落工作目录", async () => {
    overrideState.value = "相对/目录";
    const dir = await resolveSessionOutputDir({
      sessionId: "sess-1234",
      workspacePath: "D:/proj",
      projectTitle: "我的项目",
      sessionTitle: "测试会话",
      createdAt: FIXED_DAY,
    });
    expect(dir).toBe("D:/proj/Omni-导出/2026-09-10/我的项目/测试会话_sess-123");
  });
});

describe("会话附件快照", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    overrideState.value = "";
  });

  it("sanitizeAttachmentFileName 去掉路径分隔符与非法字符但保留扩展名", () => {
    expect(sanitizeAttachmentFileName("report.md")).toBe("report.md");
    expect(sanitizeAttachmentFileName("../../etc/passwd")).toBe(".. .. etc passwd");
    expect(sanitizeAttachmentFileName("周报:2026?.docx")).toBe("周报 2026 .docx");
    expect(sanitizeAttachmentFileName("   ")).toBe("attachment");
    expect(sanitizeAttachmentFileName("a".repeat(200)).length).toBeLessThanOrEqual(80);
  });

  it("复制成功后把路径改写成会话快照路径并回填真实大小", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "resolve_session_dir") return Promise.resolve(SESSION_DIR);
      if (cmd === "copy_file_to_store") {
        return Promise.resolve({
          path: `${SESSION_DIR}/attachments/report.md`,
          size: 2048,
        });
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });

    const result = await snapshotAttachments(
      [{ path: "D:\\用户\\桌面\\report.md", name: "report.md", size: null }],
      { sessionId: "sess-1234" }
    );

    expect(result).toHaveLength(1);
    // path 指向快照，name 仍是用户看到的原始文件名
    expect(result[0].path).toBe(`${SESSION_DIR}/attachments/report.md`);
    expect(result[0].name).toBe("report.md");
    expect(result[0].size).toBe(2048);

    const copyCall = mockedInvoke.mock.calls.find((call) => call[0] === "copy_file_to_store");
    expect(copyCall).toBeTruthy();
    expect(copyCall![1].src).toBe("D:\\用户\\桌面\\report.md");
    expect(copyCall![1].dst).toBe(`${SESSION_DIR}/attachments/report.md`);
  });

  it("复制失败时回退原始路径，不阻断发送", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "resolve_session_dir") return Promise.resolve(SESSION_DIR);
      if (cmd === "copy_file_to_store") return Promise.reject(new Error("磁盘已满"));
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });

    const original = { path: "D:\\report.md", name: "report.md", size: null };
    const result = await snapshotAttachments([original], { sessionId: "sess-1" });

    expect(result).toEqual([original]);
  });

  it("会话目录无法解析时原样返回且不落盘", async () => {
    mockedInvoke.mockRejectedValue(new Error("会话不存在"));

    const original = { path: "D:\\report.md", name: "report.md", size: null };
    const result = await snapshotAttachments([original], { sessionId: "sess-1" });

    expect(result).toEqual([original]);
    expect(mockedInvoke).not.toHaveBeenCalledWith("copy_file_to_store", expect.anything());
  });

  it("没有附件时直接返回空数组且不调用后端", async () => {
    const result = await snapshotAttachments([], { sessionId: "sess-1" });
    expect(result).toEqual([]);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });
});
