// Omni - gitChanges 数据层单元测试
// 后端走 Tauri 命令,这里覆盖纯函数:状态码描述/分组、汇总、diff 段解析。
import { describe, expect, it } from "vitest";
import {
  CHANGE_GROUP_LABEL,
  CHANGE_GROUP_ORDER,
  describeGitStatus,
  groupForStatus,
  parseUnifiedDiff,
  summarizeChanges,
  type GitFileChange,
} from "./gitChanges";

describe("gitChanges 纯函数", () => {
  describe("describeGitStatus", () => {
    it("识别常见 XY 码", () => {
      expect(describeGitStatus("??")).toBe("未跟踪");
      expect(describeGitStatus(" M")).toBe("已修改");
      expect(describeGitStatus("M ")).toBe("已修改");
      expect(describeGitStatus("A ")).toBe("新增");
      expect(describeGitStatus("D ")).toBe("已删除");
      expect(describeGitStatus("R ")).toBe("已重命名");
      expect(describeGitStatus("  ")).toBe("无变更");
    });

    it("未知码返回原值", () => {
      expect(describeGitStatus("XY")).toBe("XY");
      expect(describeGitStatus("")).toBe("未知");
    });
  });

  describe("groupForStatus", () => {
    it("未跟踪优先", () => {
      expect(groupForStatus("??", false)).toBe("untracked");
    });
    it("已暂存 vs 工作区", () => {
      expect(groupForStatus("M ", true)).toBe("staged");
      expect(groupForStatus(" M", false)).toBe("unstaged");
    });
    it("删除独立", () => {
      expect(groupForStatus("D ", true)).toBe("staged");
      expect(groupForStatus(" D", false)).toBe("deleted");
    });
  });

  describe("summarizeChanges", () => {
    it("累加加/删,二进制不计", () => {
      const list: GitFileChange[] = [
        { path: "a.rs", status: " M", additions: 10, deletions: 2, staged: false },
        { path: "b.rs", status: "M ", additions: 5, deletions: 3, staged: true },
        { path: "c.png", status: "??", additions: -1, deletions: -1, staged: false },
      ];
      const sum = summarizeChanges(list);
      expect(sum.additions).toBe(15);
      expect(sum.deletions).toBe(5);
      expect(sum.binaryCount).toBe(1);
    });
  });

  describe("parseUnifiedDiff", () => {
    it("空文本返回空数组", () => {
      expect(parseUnifiedDiff("")).toEqual([]);
      expect(parseUnifiedDiff("   ")).toEqual([]);
    });

    it("按 @@ hunk 拆段并携带起始行号", () => {
      const text = [
        "diff --git a/x.rs b/x.rs",
        "index 1234567..89abcde 100644",
        "--- a/x.rs",
        "+++ b/x.rs",
        "@@ -1,3 +1,3 @@",
        "-old line",
        "+new line",
        " unchanged",
        "@@ -10,2 +10,4 @@",
        "+inserted 1",
        "+inserted 2",
      ].join("\n");
      const segs = parseUnifiedDiff(text);
      // 首段: hunk 头前的文件头;后续每个 @@ 为一段。
      expect(segs.length).toBe(3);
      expect(segs[0].header).toBe("");
      expect(segs[0].lines[0]).toBe("diff --git a/x.rs b/x.rs");
      expect(segs[1].header).toBe("@@ -1,3 +1,3 @@");
      expect(segs[1].oldLineStart).toBe(1);
      expect(segs[1].newLineStart).toBe(1);
      expect(segs[1].lines.length).toBe(3);
      expect(segs[2].header).toBe("@@ -10,2 +10,4 @@");
      expect(segs[2].oldLineStart).toBe(10);
    });
  });

  describe("GROUP 常量", () => {
    it("排序与文案键齐全", () => {
      expect(CHANGE_GROUP_ORDER.untracked).toBeLessThan(CHANGE_GROUP_ORDER.unstaged);
      expect(CHANGE_GROUP_ORDER.unstaged).toBeLessThan(CHANGE_GROUP_ORDER.deleted);
      expect(CHANGE_GROUP_ORDER.deleted).toBeLessThan(CHANGE_GROUP_ORDER.staged);
      for (const [k, v] of Object.entries(CHANGE_GROUP_LABEL)) {
        expect(v.length).toBeGreaterThan(0);
        expect(k).toBeTruthy();
      }
    });
  });
});
