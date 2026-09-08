// bash 命令写语义静态扫描（对齐「bash 是围栏旁路」的结构性缺口）：
// write_file/edit_file 走 no_go_zone + HITL + diff/撤销，但模型可用 /bash 的
// 重定向、sed -i、rm/del、tee 等绕过这一切。本模块在执行前从命令字符串
// 尽力识别写语义、提取写目标，供执行层：
//   1) 命中禁区路径（.ssh/AppData/Windows/Program Files）→ 无条件硬拦截；
//   2) 含写语义 → 确认弹窗升级为写类/破坏性措辞并展示写目标；
//   3) 纯只读 → 维持原快通道。
// 设计取舍：纯字符串级启发（不做 shell AST），引号内容剥离防误报，
// 提取目标是「尽力而为」——宁可多确认、不可漏拦截。

export interface BashWriteFinding {
  /** 命中的写语义描述，如「输出重定向 >」「sed -i 原地修改」「rm 删除」 */
  description: string;
  /** 该语义下尽力提取到的目标路径/文件名 */
  targets: string[];
}

export interface BashWriteScan {
  /** 是否存在任何写语义（含安装/解压等落盘动作） */
  hasWriteSemantics: boolean;
  /** 破坏性（删除/覆盖/磁盘类），确认弹窗升级措辞 */
  destructive: boolean;
  findings: BashWriteFinding[];
  /** 全部写目标去重汇总 */
  targets: string[];
}

/** 剥离单/双引号内容（保留引号本身占位），防 echo "..." 等文案误报 */
function stripQuoted(command: string): string {
  return command.replace(/'[^'\n]*'/g, "''").replace(/"[^"\n]*"/g, '""');
}

/** 重定向写目标：`>` `>>` `2>` `&>`（排除 2>&1、/dev/null、nul、con） */
const REDIRECT_RE = /(?:>>?|&>>?|2>>?)\s*([^\s;&|<>]+)/g;
const REDIRECT_BLACKLIST = new Set(["&1", "1", "2", "nul", "con", "nul.", "/dev/null", "null"]);

/** 无条件破坏性的独立命令（删除/磁盘/清空类） */
const DESTRUCTIVE_COMMANDS = new Set([
  "rm", "del", "erase", "rd", "rmdir", "rmdir", "unlink", "shred",
  "format", "mkfs", "diskpart", "bcdedit", "cipher",
]);

/** 落盘类命令（写入但非删除）：新建/复制/移动/属性/解压/安装 */
const WRITE_COMMANDS = new Set([
  "touch", "mkdir", "md", "cp", "copy", "xcopy", "robocopy", "mv", "move",
  "ren", "rename", "chmod", "chown", "chgrp", "attrib", "ln", "mklink",
  "tar", "unzip", "gzip", "gunzip", "zip", "patch", "setx",
  "winget", "scoop", "choco", "apt", "apt-get", "brew", "pacman", "apk",
  "npm", "pnpm", "yarn", "bun", "pip", "pip3", "cargo", "composer", "gem",
]);

/** 包管理器的写子命令（install/add/i 等）；不在集合内的子命令（如 npm ls）不算写 */
const PACKAGE_WRITE_SUBCOMMANDS = new Set([
  "install", "add", "i", "uninstall", "remove", "rm", "update", "upgrade", "ci",
]);

/** 从 token 列表提取目标：排除旗标（-x / /x 与 /xyz 短旗标）、纯数字、空 */
function extractTargets(tokens: string[]): string[] {
  return tokens.filter((t) => {
    if (!t) return false;
    if (/^[-@]/.test(t)) return false;
    if (/^\/[a-z]{1,3}$/i.test(t)) return false; // Windows 短旗标 /s /f /q /y
    if (/^\d+$/.test(t)) return false;
    return true;
  });
}

/**
 * 扫描 bash/cmd 命令的写语义。启发式、宁滥勿缺：
 * 未识别的写法最坏退回「走普通确认门」，不会放行。
 */
