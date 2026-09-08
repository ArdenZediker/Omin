import { beforeEach, describe, expect, it } from "vitest";
import { buildShellEnvHint, resolveShellEnv } from "./shellEnv";

function setShellPath(shellPath: string) {
  localStorage.setItem("omni_basic_settings", JSON.stringify({ shellPath }));
}

describe("resolveShellEnv（判定规则须与 Rust apply_shell_args 一致）", () => {
  beforeEach(() => {
    localStorage.removeItem("omni_basic_settings");
  });

  it("未配置时为 auto", () => {
    expect(resolveShellEnv()).toEqual({ kind: "auto", path: null });
  });

  it.each([
    ["D:/Git/bin/bash.exe", "posix-bash"],
    ["C:/msys64/usr/bin/bash.exe", "posix-bash"],
    ["C:/Windows/System32/cmd.exe", "cmd"],
    ["C:/Program Files/PowerShell/7/pwsh.exe", "powershell"],
    ["C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", "powershell"],
    ["C:/Windows/System32/wsl.exe", "wsl"],
    ["D:/omni-resource/busybox.exe", "other"],
    ["/usr/bin/zsh", "posix-bash"],
  ])("%s → %s", (path, expected) => {
    setShellPath(path);
    const env = resolveShellEnv();
    expect(env.kind).toBe(expected);
    expect(env.path).toBe(path);
  });
});

describe("buildShellEnvHint（方案B：动态工具描述）", () => {
  beforeEach(() => {
    localStorage.removeItem("omni_basic_settings");
  });

  it("auto 环境返回空串（静态描述已覆盖）", () => {
    expect(buildShellEnvHint()).toBe("");
  });

  it("自定义 bash：提示 POSIX 语法与路径格式", () => {
    setShellPath("D:/Git/bin/bash.exe");
    const hint = buildShellEnvHint();
    expect(hint).toContain("bash/zsh");
    expect(hint).toContain("POSIX");
  });

  it("自定义 cmd：提示 cmd 语法、禁 POSIX 特有写法", () => {
    setShellPath("C:/Windows/System32/cmd.exe");
    const hint = buildShellEnvHint();
    expect(hint).toContain("cmd.exe");
    expect(hint).toContain("dir/findstr/type");
  });

  it("自定义 wsl：提示 /mnt/c 路径体系", () => {
    setShellPath("C:/Windows/System32/wsl.exe");
    const hint = buildShellEnvHint();
    expect(hint).toContain("WSL");
    expect(hint).toContain("/mnt/c/");
  });

  it("自定义 powershell：提示 PowerShell 语法", () => {
    setShellPath("C:/Program Files/PowerShell/7/pwsh.exe");
    const hint = buildShellEnvHint();
    expect(hint).toContain("PowerShell");
  });
});
