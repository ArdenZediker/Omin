import { describe, expect, it } from "vitest";
import { validateToolArgs } from "./toolArgsValidation";
import { extractToolCallArgsDetailed } from "../hooks/chatRuntimeHelpers";
import { getToolManifestById } from "../config/manifests/tools";

const readFileParams = getToolManifestById("read_file")?.parameters;
const listFilesParams = getToolManifestById("list_files")?.parameters;
const writeFileParams = getToolManifestById("write_file")?.parameters;
const searchFilesParams = getToolManifestById("search_files")?.parameters;
const installExpertParams = getToolManifestById("install_expert")?.parameters;

describe("validateToolArgs（用下发给模型的同一份 schema 校验入参）", () => {
  it("未声明 parameters 的工具不校验", () => {
    expect(validateToolArgs(undefined, { anything: 1 })).toBeNull();
  });

  it("非 JSON 形态（null/undefined）一律放行：斜杠命令与模型直给字符串", () => {
    expect(validateToolArgs(readFileParams, null)).toBeNull();
    expect(validateToolArgs(readFileParams, undefined)).toBeNull();
  });

  it("空对象缺必填时报错并点名", () => {
    expect(validateToolArgs(readFileParams, {})).toBe("缺少必填参数：path");
  });

  it("无必填声明的工具（list_files）空对象放行", () => {
    expect(validateToolArgs(listFilesParams, {})).toBeNull();
  });

  it("必填字段是空白串同样算缺失", () => {
    expect(validateToolArgs(writeFileParams, { path: "a.ts", content: "   " })).toBe(
      "缺少必填参数：content",
    );
  });

  it("缺必填但其他字段齐全时仍被拦下", () => {
    expect(validateToolArgs(writeFileParams, { path: "a.ts", overwrite: true })).toBe(
      "缺少必填参数：content",
    );
  });

  it("多个必填同时缺失时全部点名", () => {
    expect(validateToolArgs(writeFileParams, { overwrite: true })).toBe(
      "缺少必填参数：path、content",
    );
  });

  it("参数齐全时放行", () => {
    expect(validateToolArgs(writeFileParams, { path: "a.ts", content: "hi" })).toBeNull();
  });

  it("对象塞进字符串字段 = 类型严重不符", () => {
    expect(validateToolArgs(readFileParams, { path: { a: 1 }, maxChars: 100 })).toContain(
      "参数 path 类型不符",
    );
  });

  it("数组塞进标量字段 = 类型严重不符", () => {
    expect(validateToolArgs(readFileParams, { path: ["a", "b"], maxChars: 100 })).toContain(
      "参数 path 类型不符",
    );
  });

  it("数值字段收到无法解析的字符串 = 类型严重不符", () => {
    expect(validateToolArgs(searchFilesParams, { pattern: "x", limit: "abc" })).toContain(
      "参数 limit 类型不符",
    );
  });

  it("布尔字段收到非 true/false = 类型严重不符", () => {
    expect(validateToolArgs(searchFilesParams, { pattern: "x", literal: "yes" })).toContain(
      "参数 literal 类型不符",
    );
  });

  it("对象字段收到字符串 = 类型严重不符", () => {
    expect(validateToolArgs(installExpertParams, { manifest: "不是对象" })).toContain(
      "参数 manifest 类型不符",
    );
  });

  it("宽容：数字字符串填数值字段放行（工具侧本就会转换）", () => {
    expect(validateToolArgs(searchFilesParams, { pattern: "x", limit: "50" })).toBeNull();
  });

  it('宽容：字符串 "true" 填布尔字段放行', () => {
    expect(validateToolArgs(searchFilesParams, { pattern: "x", literal: "true" })).toBeNull();
  });

  it("宽容：数字填字符串字段放行", () => {
    expect(validateToolArgs(readFileParams, { path: 123, maxChars: 100 })).toBeNull();
  });

  it("未在 schema 里声明的字段放行（模型可能带扩展参数）", () => {
    expect(
      validateToolArgs(readFileParams, { path: "a.ts", maxChars: 100, extra: { a: 1 } }),
    ).toBeNull();
  });

  it("全链路：执行用拆解后的 args，校验用未拆解的原始对象，两者各取所需", () => {
    // ① 单字段：执行侧拿到裸值（修复「命令首词被吞」的那条链路），校验侧仍能看到字段名。
    const single = extractToolCallArgsDetailed(JSON.stringify({ path: "src/a.ts" }));
    expect(single.args).toBe("src/a.ts");
    expect(single.rawObject).toEqual({ path: "src/a.ts" });
    expect(validateToolArgs(readFileParams, single.rawObject)).toBeNull();

    // ② manifest 拆包：执行侧拿到拆包后的 manifest，校验侧仍能看到 manifest 这个键。
    const packed = extractToolCallArgsDetailed(JSON.stringify({ manifest: { id: "x" } }));
    expect(packed.args).toBe('{"id":"x"}');
    expect(validateToolArgs(installExpertParams, packed.rawObject)).toBeNull();

    // ③ 斜杠命令 / 空参数：原始入参不是 JSON 对象，rawObject 为 null → 不校验，保留工具自身的用法提示。
    const manual = extractToolCallArgsDetailed("");
    expect(manual.rawObject).toBeNull();
    expect(validateToolArgs(readFileParams, manual.rawObject)).toBeNull();

    // ④ 多字段缺必填：即使经过拆解也仍被拦住。
    const broken = extractToolCallArgsDetailed(JSON.stringify({ path: "a.ts", overwrite: true }));
    expect(validateToolArgs(writeFileParams, broken.rawObject)).toBe("缺少必填参数：content");
  });
});