export function scanBashWriteSemantics(command: string): BashWriteScan {
  const findings: BashWriteFinding[] = [];
  const text = stripQuoted(command ?? "");
  const tokens = text.split(/[\s;&|()]+/).filter(Boolean);

  // 1) 重定向：> file、>> file、2> file、&> file（2>&1 排除）
  const redirectTargets: string[] = [];
  for (const m of text.matchAll(REDIRECT_RE)) {
    const target = (m[1] ?? "").replace(/^["']|["']$/g, "");
    if (!target || REDIRECT_BLACKLIST.has(target.toLowerCase())) continue;
    redirectTargets.push(target);
  }
  if (redirectTargets.length > 0) {
    findings.push({ description: "输出重定向（>/>>）", targets: redirectTargets });
  }

  // 2) 管道写入：| tee（含 tee -a）
  const teeIndex = tokens.findIndex((t) => t.toLowerCase() === "tee");
  if (teeIndex >= 0) {
    findings.push({
      description: "tee 写入",
      targets: extractTargets(tokens.slice(teeIndex + 1)),
    });
  }

  // 3) 原地修改：sed -i / perl -i
  for (const [i, t] of tokens.entries()) {
    const lower = t.toLowerCase();
    if ((lower === "sed" || lower === "perl") && tokens.slice(i + 1, i + 3).some((f) => /^-{1,2}i$/.test(f))) {
      const afterFlags = tokens.slice(i + 1).filter((f) => !f.startsWith("-"));
      findings.push({ description: `${lower} -i 原地修改`, targets: extractTargets(afterFlags).slice(0, 2) });
      break;
    }
  }

  // 4) 命令级判定：按可执行名（去路径/扩展名）
  const exeRaw = (tokens[0] ?? "").replace(/^[./\\]+/, "");
  const exe = (exeRaw.includes("/") || exeRaw.includes("\\") ? exeRaw.split(/[\\/]/).pop()! : exeRaw)
    .replace(/\.(exe|cmd|bat|ps1|sh)$/i, "")
    .toLowerCase();

  if (DESTRUCTIVE_COMMANDS.has(exe)) {
    findings.push({ description: `${exe}（删除/破坏类）`, targets: extractTargets(tokens.slice(1)) });
  } else if (WRITE_COMMANDS.has(exe)) {
    // 包管理器只在携带写子命令时才算落盘（npm ls / cargo check 不算）
    const isPackageManager = ["npm", "pnpm", "yarn", "bun", "pip", "pip3", "cargo", "composer", "gem"].includes(exe);
    if (isPackageManager) {
      const sub = (tokens[1] ?? "").toLowerCase();
      if (PACKAGE_WRITE_SUBCOMMANDS.has(sub)) {
        findings.push({ description: `${exe} ${sub}（安装/卸载）`, targets: [] });
      }
    } else {
      findings.push({ description: `${exe}（文件写入/变更）`, targets: extractTargets(tokens.slice(1)) });
    }
  } else if (exe === "git") {
    const sub = (tokens[1] ?? "").toLowerCase();
    if (sub === "clean" || (sub === "reset" && tokens.some((t) => t.toLowerCase() === "--hard"))) {
      findings.push({ description: `git ${sub}（破坏性仓库操作）`, targets: [] });
    }
  } else if (exe === "powershell" || exe === "pwsh") {
    const rest = tokens.slice(1).join(" ").toLowerCase();
    if (/new-item|set-content|add-content|copy-item|move-item|remove-item/.test(rest)) {
      findings.push({ description: "PowerShell 文件写入/删除", targets: [] });
    }
  }

  const targets = [...new Set(findings.flatMap((f) => f.targets))];
  return {
    hasWriteSemantics: findings.length > 0,
    destructive: findings.some((f) => /删除|破坏|磁盘|仓库操作|原地修改|安装\/卸载|文件写入\/删除/.test(f.description)),
    findings,
    targets,
  };
}

/**
 * TS 侧禁区路径静态启发（前端拿不到环境变量，保守正则）：
 * 任意盘符的 Windows 目录、Program Files(×86)、ProgramData、路径中出现 .ssh。
 * AppData（含 TEMP 豁免）的权威判定在 Rust 端 `no_go_zone_check` 命令
 * （复用 office_export.rs::no_go_zone，单一事实来源），本函数仅作 invoke 失败兜底。
 */
export function isNoGoZonePath(path: string): boolean {
  const lower = (path ?? "").replace(/\\/g, "/").toLowerCase().trim();
  if (!lower) return false;
  return (
    /^[a-z]:\/windows(\/|$)/.test(lower) ||
    /^[a-z]:\/program files( \(x86\))?(\/|$)/.test(lower) ||
    /^[a-z]:\/programdata(\/|$)/.test(lower) ||
    /\/\.ssh(\/|$)/.test(lower)
  );
}

/** 汇总扫描结果中命中禁区的首个目标（无则 null） */
export function findNoGoZoneTarget(targets: string[]): string | null {
  return targets.find((t) => isNoGoZonePath(t)) ?? null;
}
