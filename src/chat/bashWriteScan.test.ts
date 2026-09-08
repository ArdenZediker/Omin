// bashWriteScan 测试：写语义识别、目标提取、禁区路径判定。
// 原则：宁滥勿缺——未识别的写法最坏退回普通确认门，不允许漏拦截禁区。
import { describe, expect, it } from "vitest";
import { findNoGoZoneTarget, isNoGoZonePath, scanBashWriteSemantics } from "./bashWriteScan";

describe("scanBashWriteSemantics · 只读命令不误报", () => {
  it("纯只读命令无写语义", () => {
    for (const cmd of [
      "git status",
      "git log --oneline -5",
      "ls -la",
      "cat package.json",
      "node --version",
      "rg pattern src/",
      "type notes.md",
      "echo hello", // 无重定向的 echo 是打印
    ]) {
      expect(scanBashWriteSemantics(cmd).hasWriteSemantics, cmd).toBe(false);
    }
  });

  it("引号内的 > 不算重定向（echo \"a > b\" 是纯打印）", () => {
    expect(scanBashWriteSemantics('echo "a > b"').hasWriteSemantics).toBe(false);
  });
});

describe("scanBashWriteSemantics · 重定向与管道写入", () => {
  it("识别 > 重定向并提取目标", () => {
    const scan = scanBashWriteSemantics("echo hello > out.txt");
    expect(scan.hasWriteSemantics).toBe(true);
    expect(scan.destructive).toBe(false);
    expect(scan.targets).toContain("out.txt");
  });

  it("识别 >> 追加、2> 错误重定向；2>&1 与 /dev/null 不算", () => {
    expect(scanBashWriteSemantics("make 2>&1").hasWriteSemantics).toBe(false);
    expect(scanBashWriteSemantics("cmd > /dev/null").hasWriteSemantics).toBe(false);

    const append = scanBashWriteSemantics("echo x >> log/app.log");
    expect(append.targets).toContain("log/app.log");

    const err = scanBashWriteSemantics("build 2> err.log");
    expect(err.targets).toContain("err.log");
  });

  it("识别管道 tee 写入", () => {
    const scan = scanBashWriteSemantics("cat a | tee b.txt");
    expect(scan.hasWriteSemantics).toBe(true);
    expect(scan.targets).toContain("b.txt");
  });
});

describe("scanBashWriteSemantics · 原地修改与命令级判定", () => {
  it("sed -i 识别为破坏性原地修改", () => {
    const scan = scanBashWriteSemantics("sed -i 's/a/b/' src/app.ts");
    expect(scan.hasWriteSemantics).toBe(true);
    expect(scan.destructive).toBe(true);
  });

  it("rm 即使不带 -rf 也判破坏性（rm file.txt 未进黑名单但需重确认）", () => {
    const scan = scanBashWriteSemantics("rm build/cache.tmp");
    expect(scan.hasWriteSemantics).toBe(true);
    expect(scan.destructive).toBe(true);
  });

  it("del 判破坏性并过滤 Windows 短旗标", () => {
    const scan = scanBashWriteSemantics("del /q temp\\old.log");
    expect(scan.destructive).toBe(true);
    expect(scan.targets).toContain("temp\\old.log");
  });

  it("cp/mv/touch/mkdir 判写入非破坏", () => {
    for (const cmd of ["cp a.txt b.txt", "mv old new", "touch .gitkeep", "mkdir -p dist/lib"]) {
      const scan = scanBashWriteSemantics(cmd);
      expect(scan.hasWriteSemantics, cmd).toBe(true);
      expect(scan.destructive, cmd).toBe(false);
    }
  });

  it("包管理器带 install 子命令算写入，查询子命令不算", () => {
    expect(scanBashWriteSemantics("npm install left-pad").hasWriteSemantics).toBe(true);
    expect(scanBashWriteSemantics("npm install -g bun").hasWriteSemantics).toBe(true);
    expect(scanBashWriteSemantics("npm ls --depth=0").hasWriteSemantics).toBe(false);
    expect(scanBashWriteSemantics("cargo check").hasWriteSemantics).toBe(false);
  });

  it("git clean / reset --hard 判破坏性；git add 不算", () => {
    expect(scanBashWriteSemantics("git clean -fd").destructive).toBe(true);
    expect(scanBashWriteSemantics("git reset --hard HEAD~1").destructive).toBe(true);
    expect(scanBashWriteSemantics("git add -A").hasWriteSemantics).toBe(false);
  });

  it("tar/unzip 解压算写入", () => {
    expect(scanBashWriteSemantics("tar -xzf bundle.tar.gz").hasWriteSemantics).toBe(true);
    expect(scanBashWriteSemantics("unzip pack.zip -d out/").hasWriteSemantics).toBe(true);
  });
});

describe("isNoGoZonePath（静态启发兜底；AppData/TEMP 权威判定在 Rust 端）", () => {
  it("命中 Windows / Program Files / ProgramData / .ssh", () => {
    expect(isNoGoZonePath("C:/Windows/System32/config")).toBe(true);
    expect(isNoGoZonePath("C:\\Program Files\\Evil\\tool.exe")).toBe(true);
    expect(isNoGoZonePath("d:/Program Files (x86)/x")).toBe(true);
    expect(isNoGoZonePath("C:/ProgramData/x")).toBe(true);
    expect(isNoGoZonePath("C:/Users/me/.ssh/authorized_keys")).toBe(true);
  });

  it("项目工作区常规路径不命中", () => {
    expect(isNoGoZonePath("src/app.ts")).toBe(false);
    expect(isNoGoZonePath("D:/repo/build/out.txt")).toBe(false);
    expect(isNoGoZonePath("D:/repo/AppDataBackup/notes.txt")).toBe(false); // 仅命中真实 AppData 目录才算
    expect(isNoGoZonePath("")).toBe(false);
  });

  it("findNoGoZoneTarget 返回首个命中项", () => {
    expect(findNoGoZoneTarget(["D:/repo/a.txt", "C:/Windows/temp/x"])).toBe("C:/Windows/temp/x");
    expect(findNoGoZoneTarget(["D:/repo/a.txt"])).toBeNull();
  });
});
