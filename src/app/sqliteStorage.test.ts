import { beforeEach, describe, expect, it } from "vitest";
import { readSqliteBackedJson, readSqliteBackedValue, saveSqliteBackedValue } from "./sqliteStorage";

describe("sqliteStorage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("readSqliteBackedJson", () => {
    it("数组 fallback：返回解析后的数组而不是对象结构", () => {
      saveSqliteBackedValue("omni_test_array", JSON.stringify([{ id: "a" }, { id: "b" }]));
      const result = readSqliteBackedJson<Array<{ id: string }>>("omni_test_array", []);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ id: "a" });
      expect(result[1]).toEqual({ id: "b" });
    });

    it("数组 fallback：存储非数组时回落到 fallback", () => {
      saveSqliteBackedValue("omni_test_array_bad", JSON.stringify({ not: "array" }));
      const result = readSqliteBackedJson<string[]>("omni_test_array_bad", ["fallback"]);
      expect(result).toEqual(["fallback"]);
    });

    it("对象 fallback：保持浅合并行为", () => {
      saveSqliteBackedValue("omni_test_object", JSON.stringify({ b: 2 }));
      const result = readSqliteBackedJson<{ a: number; b: number }>("omni_test_object", { a: 1, b: 0 });
      expect(result).toEqual({ a: 1, b: 2 });
    });

    it("无值时返回 fallback", () => {
      const result = readSqliteBackedJson<string[]>("omni_test_missing", []);
      expect(result).toEqual([]);
    });

    it("非法 JSON 时返回 fallback", () => {
      saveSqliteBackedValue("omni_test_bad_json", "{not json");
      const result = readSqliteBackedJson<string[]>("omni_test_bad_json", ["fallback"]);
      expect(result).toEqual(["fallback"]);
    });
  });

  describe("saveSqliteBackedValue", () => {
    it("同步写入 localStorage", () => {
      saveSqliteBackedValue("omni_test_save", "hello");
      expect(readSqliteBackedValue("omni_test_save")).toBe("hello");
    });
  });
});
