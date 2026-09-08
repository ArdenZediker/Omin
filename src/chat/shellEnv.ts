import { BASIC_SETTINGS_STORAGE_KEY, DEFAULT_BASIC_SETTINGS } from "../app/constants";
import { loadBasicSettings } from "../app/settings";

/**
 * 当前 Shell 执行环境（方案B：动态工具描述的数据源）。
 *
 * - `auto`：用户未配置自定义 Shell，走 Rust 端默认降级（Windows 探测 Git-Bash → cmd /C；
 *   macOS/Linux sh -c），静态工具描述已覆盖，无需动态提示。
 * - 其余：用户在设置里显式指定了 Shell，按可执行名归类，向模型注入对应的语法/路径格式提示。
 */
export type ShellEnvKind = "auto" | "posix-bash" | "wsl" | "cmd" | "powershell" | "other";

export type ShellEnv = {
  kind: ShellEnvKind;
  path: string | null;
};

/** 从设置读取自定义 Shell 路径并归类（判定规则须与 Rust 端 apply_shell_args 一致）。 */
export function resolveShellEnv(): ShellEnv {
  let shellPath = "";
  try {
    shellPath = loadBasicSettings(BASIC_SETTINGS_STORAGE_KEY, DEFAULT_BASIC_SETTINGS).shellPath?.trim() || "";
  } catch {
    shellPath = "";
  }
  if (!shellPath) return { kind: "auto", path: null };
  const stem = (shellPath.split(/[\\/]/).pop() ?? "").replace(/\.(exe|bat|cmd)$/i, "").toLowerCase();
  if (stem === "wsl") return { kind: "wsl", path: shellPath };
  if (stem === "cmd") return { kind: "cmd", path: shellPath };
  if (stem === "pwsh" || stem.includes("powershell")) return { kind: "powershell", path: shellPath };
  if (stem.includes("bash") || stem.includes("zsh")) return { kind: "posix-bash", path: shellPath };
  return { kind: "other", path: shellPath };
}

function isWindows(): boolean {
  return typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent);
}

/**
 * 按当前 Shell 环境生成追加到 /bash 工具描述的动态提示。
 * 返回空串表示无额外提示（auto 环境由静态描述覆盖）。
 */
export function buildShellEnvHint(): string {
  const { kind } = resolveShellEnv();
  switch (kind) {
    case "posix-bash":
      return isWindows()
        ? "ACTIVE SHELL: the user configured a custom bash/zsh (runs via `bash -lc`). " +
            "Full POSIX syntax works (grep/sed/awk, pipes, $(), &&, single quotes). " +
            "Use POSIX-style paths (/d/code/... or /c/...) — do NOT pass D:\\ style Windows paths to commands."
        : "ACTIVE SHELL: the user configured a custom bash/zsh (runs via `bash -lc`). Full POSIX syntax works.";
    case "wsl":
      return "ACTIVE SHELL: the user configured WSL (`wsl -- <command>` runs via the default Linux shell). " +
        "Use Linux commands and POSIX paths (/mnt/c/... corresponds to C:\\...).";
    case "cmd":
      return "ACTIVE SHELL: the user configured cmd.exe as the executor (cmd /C). " +
        "Generate CMD-compatible syntax: dir/findstr/type; do NOT use POSIX-only commands or $().";
    case "powershell":
      return "ACTIVE SHELL: the user configured PowerShell as the executor (-NoLogo -Command). " +
        "Generate PowerShell syntax (Get-ChildItem, Select-String, etc.).";
    case "other":
      return "ACTIVE SHELL: the user configured a custom executable as the shell (command passed via -c). " +
        "Assume POSIX-like behavior and prefer portable commands.";
    default:
      return "";
  }
}
