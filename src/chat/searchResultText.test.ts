import { describe, expect, it } from "vitest";
import { parseSearchMatches } from "./searchResultText";

describe("parseSearchMatches（/search_files 结果文本解析）", () => {
  it("解析标准输出：统计头之后的无缩进「path:line 内容」行", () => {
    const text = [
      "找到 2 个相关匹配：",
      "1.",
      "  import { a } from \"./a\";",
      "src/app.ts:42 export const x = 1;",
      "  export const y = 2;",
      "2.",
      "  const z = 3;",
      "src/lib/util.ts:7 return z;",
    ].join("\n");

    expect(parseSearchMatches(text)).toEqual([
      { path: "src/app.ts", line: 42, text: "export const x = 1;" },
      { path: "src/lib/util.ts", line: 7, text: "return z;" },
    ]);
  });

  it("Windows 绝对路径与冒号盘符不干扰行号提取", () => {
    const text = ["找到 1 个相关匹配：", "1.", "C:\\repo\\src\\a.ts:12 hello world"].join("\n");
    expect(parseSearchMatches(text)).toEqual([{ path: "C:\\repo\\src\\a.ts", line: 12, text: "hello world" }]);
  });

  it("内容里再含「数字:数字」时取最后一个「:行号 空格」边界", () => {
    const text = ["找到 1 个相关匹配：", "1.", "src/a.ts:5 at 12:30 meet"].join("\n");
    // 贪婪回溯取最后一个「:30 」→ path 含前面整段？不——路径 token 不允许空白，
    // ^(\S+):(\d+)\s 会匹配 src/a.ts:5 ，内容 "at 12:30 meet" 整体成为 text。
    expect(parseSearchMatches(text)).toEqual([{ path: "src/a.ts", line: 5, text: "at 12:30 meet" }]);
  });

  it("跳过缩进上下文行与空行；无命中时返回空数组", () => {
    const text = ["没有文件内容匹配「foo」。"].join("\n");
    expect(parseSearchMatches(text)).toEqual([]);

    const withContext = ["找到 1 个相关匹配：", "1.", "  indented.ts:9 不算命中", "", "real.ts:1 ok"].join("\n");
    expect(parseSearchMatches(withContext)).toEqual([{ path: "real.ts", line: 1, text: "ok" }]);
  });

  it("空入参与畸形输入安全返回", () => {
    expect(parseSearchMatches("")).toEqual([]);
    expect(parseSearchMatches(undefined as unknown as string)).toEqual([]);
    expect(parseSearchMatches("找到 1 个相关匹配：\n1.\n:abc 没有行号")).toEqual([]);
  });
});
