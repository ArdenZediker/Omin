import { describe, expect, it } from "vitest";
import { buildOutline, renderOutline } from "./codeOutline";

const TS = [
  "import path from 'node:path';",
  "",
  "// 顶部注释不应被识别",
  "export class Repo {",
  "  private readonly root: string;",
  "",
  "  constructor(root: string) {",
  "    this.root = root;",
  "  }",
  "",
  "  async load(id: string): Promise<void> {",
  "    if (!id) {",
  "      return;",
  "    }",
  "  }",
  "}",
  "",
  "export function helper(a: number) {",
  "  return a + 1;",
  "}",
  "",
  "const render = () => {",
  "  console.log('x');",
  "}",
].join("\n");

const PY = [
  "import os",
  "",
  "class Repo:",
  "    def __init__(self, root):",
  "        self.root = root",
  "",
  "    async def load(self, id):",
  "        if not id:",
  "            return None",
].join("\n");

const RS = [
  "use std::path::Path;",
  "",
  "pub struct Repo {",
  "    root: String,",
  "}",
  "",
  "impl Repo {",
  "    pub fn load(&self, id: &str) {}",
  "}",
].join("\n");

const GO = [
  "package main",
  "",
  "func Load() {}",
  "",
  "func (r *Repo) Save() error { return nil }",
].join("\n");

function kinds(text: string) {
  return buildOutline(text).symbols.map((s) => `${s.kind}:${s.name}`);
}

describe("buildOutline 多语言识别", () => {
  it("TypeScript：容器 / 方法 / 顶层函数 / 箭头常量", () => {
    expect(kinds(TS)).toEqual([
      "class:Repo",
      "method:constructor",
      "method:load",
      "fn:helper",
      "const:render",
    ]);
  });

  it("Python：4 空格缩进下方法归到类下一级", () => {
    const { symbols } = buildOutline(PY);
    expect(symbols.map((s) => s.name)).toEqual(["Repo", "__init__", "load"]);
    expect(symbols[0].depth).toBe(0);
    expect(symbols[1].depth).toBe(1);
  });

  it("Rust：保留 struct / impl 关键字，函数归一为 fn", () => {
    expect(kinds(RS)).toEqual(["struct:Repo", "impl:Repo", "fn:load"]);
  });

  it("Go：带接收者的方法不被漏掉", () => {
    expect(kinds(GO)).toEqual(["fn:Load", "method:Save"]);
  });

  it("控制流与注释不会被当成声明", () => {
    const text = [
      "export function f() {",
      "  if (x) {",
      "    return;",
      "  }",
      "  for (const i of list) {",
      "    console.log(i);",
      "  }",
      "  // const fake = () => {}",
      "  while (true) {}",
      "}",
    ].join("\n");
    expect(kinds(text)).toEqual(["fn:f"]);
  });

  it("没有声明时返回空列表而不是报错", () => {
    expect(buildOutline("").symbols).toEqual([]);
    expect(buildOutline("just some prose\nno code here").symbols).toEqual([]);
  });
});

describe("buildOutline 边界", () => {
  it("maxDepth 之外的深层声明被折叠并计数", () => {
    const text = ["class A {", "  m1() {}", "    m2() {}", "      m3() {}", "}"].join("\n");
    const result = buildOutline(text, { maxDepth: 1 });
    expect(result.symbols.map((s) => s.name)).toEqual(["A", "m1"]);
    expect(result.folded).toBe(2);
  });

  it("超过 maxSymbols 时截断并给出剩余估计", () => {
    const text = Array.from({ length: 12 }, (_, i) => `function f${i}() {}`).join("\n");
    const result = buildOutline(text, { maxSymbols: 5 });
    expect(result.symbols).toHaveLength(5);
    expect(result.dropped).toBeGreaterThan(0);
  });

  it("startLine 偏移让行号与 /read_file 分页一致", () => {
    const result = buildOutline("function a() {}\nfunction b() {}", { startLine: 101 });
    expect(result.symbols.map((s) => s.line)).toEqual([101, 102]);
  });
});

describe("renderOutline", () => {
  it("渲染行号、层级缩进与统计", () => {
    const text = renderOutline("src/chat/x.ts", buildOutline(TS));
    expect(text).toContain("文件：src/chat/x.ts（共 24 行 · 列出 5 个声明）");
    expect(text).toContain("class Repo");
    expect(text).toContain("  method load");
  });

  it("空结果给出可执行的下一步建议", () => {
    const text = renderOutline("notes.txt", buildOutline("no code"));
    expect(text).toContain("未识别出任何声明");
    expect(text).toContain("/read_file");
  });
});
