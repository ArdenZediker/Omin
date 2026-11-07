import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatExecutionResult } from "./types";
import { invoke } from "@tauri-apps/api/core";
import { validateTaskOutput } from "./taskValidation";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const mockInvoke = vi.mocked(invoke);

function result(overrides: Partial<ChatExecutionResult> = {}): ChatExecutionResult {
  return { content: "已完成", model: "test", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, estimated: true, costUsd: 0, ...overrides };
}

describe("validateTaskOutput", () => {
  beforeEach(() => mockInvoke.mockReset());
  it("接受正常文本结果和成功工具结果", async () => {
    await expect(validateTaskOutput(result({ steps: [{ type: "tool_call", name: "read_file", arguments: "{}", result: "内容" }] }))).resolves.toBeUndefined();
  });
  it("拒绝空结果", async () => {
    await expect(validateTaskOutput(result({ content: "  " }))).rejects.toThrow("空结果");
  });
  it("拒绝失败工具，即使模型生成了文字", async () => {
    await expect(validateTaskOutput(result({ steps: [{ type: "tool_call", name: "write_file", arguments: "{}", result: "拒绝", isError: true }] }))).rejects.toThrow("write_file");
  });
  it("要求 Office 导出路径存在，且缺失文件明确失败", async () => {
    mockInvoke.mockResolvedValue(false);
    await expect(validateTaskOutput(result({ steps: [{ type: "tool_call", name: "export_docx", arguments: "{}", result: "已导出", path: "D:/missing.docx" }] }))).rejects.toThrow("文件不存在");
    expect(mockInvoke).toHaveBeenCalledWith("path_exists", { path: "D:/missing.docx" });
  });
});
